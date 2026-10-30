import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import { answerShareText, chatLanguage, chatShareText, notALink, textLanguage, toPlainText } from "../src/shared/share.ts"

const labels = { you: "You", sources: "Sources", source: "Source", madeWith: "Made with ContextFlow" }
const page = { url: "https://news.example/a", title: "Article A" }
const app = "https://apps.apple.com/app/id1"
const links = (here: string) => ({ page: here, app })
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

test("a shared chat is one text under its name with its links, Google sources, pages and the app link", () => {
  assert.equal(chatShareText(entries, "Four-day week", labels, links("https://other.example")), [
    "Four-day week",
    "",
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
    "",
    "Made with ContextFlow: https://apps.apple.com/app/id1"
  ].join("\n"))
  assert.match(chatShareText([{ role: "user", content: "Hi" }], "Hi", labels, links("https://here.example")), /Source: https:\/\/here\.example\n\nMade with ContextFlow: https:\/\/apps/)
})

test("a shared answer names its own page", () => {
  assert.equal(answerShareText(entries, 1, labels, links("https://other.example")), [
    "New rules start in May. See the docs: https://docs.example/rules for details.",
    "",
    "Source: https://news.example/a",
    "",
    "Made with ContextFlow: https://apps.apple.com/app/id1"
  ].join("\n"))
  assert.match(answerShareText([{ role: "assistant", content: "Hi" }], 0, labels, links("https://here.example")), /Source: https:\/\/here\.example/)
})

test("the language of typed questions picks the share labels", () => {
  assert.equal(textLanguage("О чём эта статья? https://example.com/a"), "ru")
  assert.equal(textLanguage("Про що ця стаття?"), "uk")
  assert.equal(textLanguage("この記事は何について?"), "ja")
  assert.equal(textLanguage("这篇文章讲什么?"), "zh_CN")
  assert.equal(textLanguage("이 기사는 무엇에 관한 것인가요?"), "ko")
  assert.equal(textLanguage("What is this article about?"), "en")
  assert.equal(textLanguage("Worum geht es in diesem Artikel?"), "de")
  assert.equal(textLanguage("¿De qué trata este artículo?"), "es")
  assert.equal(textLanguage("De quoi parle cet article ?"), "fr")
  assert.equal(textLanguage("Di cosa parla questo articolo?"), "it")
  assert.equal(textLanguage("Sobre o que é este artigo?"), "pt_BR")
  assert.equal(textLanguage("ok"), undefined)
  // Quick actions are in the device's language, so only typed questions count.
  assert.equal(chatLanguage([{ role: "user", content: "Summarize this page", label: "Summarize" }, { role: "assistant", content: "Kurz gesagt" }]), undefined)
  // A mixed chat goes by the language most of it is in.
  assert.equal(chatLanguage([...entries, { role: "user", content: "А дальше?" }]), "en")
  assert.equal(chatLanguage([...entries, { role: "user", content: "А что было дальше и почему?" }]), "ru")
})

test("shared text never parses as a URL (Heptabase would save it as one link)", () => {
  // "You: …" is a URL with the scheme "you" to URL parsers.
  assert.equal(URL.canParse(chatShareText(entries, "", labels, links("https://x.example"))), false)
  assert.ok(chatShareText(entries, "", labels, links("https://x.example")).startsWith("You — What is this about?\n"))
  assert.ok(chatShareText(entries, "Summary: rules", labels, links("https://x.example")).startsWith("Summary — rules\n\nYou: What"))
  assert.equal(URL.canParse(answerShareText([{ role: "assistant", content: "**Summary:** fine" }], 0, labels, links("https://x.example"))), false)
  assert.equal(notALink("Summary: fine"), "Summary — fine")
  assert.equal(notALink("Вы: О чём статья?"), "Вы: О чём статья?")
  assert.equal(notALink("Short answer: yes"), "Short answer: yes")
  assert.equal(notALink("https://example.com is the site"), "https://example.com is the site")
})
