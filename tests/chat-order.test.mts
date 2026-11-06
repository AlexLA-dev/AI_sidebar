// The order of the chats (2.5 (77), the owner's note: "the order of two chats keeps jumping back and forth").
// A chat moves up only when a question, an answer or a note is new in it. Opening it, reading it, pinning,
// organizing hints, reminders, highlights, sync between devices and moving messages keep its place.
import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  applyAppChanges,
  applyRemote,
  chatList,
  MAX_TURNS,
  moveEntries,
  savedThread,
  threadForCloud,
  type Thread,
  type Threads
} from "../src/shared/threads.ts"

const page = (n: number, text?: string) => ({ url: `https://site.example/${n}`, title: `Page ${n}`, at: n, ...(text ? { text } : {}) })
// A long chat: more messages than the panel keeps, and page texts on more pages than it keeps.
function longChat(id: string, a: number): Thread {
  const m: Entry[] = []
  for (let i = 0; i < 24; i++) {
    m.push({ role: "user", content: `${id} question ${i}`, page: page(i, `text ${i}`), id: `${id}q${i}`, t: a - 100 + i })
    m.push({ role: "assistant", content: `${id} answer ${i}`, id: `${id}a${i}`, t: a - 100 + i })
  }
  return { id, u: a, a, m }
}
const order = (threads: Threads) => chatList(threads).map((t) => t.id)
// What the panel's save does with the shown chat's messages (store.ts saveThread).
function save(threads: Threads, id: string, entries: Entry[], now: number): Threads {
  const next = savedThread(threads[id], id, entries, now)
  return next ? { ...threads, [id]: next } : threads
}

test("opening two long chats one after the other doesn't swap them (the owner's note)", () => {
  // Each one came from the app or iCloud longer than the panel keeps: opening it stored a trimmed copy with a new
  // time, so the chat opened went to the top, and the other one next time.
  let threads: Threads = { older: longChat("older", 1_000), newer: longChat("newer", 2_000) }
  assert.ok(threads.older.m.length > MAX_TURNS)
  assert.deepEqual(order(threads), ["newer", "older"])
  for (let round = 0; round < 3; round++) {
    threads = save(threads, "older", threads.older.m, 10_000 + round * 10)
    assert.deepEqual(order(threads), ["newer", "older"], "after opening the older one")
    threads = save(threads, "newer", threads.newer.m, 10_005 + round * 10)
    assert.deepEqual(order(threads), ["newer", "older"], "after opening the newer one")
  }
  // Nothing was stored: no new copy for iCloud, and the first messages are still there.
  assert.equal(threads.older.u, 1_000)
  assert.equal(threads.older.m.length, 48)
})

test("highlights, pins, reminders, tags, organizing hints and deleting keep the chat's place", () => {
  const base: Threads = {
    top: { id: "top", u: 5_000, a: 5_000, m: [{ role: "user", content: "Q", id: "tq", t: 4_900 }, { role: "assistant", content: "A", id: "ta", t: 5_000 }] },
    low: { id: "low", u: 3_000, a: 3_000, m: [{ role: "user", content: "q", id: "lq", t: 2_900 }, { role: "assistant", content: "a", id: "la", t: 3_000 }, { role: "user", content: "a note", note: true, id: "ln", t: 2_950 }] }
  }
  const edit = (change: (e: Entry) => Entry, index = 1) => base.low.m.map((e, i) => (i === index ? change(e) : e))
  const edits: Array<[string, Entry[]]> = [
    ["highlight", edit((e) => ({ ...e, marks: [{ s: 0, e: 1, q: "a" }] }))],
    ["pin a message", edit((e) => ({ ...e, pinned: 9_000 }))],
    ["reminder", edit((e) => ({ ...e, remind: { at: 99_000, dev: "iphone" } }))],
    ["tag", edit((e) => ({ ...e, tags: ["Cars"] }))],
    ["organizing hint turned down", edit((e) => ({ ...e, dismissed: { move: true } }))],
    ["suggested tag taken", edit((e) => ({ ...e, accepted: { tags: ["Cars"] }, tags: ["Cars"] }))],
    ["note edited", edit((e) => ({ ...e, content: "a longer note" }), 2)],
    ["message deleted", base.low.m.slice(0, 2)]
  ]
  for (const [what, entries] of edits) {
    const threads = save(base, "low", entries, 9_000)
    assert.equal(threads.low.u, 9_000, `${what}: a new copy for iCloud`)
    assert.equal(threads.low.a, 3_000, `${what}: the same place`)
    assert.deepEqual(order(threads), ["top", "low"], what)
  }
  // Deleted, then put back (Undo): still in its place.
  const gone = save(base, "low", base.low.m.slice(0, 2), 9_000)
  assert.equal(save(gone, "low", base.low.m, 9_100).low.a, 3_000)
})

