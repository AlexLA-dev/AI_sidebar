// Build 91: answers that go on with the panel closed. The job model (pure), then the background's runner on stand-ins for
// the extension's storage: the answer written into its chat with nobody following, a panel coming back mid-answer, a
// request delivered twice, the stop button, an interrupted Find similar, a background that restarted, and the panel's
// own save of an older copy of the chat.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import type { Entry } from "../src/shared/conversation.ts"
import {
  afterRestart, extendsChat, hasUnread, interruption, keepingAnswers, ORPHAN_MS, prunedJobs, repeatsLast, runningThreads, seenIn, unreadThreads,
  withAnswer, withoutQuestion, type Job, type Jobs
} from "../src/shared/jobs.ts"

const q = (id: string, content = "Why?", extra: Partial<Entry> = {}): Entry => ({ role: "user", content, id, t: Date.now(), ...extra })
const a = (id: string, content = "Because."): Entry => ({ role: "assistant", content, id })
const job = (over: Partial<Job> & { id: string }): Job => ({ thread: "T", kind: "chat", state: "running", at: Date.now(), ...over })

// ---- the model -------------------------------------------------------------------------------

test("the answer goes right after its own question, once", () => {
  const m = [q("q1"), a("a1"), q("q2")]
  assert.deepEqual(withAnswer(m, "q2", a("a2"))?.map((e) => e.id), ["q1", "a1", "q2", "a2"])
  // A note written meanwhile stays after the answer.
  const withNote = [...m, { role: "user", content: "note", note: true, id: "n" } as Entry]
  assert.deepEqual(withAnswer(withNote, "q2", a("a2"))?.map((e) => e.id), ["q1", "a1", "q2", "a2", "n"])
  assert.equal(withAnswer(m, "gone", a("a2")), null)
  assert.equal(withAnswer([...m, a("a2")], "q2", a("a2")), null)
  assert.deepEqual(withoutQuestion(m, "q2")?.map((e) => e.id), ["q1", "a1"])
  assert.equal(withoutQuestion(m, "zz"), null)
})

test("the panel's older copy keeps the answers its jobs wrote", () => {
  const stored = [q("q1"), a("a1")]
  const jobs: Jobs = { q1: job({ id: "q1", state: "done", answer: "a1" }) }
  // The panel still has the question alone (it was on another chat) and adds a tag to it.
  const panel = [{ ...q("q1"), tags: ["x"] }]
  assert.deepEqual(keepingAnswers(panel, stored, jobs, "T").map((e) => e.id), ["q1", "a1"])
  // Another chat's job, or a question no longer there: nothing added.
  assert.deepEqual(keepingAnswers(panel, stored, jobs, "other").map((e) => e.id), ["q1"])
  assert.deepEqual(keepingAnswers([], stored, jobs, "T"), [])
})

test("the chats list and the button: working, news, seen", () => {
  const jobs: Jobs = {
    r: job({ id: "r", thread: "A" }),
    d: job({ id: "d", thread: "B", state: "done", end: Date.now() }),
    f: job({ id: "f", thread: "C", state: "failed", code: "STREAM", end: Date.now() }),
    s: job({ id: "s", thread: "D", state: "done", seen: true, end: Date.now() })
  }
  assert.deepEqual([...runningThreads(jobs)], ["A"])
  assert.deepEqual([...unreadThreads(jobs)].sort(), ["B", "C"])
  assert.equal(hasUnread(jobs), true)
  const seen = seenIn(jobs, "B")!
  assert.equal(seen.d.seen, true)
  assert.equal(seenIn(seen, "B"), null)
  assert.equal(seenIn(jobs, "A"), null)
  assert.equal(hasUnread(seenIn(seenIn(jobs, "B")!, "C")!), false)
})

