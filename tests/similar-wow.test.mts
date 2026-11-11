// Find similar: a shop abroad's delivery page, and the alternatives search beside the plan's — in any language,
// country and currency.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { altQueries, deliveryPage, shipsTo, shopCountry, useCountryStore, loadUnsupportedCountries } = await import("../netlify/shared/similar.mts")
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
  assert.equal(shipsTo("We ship to Germany, Austria and Switzerland.", "CY", ["en"]), "no")
  assert.equal(shipsTo("We ship worldwide with tracked delivery.", "BR", ["en", "pt"]), "yes")
  assert.equal(shipsTo("Livraison dans toute l'Union européenne sous 5 jours.", "PT", ["fr", "pt"]), "yes")
  assert.equal(shipsTo("Livraison dans toute l'Union européenne sous 5 jours.", "CH", ["fr", "de"]), "unknown")
  assert.equal(shipsTo("Wir liefern nach Deutschland und Österreich.", "IT", ["de", "it"]), "no")
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

test("the search beside the plan's: things of the same kind (the first traits), the country named where it can't be located", async () => {
  assert.deepEqual(altQueries(input(), plan({ subject: "Zojirushi CK-DAQ10", traits: ["electric kettle", "1 litre", "keep warm"], language: "ja" })), ["electric kettle 1 litre"])
  assert.deepEqual(altQueries(input(), plan({ subject: "Bosch MUM5", traits: ["Küchenmaschine"], language: "de" })), ["Küchenmaschine"])
  assert.deepEqual(altQueries(input(), plan({ subject: "Some App", traits: [], language: "es" })), ["Some App"])
  useCountryStore({ get: async () => ["KE"], set: async () => undefined })
  await loadUnsupportedCountries()
  assert.deepEqual(altQueries(input({ region: "local", country: "KE", locale: "en-KE" }), plan({ subject: "Solar lantern S2", traits: ["solar lantern", "USB charging"] })), ["solar lantern USB charging Kenya"])
  useCountryStore(null)
})
