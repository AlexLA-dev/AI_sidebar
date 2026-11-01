import assert from "node:assert/strict"
import { test } from "node:test"

import { findPrompt, historyPrompt, MAX_FIND_RESULTS, parseFindAnswer, sanitizeDigests } from "../src/shared/history.ts"

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