test("old jobs go: seen ones an hour after they ended, at most 30", () => {
  const now = Date.now()
  const jobs: Jobs = {
    old: job({ id: "old", state: "done", seen: true, at: now - 7_200_000, end: now - 7_100_000 }),
    unseen: job({ id: "unseen", state: "done", at: now - 7_200_000, end: now - 7_100_000 }),
    fresh: job({ id: "fresh", state: "done", seen: true, at: now - 60_000, end: now - 30_000 })
  }
  assert.deepEqual(Object.keys(prunedJobs(jobs, now)).sort(), ["fresh", "unseen"])
  const many: Jobs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`j${i}`, job({ id: `j${i}`, at: now - i })]))
  const kept = prunedJobs(many, now)
  assert.equal(Object.keys(kept).length, 30)
  assert.ok(kept.j0 && !kept.j39)
})

test("a background that started again: what it was running was interrupted", () => {
  const jobs: Jobs = { r: job({ id: "r" }), d: job({ id: "d", state: "done" }) }
  const next = afterRestart(jobs, 5)!
  assert.equal(next.r.state, "failed")
  assert.equal(next.r.code, "STREAM")
  assert.equal(next.r.end, 5)
  assert.equal(next.d.state, "done")
  assert.equal(afterRestart({ d: jobs.d }), null)
})

test("a last question without an answer: interrupted, still working, or too fresh to tell", () => {
  const now = Date.now()
  const asked = [q("q1"), a("a1"), q("q2")]
  // Its job failed here.
  assert.deepEqual(interruption(asked, { q2: job({ id: "q2", state: "failed", code: "NETWORK" }) }, false, now), { code: "NETWORK" })
  // Its job runs (the panel follows it), or the panel follows it already.
  assert.equal(interruption(asked, { q2: job({ id: "q2" }) }, false, now), null)
  assert.equal(interruption(asked, {}, true, now), null)
  // No job here: a moment ago (another device may be answering), or long ago (lost).
  assert.equal(interruption(asked, {}, false, now + 5_000), null)
  assert.deepEqual(interruption(asked, {}, false, now + ORPHAN_MS + 1), { code: "STREAM" })
  // Answered, or a note last: nothing.
  assert.equal(interruption([q("q1"), a("a1")], {}, false, now + ORPHAN_MS * 2), null)
  assert.equal(interruption([q("n", "note", { note: true, t: 0 })], {}, false, now), null)
})

test("the same question again after an interruption takes its place, another doesn't", () => {
  const sim = q("q2", "“Text…” · Free", { similarAsk: "free", similarSel: "Text" })
  const m = [q("q1"), a("a1"), sim]
  assert.equal(repeatsLast(m, { content: "“Text…” · Free", similarAsk: "free", similarSel: "Text" }), true)
  assert.equal(repeatsLast(m, { content: "“Text…” · Free", similarAsk: "cheaper", similarSel: "Text" }), false)
  assert.equal(repeatsLast(m, { content: "Why?" }), false)
  assert.equal(repeatsLast([q("q1"), a("a1")], { content: "Because." }), false)
  assert.equal(repeatsLast([q("q1")], { content: "Why?" }), true)
})

test("a chat with more messages after the ones shown is taken as it is", () => {
  const shown = [q("q1"), a("a1"), q("q2")]
  assert.equal(extendsChat([...shown, a("a2")], shown), true)
  assert.equal(extendsChat(shown, shown), false)
  assert.equal(extendsChat([q("q1"), a("x"), q("q2"), a("a2")], shown), false)
})

// ---- the background's runner -----------------------------------------------------------------

let store: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (o: Record<string, unknown>) => {
        Object.assign(store, structuredClone(o))
      }
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined }
  },
  runtime: { getPlatformInfo: async () => ({}) },
  i18n: { getMessage: () => "", getUILanguage: () => "en" }
}

