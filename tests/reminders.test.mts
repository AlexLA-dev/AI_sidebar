import { test } from "node:test"
import assert from "node:assert/strict"

import { reminderNotice, reminderText } from "../src/shared/reminders.ts"

test("a reminder's text has no Markdown, tables, list signs or citations", () => {
  assert.equal(reminderText("**In short:** a four-day week [2](https://x.example/a).\n\n- **61** companies\n- 56 stayed"), "In short: a four-day week. 61 companies 56 stayed")
  assert.equal(reminderText("Key takeaways\n\n| Metric | Result |\n|---|---|\n| Companies | 56 of 61 |"), "Key takeaways Metric Result Companies 56 of 61")
  assert.equal(reminderText("x".repeat(300)).length, 160)
})

test("a reminder on a note made on a page is titled with the page; on an answer, with the chat", () => {
  const note = { role: "user" as const, content: "«Revenue rose 1.4%»\n\nlook again on Friday", note: true, quote: true, page: { url: "https://shop.example/p", title: "Lamp" }, remind: { at: 1 } }
  assert.deepEqual(reminderNotice(note, "Chat"), { title: "Lamp", body: "«Revenue rose 1.4%» look again on Friday" })
  const answer = { role: "assistant" as const, content: "**Fewer meetings** came first.", remind: { at: 1 } }
  assert.deepEqual(reminderNotice(answer, "Four-day week"), { title: "Four-day week", body: "Fewer meetings came first." })
})

test("a page reminder (the bell by a selection) says the note under the page's title and opens the page", () => {
  const page = { role: "user" as const, content: "«Revenue rose 1.4%»", note: true, quote: true, page: { url: "https://shop.example/p", title: "" }, remind: { at: 1, page: true as const } }
  assert.deepEqual(reminderNotice(page, "Chat"), { title: "https://shop.example/p", body: "«Revenue rose 1.4%»", url: "https://shop.example/p" })
  const odd = { ...page, page: { url: "javascript:alert(1)", title: "x" } }
  assert.equal(reminderNotice(odd, "Chat").url, undefined)
})

test("the notification's body says it was asked for (2.5): \"You asked to be reminded: …\"", () => {
  const answer = { role: "assistant" as const, content: "**Fewer meetings** came first.", remind: { at: 1 } }
  assert.equal(reminderNotice(answer, "Four-day week", (t) => `You asked to be reminded: ${t}`).body, "You asked to be reminded: Fewer meetings came first.")
})
