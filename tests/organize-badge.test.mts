// "N recommendations" on a chat in the list (2.6): every language has the forms its plural rules pick, with the number.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const FORMS = ["one", "two", "few", "many", "other"]

test("each language has every form, and the number in it (Arabic's one and two say it in words)", () => {
  for (const file of readdirSync(`${root}src/locales`)) {
    const strings = JSON.parse(readFileSync(`${root}src/locales/${file}`, "utf8")) as Record<string, string>
    for (const form of FORMS) {
      const text = strings[`recs_${form}`]
      assert.ok(text, `${file}: recs_${form}`)
      if (!(file === "ar.json" && (form === "one" || form === "two"))) assert.match(text, /\{0\}/, `${file}: recs_${form}`)
    }
  }
})

test("Russian: 1 рекомендация, 2 рекомендации, 5 рекомендаций, 21 рекомендация", () => {
  const ru = JSON.parse(readFileSync(`${root}src/locales/ru.json`, "utf8")) as Record<string, string>
  const say = (n: number) => ru[`recs_${new Intl.PluralRules("ru").select(n)}`].replace("{0}", String(n))
  assert.deepEqual([1, 2, 5, 21].map(say), ["1 рекомендация", "2 рекомендации", "5 рекомендаций", "21 рекомендация"])
})

test("the app's catalog has the plural for the same forms", () => {
  const catalog = JSON.parse(readFileSync(`${root}ContextFlow/Shared (App)/Localizable.xcstrings`, "utf8"))
  const entry = catalog.strings["%lld recommendations"]
  assert.equal(entry.localizations.ru.variations.plural.few.stringUnit.value, "%lld рекомендации")
  assert.equal(entry.localizations.en.variations.plural.one.stringUnit.value, "%lld recommendation")
  assert.equal(Object.keys(entry.localizations).length, 14)
})
