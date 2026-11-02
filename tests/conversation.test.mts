import assert from "node:assert/strict"
import { test } from "node:test"

import {
  entriesFrom,
  historyForModel,
  isQuestion,
  lastPage,
  MAX_NOTE_QUOTE,
  MAX_SAVED_PAGE_CHARS,
  otherPages,
  pageRef,
  savedPages,
  selectionNote,
  urlKey,
  WHOLE_CHAT_CHARS,
  pageHasChanged,
  stripCitations,
  textFingerprint,
  trimSavedPages,
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

test("Note by a selection: the quoted text with the page and the comment, a note (no AI, no answer)", () => {
  const page = { url: "https://weekly.example/four-day-week", title: "Four-day week", hash: "abc" }
  const note = selectionNote("  61 companies cut   hours\n\n\n\nby 20%.  ", "  check the pay part  ", page, (text) => `«${text}»`)
  assert.deepEqual(note, { role: "user", content: "«61 companies cut hours\n\nby 20%.»\n\ncheck the pay part", note: true, quote: true, page })
  assert.equal(isQuestion(note), false)
  // Without a comment: just the quote; English quotes by default.
  assert.equal(selectionNote("Burnout fell.", "   ", page).content, "“Burnout fell.”")
  // A long selection is cut.
  const long = selectionNote("word ".repeat(2_000), "", page).content
  assert.ok(long.length <= MAX_NOTE_QUOTE + 3 && long.endsWith("…”"), String(long.length))
  // In the chat it stays out of the questions to the model, and the page link goes with it.
  const chat: Entry[] = [{ role: "user", content: "Summarize", page }, { role: "assistant", content: "Hours fell." }, note]
  assert.deepEqual(historyForModel(chat, page.url).map((m) => m.content), ["Summarize", "Hours fell."])
  assert.deepEqual(lastPage(chat), page)
})

test("pageRef keeps the page's text the first time and when it changed, cut to the limit", () => {
  const first = pageRef([], A.url, A.title, "Article text")
  assert.equal(first.text, "Article text")
  assert.equal(first.hash, textFingerprint("Article text"))
  const chat: Entry[] = [{ role: "user", content: "q", page: first }, { role: "assistant", content: "a" }]
  // The same version again: the chat has it already.
  assert.equal(pageRef(chat, A.url, A.title, "Article text").text, undefined)
  // Changed since: kept again.
  assert.equal(pageRef(chat, A.url, A.title, "Article text, updated").text, "Article text, updated")
  // Private Browsing (or nothing to keep): no text, the fingerprint as before.
  assert.equal(pageRef([], A.url, A.title, "Article text", false).text, undefined)
  assert.equal(pageRef([], A.url, A.title, "   ").text, undefined)
  assert.equal(pageRef([], A.url, A.title, "x".repeat(20_000)).text?.length, MAX_SAVED_PAGE_CHARS)
})

test("savedPages gives each page's latest text, the most recent page first", () => {
  const chat: Entry[] = [
    { role: "user", content: "1", page: { ...A, hash: "1", text: "A old" } },
    { role: "user", content: "2", page: { ...B, hash: "2", text: "B" } },
    { role: "user", content: "3", page: { ...A, hash: "3", text: "A new" } },
    { role: "user", content: "4", page: { ...B, hash: "2" } },
    { role: "user", content: "5" }
  ]
  assert.deepEqual(savedPages(chat), [{ ...A, text: "A new" }, { ...B, text: "B" }])
  assert.deepEqual(savedPages([{ role: "user", content: "q", page: A }]), [])
})

test("trimSavedPages keeps the texts of the last few pages only", () => {
  const page = (n: number, text = `text ${n}`) => ({ url: `https://p.example/${n}`, title: `P${n}`, hash: String(n), text })
  const chat: Entry[] = [1, 2, 3, 4, 5].map((n) => ({ role: "user", content: String(n), page: page(n) }))
  chat.push({ role: "user", content: "again", page: page(1, "text 1 new") })
  const trimmed = trimSavedPages(chat, 4)
  assert.deepEqual(savedPages(trimmed).map((p) => p.text), ["text 1 new", "text 5", "text 4", "text 3"])
  // The first, older copy of page 1 and page 2 lost their text, nothing else changed.
  assert.equal(trimmed[0].page?.text, undefined)
  assert.equal(trimmed[1].page?.text, undefined)
  assert.equal(trimmed[0].page?.hash, "1")
  assert.equal(trimmed.length, chat.length)
  assert.equal(trimSavedPages(chat.slice(0, 2), 4)[0], chat[0])
})
