// Find similar: one listing per marketplace, and it's the one that fits best, not the one the searches gave first.
// A few listings of each marketplace are opened; the pages' facts keep the two best for the writer; the writer's
// verdict (how close, their words, the chip) and then the price pick the one shown. Every marketplace the same, a
// country's own as Amazon.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { Claims, ItemFinisher, bestListings, checkCondition, finishItems } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

const plan = (over: Partial<Plan>): Plan => ({
  category: "product", subject: "x", traits: [], condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "",
  queries: ["q"], language: "en", ...over
})
const offer = (amount: string, currency: string) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", price: amount, priceCurrency: currency } })}</script>`
const page = (title: string, body: string, head = "", lang = "en") =>
  `<html lang="${lang}"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body} ${"Details, care and what comes in the box, in a few plain sentences. ".repeat(6)}</p></main></body></html>`
function at(url: string, name: string, body: string, p: Plan, price?: [string, string], lang = "en"): CheckedCandidate {
  const checked = describePage(page(name, body, price ? offer(...price) : "", lang), url, url, 200, 0)
  return { url, name, kind: "item", resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(p, {}, checked), kept: true, why: "ok" }
}
const written = (pages: CheckedCandidate[], shares: number[][], over: Array<Record<string, unknown>> = []) =>
  ({ intro: "", note: "", items: pages.map((c, i) => ({ page: i + 1, name: c.name, why: "w", fit: "f", met: "n/a", words_met: "n/a", same: false, shares: shares[i] ?? [1], differs: "", ...(over[i] ?? {}) })) })
const source = { title: "x", url: "https://brand.example.com/x", text: "" }

test("a few listings of each marketplace are opened (three), each marketplace counted on its own", () => {
  const claims = new Claims({ title: "", url: "https://shop.example/kettle", text: "" })
  const c = (url: string, name: string) => ({ url, name, kind: "item" as const, resultTitle: name, pageAge: null })
  const taken = claims.take([
    c("https://www.amazon.de/dp/1", "Wasserkocher Bosch"), c("https://www.amazon.de/dp/2", "Wasserkocher Tefal"), c("https://www.amazon.de/dp/3", "Wasserkocher Russell"),
    c("https://www.amazon.de/dp/4", "Wasserkocher Severin"), c("https://www.ozon.ru/product/5", "Чайник Polaris"), c("https://www.coupang.com/vp/products/6", "전기포트 키친아트"),
    c("https://www.coupang.com/vp/products/7", "전기포트 보만"), c("https://kettles.example/a", "Kettle A")
  ])
  assert.deepEqual(taken.map((t) => t.name), ["Wasserkocher Bosch", "Wasserkocher Tefal", "Wasserkocher Russell", "Чайник Polaris", "전기포트 키친아트", "전기포트 보만", "Kettle A"])
})

test("the writer sees the two listings of a marketplace whose pages fit best: the chip, the traits they show, the price", () => {
  // Cheaper than 60 EUR; the first listing the searches gave costs more, the third shows every trait and costs least.
  const p = plan({ subject: "Kettle K1", traits: ["electric kettle", "1 litre", "temperature control"], condition: { kind: "cheaper", maxPrice: 60, currency: "EUR", language: "", place: "", soft: true } })
  const pages = [
    at("https://www.amazon.de/dp/A1", "Kettle Alpha", "An electric kettle.", p, ["80", "EUR"]),
    at("https://www.amazon.de/dp/B2", "Kettle Beta", "An electric kettle of 1 litre with temperature control.", p, ["45", "EUR"]),
    at("https://www.amazon.de/dp/C3", "Kettle Gamma", "An electric kettle, 1 litre, with temperature control.", p, ["39", "EUR"]),
    at("https://kettles.example/d", "Kettle Delta", "An electric kettle.", p, ["90", "EUR"])
  ]
  const out = bestListings(pages, p)
  assert.deepEqual(out.filter((c) => c.kept).map((c) => c.name), ["Kettle Beta", "Kettle Gamma", "Kettle Delta"])
  assert.equal(out[0].why, "a listing on the same marketplace fits better")
  // A shop's own pages are never thinned here (its cap is three pages a site, in the searches).
  assert.equal(out[3].kept, true)
})

test("every marketplace the same, a country's own as Amazon: each keeps its own best two", () => {
  const p = plan({ subject: "Чайник X", traits: ["электрический чайник", "1 литр"] })
  const ru = (id: string, name: string, body: string, price: string) => at(`https://www.ozon.ru/product/${id}`, name, body, p, [price, "RUB"], "ru")
  const pages = [
    ru("1", "Чайник Polaris PWK", "Электрический чайник.", "2490"),
    ru("2", "Чайник Kitfort KT", "Электрический чайник на 1 литр.", "2190"),
    ru("3", "Чайник Redmond RK", "Электрический чайник, объём 1 литр.", "1990"),
    at("https://market.yandex.ru/product/4", "Чайник Tefal KO", "Электрический чайник.", p, ["3290", "RUB"], "ru")
  ]
  const out = bestListings(pages, p)
  assert.deepEqual(out.filter((c) => c.kept).map((c) => c.name), ["Чайник Kitfort KT", "Чайник Redmond RK", "Чайник Tefal KO"])
})

