// Build 94: Listen's "already voiced" mark. A text's id is the same in the panel and the app (Listen.swift
// VoicedList.id: the expected values below come from it), and the list keeps the newest 400.
import { test } from "node:test"
import assert from "node:assert/strict"

import { voicedId, withVoiced, VOICED_MAX } from "../src/shared/voiced.ts"

test("voiced: the panel's id is the app's, for any text (Cyrillic, emoji, a table, past 24,000 units)", () => {
  const long = "Ab😀ё".repeat(7000)
  assert.equal(voicedId("answer", ""), "9612781775f47dee")
  assert.equal(voicedId("answer", "Hello"), "ccbb182304b1e2ae")
  assert.equal(voicedId("page", "Hello"), "7b5701252049933b")
  assert.equal(voicedId("answer", "Привет, **мир**! 😀 — «кавычки»\n| a | b |"), "c61d01fb71002854")
  assert.equal(voicedId("answer", long), "33a824763ed56edf")
  // Only the first 24,000 units count: what the panel hands to the app.
  assert.equal(voicedId("answer", long + "more"), voicedId("answer", long))
  assert.match(voicedId("answer", "x"), /^[0-9a-f]{16}$/)
})

test("voiced: the list takes new ids only, leaves out anything else, and keeps the newest 400", () => {
  const one = withVoiced({}, ["ccbb182304b1e2ae", "nope", "CCBB182304B1E2AE"], 1000)
  assert.deepEqual(one, { ccbb182304b1e2ae: 1000 })
  // Marked again later: it keeps its first time.
  assert.deepEqual(withVoiced(one, ["ccbb182304b1e2ae"], 2000), one)
  let list: Record<string, number> = {}
  for (let i = 0; i < VOICED_MAX + 5; i++) list = withVoiced(list, [i.toString(16).padStart(16, "0")], i)
  assert.equal(Object.keys(list).length, VOICED_MAX)
  assert.equal(list["0000000000000000"], undefined)
  assert.equal(list[(VOICED_MAX + 4).toString(16).padStart(16, "0")], VOICED_MAX + 4)
})
