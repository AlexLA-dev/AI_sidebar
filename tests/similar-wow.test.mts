// Find similar: a shop abroad's delivery page, and the alternatives search beside the plan's — in any language,
// country and currency.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { altQueries, checkPlan, deliveryPage, shipsTo, shopCountry, useCountryStore, loadUnsupportedCountries } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan

const filler = "<p>" + "What it is, what it does and how to care for it, in a few plain sentences. ".repeat(8) + "</p>"
const page = (h1: string, body: string, lang = "en") => `<html lang="${lang}"><head><title>${h1} | Shop</title></head><body><main><h1>${h1}</h1>${body}${filler}</main></body></html>`
const plan = (over: Partial<Plan> = {}): Plan => ({
  category: "product", subject: "x", traits: ["a", "b"], condition: { kind: "cheaper", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "",
  queries: ["q"], language: "en", ...over
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "t", url: "https://shop.example/item", text: "t" }, facts: {}, condition: "", locale: "en-US", ...over })

// ---- a shop abroad's delivery page ------------------------------------------------------------------------------

test("a shop's country from its domain; generic domains name none", () => {
  assert.equal(shopCountry("https://bikes.example.co.uk/f16"), "GB")
  assert.equal(shopCountry("https://www.example.de/x"), "DE")
  assert.equal(shopCountry("https://example.com.br/x"), "BR")
  for (const u of ["https://example.com/x", "https://example.io/x", "https://example.shop/x", "https://example.co/x"]) assert.equal(shopCountry(u), "", u)
})

test("whether a delivery page ships to their country, in its language or theirs", () => {
  // Other countries named alone say nothing of theirs: not "no" (shops list their own regions and prices too).
  assert.equal(shipsTo("We ship to Germany, Austria and Switzerland.", "CY", ["en"]), "unknown")
  assert.equal(shipsTo("We only ship to Germany, Austria and Switzerland.", "CY", ["en"]), "no")
  assert.equal(shipsTo("We ship worldwide with tracked delivery.", "BR", ["en", "pt"]), "yes")
  assert.equal(shipsTo("Livraison dans toute l'Union européenne sous 5 jours.", "PT", ["fr", "pt"]), "yes")
  assert.equal(shipsTo("Livraison dans toute l'Union européenne sous 5 jours.", "CH", ["fr", "de"]), "unknown")
  assert.equal(shipsTo("Wir liefern nach Deutschland und Österreich.", "IT", ["de", "it"]), "unknown")
  assert.equal(shipsTo("Wir liefern nur nach Deutschland und Österreich.", "IT", ["de", "it"]), "no")
  assert.equal(shipsTo("Wir liefern nach Deutschland, Österreich und Italien.", "IT", ["de", "it"]), "yes")
  assert.equal(shipsTo("We deliver to Kenya, Uganda and Tanzania.", "KE", ["en", "sw"]), "yes")
  assert.equal(shipsTo("海外発送も承ります。", "KR", ["ja", "ko"]), "yes")
  assert.equal(shipsTo("Delivery takes 3–5 working days.", "MX", ["en", "es"]), "unknown")
})

test("a shop's delivery page: a link that says so, in any of the app's languages, else a Shopify shop's policy", () => {
  const read = (links: Array<{ url: string; text: string }>, shopify = false) => ({ ...describePage(page("Item", ""), "https://shop.example.de/p", "https://shop.example.de/p", 200, 0), links, ...(shopify ? { shopify: true as const } : {}) })
  assert.equal(deliveryPage(read([{ url: "https://shop.example.de/agb", text: "AGB" }, { url: "https://shop.example.de/service/versand", text: "Versand & Lieferung" }])), "https://shop.example.de/service/versand")
  assert.equal(deliveryPage(read([{ url: "https://shop.example.de/info/shipping-policy", text: "Info" }])), "https://shop.example.de/info/shipping-policy")
  assert.equal(deliveryPage(read([{ url: "https://other.example/versand", text: "Versand" }])), "")
  assert.equal(deliveryPage(read([], true)), "https://shop.example.de/policies/shipping-policy")
})

// ---- the alternatives search beside the plan's ------------------------------------------------------------------

test("the search beside the plan's: things of the same kind (the planner's, else the first traits), the country named where it can't be located", async () => {
  assert.deepEqual(altQueries(input(), plan({ subject: "Zojirushi CK-DAQ10", traits: ["electric kettle", "1 litre", "keep warm"], language: "ja" })), ["electric kettle 1 litre"])
  assert.deepEqual(altQueries(input(), plan({ subject: "Bosch MUM5", traits: ["Küchenmaschine"], language: "de" })), ["Küchenmaschine"])
  assert.deepEqual(altQueries(input(), plan({ subject: "Some App", traits: [], language: "es" })), ["Some App"])
  // The planner's own search for the kind, in the language of its searches, comes first.
  assert.deepEqual(altQueries(input(), plan({ subject: "Bosch MUM5", traits: ["stand mixer"], language: "de", kindSearch: "Küchenmaschine mit Rührschüssel 5 Liter" })), ["Küchenmaschine mit Rührschüssel 5 Liter"])
  useCountryStore({ get: async () => ["KE"], set: async () => undefined })
  await loadUnsupportedCountries()
  assert.deepEqual(altQueries(input({ region: "local", country: "KE", locale: "en-KE" }), plan({ subject: "Solar lantern S2", traits: ["solar lantern", "USB charging"] })), ["solar lantern USB charging Kenya"])
  useCountryStore(null)
})

