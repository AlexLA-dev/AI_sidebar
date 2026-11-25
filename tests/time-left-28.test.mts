// 2.8 (the director's acceptance 3): «5 new free answers at 2:00 AM, in 1 h» was shown with 1 h 40 and 1 h 25 left: the
// hours were cut down. Under 3 hours the limit card now says hours and minutes, past that the nearest hour; in every language.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let i18n: Record<string, (...args: any[]) => any>
before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-time-left-")), "i18n.mjs")
  await build({ entryPoints: [join(root, "src/shared/i18n.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" })
  i18n = await import(pathToFileURL(out).href)
})

const MIN = 60_000
// The words as read (the spaces are non-breaking: a number stays with its unit).
const spaced = (ms: number) => (i18n.timeLeft(ms) as string).replace(/\u00a0/g, " ")

test("under an hour: minutes, never 0", () => {
  assert.equal(spaced(0), "1 min")
  assert.equal(spaced(20_000), "1 min")
  assert.equal(spaced(40 * MIN), "40 min")
  assert.equal(spaced(59 * MIN + 1), "1 h")
})

test("under 3 hours: hours and minutes (the cases seen: 1 h 40 and 1 h 25 left)", () => {
  assert.equal(spaced(100 * MIN), "1 h 40 min")
  assert.equal(spaced(85 * MIN), "1 h 25 min")
  assert.equal(spaced(84 * MIN + 30_000), "1 h 25 min")
  assert.equal(spaced(120 * MIN), "2 h")
  assert.equal(spaced(179 * MIN), "2 h 59 min")
})

test("3 hours and more: the nearest hour, not cut down", () => {
  assert.equal(spaced(180 * MIN), "3 h")
  assert.equal(spaced(16 * 60 * MIN + 40 * MIN), "17 h")
  assert.equal(spaced(16 * 60 * MIN + 20 * MIN), "16 h")
  assert.equal(spaced(24 * 60 * MIN), "24 h")
})

test("hours and minutes are in all 15 languages, with both numbers", () => {
  const dir = join(root, "src/locales")
  const langs = readdirSync(dir).filter((f) => f.endsWith(".json"))
  assert.equal(langs.length, 15)
  for (const f of langs) {
    const text = JSON.parse(readFileSync(join(dir, f), "utf8")).hoursMinutes as string
    assert.ok(text?.includes("{0}") && text.includes("{1}"), `${f}: ${text}`)
  }
})

test("the limit card's «in …» goes through it", () => {
  const app = readFileSync(join(root, "src/content/App.tsx"), "utf8")
  assert.match(app, /function timeUntil[\s\S]{0,120}return timeLeft\(/)
})

test("a time ending in an abbreviation's point gets one point at the sentence's end (de «40 Min.», 2.8 Р19)", () => {
  const de = JSON.parse(readFileSync(join(root, "src/locales/de.json"), "utf8")) as Record<string, string>
  const g = globalThis as { chrome?: unknown }
  const was = g.chrome
  g.chrome = { i18n: { getMessage: (key: string) => de[key] ?? "", getUILanguage: () => "de" } }
  try {
    const line = i18n.freeAnswersBack(5, "11:47", i18n.timeLeft(100 * MIN), "de") as string
    assert.match(line, /40\u00a0Min\.$/)
    assert.doesNotMatch(line, /\.\./)
  } finally {
    g.chrome = was
  }
})

test("a number stays on one line with its unit (the director on #263: «через 16» and «ч.» alone on the next line)", () => {
  assert.equal(i18n.timeLeft(16 * 60 * MIN), "16\u00a0h")
  assert.equal(i18n.timeLeft(100 * MIN), "1\u00a0h\u00a040\u00a0min")
  const line = i18n.freeAnswersBack(5, "2:00 AM", i18n.timeLeft(16 * 60 * MIN)) as string
  assert.equal(line, "5 new free answers at 2:00\u00a0AM, in 16\u00a0h.")
})
