import assert from "node:assert/strict"
import { test } from "node:test"

import { entryKey, entryTimes, newEntryId, stamped, textKey, withPageChanges, type Entry } from "../src/shared/conversation.ts"
import { applyAppChanges, applyRemote, moveEntries, pageBlocks, sweepMoved, threadForCloud, threadFromCloud, undoMove, type Thread, type Threads } from "../src/shared/threads.ts"

const page = (url: string, at?: number, extra: Record<string, unknown> = {}) => ({ url, title: url.split("/").pop() ?? url, hash: "h1", ...(at !== undefined ? { at } : {}), ...extra })
const q = (content: string, url: string, at?: number, extra: Partial<Entry> = {}): Entry => ({ role: "user", content, page: page(url, at), ...extra })
const a = (content: string, extra: Partial<Entry> = {}): Entry => ({ role: "assistant", content, ...extra })
const note = (content: string, url?: string, at?: number): Entry => ({ role: "user", content, note: true, ...(url ? { page: page(url, at) } : {}) })
const thread = (id: string, m: Entry[], extra: Partial<Thread> = {}): Thread => ({ id, u: 1_000, m, ...extra })

test("new messages get an id and a time; older ones a key from their content, the same every time", () => {
  const id = newEntryId()
  assert.match(id, /^[a-z0-9]{12}$/)
  assert.notEqual(newEntryId(), id)
  const e = stamped({ role: "user", content: "Hi" } as Entry, 42)
  assert.equal(e.t, 42)
  assert.match(e.id!, /^[a-z0-9]{12}$/)
  assert.deepEqual(stamped(e, 99), e)
  assert.equal(entryKey(e), e.id)
  const old = q("What is this?", "https://a.example/x", 5)
  assert.equal(entryKey(old), entryKey({ ...old }))
  assert.match(entryKey(old), /^h[0-9a-f]{16}$/)
  // The same quick action on the same page at another time is another message.
  assert.notEqual(entryKey(old), entryKey(q("What is this?", "https://a.example/x", 6)))
  // Fixed values: the app (Organize.swift) computes the same.
  assert.equal(textKey(""), "811c9dc5050c5d1f")
  assert.equal(textKey("Привет, 세계"), textKey("Привет, 세계"))
})

test("times: t, else the page's, else the message before; none before the first known", () => {
  const m = [q("old", "https://a/1"), a("old answer"), q("new", "https://a/2", 100), a("answer", { t: 150 }), note("n", undefined), { ...a("x"), t: 300 }]
  assert.deepEqual(entryTimes(m), [null, null, 100, 150, 150, 300])
})

test("page blocks: a question or note on another page starts one; a note without a page is its own", () => {
  const m = [
    q("one", "https://a/1", 1), a("1"), q("again", "https://a/1", 2), a("2"), note("there", "https://a/1", 3),
    q("two", "https://b/1", 4), a("3"),
    note("loose"), { role: "user", content: "about the chat" } as Entry, a("4"),
    q("three", "https://c/1", 5), a("5")
  ]
  assert.deepEqual(pageBlocks(m), [
    { start: 0, end: 4, url: "https://a/1" },
    { start: 5, end: 6, url: "https://b/1" },
    { start: 7, end: 9, url: null },
    { start: 10, end: 11, url: "https://c/1" }
  ])
  assert.deepEqual(pageBlocks([]), [])
})

