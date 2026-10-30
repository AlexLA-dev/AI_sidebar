import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  applyRemote,
  chatList,
  cleanTitle,
  liveThreads,
  markSent,
  MAX_THREADS,
  pendingChanges,
  pinAt,
  prune,
  shownThread,
  threadForCloud,
  threadFromCloud,
  threadName,
  threadNotes,
  threadPages,
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

test("a renamed chat keeps its place in the list and its name travels through iCloud", () => {
  const threads: Threads = {
    old: { id: "old", u: 300, a: 100, m: chat("old", "old"), title: "Trip to Rome" },
    recent: { id: "recent", u: 200, m: chat("recent", "recent") }
  }
  assert.deepEqual(liveThreads(threads).map((t) => t.id), ["recent", "old"])
  assert.equal(threadName(threads.old), "Trip to Rome")
  assert.equal(threadName(threads.recent), "recent")
  // Renaming an old chat on another device doesn't make this one jump to it.
  assert.equal(shownThread(threads, { id: "recent", at: 150 }).id, "recent")

  const [sent] = pendingChanges({ old: threads.old }, {})
  assert.ok(!("deleted" in sent))
  const back = applyRemote({}, {}, [{ id: "old", updatedAt: 300, data: (sent as { data: string }).data }], [])
  assert.deepEqual(back.threads.old, threads.old)
  assert.equal(cleanTitle("  Trip \n to   Rome  "), "Trip to Rome")
  assert.ok(cleanTitle("x".repeat(200)).length <= 80)
})

test("threadForCloud fits one record; threadFromCloud reads both formats and rejects the rest", () => {
  const m: Entry[] = [
    { role: "user", content: "x".repeat(50), page },
    { role: "assistant", content: "y".repeat(50) },
    { role: "user", content: "Short", mode: "google" },
    { role: "assistant", content: "Answer", grounding: { sources: [{ title: "S", url: "https://s.example" }], suggestions: "", queries: ["q"] } }
  ]
  assert.deepEqual(threadFromCloud(threadForCloud({ id: "t", u: 5, a: 5, m })), { m })
  assert.deepEqual(threadFromCloud(threadForCloud({ id: "t", u: 5, m, title: "Name" }, 250))?.m, m.slice(2))
  // 2.3 (56) stored just the messages.
  assert.deepEqual(threadFromCloud(JSON.stringify(m)), { m })
  assert.equal(threadFromCloud("not json"), null)
  assert.equal(threadFromCloud("{}"), null)
  assert.equal(threadFromCloud("null"), null)
  assert.equal(threadFromCloud('{"m":[{"role":"system","content":"x"}]}'), null)
  assert.deepEqual(threadFromCloud('{"m":[],"title":"  ","a":"x"}'), { m: [] })
})

test("pinned chats come first in their order, the rest by activity", () => {
  const q = (id: string, a: number, pin?: number) => ({ id, u: a, a, m: [{ role: "user", content: id }] as Entry[], ...(pin !== undefined ? { pin } : {}) })
  const threads: Threads = { a: q("a", 5), b: q("b", 1, 2), c: q("c", 9), d: q("d", 3, -1) }
  assert.deepEqual(chatList(threads).map((t) => t.id), ["d", "b", "c", "a"])
  assert.deepEqual(liveThreads(threads).map((t) => t.id), ["c", "a", "d", "b"]) // what opens stays by activity
  const pinned = chatList(threads).filter((t) => t.pin !== undefined)
  assert.equal(pinAt([], 0), 0)
  assert.equal(pinAt(pinned, 0), -2)
  assert.equal(pinAt(pinned, 1), 0.5)
  assert.equal(pinAt(pinned, 2), 3)
})

test("a pin goes to iCloud and back, and pinned chats are never pruned", () => {
  const thread = { id: "x", u: 1, m: [{ role: "user", content: "Hi" }] as Entry[], pin: 1.5 }
  assert.equal(threadFromCloud(threadForCloud(thread))?.pin, 1.5)
  assert.equal(threadFromCloud(JSON.stringify({ m: thread.m }))?.pin, undefined)
  const many: Threads = {}
  for (let i = 0; i < MAX_THREADS + 5; i++) many[`t${i}`] = { id: `t${i}`, u: 100 + i, m: [{ role: "user", content: `${i}` }] }
  many.old = { id: "old", u: 1, m: [{ role: "user", content: "old" }], pin: 0 }
  const kept = prune(many, 999)
  assert.equal(kept.old.deleted, undefined)
  assert.equal(Object.values(kept).filter((t) => !t.deleted).length, MAX_THREADS)
})

test("a chat lists its pages once each and counts its notes", () => {
  const a = { url: "https://a.example", title: "A" }
  const b = { url: "https://b.example", title: "B" }
  const m: Entry[] = [
    { role: "user", content: "q1", page: a },
    { role: "assistant", content: "x" },
    { role: "user", content: "n", note: true, page: b },
    { role: "user", content: "q2", page: a }
  ]
  assert.deepEqual(threadPages(m), [a, b])
  assert.equal(threadNotes(m), 1)
})