// The background's runner (src/background/jobs.ts), bundled for node: its exports as the tests use them.
type Listener = (e: Record<string, any>) => void
let jobs: {
  startJob: (spec: { id: string; thread: string; kind: "chat" | "similar"; asked?: string }, run: (emit: (e: any) => void, signal: AbortSignal) => Promise<void>, listener: Listener) => () => void
  follow: (id: string, listener: Listener) => (() => void) | null
  stopJob: (id: string) => void
  liveJobIds: () => string[]
  markSeen: (thread: string) => Promise<void>
  jobsOnStart: () => Promise<void>
  sweepStale: (now?: number) => void
}
let panelStore: { saveThread: (id: string, entries: Entry[]) => Promise<void> }

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-jobs-"))
  const out = join(dir, "jobs.mjs")
  await build({
    stdin: { contents: `export * from "./src/background/jobs"; export { saveThread } from "./src/content/store"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { "process.env.NODE_ENV": "\"test\"" }
  })
  const mod = await import(pathToFileURL(out).href)
  jobs = mod
  panelStore = mod
})

beforeEach(() => {
  store = { "cf:threads": { T: { id: "T", u: 1, m: [q("q1"), a("a1"), q("q2")] } } }
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const thread = () => (store["cf:threads"] as Record<string, { m: Entry[] }>).T.m
const stored = () => (store["cf:jobs"] ?? {}) as Jobs

/** A run the test drives: `push` an event, `end` it. */
function scripted() {
  let emit: ((e: any) => void) | null = null
  let finish: () => void = () => undefined
  let runs = 0
  let aborted = false
  const run = (e: (x: any) => void, signal: AbortSignal) => {
    runs++
    emit = e
    signal.addEventListener("abort", () => {
      aborted = true
      finish()
    })
    return new Promise<void>((resolve) => (finish = resolve))
  }
  return { run, push: (e: any) => emit!(e), end: () => finish(), runs: () => runs, aborted: () => aborted }
}

test("the panel closed mid-answer: the answer is written into its chat after the question", async () => {
  const s = scripted()
  const heard: any[] = []
  const unfollow = jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, (e) => heard.push(e))
  await tick()
  assert.equal(stored().q2.state, "running")
  s.push({ type: "delta", text: "Half " })
  unfollow() // the panel went
  s.push({ type: "delta", text: "and the rest." })
  s.push({ type: "done", usage: null })
  s.end()
  await tick(10)
  const m = thread()
  assert.equal(m.length, 4)
  assert.equal(m[3].role, "assistant")
  assert.equal(m[3].content, "Half and the rest.")
  assert.equal(stored().q2.state, "done")
  assert.equal(stored().q2.answer, m[3].id)
  assert.equal(stored().q2.seen, undefined)
  assert.deepEqual(heard.map((e) => e.type), ["delta"])
  assert.deepEqual(jobs.liveJobIds(), [])
})

test("a panel coming back gets what came so far, then the rest and the answer as written", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "delta", text: "So far" })
  const heard: any[] = []
  const unfollow = jobs.follow("q2", (e) => heard.push(e))
  assert.ok(unfollow)
  assert.deepEqual(heard[0], { type: "snapshot", kind: "chat", text: "So far", items: [] })
  s.push({ type: "delta", text: ", then more." })
  s.push({ type: "done", usage: null })
  await tick(10)
  assert.equal(heard[1].text, ", then more.")
  assert.equal(heard[2].type, "done")
  assert.equal(heard[2].entry.content, "So far, then more.")
  assert.equal(heard[2].entry.id, thread()[3].id)
  assert.equal(jobs.follow("q2", () => undefined), null)
})

test("the same question delivered twice runs once", async () => {
  const s = scripted()
  const one: any[] = []
  const two: any[] = []
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, (e) => one.push(e))
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, (e) => two.push(e))
  assert.equal(s.runs(), 1)
  assert.equal(two[0].type, "snapshot")
  s.push({ type: "done", usage: null })
  await tick(10)
  assert.equal(thread().length, 3) // nothing came: no answer written
  assert.equal(one.at(-1).type, "done")
  assert.equal(two.at(-1).type, "done")
})

test("the stop button: the request stops, nothing is written, the job goes", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "delta", text: "Partial" })
  await tick()
  jobs.stopJob("q2")
  await tick(10)
  assert.equal(s.aborted(), true)
  assert.equal(thread().length, 3)
  assert.equal(stored().q2, undefined)
})

test("Find similar broken after two items: those two are written, the job says interrupted", async () => {
  const s = scripted()
  const item = (n: number) => ({ name: `App ${n}`, url: `https://example.com/${n}`, host: "example.com", why: "", checked: true, fit: null })
  jobs.startJob({ id: "q2", thread: "T", kind: "similar", asked: "free" }, s.run, () => undefined)
  s.push({ type: "progress", step: "write" })
  s.push({ type: "item", item: item(1) })
  s.push({ type: "item", item: item(2) })
  const back: any[] = []
  jobs.follow("q2", (e) => back.push(e))
  assert.equal(back[0].step, "write")
  assert.equal(back[0].items.length, 2)
  s.push({ type: "error", code: "STREAM" })
  await tick(10)
  const answer = thread()[3]
  assert.equal(answer.similar?.items.length, 2)
  assert.equal(answer.similar?.asked, "free")
  assert.equal(stored().q2.state, "failed")
  assert.equal(stored().q2.code, "STREAM")
  assert.equal(back.at(-1).entry.id, answer.id)
})

test("Find similar refused (not Ultra): the question goes from the chat", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "similar", asked: "" }, s.run, () => undefined)
  s.push({ type: "error", code: "ULTRA_ONLY" })
  await tick(10)
  assert.deepEqual(thread().map((e) => e.id), ["q1", "a1"])
})

