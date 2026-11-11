// Build 94: Listen's "already voiced" mark. A text's id is the same in the panel and the app (Listen.swift
// VoicedList.id: the expected values below come from it), and the list keeps the newest 400.
import { test } from "node:test"
import assert from "node:assert/strict"

import { listenMark, madeTexts, markClock, voicedId, withMade, withVoiced, VOICED_MAX } from "../src/shared/voiced.ts"

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

test("voiced (98 release): a text made in full is marked with what a replay charges; heard in full, replay is free", () => {
  const a = "ccbb182304b1e2ae", b = "7b5701252049933b"
  // The server's list as it came: bad ids, nothing left or nonsense out; seconds whole, rounded up.
  assert.deepEqual(madeTexts([{ id: a, left: 11.2 }, { id: "nope", left: 3 }, { id: b, left: 0 }, { id: b, left: "4" }, null, 7]), [{ id: a, left: 12 }])
  assert.deepEqual(madeTexts({ id: a, left: 3 }), [])
  // Kept with when; asked again, the seconds follow the server (heard more elsewhere); voiced ones go.
  const one = withMade({}, [{ id: a, left: 12 }, { id: b, left: 5 }], {}, 1000)
  assert.deepEqual(one, { [a]: { left: 12, at: 1000 }, [b]: { left: 5, at: 1000 } })
  const two = withMade(one, [{ id: a, left: 4 }], { [b]: 2000 }, 2000)
  assert.deepEqual(two, { [a]: { left: 4, at: 2000 } })
  // The mark: heard in full wins; made says its seconds; neither, none.
  assert.equal(listenMark(a, {}, two), 4)
  assert.equal(listenMark(a, { [a]: 1 }, two), "free")
  assert.equal(listenMark(b, {}, two), null)
  // As the players show time (the app's ListenScrubber.clock).
  assert.deepEqual([markClock(0), markClock(12), markClock(65.4), markClock(4503)], ["0:00", "0:12", "1:05", "75:03"])
  // The newest VOICED_MAX are kept.
  let list = {}
  for (let i = 0; i < VOICED_MAX + 3; i++) list = withMade(list, [{ id: i.toString(16).padStart(16, "0"), left: 1 }], {}, i)
  assert.equal(Object.keys(list).length, VOICED_MAX)
})

test("voiced (98 release): every language says both marks; the app has the same sentence in each", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const dir = new URL("../src/locales/", import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 14)
  for (const file of files) {
    const messages = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>
    assert.ok(messages.listenVoiced, file)
    assert.equal((messages.listenMadeLeft.match(/\{0\}/g) ?? []).length, 1, file)
  }
  const catalog = JSON.parse(readFileSync(new URL("../ContextFlow/Shared (App)/Localizable.xcstrings", import.meta.url), "utf8"))
  const made = catalog.strings["Already voiced: only the unheard part is charged, %@"]
  assert.deepEqual(Object.keys(made.localizations).sort(), Object.keys(catalog.strings["Already voiced: replay is free"].localizations).sort())
  for (const [lang, value] of Object.entries(made.localizations) as Array<[string, { stringUnit: { value: string } }]>) {
    assert.equal((value.stringUnit.value.match(/%@/g) ?? []).length, 1, lang)
  }
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
