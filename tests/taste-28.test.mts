// 2.8 (В7.4): Pro's weekly tastes of Ultra in the panel. The owner's idea («Pro gets small weekly tastes of Ultra»): a
// few minutes of Listen and a full Find similar a week, on the server's numbers; a counter with «In Ultra: …» that opens
// the plans on that feature; the taste used up, the plans open with that feature first.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

import { similarMode, similarTaste } from "../src/shared/similar.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const LANGS = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]

let taste: typeof import("../src/content/Taste.tsx")
let plans: { tierLines: (plan: string, facts: unknown, feature?: string) => string[] }
before(async () => {
  ;(globalThis as { chrome?: unknown }).chrome = { i18n: undefined }
  const out = join(mkdtempSync(join(tmpdir(), "cf-taste-")), "taste.mjs")
  const entry = join(dirname(out), "entry.ts")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(entry, `export * from ${JSON.stringify(join(root, "src/content/Taste.tsx"))}\nexport { tierLines } from ${JSON.stringify(join(root, "src/content/Plans.tsx"))}\n`)
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } })
  const mod = await import(pathToFileURL(out).href)
  taste = mod
  plans = mod
})

const week = (used: number, limit: number) => ({ used, limit, period: "week" as const, resetsAt: "2026-11-30T00:00:00.000Z" })
const FACTS = { freeDaily: 5, proWeekly: 375, ultraWeekly: 375, searchProWeekly: 50, speakWeeklySeconds: 1800, similarWeekly: 10, similarLightWeekly: 5, similarProAnswers: 10, watch: { free: 5, byok: 20, pro: 20, ultra: 50 } }

test("a Pro subscriber's taste of the full search makes Find similar full while one is left; Ultra always, others never", () => {
  assert.equal(similarTaste("pro", week(0, 1)), true)
  assert.equal(similarTaste("pro", week(1, 1)), false)
  assert.equal(similarTaste("byok", week(0, 1)), false)
  assert.equal(similarTaste("pro", null), false)
  assert.deepEqual([similarMode("pro", week(0, 1)), similarMode("pro", week(1, 1)), similarMode("pro"), similarMode("ultra"), similarMode("byok", week(0, 1))], ["full", "light", "light", "full", "light"])
})

test("the counter, «In Ultra», and the line on top of the plans when a taste is used", () => {
  const status = { plan: "pro", taste: { speak: week(120, 300), similar: week(0, 1) } } as never
  assert.deepEqual(taste.tasteOf(status, "listen"), week(120, 300))
  assert.equal(taste.tasteOf({ ...(status as object), plan: "ultra" } as never, "listen"), null)
  assert.equal(taste.tasteCount("listen", week(120, 300)), "Listen in Pro: 3 of 5 min left this week")
  assert.equal(taste.tasteCount("similar", week(0, 1)), "Full search in Pro: 1 of 1 left this week")
  assert.equal(taste.ultraLine("listen", FACTS as never), "In Ultra: 30 min a week")
  assert.equal(taste.ultraLine("similar", FACTS as never), "In Ultra: 10 full searches a week")
  assert.match(taste.tasteUsedLead("listen", week(300, 300), "en"), /^This week's 5 minutes of listening in Pro are used up\. They come back on Monday\.$/)
})

test("the plans opened on a feature: Ultra's line for it first, its slide first", () => {
  const ultra = plans.tierLines("ultra", FACTS)
  assert.match(plans.tierLines("ultra", FACTS, "listen")[0], /30 minutes a week/)
  assert.match(plans.tierLines("ultra", FACTS, "similar")[0], /10 searches a week/)
  assert.deepEqual([...plans.tierLines("ultra", FACTS, "similar")].sort(), [...ultra].sort())
  assert.match(read("src/content/Gallery.tsx"), /useState\(start \? SLIDES\.indexOf\(start\) : ultra \? ULTRA_FROM : 0\)/)
})

test("the panel: Listen for Pro with a taste, the full search asked as a taste, the plans on the feature when used", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /allowed: listenAllowed,/)
  assert.match(app, /onUltra: \(used\) => \(used \? openPlans\("ultra", "listen", "listen", tasteUsedLead/)
  assert.match(app, /\.\.\.\(taste \? \{ taste: true \} : \{\}\)/)
  assert.match(app, /if \(code === "LIMIT_REACHED" && taste\) \{[\s\S]{0,300}openPlans\("ultra", "similar", "similar"/)
  assert.match(read("src/content/listen/useListen.tsx"), /if \(!isUltra\(plan\) && left === 0\) \{\s*step\("taste_used"\)\s*return onUltra\(true\)/)
  assert.match(read("src/background/similar.ts"), /\.\.\.\(req\.payload\.taste \? \{ taste: true \} : \{\}\)/)
})

test("every taste text is in every panel language with its placeholders, and in the app's catalog", () => {
  const keys = ["tasteListenLeft", "tasteSimilarLeft", "tasteUltraListen", "tasteUltraSimilar", "tasteListenUsed", "tasteSimilarUsed", "tasteSimilarDone"]
  const en = JSON.parse(read("src/locales/en.json"))
  for (const lang of LANGS) {
    const d = JSON.parse(read(`src/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(d[key], `${lang} ${key}`)
      for (const p of en[key].match(/\{\d\}/g) ?? []) assert.ok(d[key].includes(p), `${lang} ${key} ${p}`)
    }
  }
  const cat = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
  for (const key of ["Listen in Pro: %lld of %lld min left this week", "In Ultra: %lld min a week"]) assert.equal(Object.keys(cat[key].localizations).length, 14, key)
})
