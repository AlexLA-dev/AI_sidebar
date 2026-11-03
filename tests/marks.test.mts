import { test } from "node:test"
import assert from "node:assert/strict"

import { addMark, markedContent, marksLine, placeMarks, removeMark, starMarks } from "../src/shared/marks.ts"

test("addMark merges overlapping and touching highlights, keeps them in order", () => {
  const text = "Teams cut long meetings and kept their output."
  let marks = addMark([], 10, 23, text)
  assert.deepEqual(marks, [{ s: 10, e: 23, q: "long meetings" }])
  marks = addMark(marks, 0, 5, text)
  marks = addMark(marks, 20, 30, text)
  assert.deepEqual(marks.map((m) => m.q), ["Teams", "long meetings and ke"])
  assert.deepEqual(removeMark(marks, 0).map((m) => m.q), ["long meetings and ke"])
  assert.deepEqual(addMark(marks, 5, 5, text), marks)
})

test("placeMarks keeps highlights that fit and finds moved ones by their text", () => {
  const before = { s: 6, e: 10, q: "week" }
  assert.deepEqual(placeMarks([before], "A one week trial"), [{ s: 6, e: 10, q: "week" }])
  assert.deepEqual(placeMarks([before], "A short four-day week trial"), [{ s: 17, e: 21, q: "week" }])
  assert.deepEqual(placeMarks([{ s: 0, e: 4, q: "gone" }], "nothing here"), [])
})

test("markedContent wraps highlights in the Markdown source, across bold, links and list items", () => {
  const md = "**In short:** a four-day week kept revenue flat.\n\n- **61 companies** cut hours by 20%\n- Read [the study](https://example.com/s) first"
  assert.equal(markedContent(md, [{ s: 0, e: 0, q: "four-day week kept" }]), "**In short:** a <mark>four-day week kept</mark> revenue flat.\n\n- **61 companies** cut hours by 20%\n- Read [the study](https://example.com/s) first")
  // Across the bold's closing marks.
  assert.match(markedContent(md, [{ s: 0, e: 0, q: "61 companies cut hours" }]), /<mark>61 companies\*\* cut hours<\/mark>/)
  // A link: its label is what's shown.
  assert.match(markedContent(md, [{ s: 0, e: 0, q: "the study first" }]), /\[<mark>the study\]\(https:\/\/example\.com\/s\) first<\/mark>/)
  // From one list item into the next (the shown text has no break there).
  assert.match(markedContent(md, [{ s: 0, e: 0, q: "by 20%Read" }]), /<mark>by 20%\n- Read<\/mark>/)
  // Not found: left out.
  assert.equal(markedContent(md, [{ s: 0, e: 0, q: "not in the answer" }]), md)
  assert.equal(markedContent(md, []), md)
})

test("markedContent picks the occurrence nearest to where the highlight is shown", () => {
  const md = "week one, then week two, then week three"
  const shown = md.length
  assert.equal(markedContent(md, [{ s: 31, e: 35, q: "week" }], shown), "week one, then week two, then <mark>week</mark> three")
  assert.equal(markedContent(md, [{ s: 0, e: 4, q: "week" }], shown), "<mark>week</mark> one, then week two, then week three")
  // Two highlights of the same word don't take the same spot.
  assert.equal(markedContent(md, [{ s: 0, e: 4, q: "week" }, { s: 15, e: 19, q: "week" }], shown), "<mark>week</mark> one, then <mark>week</mark> two, then week three")
})

test("starMarks wraps highlights in ** for sharing; marksLine lists them for digests", () => {
  assert.equal(starMarks("In short: the week works.", [{ s: 3, e: 8, q: "short" }]), "In **short**: the week works.")
  assert.equal(starMarks("No match", [{ s: 0, e: 3, q: "xyz" }]), "No match")
  assert.equal(marksLine([{ s: 0, e: 1, q: "fewer  meetings" }, { s: 2, e: 3, q: "focus" }]), "«fewer meetings» · «focus»")
  assert.equal(marksLine([{ s: 0, e: 1, q: "x".repeat(400) }], 20).length, 20)
})

test("the model gets an answer's highlights as <mark>; Ask your chats gets a Highlighted line", async () => {
  const { historyForModel } = await import("../src/shared/conversation.ts")
  const { chatDigests } = await import("../src/shared/threads.ts")
  const { MULTI_PAGE_RULE } = await import("../src/shared/prompt.ts")
  const entries = [
    { role: "user" as const, content: "Summarize", page: { url: "https://a.example/p", title: "A" } },
    { role: "assistant" as const, content: "Teams cut **long meetings** first.", marks: [{ s: 10, e: 23, q: "long meetings" }] }
  ]
  const turns = historyForModel(entries, "https://a.example/p")
  assert.equal(turns[1].content, "Teams cut **<mark>long meetings</mark>** first.")
  assert.match(MULTI_PAGE_RULE, /<mark>/)
  const [digest] = chatDigests([{ id: "c1", u: 1, a: 1, m: entries }], { perChat: 2000, perAnswer: 400, total: 4000 })
  assert.match(digest.text, /\nHighlighted: «long meetings»/)
})
