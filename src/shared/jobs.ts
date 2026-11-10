// Answers that keep coming with the panel closed (build 91, the owner's notes: «запрос продолжал процесситься»): the
// background runs every question (a chat answer, Find similar) as a job and writes the answer into its chat itself,
// so closing the panel, opening another chat or leaving the page loses nothing. The jobs are kept in storage
// (STORAGE.jobs) for the panel (still working, interrupted), the chats list (a chat working, a chat with news) and the
// floating button's dot. Pure helpers shared by the background, the content script and tests.

import { entryKey, isQuestion, type Entry } from "./conversation.ts"

export type JobKind = "chat" | "similar"
// "waiting" (build 94): a Find similar whose request was cut (Safari left, the background suspended) while our server
// carries on: its answer is picked up from the server (/api/v2/similar-result).
export type JobState = "running" | "waiting" | "done" | "failed"

export interface Job {
  // The question's id in its chat (Entry.id): one job per question, asked once however often the request comes.
  id: string
  thread: string
  kind: JobKind
  state: JobState
  // Started and finished (ms).
  at: number
  end?: number
  // Failed: why (STREAM: the connection broke, or the background that ran it was closed).
  code?: string
  // The answer's id in the chat, when one was written (a failed job may have written what came before the break).
  answer?: string
  // Its outcome was on screen: the panel open on that chat.
  seen?: true
  // Find similar (build 94): the condition asked (the answer keeps it), and the page it was asked on (the app's
  // "found" notification opens it).
  asked?: string
  open?: string
}

export type Jobs = Record<string, Job>

// Jobs kept, the newest first; a seen job goes an hour after it ended.
export const MAX_JOBS = 30
export const SEEN_KEEP_MS = 3_600_000
// A question without an answer and without a job on this device (asked on another one, or before build 91) counts as
// interrupted after this long: by then any device asking it has written its answer.
export const ORPHAN_MS = 120_000

// A Find similar picked up from our server after the background restarted: within this long (the server keeps it a day).
export const RESUME_MS = 3_600_000

/** Whether a job is still at work: here, or on our server waiting to be picked up. */
export function isActive(job: Job): boolean {
  return job.state === "running" || job.state === "waiting"
}

/** The chats with a job running (or waiting on our server): the chats list shows them as working. */
export function runningThreads(jobs: Jobs): Set<string> {
  return new Set(Object.values(jobs).filter(isActive).map((j) => j.thread))
}

/**
 * The chats at work, each with its newest active job's kind and start (ms): the chats list's row shows a Find similar
 * as searching (build 94, the owner: «на полоске чата видеть, что там какой-то процесс идет»).
 */
export function activeJobs(jobs: Jobs): Map<string, { kind: JobKind; since: number }> {
  const out = new Map<string, { kind: JobKind; since: number }>()
  for (const j of Object.values(jobs)) {
    if (!isActive(j)) continue
    const had = out.get(j.thread)
    if (!had || j.at > had.since) out.set(j.thread, { kind: j.kind, since: j.at })
  }
  return out
}

/** The chats whose job ended while they weren't on screen (an answer, or the interruption): the chats list's dot. */
export function unreadThreads(jobs: Jobs): Set<string> {
  return new Set(Object.values(jobs).filter((j) => !isActive(j) && !j.seen).map((j) => j.thread))
}

/** Whether any chat has news: the floating button's dot. */
export function hasUnread(jobs: Jobs): boolean {
  return unreadThreads(jobs).size > 0
}

/** The jobs with those of `thread` seen (null: nothing to change). */
export function seenIn(jobs: Jobs, thread: string): Jobs | null {
  const unseen = Object.values(jobs).filter((j) => j.thread === thread && !isActive(j) && !j.seen)
  if (!unseen.length) return null
  const next = { ...jobs }
  for (const j of unseen) next[j.id] = { ...j, seen: true }
  return next
}

/** The jobs kept: running ones, unseen ones, seen ones for an hour after they ended; the newest MAX_JOBS. */
export function prunedJobs(jobs: Jobs, now = Date.now()): Jobs {
  const kept = Object.values(jobs)
    .filter((j) => isActive(j) || !j.seen || now - (j.end ?? j.at) < SEEN_KEEP_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_JOBS)
  return Object.fromEntries(kept.map((j) => [j.id, j]))
}

