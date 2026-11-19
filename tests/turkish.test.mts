// 2.7, the owner: «Добавляй» — Turkish in the panel and the app (ads run in Turkey, people pay there, and the panel's
// buttons were English for them). The panel's strings, the app's catalogs and the project's regions; the words the
// page readers look for (Find similar, page watch, the search field, a conversation, which language a text is in).
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

// @ts-expect-error: a plain .mjs module (the build's own)
import { CATALOG_LANG } from "../scripts/tips-source.mjs"
import { searchNamed } from "../src/content/insert/spot.ts"
import { CONVERSATION_WORDS } from "../src/content/insert/conversation.ts"
import { guessLanguage } from "../src/content/translateTarget.ts"
import { textLanguage } from "../src/shared/share.ts"
import { firstValue, isOutOfStock, monthOf } from "../src/shared/watch/detect.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const locales = join(root, "src/locales")
const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
const tr = JSON.parse(read("src/locales/tr.json")) as Record<string, string>
const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings as Record<string, any>

const PANEL = /\{\d\}/g
const SWIFT = /%(?:\d\$)?(?:lld|ld|d|@|f|%)/g
// Positions written out ("%2$lld … %1$lld", Turkish order) are the same arguments.
const sorted = (s: string, re: RegExp) => (s.match(re) ?? []).map((m) => m.replace(/%\d\$/, "%")).sort()

test("every panel language has every key, Turkish too", () => {
  const files = readdirSync(locales).filter((f) => f.endsWith(".json"))
  assert.ok(files.includes("tr.json"))
  assert.equal(files.length, 15)
  for (const file of files) {
    const own = JSON.parse(readFileSync(join(locales, file), "utf8"))
    assert.deepEqual(Object.keys(own).sort(), Object.keys(en).sort(), file)
    for (const [key, value] of Object.entries(own)) assert.ok(typeof value === "string" && value.trim() !== "", `${file}: ${key}`)
  }
  assert.equal(tr.langCode, "tr")
})

test("placeholders: Turkish keeps every one; the other languages too, but for numbers written as words", () => {
  for (const key of Object.keys(en)) assert.deepEqual(sorted(tr[key], PANEL), sorted(en[key], PANEL), `tr: ${key}`)
  // Never a suffix glued to a placeholder: vowel harmony can't be known («{0}'a»).
  for (const [key, value] of Object.entries(tr)) assert.doesNotMatch(value, /\{\d\}['’]\p{L}/u, `tr: ${key}`)
  // A plural form may say its number as a word (Arabic's one and two); French says "this device" rather than name it.
  const allowed = (file: string, key: string) => /_(one|two|zero)$/.test(key) || (file === "fr.json" && key === "qiPrivacy")
  for (const file of readdirSync(locales).filter((f) => f.endsWith(".json"))) {
    const own = JSON.parse(readFileSync(join(locales, file), "utf8"))
    for (const key of Object.keys(en)) {
      if (allowed(file, key)) continue
      assert.deepEqual(sorted(own[key], PANEL), sorted(en[key], PANEL), `${file}: ${key}`)
    }
  }
})

test("the panel in Turkish: plan names stay Latin, the buttons stay short", () => {
  for (const [key, value] of Object.entries(en)) {
    // The plans keep their names (the director: Pro, Ultra and Own key stay in Latin letters).
    for (const name of ["Pro", "Ultra", "Own key"]) {
      if (new RegExp(`\\b${name}\\b`).test(value)) assert.match(tr[key], new RegExp(`\\b${name}\\b`), `${key}: ${name}`)
    }
  }
  // Short labels (one or two English words, no placeholder): a button, a chip, a tab. Turkish runs longer; these few
  // are as Apple's Turkish says them («Sabitlemeyi Kaldır») or have no shorter natural form, and were looked at on screen.
  const LONG = ["uxUnpin", "uxUnpinAll", "selAsk", "upsellFindName", "findToggle", "renameChat"]
  const long = Object.entries(en)
    .filter(([key, value]) => value.split(" ").length <= 2 && !/\{\d\}/.test(value) && value.length >= 4 && tr[key].length > Math.max(14, value.length * 1.9))
    .map(([key]) => key)
  assert.deepEqual(long.filter((k) => !LONG.includes(k)), [], "a new label much longer than the English: check it fits")
  // Left in English only where English is the word (names).
  const same = Object.keys(en).filter((k) => tr[k] === en[k] && /\p{L}{4,}/u.test(en[k]) && !/^(ContextFlow|Pro|Ultra|Google|Safari|OpenAI|Claude|PDF)\b/.test(en[k]))
  assert.ok(same.length <= 12, `left in English: ${same.slice(0, 20).join(", ")}`)
})

test("the app: a Turkish column in both catalogs, every format kept, the region known", () => {
  assert.equal(CATALOG_LANG.tr, "tr")
  let checked = 0
  for (const [key, entry] of Object.entries(catalog)) {
    const locs = entry.localizations ?? {}
    if (entry.shouldTranslate === false || !locs.ru) continue
    const t = locs.tr
    assert.ok(t, `tr: ${key.slice(0, 60)}`)
    const english = locs.en?.stringUnit?.value ?? key
    if (t.variations) {
      for (const form of ["one", "other"]) {
        const v = t.variations.plural[form].stringUnit
        assert.ok(v.state === "translated" && v.value, `${key}: ${form}`)
        assert.deepEqual(sorted(v.value, SWIFT), sorted(locs.en.variations.plural[form].stringUnit.value, SWIFT), `${key}: ${form}`)
      }
    } else {
      assert.ok(t.stringUnit.state === "translated" && t.stringUnit.value.trim(), key.slice(0, 60))
      assert.deepEqual(sorted(t.stringUnit.value, SWIFT), sorted(english, SWIFT), key.slice(0, 60))
    }
    checked++
  }
  assert.ok(checked > 700)
  const plist = JSON.parse(read("ContextFlow/Shared (App)/InfoPlist.xcstrings")).strings as Record<string, any>
  for (const [key, entry] of Object.entries(plist)) assert.ok(entry.localizations.tr?.stringUnit?.value, key)
  assert.match(read("ContextFlow/ContextFlow.xcodeproj/project.pbxproj"), /knownRegions = \([\s\S]*?\btr,[\s\S]*?\);/)
})

test("the page readers know Turkish: a search field, a conversation, the language, stock, dates", () => {
  assert.equal(searchNamed("Ürün, kategori veya marka ara"), true)
  assert.equal(searchNamed("Aradığınız ürünü yazın"), true)
  // "ara" inside another word is no search.
  for (const hint of ["Parametre", "Paragraf", "Karakter", "Adınız"]) assert.equal(searchNamed(hint), false, hint)
  assert.ok(CONVERSATION_WORDS.tr.includes("mesaj"))
  assert.equal(textLanguage("Bu sayfa ne hakkında? Kısaca özetler misin?"), "tr")
  assert.equal(guessLanguage("Türkiye'de kış ayları yaklaşırken doğalgaz faturaları için yapılan açıklamalar ve ilgili kurumların değerlendirmeleri bu haberde."), "tr")
  assert.equal(isOutOfStock("Tükendi"), true)
  assert.equal(isOutOfStock("Stokta var"), false)
  assert.equal(firstValue("stock", "Fiyat 1.299 TL · Stokta yok"), "Stokta yok")
  assert.equal(firstValue("price", "Sepette 1.299,90 TL"), "1.299,90 TL")
  assert.equal(monthOf("Kasım"), 11)
  assert.equal(monthOf("şub"), 2)
  assert.equal(monthOf("ara"), null)
})
