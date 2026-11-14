// 2.7, a page translated in place: whether the pill offers it. The page's text decides when it's clear (`<html lang>` is
// often a template's default); its markup when the text can't tell (Turkish, Dutch) or shares its letters with another
// language (Bulgarian in Cyrillic, Persian in Arabic script). Too few words: no offer.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let pageLanguage: (htmlLang: string, text: string) => string | null
let offerFor: (pageLang: string | null, ui: string, letters: number) => boolean

before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-decide-")), "decide.mjs")
  await build({ entryPoints: [new URL("../src/content/translate/decide.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  ;({ pageLanguage, offerFor } = await import(pathToFileURL(out).href))
})

const DE = "Die Stadt hat am Montag die neue Brücke über den Fluss eröffnet. Sie ist nicht nur für Autos, sondern auch für Radfahrer und die Fußgänger gedacht."
const EN = "The city opened the new bridge over the river on Monday. It is not only for cars, but also for cyclists and people on foot."
const IT = "Il comune ha aperto il nuovo ponte sul fiume lunedì. Non è solo per le auto, ma anche per chi va in bici e per i pedoni che lo usano."
const TR = "Belediye pazartesi günü nehir üzerindeki yeni köprüyü açtı. Köprü sadece arabalar için değil, bisikletliler ve yayalar için de yapıldı."
const ZH = "市政府星期一开通了河上的新桥。这座桥不仅供汽车通行，也供骑自行车的人和行人使用。"
const BG = "Общината откри новия мост над реката в понеделник. Той е не само за коли, но и за велосипедисти и пешеходци."

test("the text decides when it's clear, whatever the markup says", () => {
  assert.equal(pageLanguage("en", DE), "de", "a German page left at the template's lang=en")
  assert.equal(pageLanguage("", IT), "it")
  assert.equal(pageLanguage("de-DE", EN), "en")
  assert.equal(pageLanguage("zh-CN", ZH), "zh")
})

test("the markup decides when the text can't tell, or shares its letters with another language", () => {
  assert.equal(pageLanguage("tr", TR), "tr")
  assert.equal(pageLanguage("bg", BG), "bg")
  assert.equal(pageLanguage("ru", BG), "ru")
  assert.equal(pageLanguage("", TR), null, "neither tells")
  assert.equal(pageLanguage("x-klingon", TR), null)
})

test("offered on a page in another language with enough words; never in the person's own", () => {
  assert.equal(offerFor("de", "ru", 400), true)
  assert.equal(offerFor("ru", "ru", 400), false)
  assert.equal(offerFor("zh", "zh", 400), false, "Traditional Chinese reader on a Simplified page: the same language")
  assert.equal(offerFor("de", "ru", 40), false, "a sign-in form, a gallery")
  assert.equal(offerFor(null, "ru", 4000), false)
})