test("the one shown is the writer's closest, not the first: how close, then the price when they're about as close", () => {
  const p = plan({ subject: "Rice cooker R", traits: ["rice cooker", "5 cups", "keep warm", "induction heating", "timer"] })
  const jp = (id: string, name: string, price: string) => at(`https://www.amazon.co.jp/dp/${id}`, name, "炊飯器", p, [price, "JPY"], "ja")
  // Closer by two traits of five: the later listing wins.
  {
    const pages = [jp("1", "炊飯器 アルファ", "9800"), jp("2", "炊飯器 ベータ", "12800")]
    const { result, dropped } = finishItems(written(pages, [[1, 2], [1, 2, 3, 4]]), pages, p, source)
    assert.deepEqual(result.items.map((i) => i.name), ["炊飯器 ベータ"])
    assert.deepEqual(dropped.map((d) => [d.name, d.why]), [["炊飯器 アルファ", "one listing per marketplace"]])
  }
  // About as close (one trait apart): the lower price.
  {
    const pages = [jp("1", "炊飯器 アルファ", "12800"), jp("2", "炊飯器 ベータ", "9800")]
    const { result } = finishItems(written(pages, [[1, 2, 3], [1, 2, 3, 4]]), pages, p, source)
    assert.deepEqual(result.items.map((i) => i.name), ["炊飯器 ベータ"])
  }
  // About as close and dearer: the first stays.
  {
    const pages = [jp("1", "炊飯器 アルファ", "9800"), jp("2", "炊飯器 ベータ", "12800")]
    const { result } = finishItems(written(pages, [[1, 2, 3], [1, 2, 3]]), pages, p, source)
    assert.deepEqual(result.items.map((i) => i.name), ["炊飯器 アルファ"])
  }
})

test("their words and the chip come first: a listing that holds them wins over a closer one that may not", () => {
  const words = plan({ subject: "Sneaker S", traits: ["sneaker", "leather-free"], words: "vegan" })
  const kr = (id: string, name: string, price: string) => at(`https://www.coupang.com/vp/products/${id}`, name, "운동화", words, [price, "KRW"], "ko")
  {
    const pages = [kr("1", "운동화 알파", "59000"), kr("2", "운동화 베타", "69000")]
    const { result } = finishItems(written(pages, [[1, 2], [1]], [{ words_met: "unknown" }, { words_met: "yes" }]), pages, words, source)
    assert.deepEqual(result.items.map((i) => i.name), ["운동화 베타"])
  }
  // A tapped chip: the first misses "cheaper" (held for the end), the second meets it; the second is the one shown.
  const cheaper = plan({ subject: "Lamp L", traits: ["desk lamp", "dimmable"], condition: { kind: "cheaper", maxPrice: 50, currency: "EUR", language: "", place: "", soft: true } })
  const fr = (id: string, name: string, price: string) => at(`https://www.cdiscount.com/p/${id}`, name, "Lampe de bureau", cheaper, [price, "EUR"], "fr")
  const pages = [fr("1", "Lampe Alpha", "55"), fr("2", "Lampe Beta", "42"), at("https://lamps.example/c", "Lampe Gamma", "Lampe", cheaper, ["35", "EUR"], "fr")]
  const { result } = finishItems(written(pages, [[1, 2], [1, 2], [1, 2]]), pages, cheaper, source)
  // As close as each other and both meet it: the cheaper first (2.6).
  assert.deepEqual(result.items.map((i) => i.name), ["Lampe Gamma", "Lampe Beta"])
})

test("streamed: a better listing that comes later takes the first one's place in the answer, not a new place", () => {
  const p = plan({ subject: "Kettle K1", traits: ["electric kettle", "1 litre", "temperature control"] })
  const pages = [
    at("https://www.ebay.co.uk/itm/1", "Kettle Alpha", "An electric kettle.", p, ["40", "GBP"]),
    at("https://kettles.example/b", "Kettle Beta", "An electric kettle.", p, ["35", "GBP"]),
    at("https://www.ebay.co.uk/itm/3", "Kettle Gamma", "An electric kettle, 1 litre, temperature control.", p, ["38", "GBP"])
  ]
  const f = new ItemFinisher(pages, p, source)
  const raw = written(pages, [[1], [1, 2], [1, 2, 3]]).items
  assert.equal(f.add(raw[0])?.name, "Kettle Alpha")
  assert.equal(f.add(raw[1])?.name, "Kettle Beta")
  // Not sent as an item of its own (the list already has an eBay listing); the answer's list has it in that place.
  assert.equal(f.add(raw[2]), null)
  assert.deepEqual(f.items.map((i) => i.name), ["Kettle Gamma", "Kettle Beta"])
})
