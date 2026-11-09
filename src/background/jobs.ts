// Build 91: questions answered here, whatever the panel does meanwhile (the owner's notes: he closed the panel during
// a Find similar, and its answer was lost while our server had it ready). A job runs one question (a chat answer or a
// Find similar), keeps what came so far for a panel that comes back, and writes the answer into the question's chat
// itself. Panels follow a job through ports: the one that asked it, and any that comes back to it ("job" port).

import { stamped, type Entry } from "../shared/conversation"
import { afterRestart, prunedJobs, seenIn, withAnswer, withoutQuestion, type Job, type JobKind, type Jobs } from "../shared/jobs"
import { similarMarkdown, type SimilarAnswer, type SimilarItem, type SimilarStep, type SimilarStreamEvent } from "../shared/similar"
import { prune, savedThread, type Threads } from "../shared/threads"
import { t } from "../shared/i18n"
import { STORAGE, type Grounding, type StreamEvent } from "../shared/types"

type AnyEvent = StreamEvent | SimilarStreamEvent

/** What came so far, for a panel that comes back to the job: it shows the answer from there. */
export interface Snapshot {
  type: "snapshot"
  kind: JobKind
  text: string
  grounding?: { text: string; grounding: Grounding }
  step?: SimilarStep
  pages?: number
  items: SimilarItem[]
}

type Listener = (event: Record<string, unknown>) => void

interface Live {
  job: Job
  // When the job last heard from its request (ms), and how it ends itself (a stale one, below).
  heard: number
  emit?: (event: AnyEvent) => void
  // Find similar: the condition asked (kept with the answer).
  asked: string
  controller: AbortController
  listeners: Set<Listener>
  snapshot: Snapshot
  answer?: Omit<SimilarAnswer, "asked" | "at">
}

const live = new Map<string, Live>()

// Every write to the jobs and to the chats goes one after another (the panel's own writes go through saveThread,
// which keeps the answers written here: keepingAnswers).
let queue: Promise<unknown> = Promise.resolve()
// A write that never comes back (storage stuck) gives way after this, so the next ones still go (build 92).
const WRITE_MS = 15_000
function serial<T>(work: () => Promise<T>): Promise<T> {
  const bounded = () => Promise.race([work(), new Promise<T>((_, reject) => setTimeout(() => reject(new Error("storage write timed out")), WRITE_MS))])
  const next = queue.then(bounded, bounded)
  queue = next.catch(() => undefined)
  return next
}

async function readJobs(): Promise<Jobs> {
  return ((await chrome.storage.local.get(STORAGE.jobs).catch(() => ({} as Record<string, unknown>)))[STORAGE.jobs] as Jobs | undefined) ?? {}
}

function updateJobs(change: (jobs: Jobs) => Jobs | null): Promise<void> {
  return serial(async () => {
    const next = change(await readJobs())
    if (next) await chrome.storage.local.set({ [STORAGE.jobs]: prunedJobs(next) }).catch(() => undefined)
  })
}

/** Changes a chat's messages (false: the chat is gone, in Recently Deleted, or `change` left it as it was). */
function updateThread(id: string, change: (entries: Entry[]) => Entry[] | null): Promise<boolean> {
  return serial(async () => {
    const threads = ((await chrome.storage.local.get(STORAGE.threads).catch(() => ({} as Record<string, unknown>)))[STORAGE.threads] as Threads | undefined) ?? {}
    const thread = threads[id]
    if (!thread || thread.deleted || thread.trashed !== undefined) return false
    const entries = change(thread.m)
    if (!entries) return false
    const next = savedThread(thread, id, entries, Date.now())
    if (next) await chrome.storage.local.set({ [STORAGE.threads]: prune({ ...threads, [id]: next }) }).catch(() => undefined)
    return Boolean(next)
  })
}

/** The jobs running now (their question ids). */
export function liveJobIds(): string[] {
  return [...live.keys()]
}

/** The panel showed this chat: its jobs' outcomes were seen. */
export function markSeen(thread: string): Promise<void> {
  return updateJobs((jobs) => seenIn(jobs, thread))
}

/** The background started: jobs a previous one was running were lost with it. */
export function jobsOnStart(): Promise<void> {
  return updateJobs((jobs) => afterRestart(jobs))
}

// While a job runs: every few seconds the panels following it hear it's alive (a panel that hears nothing asks again,
// 2.6 (90): "Reading the page…" for minutes), and an extension call keeps Chrome from closing the background
// mid-answer.
// A job that hears nothing for this long, or runs longer than this, has lost its request (build 92: a stream stalled by
// the system never ended, and the beat kept the background awake for good): it ends as interrupted.
export const JOB_QUIET_MS = 75_000
export const JOB_MAX_MS = 5 * 60_000

/** Ends the jobs that went quiet or ran too long, as interrupted (their requests stopped). */
export function sweepStale(now = Date.now()): void {
  for (const job of [...live.values()]) {
    if (now - job.heard > JOB_QUIET_MS || now - job.job.at > JOB_MAX_MS) {
      job.emit?.({ type: "error", code: "STREAM" })
      job.controller.abort()
    }
  }
}

let beat: ReturnType<typeof setInterval> | undefined
function beating(): void {
  if (beat || !live.size) return
  beat = setInterval(() => {
    if (!live.size) {
      clearInterval(beat)
      beat = undefined
      return
    }
    sweepStale()
    for (const job of live.values()) for (const listener of job.listeners) listener({ type: "beat" })
    try {
      void chrome.runtime.getPlatformInfo?.().catch(() => undefined)
    } catch {
      // not in this browser
    }
  }, 5_000)
}