test("a run that ends without saying so counts as interrupted", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "delta", text: "Cut" })
  s.end()
  await tick(10)
  assert.equal(stored().q2.state, "failed")
  assert.equal(thread()[3].content, "Cut")
})

test("a chat in Recently Deleted gets nothing written", async () => {
  ;(store["cf:threads"] as any).T.trashed = Date.now()
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "delta", text: "Answer" })
  s.push({ type: "done", usage: null })
  await tick(10)
  assert.equal(thread().length, 3)
})

test("the background started again: the job it was running is interrupted", async () => {
  store["cf:jobs"] = { q2: job({ id: "q2" }) }
  await jobs.jobsOnStart()
  assert.equal(stored().q2.state, "failed")
  assert.equal(stored().q2.code, "STREAM")
})

test("the panel saving its older copy keeps the answer the background wrote", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "delta", text: "Kept." })
  s.push({ type: "done", usage: null })
  await tick(10)
  // The panel, still without it, tags the question.
  await panelStore.saveThread("T", [q("q1"), a("a1"), { ...q("q2"), tags: ["later"] }])
  const m = thread()
  assert.equal(m.length, 4)
  assert.deepEqual(m[2].tags, ["later"])
  assert.equal(m[3].content, "Kept.")
})

test("seen: the panel showed the chat", async () => {
  const s = scripted()
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, () => undefined)
  s.push({ type: "done", usage: null })
  await tick(10)
  assert.equal(stored().q2.seen, undefined)
  await jobs.markSeen("T")
  assert.equal(stored().q2.seen, true)
})

test("a job that goes quiet ends as interrupted, its request stopped (build 92: the beat kept the background awake)", async () => {
  const s = scripted()
  const heard: any[] = []
  jobs.startJob({ id: "q2", thread: "T", kind: "chat" }, s.run, (e) => heard.push(e))
  s.push({ type: "delta", text: "Half" })
  jobs.sweepStale(Date.now() + 10_000)
  assert.deepEqual(jobs.liveJobIds(), ["q2"]) // still talking
  jobs.sweepStale(Date.now() + 80_000)
  await tick(10)
  assert.equal(s.aborted(), true)
  assert.deepEqual(jobs.liveJobIds(), [])
  assert.equal(stored().q2.state, "failed")
  assert.equal(stored().q2.code, "STREAM")
  assert.equal(thread()[3].content, "Half") // what came stays
  assert.equal(heard.at(-1).type, "error")
})