test("the planner's search for the kind is kept when it gives one, and left out when it doesn't", () => {
  const raw = { category: "product", subject: "Philips HD9285", traits: ["air fryer"], condition: { kind: "none", max_price: 0, currency: "", language: "", place: "" }, source_price: 0, source_currency: "", queries: ["Heißluftfritteuse günstig"], language: "de" }
  assert.equal(checkPlan({ ...raw, kind_search: "Heißluftfritteuse 7 Liter" }, input()).kindSearch, "Heißluftfritteuse 7 Liter")
  assert.equal(checkPlan(raw, input()).kindSearch, undefined)
})

test("a delivery page's refusals are refusals; a word only counts in a sentence about shipping (the review's phrases)", () => {
  const cases: Array<[string, string, string[], "yes" | "no" | "unknown"]> = [
    // "Outside" alone isn't read: it's also "outside our control", "outside the contiguous US" for one service.
    ["Delivery may be affected by circumstances outside our reasonable control.", "DE", ["en", "de"], "unknown"],
    ["Die Lieferadresse muss in Österreich liegen.", "DE", ["de"], "no"],
    ["For select international destinations we offer free shipping, including: Australia, Belgium, Brazil.", "RU", ["en", "ru"], "unknown"],
    ["For shipments to the UK and EU, see our terms.", "IT", ["en", "it"], "yes"],
    ["We do not ship internationally.", "DE", ["en", "de"], "no"],
    ["International shipping is not available at this time.", "FR", ["en", "fr"], "no"],
    ["We don't ship to Cyprus or Malta.", "CY", ["en", "el"], "no"],
    ["Trusted by customers worldwide.", "IT", ["en", "it"], "unknown"],
    ["We ship from Europe to the UK only.", "PT", ["en", "pt"], "no"],
    ["We ship worldwide, except Russia.", "RU", ["en", "ru"], "no"],
    ["We ship worldwide, except Russia.", "DE", ["en", "de"], "yes"],
    ["We ship to Germany, but not to Austria.", "DE", ["en", "de"], "yes"],
    ["We ship to Germany, but not to Austria.", "AT", ["en", "de"], "no"],
    ["Free shipping to Germany, except islands.", "DE", ["en", "de"], "yes"],
    ["Kein Versand ins Ausland.", "AT", ["de"], "no"],
    ["Wir liefern nur innerhalb Deutschlands.", "AT", ["de"], "no"],
    ["Envío gratis a España, no incluye Canarias.", "ES", ["es"], "yes"],
    ["Contact us about shipping.", "US", ["en"], "unknown"],
    ["Ship with us: delivery to Canada and Mexico.", "US", ["en"], "unknown"],
    ["Delivery takes 3–5 working days.", "MX", ["en", "es"], "unknown"]
  ]
  for (const [text, country, langs, want] of cases) assert.equal(shipsTo(text, country, langs), want, `${country}: ${text}`)
})

test("country names as sentences write them: endings, prefixes, two-character names; common words aren't countries", () => {
  assert.equal(shipsTo("Доставляем по России, в Казахстан и Беларусь.", "RU", ["ru"]), "yes")
  assert.equal(shipsTo("Доставка по Україні, у Польщу та Німеччину.", "UA", ["uk"]), "yes")
  assert.equal(shipsTo("نشحن إلى السعودية والإمارات", "SA", ["ar"]), "yes")
  assert.equal(shipsTo("نشحن إلى السعودية والإمارات", "AE", ["ar"]), "yes")
  assert.equal(shipsTo("日本全国に配送します", "JP", ["ja"]), "yes")
  assert.equal(shipsTo("配送到香港、澳门、台湾", "TW", ["zh", "zh-Hant"]), "yes")
  assert.equal(shipsTo("국내 배송: 한국 전 지역", "KR", ["ko"]), "yes")
  // «того» is "of that", not Togo.
  assert.equal(shipsTo("Доставка по Германии и Франции; того, кто заказал, уведомим.", "TG", ["ru", "fr"]), "unknown")
  // Other countries named alone don't mean "not there": shops list their own regions and per-country prices.
  assert.equal(shipsTo("Shipping to the Channel Islands, Northern Ireland and Guam: £25.", "FR", ["en", "fr"]), "unknown")
  // Not one of the app's languages: its shipping words aren't read, so nothing is claimed.
  assert.equal(shipsTo("Wysyłamy do Polski, Czech i na Słowację.", "PL", ["pl"]), "unknown")
})