/**
 * Follows a running job: `listener` gets what came so far (a snapshot), then every event; the returned function stops
 * following (the job goes on). Null: no job with that id runs here.
 */
export function follow(id: string, listener: Listener): (() => void) | null {
  const job = live.get(id)
  if (!job) return null
  listener({ ...job.snapshot, items: [...job.snapshot.items] })
  job.listeners.add(listener)
  return () => job.listeners.delete(listener)
}

/** Stops a job (the stop button): nothing is written, the panel keeps what it showed. */
export function stopJob(id: string): void {
  const job = live.get(id)
  if (!job) return
  live.delete(id)
  job.controller.abort()
  void updateJobs((jobs) => {
    if (!jobs[id]) return null
    const next = { ...jobs }
    delete next[id]
    return next
  })
}

export interface JobSpec {
  id: string
  thread: string
  kind: JobKind
  // Find similar: the condition asked.
  asked?: string
}

/**
 * Starts a job for the question `spec.id` (asked again with the same id, the running one is followed instead: Safari
 * may deliver a request twice). `run` streams the answer's events; `listener` is the asking panel's. Returns the
 * function that stops following.
 */
export function startJob(spec: JobSpec, run: (emit: (e: AnyEvent) => void, signal: AbortSignal) => Promise<void>, listener: Listener): () => void {
  const running = follow(spec.id, listener)
  if (running) return running
  const job: Live = {
    job: { id: spec.id, thread: spec.thread, kind: spec.kind, state: "running", at: Date.now() },
    heard: Date.now(),
    asked: spec.asked ?? "",
    controller: new AbortController(),
    listeners: new Set([listener]),
    snapshot: { type: "snapshot", kind: spec.kind, text: "", items: [] }
  }
  live.set(spec.id, job)
  beating()
  void updateJobs((jobs) => ({ ...jobs, [spec.id]: job.job }))
  let ended = false
  const emit = (event: AnyEvent) => {
    if (ended || live.get(spec.id) !== job) return
    job.heard = Date.now()
    if (event.type === "done" || event.type === "error") {
      ended = true
      void end(job, event)
      return
    }
    take(job, event)
    for (const l of job.listeners) l(event as unknown as Record<string, unknown>)
  }
  job.emit = emit
  void run(emit, job.controller.signal)
    .catch(() => emit({ type: "error", code: "STREAM" }))
    .finally(() => {
      if (!ended && live.get(spec.id) === job && !job.controller.signal.aborted) emit({ type: "error", code: "STREAM" })
    })
  return () => job.listeners.delete(listener)
}

function take(job: Live, event: AnyEvent): void {
  const snap = job.snapshot
  if (event.type === "delta") snap.text += event.text
  else if (event.type === "grounding") snap.grounding = { text: event.text, grounding: event.grounding }
  else if (event.type === "progress") {
    snap.step = event.step
    if (event.pages !== undefined) snap.pages = event.pages
  } else if (event.type === "item") snap.items.push(event.item)
  else if (event.type === "result") job.answer = event.answer
}

// Not in the person's plan after all, or the week's searches used: the question goes (the panel shows a card).
const DROPS_QUESTION = ["ULTRA_ONLY", "PRO_ONLY", "LIMIT_REACHED"]

/** The answer the job wrote into the chat, as the panel shows it (null: nothing to write). */
function answerOf(job: Live, event: AnyEvent): Entry | null {
  const failed = event.type === "error"
  if (job.job.kind === "chat") {
    const grounded = failed ? undefined : job.snapshot.grounding
    const text = grounded?.text ?? job.snapshot.text
    if (!text) return null
    return stamped(grounded ? { role: "assistant", content: text, grounding: grounded.grounding } : { role: "assistant", content: text })
  }
  const items = job.snapshot.items
  const answer = failed ? (items.length ? { intro: "", items, note: "", condition: "" } : null) : job.answer ?? { intro: "", items, note: "", condition: "" }
  if (!answer) return null
  const full: SimilarAnswer = { ...answer, asked: job.asked, at: Date.now() }
  const content = similarMarkdown(full, { inStock: t("similarStockIn"), outOfStock: t("similarStockOut"), notConfirmed: t("similarNotConfirmed"), notOpened: t("similarNotOpened") })
  return stamped({ role: "assistant", content, similar: full })
}

async function end(job: Live, event: AnyEvent): Promise<void> {
  const { id, thread } = job.job
  const code = event.type === "error" ? event.code : null
  const drop = job.job.kind === "similar" && code !== null && DROPS_QUESTION.includes(code)
  const entry = drop ? null : answerOf(job, event)
  if (drop) await updateThread(thread, (m) => withoutQuestion(m, id))
  else if (entry) await updateThread(thread, (m) => withAnswer(m, id, entry))
  const done: Job = { ...job.job, state: code ? "failed" : "done", end: Date.now(), ...(code ? { code } : {}), ...(entry?.id ? { answer: entry.id } : {}) }
  await updateJobs((jobs) => ({ ...jobs, [id]: done }))
  live.delete(id)
  for (const l of job.listeners) l({ ...(event as unknown as Record<string, unknown>), ...(entry ? { entry } : {}) })
  job.listeners.clear()
  // A chat written meanwhile from a copy without the answer (iCloud's sync, another tab): the answer goes back once.
  if (entry) {
    for (const wait of [1_500, 6_000]) {
      setTimeout(() => void updateThread(thread, (m) => (m.some((e) => e.id === entry.id) ? null : withAnswer(m, id, entry))), wait)
    }
  }
}