test("a block moves in among the target's turns by time, takes its page text, and both chats get new times", () => {
  const source = thread("s", [
    q("Sofa sizes?", "https://ikea/sofa", 100, { page: page("https://ikea/sofa", 100, { text: "Sofa page text" }) }), a("200 cm"),
    q("Flights to Tokyo?", "https://air/tokyo", 300), a("From 600 €", { t: 310 }),
    q("And the sofa colour?", "https://ikea/sofa", 400), a("Grey")
  ], { a: 400 })
  const target = thread("t", [
    q("Kyoto temples?", "https://jg/kyoto", 250), a("Fushimi Inari"),
    q("JR pass?", "https://jg/jr", 500), a("Not worth it")
  ], { a: 500, title: "Japan", tags: ["travel"] })
  const threads: Threads = { s: source, t: target }
  const moved = moveEntries(threads, {}, "s", 2, 3, "t", 2_000)!
  const t = moved.threads.t
  assert.deepEqual(t.m.map((e) => e.content), ["Kyoto temples?", "Fushimi Inari", "Flights to Tokyo?", "From 600 €", "JR pass?", "Not worth it"])
  assert.deepEqual(t.m[2].from, { chat: "s", at: 2_000 })
  assert.equal(t.m[2].id, entryKey(source.m[2]))
  assert.equal(t.title, "Japan")
  assert.equal(t.u, 2_000)
  // Older than the target's last message: its place in the list stays.
  assert.equal(t.a, 500)
  const s = moved.threads.s
  assert.deepEqual(s.m.map((e) => e.content), ["Sofa sizes?", "200 cm", "And the sofa colour?", "Grey"])
  assert.equal(s.a, 400)
  assert.equal(s.u, 2_000)

  // The last block moves out: the source's last message is now earlier; the page's text goes along.
  const sofa = moveEntries(moved.threads, {}, "s", 2, 3, "t", 3_000)!
  assert.equal(sofa.threads.s.a, 100)
  const colour = sofa.threads.t.m.find((e) => e.content === "And the sofa colour?")!
  assert.equal(colour.page?.text, "Sofa page text")
  assert.equal(sofa.threads.t.a, 500)
  // The source keeps its text too.
  assert.equal(sofa.threads.s.m[0].page?.text, "Sofa page text")
})

test("a block never splits a question from its answer, and older blocks go first", () => {
  const target = thread("t", [q("Pre-2.4", "https://x/old"), a("old"), q("Q", "https://x/1", 100), a("A", { t: 500 })])
  const source = thread("s", [q("S1", "https://y/1", 50), a("a1"), q("S2", "https://y/2", 200), a("a2"), q("S3", "https://z/3"), a("a3")])
  // Written at 200: after "Q" (100), not between it and its answer (500).
  assert.deepEqual(moveEntries({ s: source, t: target }, {}, "s", 2, 3, "t", 9)!.threads.t.m.map((e) => e.content), ["Pre-2.4", "old", "Q", "A", "S2", "a2"])
  // Written at 50: after the messages without a time, before "Q".
  assert.deepEqual(moveEntries({ s: source, t: target }, {}, "s", 0, 1, "t", 9)!.threads.t.m.map((e) => e.content), ["Pre-2.4", "old", "S1", "a1", "Q", "A"])
})

test("moving to a new chat, and a source left empty is deleted (a deletion for iCloud when it has it)", () => {
  const source = thread("s", [q("Deepal S05 range?", "https://car/s05", 100), a("520 km")], { a: 100, title: "Car", pin: 1 })
  const one = moveEntries({ s: source }, { s: 900 }, "s", 0, 1, "new", 5_000)!
  assert.deepEqual(one.threads.s, { id: "s", u: 5_000, m: [], deleted: true })
  assert.equal(one.threads.new.a, 100)
  assert.equal(one.threads.new.m.length, 2)
  assert.equal(one.threads.new.title, undefined)
  const local = moveEntries({ s: source }, {}, "s", 0, 1, "new", 5_000)!
  assert.equal(local.threads.s, undefined)
  // Undo brings the chat back with its name and pin, and the new chat goes.
  const back = undoMove(one.threads, { s: 900, new: 5_000 }, one.undo, 6_000)
  assert.equal(back.s.title, "Car")
  assert.equal(back.s.pin, 1)
  assert.equal(back.s.u, 6_000)
  assert.deepEqual(back.s.m, source.m)
  assert.deepEqual(back.new, { id: "new", u: 6_000, m: [], deleted: true })
})

test("nothing moves from or into \"Ask your chats\", to the same chat, or out of range", () => {
  const s = thread("s", [q("a", "https://a/1", 1), a("b")])
  const h = thread("h", [{ role: "user", content: "what did I read?" }, a("x")], { kind: "history" })
  assert.equal(moveEntries({ s, h }, {}, "s", 0, 1, "h"), null)
  assert.equal(moveEntries({ s, h }, {}, "h", 0, 1, "s"), null)
  assert.equal(moveEntries({ s }, {}, "s", 0, 1, "s"), null)
  assert.equal(moveEntries({ s }, {}, "s", 1, 5, "t"), null)
  assert.equal(moveEntries({ s }, {}, "x", 0, 0, "t"), null)
})

