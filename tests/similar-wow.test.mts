// Find similar: the price a page's text shows, a shop abroad's delivery page, and the alternatives search beside the
// plan's — in any language, country and currency.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, textPrice } = await import("../netlify/shared/pagecheck.mts")
const { altQueries, checkCondition, deliveryPage, shipsTo, shopCountry, useCountryStore, loadUnsupportedCountries, verdictOf } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan

const filler = "<p>" + "What it is, what it does and how to care for it, in a few plain sentences. ".repeat(8) + "</p>"
const page = (h1: string, body: string, lang = "en") => `<html lang="${lang}"><head><title>${h1} | Shop</title></head><body><main><h1>${h1}</h1>${body}${filler}</main></body></html>`
const plan = (over: Partial<Plan> = {}): Plan => ({
  category: "product", subject: "x", traits: ["a", "b"], condition: { kind: "cheaper", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "",
  queries: ["q"], language: "en", ...over
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "t", url: "https://shop.example/item", text: "t" }, facts: {}, condition: "", locale: "en-US", ...over })

// ---- the price a page's text shows ------------------------------------------------------------------------------

test("a price in the text after the item's name: the one to pay, not the old one, a saving, shipping or a monthly sum", () => {
  const de = page("Kenwood Chef KVC3110S", `<p><del>UVP 499,00 €</del> <span>349,00 €</span></p>`, "de")
  assert.deepEqual(textPrice(de, "Kenwood Chef KVC3110S", "https://kueche.example.de/p/1"), { amount: 349, currency: "EUR" })
  const en = page("Trail Runner 2", `<p>Was $129.99 Now $89.99</p>`)
  assert.deepEqual(textPrice(en, "Trail Runner 2", "https://run.example.com/p"), { amount: 89.99, currency: "USD" })
  const shipping = page("Desk Lamp L1", `<p>Free shipping on orders over $50</p><p>$79.00</p>`)
  assert.deepEqual(textPrice(shipping, "Desk Lamp L1", "https://lamps.example.com/l1"), { amount: 79, currency: "USD" })
  const monthly = page("Studio Laptop 14", `<p>$1,299.00 or $108/mo for 12 months</p>`)
  assert.deepEqual(textPrice(monthly, "Studio Laptop 14", "https://pc.example.com/s14"), { amount: 1299, currency: "USD" })
  const marked = page("Linen Shirt", `<span class="compare-at-price">€59,95</span> <span class="price">€39,95</span>`, "fr")
  assert.deepEqual(textPrice(marked, "Linen Shirt", "https://mode.example.fr/chemise"), { amount: 39.95, currency: "EUR" })
})

test("the same in Japanese, Korean and Portuguese shops, in their money", () => {
  const ja = page("電気ケトル KT-1", `<p>定価 ¥9,800</p><p>販売価格 ¥6,980（税込）</p>`, "ja")
  assert.deepEqual(textPrice(ja, "電気ケトル KT-1", "https://kaden.example.jp/kt1"), { amount: 6980, currency: "JPY" })
  const ko = page("수분 크림 50ml", `<p>정가 39,000원</p><p>29,000원</p>`, "ko")
  assert.deepEqual(textPrice(ko, "수분 크림 50ml", "https://beauty.example.kr/cream"), { amount: 29000, currency: "KRW" })
  const pt = page("Jogo de Panelas Inox 5 Peças", `<p>Preço original R$ 499,90</p><p>R$ 379,90 à vista</p>`, "pt")
  assert.deepEqual(textPrice(pt, "Jogo de Panelas Inox 5 Peças", "https://casa.example.com.br/jogo"), { amount: 379.9, currency: "BRL" })
})

test("no price taken when the name isn't on the page's text or no price follows it", () => {
  assert.equal(textPrice(page("Folding Bike F16", "<p>Ask in store</p>"), "Folding Bike F16", "https://bikes.example.co.uk/f16"), undefined)
  assert.equal(textPrice(page("Folding Bike F16", "<p>£650</p>"), "Some Other Name", "https://bikes.example.co.uk/f16"), undefined)
})

test("a page with no price for machines gets the text's price, only when that switch is on and the page is the item", async () => {
  const html = page("Folding Bike F16", "<p>£650.00</p>")
  const read = describePage(html, "https://bikes.example.co.uk/f16", "https://bikes.example.co.uk/f16", 200, 0)
  assert.equal(read.price, undefined)
  assert.deepEqual(read.textPrice, { amount: 650, currency: "GBP" })
  const c = { url: read.finalUrl, name: "Folding Bike F16", kind: "item" as const, resultTitle: "Folding Bike F16", pageAge: null }
  const on = verdictOf(c, read, plan({ textPrice: true }), {})
  assert.deepEqual(on.page.price, { amount: 650, currency: "GBP" })
  assert.equal(on.page.priceFrom, "text")
  assert.equal(verdictOf(c, read, plan({ textPrice: false }), {}).page.price, undefined)
  assert.equal(verdictOf({ ...c, kind: "list" }, read, plan({ textPrice: true }), {}).page.price, undefined)
  assert.equal(verdictOf({ ...c, name: "Carbon Road Bike R9", resultTitle: "Carbon Road Bike R9" }, read, plan({ textPrice: true }), {}).page.price, undefined)
  // Compared like any price: cheaper than 700 GBP.
  const cheaper = plan({ textPrice: true, sourcePrice: 700, sourceCurrency: "GBP" })
  assert.equal(checkCondition(cheaper, { price: { amount: 700, currency: "GBP" } }, on.page).met, "yes")
})

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

test("the alternatives search in the plan's language, the country named where the search can't locate it", async () => {
  assert.deepEqual(altQueries(input(), plan({ subject: "Zojirushi CK-DAQ10", traits: ["electric kettle", "1 litre"], language: "ja" })), ["Zojirushi CK-DAQ10 代わり", "electric kettle 1 litre"])
  assert.deepEqual(altQueries(input(), plan({ subject: "Bosch MUM5", traits: ["Küchenmaschine"], language: "de" })), ["Bosch MUM5 Alternativen", "Küchenmaschine"])
  assert.deepEqual(altQueries(input(), plan({ subject: "X", traits: [], language: "zh-TW" })), ["X 替代品", "X"])
  useCountryStore({ get: async () => ["KE"], set: async () => undefined })
  await loadUnsupportedCountries()
  assert.deepEqual(altQueries(input({ region: "local", country: "KE", locale: "en-KE" }), plan({ subject: "Solar lantern S2", traits: ["solar lantern"] })), ["Solar lantern S2 alternatives Kenya", "solar lantern Kenya"])
  useCountryStore(null)
})
