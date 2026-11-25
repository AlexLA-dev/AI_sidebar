// What's New and Tips for 2.8 (the director, tracker А11, Д3.9, Д3.10, Д4.6): the agent, then cookie windows — the
// texts the director approved in English and Russian, the other 13 languages translated the site-i18n way.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// @ts-expect-error: a plain .mjs module (the build's own)
import { CATALOG_LANG, tipsData } from "../scripts/tips-source.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (p: string) => readFileSync(join(root, p), "utf8")
const data = tipsData(root) as any
const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
const card = (title: string) => data.groups.flatMap((g: any) => g.tips.map((t: any) => ({ ...t, block: g.id }))).find((t: any) => t.title.en === title)
const AGENT = "It books for you, right on the page"
const COOKIES = "Cookie windows close themselves"

test("What's new 2.8: the agent first, then cookie windows; their cards in Tips where their readers look", () => {
  assert.match(read("ContextFlow/Shared (App)/WhatsNew.swift"), /static let version = "2\.8"[\s\S]*\[TipGroup\.agentTip, TipGroup\.cookiesTip\]/)
  assert.equal(card(AGENT).block, "deeper-work")
  assert.ok(card(AGENT).pro && card(AGENT).since === "2.8")
  assert.equal(card(COOKIES).block, "privacy-and-personalization")
  assert.ok(!card(COOKIES).pro && card(COOKIES).since === "2.8")
  // The owner's limits: never paying or signing in; tables, stays, visits; no prices; a tap on iPhone and iPad, a click on a Mac.
  assert.match(card(AGENT).text.en, /^Need a table or a stay booked, or a visit to a doctor or a stylist\?.*Paying and signing in stay yours, and Stop is always there\. With Pro or Ultra\.$/)
  for (const c of [card(AGENT), card(COOKIES)]) {
    assert.doesNotMatch(c.text.en + c.mac.text.en, /[$€£¥₽]/)
    assert.match(c.text.en, /\btap/i)
    assert.doesNotMatch(c.mac.text.en, /\btap/i)
  }
})

test("every language: the cards' words, the panel's own names for Do, My details, Stop and Cookie windows", () => {
  const ext: Record<string, string> = Object.fromEntries(Object.entries(CATALOG_LANG).map(([file, code]) => [code as string, file]))
  for (const c of [card(AGENT), card(COOKIES)]) {
    for (const text of [c.title.en, c.text.en, c.mac.text.en]) {
      for (const code of Object.values(CATALOG_LANG) as string[]) {
        const unit = catalog[text]?.localizations?.[code]?.stringUnit
        assert.ok(unit?.state === "translated" && unit.value.trim() && unit.value !== text, `${code}: ${text.slice(0, 30)}`)
        assert.ok(!/\b(the|and|you|your|with)\b/.test(unit.value), `${code}: English left`)
      }
    }
  }
  for (const [code, file] of Object.entries(ext)) {
    const own = JSON.parse(read(`src/locales/${file}.json`))
    const v = (en: string) => catalog[en].localizations[code].stringUnit.value as string
    assert.ok(v(card(COOKIES).text.en).includes(own.setSecCookies), `${code}: Cookie windows`)
    assert.ok(v(card(AGENT).text.en).includes(own.agentMode), `${code}: Do`)
    assert.ok(v(card(AGENT).text.en).includes(own.stop), `${code}: Stop`)
    // (Russian bends «Мои данные» in «из «Моих данных»», the director's own text.)
    if (code !== "ru") assert.ok(v(card(AGENT).text.en).includes(own.fdTitle), `${code}: My details`)
  }
})

test("/features in every language: the two cards with the app's titles, in the page's language", () => {
  const folders = ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-br", "ru", "tr", "uk", "vi", "zh-hans", "zh-hant"]
  const codes: Record<string, string> = { "pt-br": "pt-BR", "zh-hans": "zh-Hans", "zh-hant": "zh-Hant" }
  assert.ok(read("site/features.html").includes(`<h3>${AGENT} <span class="pro-badge">Pro</span></h3>`))
  for (const folder of folders) {
    const page = read(`site/${folder}/features.html`)
    const code = codes[folder] ?? folder
    assert.ok(page.includes(`<h3>${catalog[AGENT].localizations[code].stringUnit.value} <span class="pro-badge">Pro</span></h3>`), `${folder}: agent`)
    assert.ok(page.includes(`<h3>${catalog[COOKIES].localizations[code].stringUnit.value}</h3>`), `${folder}: cookies`)
    assert.ok(!page.includes(AGENT) && !page.includes("Tired of cookie windows"), `${folder}: no English`)
  }
})
