// 2.7 (109): the owner's five notes on the panel of TestFlight 108, with the director's decisions.
// P1 an action in one place (the row when it fits, else «…»); P2 «+» doesn't repeat the roomy footer; P3 the collection
// an answer is in, by it; P4 Collections in the chats list; P5 «…» ▸ Move to another chat, kept through sync.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { addCard, cardOf, cardsMoved, newCollection, placesOf, type Collection } from "../src/shared/collections.ts"
import type { Entry } from "../src/shared/conversation.ts"
import { entryKey } from "../src/shared/conversation.ts"
import { moveEntries, sweepMoved, undoMove, type Thread, type Threads } from "../src/shared/threads.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"
import { giveWay } from "../src/content/quiet/giveWay.ts"
import { moveRange, moveTargets } from "../src/content/ux/moveAnswer.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const app = read("src/content/App.tsx")
const LANGS = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]

test("P1. the row gives way: closer, To collection's and Tag's words, then those two leave for «…», then the others' words", () => {
  const steps = giveWay([
    { give: 6, drop: null, order: null }, // Insert into field
    { give: 5, drop: null, order: null }, // Copy
    { give: 3, drop: null, order: null }, // Share
    { give: 4, drop: null, order: null }, // Listen
    { give: 2, drop: "tag", order: 2 },
    { give: 1, drop: "collect", order: 1 }
  ])
  assert.deepEqual(steps, [{ tight: true }, { give: 1 }, { give: 2 }, { drop: "collect" }, { drop: "tag" }, { give: 3 }, { give: 4 }, { give: 5 }, { give: 6 }])
  // What left is what «…» lists, and only that (the iPad Pro with a keyboard listed To collection in both).
  const footer = app.slice(app.indexOf("const messageFooter = "), app.indexOf("{markSaid === idx && mark"))
  assert.match(footer, /\{\(dropped\) => \(<>/)
  assert.match(footer, /onTag: dropped\.has\("tag"\) \?/)
  assert.match(footer, /onCollect: dropped\.has\("collect"\) && !historyMode \?/)
  // Decided by the width there is, not the device: Tag and To collection are in the row on the compact chat too.
  assert.doesNotMatch(footer, /\{!compact && \(\s*<button type="button" data-drop="tag"/)
  assert.doesNotMatch(footer, /compact \|\| touch \? \{/)
  const row = read("src/content/quiet/ToolsRow.tsx")
  assert.match(row, /button\.hidden = out\.has\(button\.dataset\.drop \?\? ""\)/)
  assert.match(read("src/content/quiet/quiet.css"), /\.cf-msg-tools \[data-drop\]\[hidden\] \{ display: none !important; \}/)
  const link = read("src/content/Collections.tsx")
  assert.match(link, /class="cf-collect-link" data-drop="collect" data-drop-order="1"/)
  assert.match(link, /data-drop=\{row \? "collect" : undefined\}/)
  // The Mac keeps its buttons under the pointer.
  assert.match(footer, /hover: !compact && !touch,/)
  assert.match(read("src/content/ux/useMessageUx.tsx"), /\{!touch && \(!extra \|\| extra\.hover\) && \(/)
})

test("P2. on the roomy chat «+» doesn't list Whole chat and the count: the line under the field has them", () => {
  const composer = app.slice(app.indexOf('<footer class="cf-composer">'), app.indexOf("</footer>", app.indexOf('<footer class="cf-composer">')))
  assert.match(composer, /whole=\{historyMode \|\| !compact \? null : \{/)
  assert.match(composer, /usage=\{compact \? usageLine\.full : ""\}/)
  assert.match(composer, /after=\{compact \? getProLink : undefined\}/)
  assert.match(composer, /\{!compact && \(\s*<div class="cf-usage">/)
  // «+» draws the count's part only when it has something in it.
  assert.match(read("src/content/quiet/Plus.tsx"), /\{\(usage \|\| after\) && \(/)
})

test("P3. an answer in a collection shows it by the answer, on its line of tags; a tap opens that collection", () => {
  const footer = app.slice(app.indexOf("const messageFooter = "), app.indexOf("{markSaid === idx && mark"))
  assert.match(footer, /\(\(m\.tags && m\.tags\.length > 0\) \|\| places\.length > 0\) && \(\s*<div class="cf-msg-tags">\s*<CollectedMark places=\{places\}/)
  assert.match(footer, /reportCollect\("open", \{ via: "mark" \}\)\s*openCollection\(id\)/)
  // Not in the row of buttons: the row stays one row.
  assert.ok(footer.indexOf("<CollectedMark") < footer.indexOf("<ToolsRow"))
  const link = read("src/content/Collections.tsx")
  assert.match(link, /class="cf-col-mark" onClick=\{\(\) => onOpen\(rec\.id\)\}/)
  // The row's ✓ no longer repeats the name; its menu and VoiceOver still say where.
  assert.match(link, /<span class="cf-collect-name cf-tl" data-give="1">\{t\("colAdd"\)\}<\/span>/)
  assert.match(read("src/content/collections.css"), /\.cf-col-mark-name \{[^}]*text-overflow: ellipsis; white-space: nowrap; \}/)
  assert.deepEqual(useFields({ f: "collect", a: "open", via: "mark" }), { f: "collect", a: "open", via: "mark" })
})

test("P4. the chats list opens Collections, next to the folders", () => {
  const list = read("src/content/Threads.tsx")
  assert.match(list, /const tagBar = \(tagsInUse\.length > 0 \|\| onCollections\) && \(/)
  assert.ok(list.indexOf('{t("tagsGroup")}') < list.indexOf('{t("colTab")}'))
  assert.match(list, /class="cf-tag-group cf-tag-cols" onClick=\{onCollections\}/)
  assert.match(app, /onCollections=\{\(\) => \{\s*setUndoBar\(null\)\s*setColOpen\(null\)\s*setView\("collections"\)/)
  assert.deepEqual(useFields({ f: "collect", a: "open", via: "chats" }), { f: "collect", a: "open", via: "chats" })
})

const q = (id: string, text: string, t: number, extra: Partial<Entry> = {}): Entry => ({ role: "user", content: text, id, t, page: { url: "https://a.example/x", title: "A", at: t }, ...extra }) as Entry
const a = (id: string, text: string, t: number, extra: Partial<Entry> = {}): Entry => ({ role: "assistant", content: text, id, t, ...extra }) as Entry

test("P5. what moves: an answer with its question, unless the question has another answer; a note by itself", () => {
  const list = [q("q1", "one?", 1), a("a1", "1", 2), q("q2", "two?", 3), a("a2", "2", 4), a("a2b", "2 again", 5), { role: "user", content: "mine", id: "n1", t: 6, note: true } as Entry, a("a3", "lone", 7)]
  assert.deepEqual(moveRange(list, 1), { start: 0, end: 1 })
  assert.deepEqual(moveRange(list, 3), { start: 3, end: 3 })
  assert.deepEqual(moveRange(list, 4), { start: 4, end: 4 })
  assert.deepEqual(moveRange(list, 5), { start: 5, end: 5 })
  assert.deepEqual(moveRange(list, 6), { start: 6, end: 6 })
  assert.equal(moveRange(list, 0), null)
  assert.equal(moveRange(list, 9), null)
})

test("P5. the picker: the latest first, every space's chats, not this one, not Ask your chats or Recently Deleted; search by name", () => {
  const th = (id: string, a: number, extra: Partial<Thread> = {}): Thread => ({ id, u: a, a, m: [q(`${id}q`, `about ${id}`, a)], ...extra })
  const all = [th("here", 9), th("old", 1, { title: "Café plans" }), th("new", 5, { sp: "work" }), th("hist", 8, { kind: "history" }), th("bin", 7, { trashed: 1 }), th("gone", 6, { deleted: true }), { id: "empty", u: 4, m: [] }]
  assert.deepEqual(moveTargets(all, "here").map((x) => x.id), ["new", "old"])
  assert.deepEqual(moveTargets(all, "here", "cafe").map((x) => x.id), ["old"])
  assert.deepEqual(moveTargets(all, "here", "PLANS café").map((x) => x.id), ["old"])
  assert.deepEqual(moveTargets(all, "here", "nothing").map((x) => x.id), [])
})

test("P5. the move keeps the answer's tags, pin, highlights and reminder; iCloud's sweep and Undo agree", () => {
  const answer = a("a1", "Lisbon in May", 2, { tags: ["trip"], pinned: 10, marks: [{ s: 0, e: 6 }] as Entry["marks"], remind: { at: 99, dev: "d1" } })
  const threads: Threads = {
    src: { id: "src", u: 5, a: 4, m: [q("q1", "where?", 1), answer, q("q2", "when?", 3), a("a2", "May", 4)] },
    dst: { id: "dst", u: 8, a: 8, m: [q("q9", "packing?", 8), a("a9", "light", 8)] }
  }
  const moved = moveEntries(threads, { src: 5, dst: 8 }, "src", 0, 1, "dst", 100)
  assert.ok(moved)
  const there = moved.threads.dst.m.find((e) => e.id === "a1")!
  assert.deepEqual([there.tags, there.pinned, there.marks, there.remind, there.from], [["trip"], 10, [{ s: 0, e: 6 }], { at: 99, dev: "d1" }, { chat: "src", at: 100 }])
  // By time among the target's (written before its messages), and gone from the source.
  assert.deepEqual(moved.threads.dst.m.map((e) => e.id), ["q1", "a1", "q9", "a9"])
  assert.deepEqual(moved.threads.src.m.map((e) => e.id), ["q2", "a2"])
  assert.deepEqual(moved.undo.keys, ["q1", "a1"])
  // A device that hadn't heard of the move brings the old copy of the source back from iCloud: the sweep takes the
  // moved ones out of it again (the app does the same, Organize.swift).
  const stale: Threads = { ...moved.threads, src: { ...threads.src, u: 200 } }
  const swept = sweepMoved(stale, {}, 300)
  assert.ok(swept.changed)
  assert.deepEqual(swept.threads.src.m.map((e) => e.id), ["q2", "a2"])
  assert.deepEqual(swept.threads.dst.m.map((e) => e.id), ["q1", "a1", "q9", "a9"])
  // Undo right after: both chats as they were.
  const back = undoMove(moved.threads, {}, moved.undo, 400)
  assert.deepEqual(back.src.m.map((e) => e.id), ["q1", "a1", "q2", "a2"])
  assert.deepEqual(back.dst.m.map((e) => e.id), ["q9", "a9"])
  // To a new chat: it's made in the source's space.
  const fresh = moveEntries({ ...threads, src: { ...threads.src, sp: "work" } }, {}, "src", 0, 1, "n1", 100)!
  assert.equal(fresh.threads.n1.sp, "work")
})

test("P5. the collections' cards follow the moved answer (the app finds a card by chat and message), and come back on Undo", () => {
  let rec: Collection = newCollection("c1", "Trip", undefined, 1, { id: "s1", name: "All" })
  rec = addCard(rec, { id: "k1", sec: "s1", k: "answer", t: "Lisbon", at: 2, chat: "src", msg: entryKey(a("a1", "x", 2)) } as Parameters<typeof addCard>[1], 3)
  rec = addCard(rec, { id: "k2", sec: "s1", k: "answer", t: "Other", at: 2, chat: "src", msg: "a2" } as Parameters<typeof addCard>[1], 3)
  const moved = cardsMoved(rec, "src", "dst", ["q1", "a1"], 50)
  assert.ok(cardOf(moved, "dst", "a1"))
  assert.equal(cardOf(moved, "src", "a1"), undefined)
  assert.ok(cardOf(moved, "src", "a2"), "another answer's card stays")
  assert.ok(moved.c.find((c) => c.id === "k1")!.u >= 50, "newer, so iCloud and the app take it")
  assert.equal(placesOf([moved], "dst", "a1")[0].rec.n, "Trip")
  assert.equal(cardsMoved(rec, "src", "dst", ["zz"], 50), rec, "unchanged when it has none of them")
  const back = cardsMoved(moved, "dst", "src", ["q1", "a1"], 60)
  assert.ok(cardOf(back, "src", "a1"))
  // The panel does both, on the move and on its Undo.
  assert.match(app, /await collectionsFollow\(source, target, moved\.undo\.keys\)/)
  assert.match(app, /await collectionsFollow\(undo\.target, undo\.source, undo\.keys\)/)
})

test("P5. «…» ▸ Move to another chat: not while an answer comes, not in Ask your chats; the bar has Undo and Open", () => {
  assert.match(app, /!historyMode && partial === null && !picked && moveRange\(messages, idx\) \? \(\) => setMoving\(idx\) : undefined/)
  assert.match(app, /onMove: moveFor\(idx\),/)
  assert.match(app, /moveFor: \(idx\) => moveForRef\.current\(idx\)/)
  assert.match(app, /text: t\("orgMoved", threadName\(there\)\),\s*kind: "move",\s*actions: \[\s*\{ label: t\("orgUndo"\), run: \(\) => void undoAnswerMove\(moved\.undo\) \}/)
  assert.match(app, /<MoveSheet\s*all=\{threadList\}/)
  assert.match(read("src/content/ux/MessageUx.tsx"), /\{onMove && <button type="button" role="menuitem" class="cf-menu-move" onClick=\{onMove\}>/)
  assert.ok((FEATURES.quiet.actions as readonly string[]).includes("moved"))
  assert.deepEqual(useFields({ f: "quiet", a: "moved", to: "space" }), { f: "quiet", a: "moved", to: "space" })
  assert.deepEqual(useFields({ f: "quiet", a: "more_pick", what: "move" }), { f: "quiet", a: "more_pick", what: "move" })
})

test("the new strings are in all 15 languages", () => {
  for (const lang of LANGS) {
    const strings = JSON.parse(read(`src/locales/${lang}.json`)) as Record<string, string>
    for (const key of ["uxMove", "uxMoveTitle", "uxMoveNoteTitle"]) assert.ok(strings[key]?.trim(), `${lang}: ${key}`)
    if (lang !== "en") {
      const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
      assert.notEqual(strings.uxMove, en.uxMove, `${lang}: translated`)
    }
  }
})