test("a new question, answer or note moves the chat up, to when it was written", () => {
  const base: Threads = {
    top: { id: "top", u: 5_000, a: 5_000, m: [{ role: "user", content: "Q", id: "tq", t: 5_000 }] },
    low: { id: "low", u: 3_000, a: 3_000, m: [{ role: "user", content: "q", id: "lq", t: 3_000 }] }
  }
  for (const entry of [
    { role: "user" as const, content: "new question", id: "n1", t: 8_000 },
    { role: "assistant" as const, content: "new answer", id: "n2", t: 8_000 },
    { role: "user" as const, content: "new note", note: true, id: "n3", t: 8_000 }
  ]) {
    const threads = save(base, "low", [...base.low.m, entry], 8_300)
    assert.equal(threads.low.a, 8_000)
    assert.deepEqual(order(threads), ["low", "top"])
  }
  // A first message in a new chat.
  assert.equal(save(base, "fresh", [{ role: "user", content: "hi", id: "f", t: 9_000 }], 9_100).fresh.a, 9_100)
})

test("sync between devices and the app's changes keep the order: the other device's pin or highlight doesn't move it", () => {
  const top: Thread = { id: "top", u: 5_000, a: 5_000, m: [{ role: "user", content: "Q", id: "tq", t: 5_000 }] }
  const low: Thread = { id: "low", u: 3_000, a: 3_000, m: [{ role: "user", content: "q", id: "lq", t: 3_000 }, { role: "assistant", content: "a", id: "la", t: 3_000 }] }
  // The other device highlighted an answer in `low` (its panel's save), then iCloud brought it here.
  const there = savedThread(low, "low", low.m.map((e, i) => (i === 1 ? { ...e, marks: [{ s: 0, e: 1, q: "a" }] } : e)), 9_000)!
  const remote = applyRemote({ top, low }, {}, [{ id: "low", updatedAt: there.u, data: threadForCloud(there) }], [])
  assert.equal(remote.changed, true)
  assert.equal(remote.threads.low.a, 3_000)
  assert.deepEqual(order(remote.threads), ["top", "low"])
  // The ContextFlow app pinned it (the app keeps `a`): pinned chats go first, by their pin; unpinned, back in its place.
  const pinned = applyAppChanges({ top, low }, {}, [{ id: "low", updatedAt: 9_500, data: JSON.stringify({ a: 3_000, pin: 0, m: low.m }) }]).threads
  assert.deepEqual(order(pinned), ["low", "top"])
  const unpinned = applyAppChanges(pinned, {}, [{ id: "low", updatedAt: 9_600, data: JSON.stringify({ a: 3_000, m: low.m }) }]).threads
  assert.deepEqual(order(unpinned), ["top", "low"])
})

test("moving messages to another chat doesn't move that chat up", () => {
  const source: Thread = { id: "s", u: 9_000, a: 9_000, m: [
    { role: "user", content: "Sofa?", page: page(1), id: "s1", t: 8_000 }, { role: "assistant", content: "Fits", id: "s2", t: 8_000 },
    { role: "user", content: "Tokyo?", page: page(2), id: "s3", t: 9_000 }, { role: "assistant", content: "600 €", id: "s4", t: 9_000 }
  ] }
  const middle: Thread = { id: "mid", u: 5_000, a: 5_000, m: [{ role: "user", content: "x", id: "m1", t: 5_000 }] }
  const target: Thread = { id: "t", u: 2_000, a: 2_000, m: [{ role: "user", content: "Japan?", page: page(3), id: "t1", t: 2_000 }] }
  const moved = moveEntries({ s: source, mid: middle, t: target }, {}, "s", 2, 3, "t", 10_000)!
  assert.equal(moved.threads.t.a, 2_000)
  assert.equal(moved.threads.t.m.length, 3)
  // The source's place is that of its last message left.
  assert.equal(moved.threads.s.a, 8_000)
  assert.deepEqual(order(moved.threads), ["s", "mid", "t"])
})
