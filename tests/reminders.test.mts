import { test } from "node:test"
import assert from "node:assert/strict"

import { reminderNotice, reminderText } from "../src/shared/reminders.ts"

test("a reminder's text has no Markdown, tables, list signs or citations", () => {
  assert.equal(reminderText("**In short:** a four-day week [2](https://x.example/a).\n\n- **61** companies\n- 56 stayed"), "In short: a four-day week. 61 companies 56 stayed")
  assert.equal(reminderText("Key takeaways\n\n| Metric | Result |\n|---|---|\n| Companies | 56 of 61 |"), "Key takeaways Metric Result Companies 56 of 61")
  assert.equal(reminderText("x".repeat(300)).length, 160)
})

test("a page reminder says Check: <the quote> under the page's title and opens the page", () => {
  const note = { role: "user" as const, content: "«Revenue rose 1.4%»\n\nlook again on Friday", note: true, quote: true, page: { url: "https://shop.example/p", title: "Lamp" }, remind: { at: 1, page: true as const } }
  assert.deepEqual(reminderNotice(note, "Chat", (q) => `Check: ${q}`), { title: "Lamp", body: "Check: Revenue rose 1.4%", url: "https://shop.example/p" })
  const answer = { role: "assistant" as const, content: "**Fewer meetings** came first.", remind: { at: 1 } }
  assert.deepEqual(reminderNotice(answer, "Four-day week", (q) => q), { title: "Four-day week", body: "Fewer meetings came first." })
})
