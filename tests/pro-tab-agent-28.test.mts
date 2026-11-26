// 2.8 (the director): the app's Pro tab didn't name the agent, the release's main feature (Pro and Ultra only). One line
// first in «Everything in Pro» and a first «What you get» slide, in the approved What's New words (no new claims, no
// numbers); the Pro box keeps its three lines, so it's no taller on iPhone. In every app language.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const APP_LANGS = ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-BR", "ru", "tr", "uk", "vi", "zh-Hans", "zh-Hant"]
const PANEL: Record<string, string> = { "pt-BR": "pt_BR", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW" }

const TITLE = "It books for you, right on the page"
const LINE = "ContextFlow picks the time, fills in your name and contacts from My details and books. Paying and signing in stay yours, and Stop is always there."
const REQUEST = "a table for two tomorrow at 7 pm"

test("«Everything in Pro» names the agent first; the Pro box keeps its three lines", () => {
  const view = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(view, /Text\("Everything in Pro"\)\.font\(\.headline\)\s*\/\/[^\n]*\n\s*Feature\(systemImage: "calendar\.badge\.checkmark", text: "It books for you, right on the page"\)/)
  const pro = view.match(/case \.pro:\s*return \[([\s\S]*?)\]/)![1]
  assert.equal((pro.match(/\("/g) ?? []).length, 3)
})

test("«What you get» opens on the agent: its title, the approved two sentences, the request as said in Do", () => {
  const gallery = read("ContextFlow/Shared (App)/PaidGallery.swift")
  assert.match(gallery, /case agent, media, search, organize, templates, watch, answers, listen, similar, watchMore/)
  assert.ok(gallery.includes(`case .agent: return Text("${TITLE}")`))
  assert.ok(gallery.includes(`case .agent: return Text("${LINE}")`))
  assert.ok(gallery.includes(`Text("${REQUEST}")`))
  assert.match(gallery, /chip\("sparkles", Text\("Do"\)\)\s*chip\("person\.text\.rectangle", Text\("My details"\)\)/)
  // No numbers about the agent (its daily limits aren't shown on the plans).
  assert.doesNotMatch(gallery.match(/private var agent: some View \{[\s\S]*?\n    \}\n/)![0], /facts\.|agentDaily|\d+ (tasks|a day)/)
})

test("every app language: the title, the line, the request and «Do», translated; «Do» and «My details» are the panel's words", () => {
  const strings = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
  for (const key of [TITLE, LINE, REQUEST, "Do", "My details"]) {
    const locs = strings[key]?.localizations ?? {}
    for (const lang of APP_LANGS) {
      const value = locs[lang]?.stringUnit?.value
      assert.ok(value?.trim(), `${lang}: ${key}`)
      assert.notEqual(value, key, `${lang}: ${key} untranslated`)
    }
  }
  for (const lang of APP_LANGS) {
    const panel = JSON.parse(read(`src/locales/${PANEL[lang] ?? lang}.json`))
    assert.equal(strings.Do.localizations[lang].stringUnit.value, panel.agentMode, lang)
    assert.equal(strings["My details"].localizations[lang].stringUnit.value, panel.fdTitle, lang)
    assert.match(strings[LINE].localizations[lang].stringUnit.value, /ContextFlow/, lang)
  }
})
