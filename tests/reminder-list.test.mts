// The panel's "Reminders" (2.5 (75), the owner's notes): a row says what the reminder is about in full, and its
// time can be changed there.
import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import type { Threads } from "../src/shared/threads.ts"
import { reminderOf, reminderRows, reminderText, withReminderAt } from "../src/content/ux/reminderList.ts"

const NOW = Date.UTC(2026, 10, 4, 12, 0)
const H = 3_600_000
const page = { url: "https://example.com/week", title: "Why the four-day week works", hash: "h", at: NOW - H }
const note: Entry = { role: "user", note: true, id: "n1", content: "Ask Anna whether support could try staggered Fridays off from January.", page, remind: { at: NOW + 20 * H, dev: "phone" } }
const long = `**In short:** ${"the trials mostly worked and most companies kept the shorter week, ".repeat(8)}`
const chats: Threads = {
  c1: { id: "c1", u: NOW, title: "Four-day week", m: [
    { role: "user", id: "q1", content: "What did the trials find?", page },
    { role: "assistant", id: "a1", content: long, remind: { at: NOW + 3 * H, dev: "mac" } },
    note
  ] },
  c2: { id: "c2", u: NOW, m: [
    { role: "user", id: "q2", content: "Old", page },
    { role: "assistant", id: "a2", content: "Rang already.", remind: { at: NOW - H } }
  ] },
  gone: { id: "gone", u: NOW, m: [], deleted: true }
}
const when = (at: number) => `in ${Math.round((at - NOW) / H)} h`
const elsewhere = (label: string) => `${label} · on another device`

test("each reminder still to ring, the soonest first, with what it's about", () => {
  const rows = reminderRows(chats, "phone", NOW, when, elsewhere)
  assert.deepEqual(rows.map((r) => r.id), ["remind:c1:a1", "remind:c1:n1"])
  const [answer, onNote] = rows
  assert.equal(answer.title, "Four-day week")
  assert.equal(answer.question, "What did the trials find?")
  assert.ok(answer.text!.startsWith("In short: the trials mostly worked"), "the answer's start, as plain text")
  assert.ok(answer.text!.endsWith("…") && answer.text!.length <= 281)
  assert.equal(answer.status, "in 3 h · on another device")
  assert.equal(answer.here, false)
  assert.equal(answer.at, NOW + 3 * H)
  assert.equal(onNote.title, "Why the four-day week works")
  assert.equal(onNote.text, note.content, "a note's text in full")
  assert.equal(onNote.question, undefined)
  assert.equal(onNote.status, "in 20 h")
})

test("a quick action's question shows as its label", () => {
  const m: Entry[] = [{ role: "user", id: "q", content: "Summarize this page in 5–7 bullet points…", label: "Summarize" }, { role: "assistant", id: "a", content: "Short." }]
  assert.deepEqual(reminderText(m, 1), { text: "Short.", question: "Summarize" })
})

test("a new time: set on this device, a page's reminder stays one; the row's chat and key", () => {
  const pageNote: Entry = { ...note, remind: { at: NOW + H, dev: "phone", page: true } }
  const m = withReminderAt([pageNote, chats.c1.m[1]], "n1", NOW + 5 * H, "mac")
  assert.deepEqual(m[0].remind, { page: true, at: NOW + 5 * H, dev: "mac" })
  assert.deepEqual(m[1].remind, { at: NOW + 3 * H, dev: "mac" }, "the others untouched")
  assert.deepEqual(reminderOf({ id: "remind:c1:a1", kind: "remind", title: "", status: "", sortAt: 0 }), { chat: "c1", key: "a1" })
  assert.equal(reminderOf({ id: "watch:w1", kind: "watch", title: "", status: "", sortAt: 0 }), null)
})
