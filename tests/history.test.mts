import assert from "node:assert/strict"
import { test } from "node:test"

import { findPrompt, historyPrompt, MAX_FIND_RESULTS, parseFindAnswer, sanitizeDigests } from "../src/shared/history.ts"
import { chatDigests, threadForCloud, threadFromCloud, type Thread } from "../src/shared/threads.ts"

const page = { url: "https://news.example/a", title: "Article A" }
const thread = (id: string, at: number, extra: Partial<Thread> = {}): Thread => ({
  id, u: at, a: at,
  m: [{ role: "user", content: `Question ${id}`, page }, { role: "assistant", content: `Answer ${id} [1](https://s.example) ${"x".repeat(900)}` }, { role: "user", content: `My note ${id}`, note: true }],
  ...extra
})

test("chatDigests: newest first, pages, Q/A/notes, citations stripped, answers and chats cut, total kept", () => {
  const threads = [thread("old", 1), thread("new", 3), thread("hist", 2, { kind: "history" }), { id: "gone", u: 4, m: [], deleted: true } as Thread]
  const out = chatDigests(threads, { perChat: 600, perAnswer: 200, total: 10_000 })
  assert.deepEqual(out.map((d) => d.id), ["new", "old"], "the history chat and deleted chats are left out")
  const [d] = out
  assert.match(d.text, /^Pages: Article A \(https:\/\/news\.example\/a\)\nQ: Question new\nA: Answer new +x+…\nNote: My note new$/)
  assert.doesNotMatch(d.text, /\[1\]|https:\/\/s\.example/)
  assert.ok(d.text.length <= 600)
  assert.equal(d.date, new Date(3).toISOString())
  const small = chatDigests(threads, { perChat: 600, perAnswer: 200, total: 300 })
  assert.equal(small.length, 1)
  assert.ok(small[0].text.length <= 300)
})

test("the history kind survives iCloud (and old copies without it stay ordinary chats)", () => {
  const back = threadFromCloud(threadForCloud(thread("h", 5, { kind: "history" })))
  assert.equal(back?.kind, "history")
  assert.equal(threadFromCloud(threadForCloud(thread("n", 5)))?.kind, undefined)
})

test("sanitizeDigests caps chats and characters and drops malformed items", () => {
  const raw = [{ id: "a", title: "A", date: "d", text: "x".repeat(50) }, { id: 5, text: "bad" }, { id: "b", text: "  " }, { id: "c", text: "y".repeat(50) }, "nope"]
  const out = sanitizeDigests(raw, 10, 70)
  assert.deepEqual(out.map((c) => [c.id, c.text.length]), [["a", 50], ["c", 20]])
  assert.equal(sanitizeDigests("nope", 10, 70).length, 0)
  assert.equal(sanitizeDigests(Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, text: "t" })), 5, 1000).length, 5)
})

test("parseFindAnswer keeps known ids once, tolerates prose around the JSON, caps results", () => {
  const ids = new Set(["a", "b"])
  assert.deepEqual(parseFindAnswer('Sure! {"results":[{"id":"b","why":"coffee"},{"id":"x"},{"id":"b"},{"id":"a"}]} done', ids), [{ id: "b", why: "coffee" }, { id: "a", why: "" }])
  assert.deepEqual(parseFindAnswer("not json", ids), [])
  assert.deepEqual(parseFindAnswer('{"results":"no"}', ids), [])
  const many = new Set(Array.from({ length: 20 }, (_, i) => `${i}`))
  assert.equal(parseFindAnswer(JSON.stringify({ results: [...many].map((id) => ({ id })) }), many).length, MAX_FIND_RESULTS)
})

test("prompts carry the chats as data with their ids", () => {
  const chats = [{ id: "a1", title: "Sleep", date: "2026-10-01", text: "Q: coffee?" }]
  assert.match(findPrompt(chats, "ru-RU"), /<<<CHAT 1 id=a1\nTitle: Sleep/)
  assert.match(findPrompt(chats, "ru-RU"), /JSON only/)
  assert.match(historyPrompt(chats, "", "en"), /Answer only from these chats/)
  assert.match(historyPrompt([], "", "en"), /no chats yet/)
})
