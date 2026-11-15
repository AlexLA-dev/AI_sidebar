// Every translation keeps its English placeholders (2.7, the owner: good translations for everything new). The panel's
// {0} {1} and the app's %@ %lld %1$@ %% are filled in by code, so one lost or added in a translation shows a raw "{1}"
// or drops the number. Feature tests check their own strings; this covers every string in every language.

import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

const root = new URL("../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

const slots = (s: string): string[] => [...(s.match(/\{\d\}/g) ?? [])].sort()

/** Plural forms a language may write without the number ("one card" in a word): Arabic's one and two. */
const PLURAL_WITHOUT_NUMBER = /_(zero|one|two)$/
/** A known choice: French says «cet appareil» rather than naming the device (cet iPhone / ce Mac by gender). */
const KNOWN = new Set(["fr:qiPrivacy"])

test("every panel string in every language has the English placeholders", () => {
  const en = JSON.parse(read("src/locales/en.json")) as Record<string, string>
  const files = readdirSync(new URL("src/locales/", root)).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 15)
  for (const file of files) {
    const lang = file.replace(".json", "")
    const strings = JSON.parse(read(`src/locales/${file}`)) as Record<string, string>
    for (const [key, english] of Object.entries(en)) {
      const value = strings[key]
      assert.ok(typeof value === "string" && value.trim(), `${lang}: ${key} is missing`)
      if (KNOWN.has(`${lang}:${key}`)) continue
      const want = slots(english)
      const got = slots(value)
      if (PLURAL_WITHOUT_NUMBER.test(key) && lang === "ar") {
        for (const slot of got) assert.ok(want.includes(slot), `${lang}: ${key} has ${slot}, the English doesn't`)
        continue
      }
      assert.deepEqual(got, want, `${lang}: ${key} placeholders`)
    }
  }
})

// The app's format specifiers, positions dropped: %1$@ and %@ are the same argument kind.
const specs = (s: string) => (s.match(/%(\d+\$)?(lld|ld|d|@|f|\.\d+f)/g) ?? []).map((m) => m.replace(/\d+\$/, "")).sort()
// A literal percent sign is %% (or Arabic's ٪, which needs no escaping); a lone % would read as a specifier.
const percents = (s: string, lang: string) => (s.match(/%%/g) ?? []).length + (lang === "ar" ? (s.match(/٪/g) ?? []).length : 0)
const lonePercent = (s: string) => /%(?!%|(\d+\$)?(lld|ld|d|@|f|\.\d+f))/.test(s.replace(/%%/g, ""))

type Unit = { stringUnit?: { value?: string }; variations?: { plural?: Record<string, Unit> } }

test("every app string in every language has the English format specifiers", () => {
  const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")) as {
    strings: Record<string, { shouldTranslate?: boolean; localizations?: Record<string, Unit> }>
  }
  let checked = 0
  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (entry.shouldTranslate === false) continue
    const locs = entry.localizations ?? {}
    const english = locs.en?.stringUnit?.value ?? key
    for (const [lang, unit] of Object.entries(locs)) {
      // A plural's forms each carry the number (or, for a language's "one", may spell it out).
      const forms = unit.variations?.plural ? Object.entries(unit.variations.plural) : [["", unit] as [string, Unit]]
      for (const [form, u] of forms) {
        const value = u.stringUnit?.value
        if (value === undefined) continue
        checked++
        const where = `${lang}${form ? `.${form}` : ""}: ${JSON.stringify(key)}`
        // A text with no arguments (an example answer saying "12%") isn't formatted, so its % is literal.
        if (lonePercent(english) && specs(english).length === 0) continue
        assert.ok(!lonePercent(value), `${where}: a lone % (write %%)`)
        if (form && form !== "other" && specs(value).length === 0) continue
        assert.deepEqual(specs(value), specs(english), `${where} specifiers`)
        assert.equal(percents(value, lang), (english.match(/%%/g) ?? []).length, `${where} percent signs`)
      }
    }
  }
  assert.ok(checked > 5000, `checked ${checked}`)
})