/**
 * The jobs after the background started: one still "running" lost its request with the background that ran it, so it
 * was interrupted — except a recent Find similar, which our server finished on its own (build 94): it waits to be
 * picked up from there (null: nothing to change).
 */
export function afterRestart(jobs: Jobs, now = Date.now()): Jobs | null {
  const lost = Object.values(jobs).filter(isActive)
  if (!lost.length) return null
  const next = { ...jobs }
  for (const j of lost) next[j.id] = resumable(j, now) ? { ...j, state: "waiting" } : { ...j, state: "failed", code: "STREAM", end: now }
  return next
}

/** A job whose answer our server may still have: a Find similar asked within RESUME_MS. */
export function resumable(job: Job, now = Date.now()): boolean {
  return job.kind === "similar" && isActive(job) && now - job.at < RESUME_MS
}

/**
 * The chat's messages with `answer` right after the question `questionId` (null: the question isn't there any more,
 * or the answer already is). The answer goes after its own question even when other messages came since.
 */
export function withAnswer<T extends Entry>(entries: T[], questionId: string, answer: T): T[] | null {
  const at = entries.findIndex((e) => e.id === questionId)
  if (at < 0 || entries.some((e) => answer.id !== undefined && e.id === answer.id)) return null
  return [...entries.slice(0, at + 1), answer, ...entries.slice(at + 1)]
}

/** The chat's messages without the question `questionId` (null: it isn't there). */
export function withoutQuestion<T extends Entry>(entries: T[], questionId: string): T[] | null {
  const at = entries.findIndex((e) => e.id === questionId)
  return at < 0 ? null : [...entries.slice(0, at), ...entries.slice(at + 1)]
}

/**
 * The messages the panel is about to store for `thread`, with the answers its jobs wrote meanwhile kept: the panel's
 * copy may predate an answer the background wrote (the panel was on another chat, or its page slept), and storing it
 * as it is would drop that answer. `stored`: the chat as it is in storage.
 */
export function keepingAnswers<T extends Entry>(entries: T[], stored: T[], jobs: Jobs, thread: string): T[] {
  let next = entries
  for (const job of Object.values(jobs)) {
    if (job.thread !== thread || !job.answer) continue
    const answer = stored.find((e) => e.id === job.answer)
    if (!answer || next.some((e) => e.id === job.answer)) continue
    next = withAnswer(next, job.id, answer) ?? next
  }
  return next
}

/**
 * What the panel shows for a chat's last question when nothing is answering it here: "interrupted" (with Retry) when
 * its job failed, or when no job here has it and it's older than ORPHAN_MS; else nothing (`null`). A job that's still
 * running is the panel's to follow, not this.
 */
export function interruption(entries: Entry[], jobs: Jobs, live: boolean, now = Date.now()): { code: string } | null {
  const last = entries[entries.length - 1]
  if (!isQuestion(last) || live) return null
  const job = last.id ? jobs[last.id] : undefined
  if (job && isActive(job)) return null
  if (job?.state === "failed") return { code: job.code ?? "STREAM" }
  if (job?.state === "done") return null
  return now - (last.t ?? last.page?.at ?? 0) > ORPHAN_MS ? { code: "STREAM" } : null
}

/**
 * Whether a new question repeats the chat's last one, left without an answer: it takes that question's place (2.6
 * (90): an interrupted Find similar asked again showed the question twice).
 */
export function repeatsLast(entries: Entry[], next: Pick<Entry, "content" | "similarAsk" | "similarSel">): boolean {
  const last = entries[entries.length - 1]
  if (!isQuestion(last)) return false
  return last.content === next.content && (last.similarAsk ?? null) === (next.similarAsk ?? null) && (last.similarSel ?? null) === (next.similarSel ?? null)
}

/** Whether `stored` is `shown` with more messages after it (an answer written meanwhile): the panel takes it. */
export function extendsChat(stored: Entry[], shown: Entry[]): boolean {
  return stored.length > shown.length && shown.every((e, i) => entryKey(e) === entryKey(stored[i]))
}
