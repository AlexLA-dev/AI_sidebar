// 2.7 (the director, from the site session): on a device in a language the panel doesn't speak, its strings are
// English, and the quick actions answered in English. They now answer in the person's own language (the first of
// Safari's preferred languages), and Translate goes into it; nothing changes where the panel speaks it, and a question
// the person types isn't touched.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-answer-lang-"))
  const src = new URL("../src/content/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${src}answerLanguage.ts"\nexport { translateTarget, languageName } from "${src}translateTarget.ts"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>
const fill = (key: string, arg = "") => en[key].replace("{0}", arg)

// An English panel (the fallback) on devices in languages it doesn't speak: what the quick actions send.
const READERS: Array<{ device: string[]; name: string; text: string; other: string }> = [
  { device: ["pl-PL", "en-US"], name: "Polish (polski)", text: "W tym tygodniu rząd przedstawił nowy projekt ustawy o podatkach. Według ministra to ważny krok, który ma pomóc małym firmom.", other: "Polish" },
  { device: ["nl-NL"], name: "Dutch (Nederlands)", text: "De gemeente heeft besloten om het nieuwe zwembad toch te bouwen. Volgens de wethouder is het een belangrijke stap voor de wijk.", other: "Dutch" },
  { device: ["id-ID", "en"], name: "Indonesian (Indonesia)", text: "Pemerintah mengumumkan bahwa harga bahan bakar akan naik mulai bulan depan. Menurut menteri, keputusan ini diambil untuk menjaga anggaran negara.", other: "Indonesian" },
  { device: ["th-TH"], name: "Thai (ไทย)", text: "รัฐบาลประกาศว่าราคาน้ำมันจะขึ้นตั้งแต่เดือนหน้า รัฐมนตรีกล่าวว่าการตัดสินใจนี้เพื่อรักษางบประมาณของประเทศ", other: "Thai" },
  { device: ["he-IL"], name: "Hebrew (עברית)", text: "הממשלה הודיעה כי מחיר הדלק יעלה החל מהחודש הבא. לדברי השר, ההחלטה נועדה לשמור על תקציב המדינה.", other: "Hebrew" }
]

test("on a device in a language the panel doesn't speak, the quick actions answer in it", () => {
  for (const r of READERS) {
    const reader = lib.answerLanguage("en", r.device)
    assert.equal(reader, r.device[0], r.device[0])
    // Summarize, Key takeaways, Explain, Google and the selection's: the instruction asks for the reader's language.
    for (const [id, key] of [["summarize", "promptSummarize"], ["key_points", "promptKeyPoints"], ["explain", "promptExplain"], ["google", "promptGoogle"], ["sel_summarize", "promptSelSummarize"], ["sel_explain", "promptSelExplain"], ["sel_reply", "promptReply"]]) {
      assert.equal(lib.withAnswerLanguage(id, fill(key), reader), `${fill(key)} Write your answer in ${r.name}.`, `${r.device[0]} ${id}`)
    }
    // Translate the page: into the reader's language, named in the panel's.
    assert.equal(fill("promptTranslate", lib.readerLanguageName(reader, "en", en.languageName)), `Translate the main content of this page into ${r.other}. Keep the structure and headings.`)
    assert.equal(lib.withAnswerLanguage("translate", fill("promptTranslate", r.other), reader), fill("promptTranslate", r.other), "Translate names its target")
    // Improve keeps the text's own language; Find similar has its own.
    assert.equal(lib.withAnswerLanguage("sel_improve", fill("promptSelImprove"), reader), fill("promptSelImprove"))
    // Translate by a selection: text in the reader's language goes into English; other text into the reader's.
    assert.deepEqual(lib.translateTarget(r.text, reader ?? "en", r.device), { code: "en" }, `${r.device[0]}: own text into English`)
    assert.deepEqual(lib.translateTarget("Der Stadtrat hat am Montag die neue Brücke über den Fluss eröffnet, und sie ist nicht nur für Autos.", reader ?? "en", r.device), { code: null }, `${r.device[0]}: German into the reader's`)
  }
})

test("nothing changes where the panel speaks the person's language, or the person reads English first", () => {
  assert.equal(lib.answerLanguage("en", ["en-US", "pl-PL"]), null)
  assert.equal(lib.answerLanguage("ru", ["ru-RU", "en"]), null)
  assert.equal(lib.answerLanguage("zh-Hant", ["zh-TW"]), null)
  assert.equal(lib.answerLanguage("zh-Hans", ["zh-Hans-CN"]), null)
  assert.equal(lib.answerLanguage("pt-BR", ["pt-PT"]), null, "the panel's Portuguese")
  assert.equal(lib.answerLanguage("en", []), null, "nothing known")
  assert.equal(lib.answerLanguage("en", ["*"]), null, "not a language")
  assert.equal(lib.withAnswerLanguage("summarize", fill("promptSummarize"), null), fill("promptSummarize"))
  assert.equal(lib.readerLanguageName(null, "ru", "русский"), "русский")
  // A Russian reader whose first language is Polish: the panel speaks Russian, the answers come in Polish.
  assert.equal(lib.answerLanguage("ru", ["pl-PL", "ru-RU"]), "pl-PL")
  assert.equal(lib.readerLanguageName("pl-PL", "ru", "русский"), "польский")
})

test("the person's languages: Safari's list, else its one language, else the device's", () => {
  assert.deepEqual(lib.preferredLanguages({ languages: ["pl-PL", "en"], language: "pl-PL" }, "pl"), ["pl-PL", "en"])
  assert.deepEqual(lib.preferredLanguages({ languages: [], language: "th-TH" }, "th"), ["th-TH", "th"])
  assert.deepEqual(lib.preferredLanguages({}, "he"), ["he"])
})

test("the panel builds the quick actions' instruction this way; a typed question goes as it is", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /const reader = answerLanguage\(ui, preferredLanguages\(navigator, uiLanguage\(\)\)\)\n\s+const prompt = t\(action\.prompt, action\.arg \?\? readerLanguageName\(reader, ui, t\("languageName"\)\)\)\n\s+ask\(withAnswerLanguage\(action\.id, prompt, reader\)/)
  assert.match(app, /const to = translateTarget\(text, answerLanguage\(ui, preferred\) \?\? ui, preferred\)/)
  assert.equal((app.match(/withAnswerLanguage\(/g) ?? []).length, 1, "only the quick actions")
})