test("a moved message keeps every field (chat UX's highlights, pins, reminders) and its key; undo and a new chat too", () => {
  // Fields this code doesn't know (chat-ux-25: marks, pinned, remind) ride along untouched.
  const ux = (extra: Record<string, unknown>) => extra as Partial<Entry>
  const asked = q("Range in winter?", "https://car/1", 200)
  const answer = a("About 380 km", ux({ marks: [{ s: 6, e: 12, q: "380 km" }], remind: { at: 9_000_000, dev: "iphone-1" }, tags: ["Cars"] }))
  const pinnedNote = { ...note("check the heat pump", "https://car/1", 210), id: "note00000001", t: 210, ...ux({ pinned: 5_000 }) }
  const source = thread("s", [q("Sofa?", "https://sofa/1", 100), a("Fits"), asked, answer, pinnedNote], { a: 210 })
  const target = thread("t", [q("Car?", "https://car/0", 150), a("Yes")], { a: 150 })
  const block = source.m.slice(2)
  const same = (moved: Entry[]) => {
    assert.deepEqual(moved.map(entryKey), block.map(entryKey))
    assert.deepEqual(moved.map(({ id: _id, from: _from, ...rest }) => rest), block.map(({ id: _id, ...rest }) => rest))
  }

  const moved = moveEntries({ s: source, t: target }, {}, "s", 2, 4, "t", 1_000)!
  assert.deepEqual(moved.threads.t.m.map((e) => e.content), ["Car?", "Yes", "Range in winter?", "About 380 km", "check the heat pump"])
  same(moved.threads.t.m.slice(2))
  // A message from before 2.5 takes its key as its id, so a reminder's link finds it by the same key.
  assert.equal(moved.threads.t.m[2].id, entryKey(asked))
  assert.equal(moved.threads.t.m[4].id, "note00000001")

  // Undo after the target changed: the messages go back by key with every field, only `from` gone.
  const t2 = moved.threads.t
  const back = undoMove({ ...moved.threads, t: { ...t2, u: 1_050, m: [...t2.m, q("New", "https://car/2", 1_040), a("n")] } }, {}, moved.undo, 1_200)
  same(back.s.m.slice(2))
  assert.ok(back.s.m.every((e) => !e.from))

  // "To a new chat".
  const split = moveEntries({ s: source }, {}, "s", 2, 4, "fresh", 1_000)!
  same(split.threads.fresh.m)

  // The sweep after iCloud brought the old copy of the source back: the moved copies stay as they are.
  const swept = sweepMoved({ ...moved.threads, s: source }, {}, 2_000).threads
  assert.deepEqual(swept.s.m.map((e) => e.content), ["Sofa?", "Fits"])
  same(swept.t.m.slice(2))
})

test("undo: both chats as they were when nothing changed since; else the messages go back by key", () => {
  const source = thread("s", [q("A", "https://a/1", 100), a("a"), q("B", "https://b/1", 200), a("b"), q("C", "https://a/1", 300), a("c")], { a: 300 })
  const target = thread("t", [q("T", "https://b/2", 150), a("t")], { a: 150 })
  const moved = moveEntries({ s: source, t: target }, {}, "s", 2, 3, "t", 1_000)!
  const exact = undoMove(moved.threads, {}, moved.undo, 1_100)
  assert.deepEqual(exact.s, { ...source, u: 1_100 })
  assert.deepEqual(exact.t, { ...target, u: 1_100 })

  // A new answer in the target meanwhile: only the moved messages go back.
  const t2 = moved.threads.t
  const changed = { ...moved.threads, t: { ...t2, u: 1_050, m: [...t2.m, q("New", "https://b/2", 1_040), a("n")] } }
  const back = undoMove(changed, {}, moved.undo, 1_200)
  assert.deepEqual(back.s.m.map((e) => e.content), ["A", "a", "B", "b", "C", "c"])
  assert.ok(back.s.m.every((e) => !e.from))
  assert.deepEqual(back.t.m.map((e) => e.content), ["T", "t", "New", "n"])
  assert.equal(back.t.u, 1_200)
})

test("page updated is worked out again for the new order", () => {
  const m = [
    q("v1", "https://a/1", 1, { page: { url: "https://a/1", title: "", hash: "x", at: 1 } }),
    q("v2", "https://a/1", 2, { page: { url: "https://a/1", title: "", hash: "y", at: 2 }, pageChanged: true }),
    q("other", "https://b/1", 3)
  ]
  assert.equal(withPageChanges(m)[1].pageChanged, true)
  assert.equal(withPageChanges([m[1], m[2]])[0].pageChanged, undefined)
  assert.equal(withPageChanges(m)[0], m[0])
})

