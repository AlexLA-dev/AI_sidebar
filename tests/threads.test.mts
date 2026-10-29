import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  applyRemote,
  liveThreads,
  markSent,
  MAX_THREADS,
  pendingChanges,
  prune,
  shownThread,
  threadSite,
  threadSnippet,
  threadTitle,
  type Threads
} from "../src/shared/threads.ts"

const page = { url: "https://www.news.example/a", title: "Article A" }
const chat = (q: string, a: string, extra: Partial<Entry> = {}): Entry[] => [
  { role: "user", content: q, page, ...extra },
  { role: "assistant", content: a }
]

test("titles, snippets and sites describe a thread for the list", () => {
  assert.equal(threadTitle(chat("What is   this about?", "x")), "What is this about?")
  assert.equal(threadTitle(chat("Summarize this page in bullets", "x", { label: "Summarize" })), "Summarize · Article A")
  assert.equal(threadTitle([]), "")
  assert.equal(threadSnippet(chat("q", "## Main point\n**Bold** answer [1](https://s.example)")), "Main point Bold answer")
  assert.equal(threadSite(chat("q", "a")), "news.example")
  assert.ok(threadTitle(chat("x".repeat(200), "a")).length <= 80)
})

test("liveThreads lists threads with messages, newest first", () => {
  const threads: Threads = {
    a: { id: "a", u: 1, m: chat("1", "1") },
    b: { id: "b", u: 3, m: chat("2", "2") },
    c: { id: "c", u: 5, m: [], deleted: true },
    d: { id: "d", u: 4, m: [] }
  }
  assert.deepEqual(liveThreads(threads).map((t) => t.id), ["b", "a"])
})

test("pending changes, sending and remote changes keep both devices in step", () => {
  let threads: Threads = {
    a: { id: "a", u: 10, m: chat("1", "1") },
    b: { id: "b", u: 20, m: chat("2", "2") },
    gone: { id: "gone", u: 30, m: [], deleted: true },
    never: { id: "never", u: 30, m: [], deleted: true }
  }
  let synced: Record<string, number> = { a: 10, gone: 5 }
  const pending = pendingChanges(threads, synced)
  assert.deepEqual(pending.map((c) => c.id).sort(), ["b", "gone"])
  ;({ threads, synced } = markSent(threads, synced, pending))
  assert.deepEqual(Object.keys(threads).sort(), ["a", "b"])
  assert.deepEqual(synced, { a: 10, b: 20 })
  assert.deepEqual(pendingChanges(threads, synced), [])

  // Another device continued "a", started "c" and deleted "b"; our own "b" upload comes back unchanged.
  const remote = applyRemote(threads, synced, [
    { id: "a", updatedAt: 40, data: JSON.stringify(chat("1", "1 more")) },
    { id: "c", updatedAt: 50, data: JSON.stringify(chat("3", "3")) },
    { id: "bad", updatedAt: 60, data: "{}" }
  ], ["b"])
  assert.equal(remote.changed, true)
  assert.deepEqual(Object.keys(remote.threads).sort(), ["a", "c"])
  assert.equal(remote.threads.a.m[1].content, "1 more")
  assert.equal(remote.synced.a, 40)
  assert.equal(remote.synced.b, undefined)

  // A local copy changed after the remote one stays and goes up next time.
  const kept = applyRemote({ a: { id: "a", u: 99, m: chat("mine", "mine") } }, { a: 40 }, [{ id: "a", updatedAt: 50, data: JSON.stringify(chat("theirs", "theirs")) }], [])
  assert.equal(kept.threads.a.m[0].content, "mine")
  assert.equal(kept.changed, false)
  assert.deepEqual(pendingChanges(kept.threads, kept.synced).map((c) => c.id), ["a"])
})

test("prune keeps the newest threads and turns the rest into deletions", () => {
  const threads: Threads = {}
  for (let i = 0; i < MAX_THREADS + 3; i++) threads[`t${i}`] = { id: `t${i}`, u: i, m: chat(`${i}`, `${i}`) }
  const pruned = prune(threads, 1000)
  assert.equal(liveThreads(pruned).length, MAX_THREADS)
  assert.deepEqual(["t0", "t1", "t2"].map((id) => pruned[id].deleted), [true, true, true])
  assert.equal(pruned.t3.deleted, undefined)
})

test("shownThread follows a chat continued on another device after this one last switched", () => {
  const threads: Threads = {
    mine: { id: "mine", u: 100, m: chat("mine", "mine") },
    phone: { id: "phone", u: 200, m: chat("phone", "phone") }
  }
  assert.equal(shownThread(threads, { id: "mine", at: 150 }).id, "phone")
  assert.equal(shownThread(threads, { id: "mine", at: 250 }).id, "mine")
  // A new, still empty thread picked after the other device's answer stays.
  assert.deepEqual(shownThread(threads, { id: "new", at: 300 }), { id: "new", m: [] })
  assert.equal(shownThread(threads, { id: "new", at: 150 }).id, "phone")
})
