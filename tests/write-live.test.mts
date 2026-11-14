// Live underlines (2.7, Pro and Ultra): after a pause in typing, only the paragraphs changed since the field got the focus
// are checked, each on its own; their changes come back as underlines at their current place; a paragraph typed in
// since loses its underlines until it's checked again; a fix keeps the paragraph's other underlines; «Пропустить» drops one.
import assert from "node:assert/strict"
import { test } from "node:test"

import { cardTop } from "../src/content/insert/spot.ts"
import { afterFix, applyEdits, diffWords, issueKey, LIVE, liveIssues, liveWorthy, paragraphs, toCheck, type Edit } from "../src/shared/writing.ts"

test("paragraphs: lines without their ends' white space, empty ones left out, places in the whole text", () => {
  const text = "Hi Anna,\n\n  Thanks for teh notes.  \nSee you\n"
  const paras = paragraphs(text)
  assert.deepEqual(paras.map((p) => p.text), ["Hi Anna,", "Thanks for teh notes.", "See you"])
  for (const p of paras) assert.equal(text.slice(p.from, p.to), p.text)
  // Within a part of the text (the draft above a signature).
  const part = paragraphs("x\nHello there all\n-- \nSig", 2, 17)
  assert.deepEqual(part.map((p) => [p.text, p.from]), [["Hello there all", 2]])
  assert.equal(liveWorthy({ from: 0, to: 2, text: "Hi" }), false)
  assert.equal(liveWorthy({ from: 0, to: 0, text: "word ".repeat(400) }), false)
})

test("only what changed since the focus is checked, the caret's paragraph first, a few per pause", () => {
  const text = "First paragraph stays as it was.\nSecond one is new and has typos.\nThird new paragraph here too.\nFourth new one with words.\nFifth new one with words."
  const paras = paragraphs(text)
  const before = new Set([paras[0].text])
  const checked = new Map<string, Edit[]>([[paras[2].text, []]])
  const caret = text.indexOf("Fourth") + 3
  const todo = toCheck(paras, before, checked, caret)
  assert.deepEqual(todo.map((p) => p.text.split(" ")[0]), ["Fourth", "Second", "Fifth"])
  assert.equal(todo.length, LIVE.perPause)
})

test("underlines follow their paragraph; a paragraph typed in since has none; set-aside ones stay out", () => {
  const para = "Thanks for teh notes, see you tommorow."
  const edits = diffWords(para, "Thanks for the notes, see you tomorrow.")
  const checked = new Map([[para, edits]])
  const text = `Hi Anna,\n${para}`
  const issues = liveIssues(checked, paragraphs(text))
  assert.deepEqual(issues.map((i) => [text.slice(i.from, i.to), i.text]), [["teh", "the"], ["tommorow", "tomorrow"]])
  // The paragraph moved down (a line added above): the underlines move with it.
  const moved = `Hi Anna,\nOne more line here.\n${para}`
  assert.deepEqual(liveIssues(checked, paragraphs(moved)).map((i) => moved.slice(i.from, i.to)), ["teh", "tommorow"])
  // Typed in since: no underlines until it's checked again.
  assert.deepEqual(liveIssues(checked, paragraphs(`Hi Anna,\n${para} More`)), [])
  // «Пропустить».
  const ignored = new Set([issueKey(para, edits[0])])
  assert.deepEqual(liveIssues(checked, paragraphs(text), ignored).map((i) => i.text), ["tomorrow"])
})

test("a fix keeps the paragraph's other underlines, moved by what it changed", () => {
  const para = "I definately recieve teh files tommorow."
  const edits = diffWords(para, "I definitely receive the files tomorrow.")
  const first = edits[0]
  const next = afterFix(para, edits, first)
  assert.equal(next.para, applyEdits(para, [first]))
  assert.equal(next.edits.length, edits.length - 1)
  assert.equal(applyEdits(next.para, next.edits), "I definitely receive the files tomorrow.")
})

test("the fix's card: above the words on touch (the keyboard is below them), below them with a pointer", () => {
  const vp = { height: 500, dy: 0 }
  assert.equal(cardTop({ top: 300, bottom: 320 }, 90, vp, true), 202, "touch: above")
  assert.equal(cardTop({ top: 40, bottom: 60 }, 90, vp, true), 68, "touch, no room above: below")
  assert.equal(cardTop({ top: 300, bottom: 320 }, 90, vp, false), 328, "pointer: below")
  assert.equal(cardTop({ top: 440, bottom: 460 }, 90, vp, false), 342, "pointer near the bottom: above")
})
