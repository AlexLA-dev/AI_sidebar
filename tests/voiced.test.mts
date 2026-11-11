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

test("listen (app): heard to its end, the server is told at once, so the minutes shown are this listen's (2.6 gate)", async () => {
  const { readFileSync } = await import("node:fs")
  const swift = readFileSync(new URL("../ContextFlow/Shared (App)/Listen.swift", import.meta.url), "utf8")
  // The player's natural end: marked voiced, ended, and what was heard goes to the server before anything else happens
  // (before, it went only once the player was closed: a replay right after showed the first listen's minute gone).
  const end = swift.slice(swift.indexOf("            if fetchedAll {"), swift.indexOf("            } else if let reason = pendingReason {"))
  assert.ok(end.includes("noteVoiced()") && end.includes("finish(.ended)"), "the natural end")
  assert.ok(end.indexOf("keepHeard()") > end.indexOf("finish(.ended)"), "what was heard is kept at the end")
  assert.match(end, /Task \{ await Self\.sendHeard\(\) \}/, "and sent at once")
})
