import assert from "node:assert/strict"
import { test } from "node:test"

import {
  entriesFrom,
  historyForModel,
  lastPage,
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