test("sweep: the copy in the chat it was moved from goes, the move's copy stays; the rest is untouched", () => {
  const source = thread("s", [q("Sofa", "https://ikea/1", 100), a("200 cm"), q("Tokyo", "https://air/1", 300), a("600 €")], { a: 300 })
  const target = thread("t", [q("Kyoto", "https://jg/1", 250), a("Inari")], { a: 250 })
  // An unrelated chat asked the same thing on the same page at the same time: it's never touched.
  const twin = thread("r", [q("Tokyo", "https://air/1", 300), a("600 €")])
  const moved = moveEntries({ s: source, t: target, r: twin }, {}, "s", 2, 3, "t", 1_000)!
  // A device that hadn't heard of the move wrote the source again (with a new message): the block came back.
  const stale = { ...source, u: 1_500, m: [...source.m, q("Sofa colour?", "https://ikea/1", 1_400), a("grey")] }
  const swept = sweepMoved({ ...moved.threads, s: stale }, {}, 2_000)
  assert.equal(swept.changed, true)
  assert.deepEqual(swept.threads.s.m.map((e) => e.content), ["Sofa", "200 cm", "Sofa colour?", "grey"])
  assert.equal(swept.threads.s.u, 2_000)
  assert.equal(swept.threads.t, moved.threads.t)
  assert.equal(swept.threads.r, twin)
  // Nothing to sweep: the same object back.
  const again = sweepMoved(swept.threads, {}, 3_000)
  assert.equal(again.changed, false)
  assert.equal(again.threads, swept.threads)
})

test("sweep: two devices moved one block to different chats, the later move stays", () => {
  const source = thread("s", [q("Old", "https://o/1", 50), a("o"), q("Tokyo", "https://air/1", 300), a("600 €")])
  const t1 = thread("t1", [q("Japan", "https://jg/1", 100), a("j")])
  const t2 = thread("t2", [q("Trips", "https://tr/1", 100), a("t")])
  const first = moveEntries({ s: source, t1, t2 }, {}, "s", 2, 3, "t1", 1_000)!
  const second = moveEntries({ s: source, t1, t2 }, {}, "s", 2, 3, "t2", 1_100)!
  const both = { s: second.threads.s, t1: first.threads.t1, t2: second.threads.t2 }
  const swept = sweepMoved(both, {}, 2_000).threads
  assert.deepEqual(swept.t1.m.map((e) => e.content), ["Japan", "j"])
  assert.deepEqual(swept.t2.m.map((e) => e.content), ["Trips", "t", "Tokyo", "600 €"])
})

test("sweep runs when iCloud or the app brings changes; moves survive the cloud format and older clients", () => {
  const source = thread("s", [q("Old", "https://o/1", 50), a("o"), q("Tokyo", "https://air/1", 300), a("600 €")], { a: 300 })
  const target = thread("t", [q("Japan", "https://jg/1", 100), a("j")], { a: 100 })
  const moved = moveEntries({ s: source, t: target }, { s: 1, t: 1 }, "s", 2, 3, "t", 1_000)!
  // The cloud format keeps every field of a message (2.4 does too: it passes messages through as they are).
  const back = threadFromCloud(threadForCloud(moved.threads.t))!
  assert.deepEqual(back.m, moved.threads.t.m)
  // A 2.4 device wrote the source after the move, with the block still in it.
  const remote = applyRemote(moved.threads, { s: 1_000, t: 1_000 }, [{ id: "s", updatedAt: 1_200, data: threadForCloud({ ...source, u: 1_200 }) }], [], 3_000)
  assert.deepEqual(remote.threads.s.m.map((e) => e.content), ["Old", "o"])
  assert.equal(remote.threads.s.u, 3_000)
  const app = applyAppChanges(moved.threads, { s: 1_000 }, [{ id: "s", updatedAt: 1_300, data: threadForCloud({ ...source, u: 1_300 }) }], 4_000)
  assert.deepEqual(app.threads.s.m.map((e) => e.content), ["Old", "o"])
  // Without moves nothing changes in what iCloud applies.
  const plain = applyRemote({ s: source }, { s: 1 }, [{ id: "s", updatedAt: 5_000, data: threadForCloud(source) }], [], 6_000)
  assert.equal(plain.threads.s.u, 5_000)
})
