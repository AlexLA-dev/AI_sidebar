import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import { answerShareText, chatShareText, toPlainText } from "../src/shared/share.ts"

const labels = { you: "You", sources: "Sources", source: "Source", madeWith: "Made with ContextFlow" }
const page = { url: "https://news.example/a", title: "Article A" }
const entries: Entry[] = [
  { role: "user", content: "What is this about?", page },
  { role: "assistant", content: "**New rules** start in May. See [the docs](https://docs.example/rules) for details [1](https://docs.example/rules)." },
  { role: "user", content: "Search Google for more", label: "Google", mode: "google", page },
  {
    role: "assistant",
    content: "Reactions were mixed [1](https://s1.example/x).",
    grounding: { sources: [{ title: "Paper One", url: "https://s1.example/x" }, { title: "", url: "https://s2.example/y" }], suggestions: "", queries: ["q"] }
  }
]

test("toPlainText keeps links as text and drops citation numbers", () => {
  assert.equal(toPlainText("See [the docs](https://d.example) and [https://e.example](https://e.example) [2](https://d.example)."), "See the docs: https://d.example and https://e.example.")
  assert.equal(toPlainText("## Title\n- **one**\n- `two`"), "Title\n• one\n• two")
})

test("a shared chat is text with its links, Google sources and pages; the app link goes separately", () => {
  assert.equal(chatShareText(entries, labels, "https://other.example"), [
    "You: What is this about?",
    "ContextFlow: New rules start in May. See the docs: https://docs.example/rules for details.",
    "",
    "You: Google",
    "ContextFlow: Reactions were mixed.",
    "",
    "Sources:",
    "• Paper One — https://s1.example/x",
    "• https://s2.example/y",
    "",
    "Source:",
    "Article A — https://news.example/a",
    "Made with ContextFlow"
  ].join("\n"))
  assert.ok(!chatShareText(entries, labels, "").includes("apps.apple.com"))
})

test("a shared answer names its own page", () => {
  assert.equal(answerShareText(entries, 1, labels, "https://other.example"), [
    "New rules start in May. See the docs: https://docs.example/rules for details.",
    "",
    "Source: https://news.example/a",
    "Made with ContextFlow"
  ].join("\n"))
  assert.match(answerShareText([{ role: "assistant", content: "Hi" }], 0, labels, "https://here.example"), /Source: https:\/\/here\.example/)
})
