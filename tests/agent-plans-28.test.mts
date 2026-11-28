// 2.8 (the director, after #272): the panel's plans sheet mirrors the app's Pro tab again (the agent's slide first, the
// same title and two sentences in every language), and the agent asked for without Pro gets the plans message the other
// Pro features get (Monthly first, the same buttons and route into the purchase), counted in chat_plans via "agent",
// with its help one link away.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const LANGS: Record<string, string> = { ar: "ar", de: "de", es: "es", fr: "fr", it: "it", ja: "ja", ko: "ko", "pt-BR": "pt_BR", ru: "ru", tr: "tr", uk: "uk", vi: "vi", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW" }

test("the panel's gallery opens on the agent, as the app's does: the same title, line and request in every language", () => {
  const gallery = read("src/content/Gallery.tsx")
  assert.match(gallery, /const SLIDES: Slide\[\] = \["agent", "media", "search", "organize", "templates", "watch", "answers", "listen", "similar", "watchMore"\]/)
  assert.match(gallery, /agent: t\("gAgentTitle"\)/)
  assert.match(gallery, /agent: t\("gAgentLine"\)/)
  assert.match(gallery, /case "agent":[\s\S]{0,300}t\("gAgentRequest"\)[\s\S]{0,200}t\("agentMode"\)[\s\S]{0,100}t\("fdTitle"\)/)
  // The app's slides in the same order.
  assert.match(read("ContextFlow/Shared (App)/PaidGallery.swift"), /case agent, media, search, organize, templates, watch, answers, listen, similar, watchMore/)
  const app = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
  const en = JSON.parse(read("src/locales/en.json"))
  const pairs = { gAgentTitle: en.gAgentTitle, gAgentLine: en.gAgentLine, gAgentRequest: en.gAgentRequest }
  assert.equal(en.gAgentTitle, "It books for you, right on the page")
  for (const [key, appKey] of Object.entries(pairs)) {
    assert.ok(app[appKey], `the app has «${appKey}»`)
    for (const [xc, lang] of Object.entries(LANGS)) {
      const panel = JSON.parse(read(`src/locales/${lang}.json`))[key]
      assert.equal(panel, app[appKey].localizations[xc].stringUnit.value, `${lang} ${key}`)
    }
  }
})

test("the agent without Pro: the plans message (place agent), its help one link away; every way in leads there", () => {
  const app = read("src/content/App.tsx")
  const from = app.indexOf("{agentUpsell && agentSells && (")
  assert.ok(from >= 0)
  const block = app.slice(from).match(/^\{agentUpsell && agentSells && \(\s*<PlanOffer[\s\S]*?\n\s*\/>\s*\n\s*\)\}/)![0]
  assert.match(block, /place="agent"/)
  assert.match(block, /title=\{t\("gAgentTitle"\)\}/)
  assert.match(block, /body=\{t\("agentProOnly"\)\}/)
  assert.match(block, /onChoose=\{\(choice\) => \{ setAgentUpsell\(false\); choosePlan\(choice\) \}\}/)
  assert.match(block, /onEvent=\{offerEvent\("agent"\)\}/)
  assert.match(block, /t\("agentHelpLink"\)/)
  assert.doesNotMatch(block, /openApp\("subscribe"\)/)
  // The chip, Do in «+», the quick chip and the server's PRO_ONLY all open it.
  assert.equal((app.match(/setAgentUpsell\(true\)/g) ?? []).length, 4)
  assert.match(read("src/content/ux/PlanOffer.tsx"), /export type OfferPlace = "limit" \| "memory" \| "pro_only" \| "ultra_only" \| "agent"/)
  assert.match(read("src/shared/usage.ts"), /chat_plans: \{[\s\S]*?via: \["limit", "memory", "pro_only", "ultra_only", "return", "settings", "agent"\]/)
})
