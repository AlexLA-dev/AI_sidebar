import assert from "node:assert/strict"
import { test } from "node:test"

import {
  entriesFrom,
  historyForModel,
  isQuestion,
  lastPage,
  otherPages,
  urlKey,
  WHOLE_CHAT_CHARS,
  pageHasChanged,
  stripCitations,
  textFingerprint,
  type Entry
} from "../src/shared/conversation.ts"

const A = { url: "https://news.example/a", title: "Article A" }
const B = { url: "https://blog.example/b", title: "Post B" }

test("textFingerprint is stable and notices changed text", () => {
  assert.equal(textFingerprint("Hello world"), textFingerprint("Hello world"))
  assert.notEqual(textFingerprint("Hello world"), textFingerprint("Hello world!"))
  assert.match(textFingerprint(""), /^[0-9a-f]{8}$/)
})

test("pageHasChanged compares with the last question asked on the same page", () => {
  const entries: Entry[] = [
    { role: "user", content: "Summarize", page: { ...A, hash: "aaaa0001" } },
    { role: "assistant", content: "…" },
    { role: "user", content: "And this?", page: { ...B, hash: "bbbb0001" } },
    { role: "assistant", content: "…" }
  ]
  assert.equal(pageHasChanged(entries, A.url, "aaaa0001"), false)
  assert.equal(pageHasChanged(entries, A.url, "aaaa0002"), true)
  assert.equal(pageHasChanged(entries, "https://new.example/c", "cccc0001"), false)
  assert.deepEqual(lastPage(entries), { ...B, hash: "bbbb0001" })
  assert.equal(lastPage([]), undefined)
})

test("historyForModel marks questions from other pages and strips citations", () => {
  const entries: Entry[] = [
    { role: "user", content: "Summarize", label: "Summarize", page: A },
    { role: "assistant", content: "Revenue held steady.[1](https://vertexaisearch.cloud.google.com/grounding-api-redirect/x)" },
    { role: "user", content: "How does this compare?", page: B }
  ]
  assert.deepEqual(historyForModel(entries, B.url), [
    { role: "user", content: `[Asked on another page: "Article A" — ${A.url}]\nSummarize` },
    { role: "assistant", content: "Revenue held steady." },
    { role: "user", content: "How does this compare?" }
  ])
  // Turns without a page (older chats) and turns on the current page stay as they are.
  assert.deepEqual(historyForModel([{ role: "user", content: "Hi" }], A.url), [{ role: "user", content: "Hi" }])
})

test("historyForModel keeps the last 12 turns", () => {
  const entries: Entry[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }) as Entry)
  const out = historyForModel(entries, A.url)
  assert.equal(out.length, 12)
  assert.equal(out[0].content, "m18")
  assert.equal(stripCitations("a[2](https://x.y/z) b"), "a b")
})

test("entriesFrom accepts only conversations", () => {
  assert.deepEqual(entriesFrom([{ role: "user", content: "q" }]), [{ role: "user", content: "q" }])
  assert.deepEqual(entriesFrom([]), [])
  assert.equal(entriesFrom({}), null)
  assert.equal(entriesFrom([{ role: "system", content: "x" }]), null)
  assert.equal(entriesFrom([{ role: "user" }]), null)
  assert.equal(entriesFrom([null]), null)
})

test("notes stay out of the model's history unless the whole chat is asked for", () => {
  const a = { url: "https://a.example/x", title: "A" }
  const b = { url: "https://b.example/y", title: "B" }
  const chat: Entry[] = [
    { role: "user", content: "Remember the second chart", note: true, page: a },
    { role: "user", content: "What is this?", page: a },
    { role: "assistant", content: "An article." },
    { role: "user", content: "Compare with yesterday's", note: true, page: b },
    { role: "user", content: "And here?", page: b }
  ]
  assert.deepEqual(historyForModel(chat, b.url).map((m) => m.content), ["[Asked on another page: \"A\" — https://a.example/x]\nWhat is this?", "An article.", "And here?"])
  assert.deepEqual(historyForModel(chat, b.url, true).map((m) => m.content), [
    "[Note the user wrote on another page: \"A\" — https://a.example/x]\nRemember the second chart",
    "[Asked on another page: \"A\" — https://a.example/x]\nWhat is this?",
    "An article.",
    "[Note the user wrote]\nCompare with yesterday's",
    "And here?"
  ])
  assert.equal(isQuestion(chat[0]), false)
  assert.equal(isQuestion(chat[1]), true)
  assert.equal(isQuestion(chat[2]), false)
  assert.deepEqual(otherPages(chat, b.url), [a])
})

test("the whole chat keeps the newest messages within its budget", () => {
  const big = "x".repeat(WHOLE_CHAT_CHARS / 4)
  const chat: Entry[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${big}` }) as Entry)
  const history = historyForModel(chat, "https://a.example", true)
  assert.ok(history.length < 10 && history.length >= 3)
  assert.ok(history[history.length - 1].content.startsWith("9 "))
})

test("urlKey drops the hash and tracking parameters", () => {
  assert.equal(urlKey("https://a.example/p?id=2&utm_source=x#top"), "https://a.example/p?id=2")
  assert.equal(urlKey("not a url"), "not a url")
})
