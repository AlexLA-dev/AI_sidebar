// A question stopped before any of its answer came (2.5 (75), the owner's notes): no empty chat, no question left
// without an answer; its text goes back to the field.
import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import { restoredDraft, withoutStopped } from "../src/content/ux/stopped.ts"

const q = (content: string, extra: Partial<Entry> = {}): Entry => ({ role: "user", content, ...extra })
const a = (content: string): Entry => ({ role: "assistant", content })

test("the stopped question leaves the chat; a chat that only had it is left empty (and is deleted)", () => {
  assert.deepEqual(withoutStopped([q("Why?")]), { kept: [], question: q("Why?") })
  const chat = [q("First"), a("Answer"), q("Stopped")]
  assert.deepEqual(withoutStopped(chat), { kept: [q("First"), a("Answer")], question: q("Stopped") })
})

test("nothing to drop: an answered chat, or a note last", () => {
  const answered = [q("First"), a("Answer")]
  assert.deepEqual(withoutStopped(answered), { kept: answered, question: null })
  const noted = [q("First"), a("Answer"), q("A note", { note: true })]
  assert.deepEqual(withoutStopped(noted), { kept: noted, question: null })
  assert.deepEqual(withoutStopped([]), { kept: [], question: null })
})

test("the question goes back to the field, before anything typed since; a quick action's doesn't", () => {
  assert.equal(restoredDraft(q("Why did revenue hold?"), ""), "Why did revenue hold?")
  assert.equal(restoredDraft(q("Why did revenue hold?"), "and sick days"), "Why did revenue hold?\nand sick days")
  assert.equal(restoredDraft(q("Summarize this page in 5–7 bullet points…", { label: "Summarize" }), ""), null)
})
