// 2.7 (selection-quote-111): an earlier question asked on a selection goes to the model with its quote, so a later
// question in the same chat knows what it was about. The question asked now sends its selection as the page.
import { test } from "node:test"
import assert from "node:assert/strict"
import { askedQuoteLine, historyForModel, MAX_HISTORY_QUOTE, selectionCite, type Entry } from "../src/shared/conversation.ts"

const page = { url: "https://a.example/p", title: "A", at: 1 }
const other = { url: "https://b.example/q", title: "B", at: 2 }

test("the second question's request carries the first one's quote", () => {
  const chat: Entry[] = [
    { role: "user", content: "Explain simply", page, cite: selectionCite("Suite consists of   well-integrated tools") },
    { role: "assistant", content: "It means the tools work together." },
    { role: "user", content: "What did I ask about?", page }
  ]
  for (const out of [historyForModel(chat, page.url), historyForModel(chat, page.url, true), historyForModel(chat, page.url, false, true)]) {
    assert.equal(out[0].content, '[Asked about this text the user selected: "Suite consists of well-integrated tools"]\nExplain simply')
    assert.equal(out[2].content, "What did I ask about?")
  }
})

test("the question asked now goes without the line: its selection is the page", () => {
  const chat: Entry[] = [{ role: "user", content: "Explain simply", page, cite: "Selected words" }]
  assert.deepEqual(historyForModel(chat, page.url), [{ role: "user", content: "Explain simply" }])
})

test("asked on another page: both lines, the page first", () => {
  const chat: Entry[] = [
    { role: "user", content: "Summarize", page: other, cite: "Hours fell." },
    { role: "assistant", content: "Fewer hours." },
    { role: "user", content: "And here?", page }
  ]
  assert.equal(historyForModel(chat, page.url)[0].content, '[Asked on another page: "B" — https://b.example/q]\n[Asked about this text the user selected: "Hours fell."]\nSummarize')
})

test("a long quote is cut; notes and older questions don't change", () => {
  const long = selectionCite("word ".repeat(1000))
  const line = askedQuoteLine(long)
  assert.ok(line.length <= MAX_HISTORY_QUOTE + 50)
  assert.ok(line.endsWith('…"]'))
  const chat: Entry[] = [
    { role: "user", content: "“Quoted”\n\nmy words", note: true, quote: true, cite: "Quoted", page },
    { role: "user", content: "Old question", page },
    { role: "assistant", content: "Old answer" },
    { role: "user", content: "Now", page }
  ]
  assert.deepEqual(historyForModel(chat, page.url, true).map((m) => m.content), ["[Note the user wrote]\n“Quoted”\n\nmy words", "Old question", "Old answer", "Now"])
})
