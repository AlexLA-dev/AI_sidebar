// Find similar's eval set (tools/similar/testset.json): every language the app ships, near-me cases in many
// countries, so what's measured on it isn't fitted to one person's language or country.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const cases = JSON.parse(readFileSync(new URL("../tools/similar/testset.json", import.meta.url), "utf8")) as Array<{ id: string; category: string; locale: string; url: string; condition: string; check?: { kind: string }; region?: string; country?: string }>
const SHIPPED = ["en", "ru", "uk", "de", "fr", "es", "it", "pt", "ja", "ko", "zh", "zh-Hant", "vi", "ar"]
const lang = (locale: string) => (/^zh-(tw|hk|mo|hant)/i.test(locale) ? "zh-Hant" : locale.split("-")[0])

test("the eval set covers every language the app ships, in more than one category", () => {
  const langs = new Set(cases.map((c) => lang(c.locale)))
  for (const l of SHIPPED) assert.ok(langs.has(l), `no page in ${l}`)
  assert.ok(new Set(cases.map((c) => c.category)).size >= 6)
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique")
})

test("near-me cases in many countries, each with its country; none fitted to one country", () => {
  const local = cases.filter((c) => c.region === "local")
  for (const c of local) assert.match(c.country ?? "", /^[A-Z]{2}$/, c.id)
  const countries = new Set(local.map((c) => c.country))
  assert.ok(countries.size >= 10, `near me in ${countries.size} countries`)
  assert.ok(Math.max(...[...countries].map((k) => local.filter((c) => c.country === k).length)) <= Math.ceil(local.length / 4), "no country dominates")
  for (const c of cases) assert.ok(!c.region || c.region === "local" || c.region === "world", c.id)
})

test("each case's check is one the eval knows", () => {
  const KINDS = new Set(["cheaper", "max_price", "in_stock", "free", "newer", "shorter", "language", "judgment"])
  for (const c of cases) if (c.check) assert.ok(KINDS.has(c.check.kind), `${c.id}: ${c.check.kind}`)
})

test("a product case is one item's page, not a shop's home page", () => {
  for (const c of cases.filter((c) => c.category === "product")) {
    const path = new URL(c.url).pathname.split("/").filter(Boolean)
    assert.ok(path.length > 1 || (path.length === 1 && !/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(path[0])) || new URL(c.url).search, `${c.id}: ${c.url}`)
  }
})

test("the language check is asked in many of the app's languages, not only in one or two", () => {
  const asked = new Set(cases.filter((c) => c.check?.kind === "language").map((c) => (c.check as { lang?: string }).lang))
  assert.ok(asked.size >= 6, `language asked in ${[...asked].join(", ")}`)
  for (const l of SHIPPED) assert.ok(cases.filter((c) => lang(c.locale) === l).length >= 2, `fewer than two cases in ${l}`)
})
