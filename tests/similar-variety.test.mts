// Build 95: Find similar's rules on items, countries, currencies and languages of every kind — each rule that build 94
// tested only on one travel-backpack case in Cyprus gets cases from other categories, countries and currencies here.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, markupRating, readPrice, textRating } = await import("../netlify/shared/pagecheck.mts")
const { currencyOf } = await import("../netlify/shared/money.mts")
const { Claims, checkCondition, distinctive, finishItems, loadUnsupportedCountries, localQueries, searchLocation, siblingLinks, traitExcerpt, useCountryStore } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

const body = "Details about this product, what it does and who it is for, with its specifications and care. ".repeat(5)
const html = (title: string, head = "", lang = "en") => `<html lang="${lang}"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
const offer = (amount: string, currency: string) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", price: amount, priceCurrency: currency } })}</script>`
const plan = (over: Partial<Plan>): Plan => ({
  category: "product", subject: "x", traits: [], condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "",
  queries: ["q"], language: "en", ...over
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "t", url: "https://shop.example/item", text: "t" }, facts: {}, condition: "", locale: "en-US", ...over })
function candidate(url: string, page: string, name: string, p: Plan): CheckedCandidate {
  const checked = describePage(page, url, url, 200, 0)
  return { url, name, kind: "item", resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(p, {}, checked), kept: true, why: "ok" }
}

test("near them in any country the search tool can't locate: named in the country's own language or English", async () => {
  useCountryStore({ get: async () => ["TH", "KE"], set: async () => undefined })
  await loadUnsupportedCountries()
  const th = input({ region: "local", country: "TH", locale: "en-TH" })
  assert.equal(searchLocation(th), null)
  // Named in Thai already (the country's own language): as planned.
  assert.deepEqual(localQueries(th, plan({ queries: ["หูฟังไร้สาย ราคาถูก ประเทศไทย", "wireless earbuds"] })), ["หูฟังไร้สาย ราคาถูก ประเทศไทย", "wireless earbuds"])
  assert.deepEqual(localQueries(th, plan({ queries: ["wireless earbuds under 1500 baht"] })), ["wireless earbuds under 1500 baht Thailand"])
  assert.deepEqual(localQueries(input({ region: "local", country: "KE", locale: "sw-KE" }), plan({ queries: ["solar lantern"] })), ["solar lantern Kenya"])
  // A country it can locate is located, and searched as planned.
  assert.equal(searchLocation(input({ region: "local", country: "JP" })), "JP")
  assert.deepEqual(localQueries(input({ region: "local", country: "JP" }), plan({ queries: ["電気ケトル"] })), ["電気ケトル"])
  useCountryStore(null)
})

test("a camera shop's catalog: other camera bodies first, lenses and straps (another product type, a fraction of the price) after", () => {
  const p = plan({ subject: "Fujifilm X-T50", traits: ["mirrorless camera", "APS-C sensor", "in-body stabilisation"] })
  const item = candidate("https://camera.example/products/x-t50", html("Fujifilm X-T50", `<meta property="og:site_name" content="Fujifilm">${offer("219800", "JPY")}`, "ja"), "Fujifilm X-T50", p)
  const catalog = [
    { url: "https://camera.example/products/x-t50", text: "Fujifilm X-T50", type: "Cameras", price: 219800 },
    { url: "https://camera.example/products/xf35mm", text: "Fujifilm XF35mm F1.4 R", type: "Lenses", price: 89800 },
    { url: "https://camera.example/products/strap", text: "Fujifilm Leather Strap", type: "Accessories", price: 6800 },
    { url: "https://camera.example/products/x-t5", text: "Fujifilm X-T5", type: "Cameras", price: 289800 },
    { url: "https://camera.example/products/x-s20", text: "Fujifilm X-S20", type: "Cameras", price: 199800 }
  ]
  const order = siblingLinks(item, catalog).map((l) => l.text)
  assert.deepEqual(order.slice(0, 2).sort(), ["Fujifilm X-S20", "Fujifilm X-T5"])
  assert.deepEqual(order.slice(2).sort(), ["Fujifilm Leather Strap", "Fujifilm XF35mm F1.4 R"])
})

test("a review page is an item's when it names what tells it from the others in this answer (headphones)", () => {
  const p = plan({ subject: "Sony WH-1000XM6", traits: ["over-ear headphones", "noise cancelling", "30-hour battery"] })
  const names = ["Sony WH-CH720N", "Sony WH-1000XM5", "Bose QuietComfort 45"]
  assert.deepEqual(distinctive("Sony WH-CH720N", p, names), ["ch720n"])
  assert.deepEqual(distinctive("Bose QuietComfort 45", p, names), ["bose", "quietcomfort"])
})

test("ratings read from a product header in German and Japanese, and from a reviews widget's markup", () => {
  assert.deepEqual(textRating(`Kaffeevollautomat\n4,7 von 5 Sternen · 2.315 Bewertungen\n${body}`), { value: 4.7, best: 5, count: 2315 })
  assert.deepEqual(textRating(`電気ケトル\n5つ星のうち4.1 312件のカスタマーレビュー\n${body}`), { value: 4.1, best: 5, count: 312 })
  assert.deepEqual(markupRating(`<div class="jdgm-prev-badge" data-average-rating="4.80" data-number-of-reviews="96"></div>`), { value: 4.8, best: 5, count: 96 })
})

test("the brand's other model's words about a trait, however far down its page (a coffee machine's milk frother)", () => {
  const text = `Philips 3300 Series fully automatic espresso machine. ${"Easy to clean ceramic grinder with 12 settings. ".repeat(20)}The LatteGo milk frother makes cappuccino at the touch of a button.`
  const out = traitExcerpt(text, ["milk frother", "15 bar pressure"])
  assert.match(out, /LatteGo milk frother/)
})

test("one marketplace listing at most, from any region's marketplaces", () => {
  const claims = new Claims({ title: "", url: "https://shop.example/kettle", text: "" })
  const c = (url: string, name: string) => ({ url, name, kind: "item" as const, resultTitle: name, pageAge: null })
  const taken = claims.take([
    c("https://item.rakuten.co.jp/shop/kettle", "Tiger Kettle"), c("https://www.mercadolivre.com.br/chaleira", "Chaleira Elétrica"),
    c("https://allegro.pl/oferta/czajnik", "Czajnik"), c("https://www.zojirushi.com/kettle", "Zojirushi Kettle"), c("https://www.coupang.com/vp/1", "전기포트")
  ])
  assert.deepEqual(taken.map((t) => new URL(t.url).hostname), ["item.rakuten.co.jp", "www.zojirushi.com"])
})

test("an item that shares none of the traits isn't an alternative (0 %), in any category", () => {
  const p = plan({ subject: "MacBook Air 13", traits: ["13-inch laptop", "lightweight", "all-day battery"] })
  const sleeve = candidate("https://bags.example/sleeve", html("Laptop Sleeve 13 inch"), "Laptop Sleeve 13 inch", p)
  const laptop = candidate("https://laptops.example/zenbook", html("ASUS Zenbook 14 OLED"), "ASUS Zenbook 14 OLED", p)
  const { result, dropped } = finishItems({ intro: "", note: "", items: [
    { page: 1, name: "Laptop Sleeve 13 inch", why: "w", fit: "", met: "n/a", words_met: "n/a", same: false, shares: [], differs: "" },
    { page: 2, name: "ASUS Zenbook 14 OLED", why: "w", fit: "", met: "n/a", words_met: "n/a", same: false, shares: [2, 3], differs: "" }
  ] }, [sleeve, laptop], p, { title: "MacBook Air", url: "https://www.apple.com/macbook-air/", text: "" })
  assert.deepEqual(result.items.map((i) => i.name), ["ASUS Zenbook 14 OLED"])
  assert.ok(dropped.some((d) => d.name === "Laptop Sleeve 13 inch" && d.why === "shares none of the traits"))
})

test("prices in yen, pounds and dollars compared in the person's money at the day's rate", () => {
  const p = plan({ condition: { kind: "cheaper", maxPrice: 0, currency: "GBP", language: "", place: "" }, sourcePrice: 120, sourceCurrency: "GBP", money: { currency: "GBP", rates: { EUR: 1, GBP: 0.87, JPY: 162, USD: 1.16 } } })
  const page = (amount: number, currency: string) => ({ ...describePage(html("Kettle"), "https://k.example", "https://k.example", 200, 0), price: { amount, currency } })
  assert.equal(checkCondition(p, { price: { amount: 120, currency: "GBP" } }, page(12000, "JPY")).met, "yes")
  assert.equal(checkCondition(p, { price: { amount: 120, currency: "GBP" } }, page(220, "USD")).met, "no")
})

test("a sign several currencies share is the shop's country's: dollars in Canada and Australia, yen in China", () => {
  assert.deepEqual(readPrice("$1,299.99", "", "https://shop.example.ca/p/1"), { amount: 1299.99, currency: "CAD" })
  assert.deepEqual(readPrice("$249", "", "https://shop.example.com.au/p/1"), { amount: 249, currency: "AUD" })
  assert.deepEqual(readPrice("¥3,999", "", "https://shop.example.cn/p/1"), { amount: 3999, currency: "CNY" })
  assert.deepEqual(readPrice("$249", "", "https://shop.example.com/p/1"), { amount: 249, currency: "USD" })
  assert.deepEqual(readPrice("¥12,800", "", "https://shop.example.jp/p/1"), { amount: 12800, currency: "JPY" })
})

test("the money people pay in, for the countries of every language the app speaks", () => {
  const want: Record<string, string> = { RU: "RUB", UA: "UAH", VN: "VND", TW: "TWD", KR: "KRW", JP: "JPY", CN: "CNY", BR: "BRL", PT: "EUR", MX: "MXN", EG: "EGP", SA: "SAR", FR: "EUR", IT: "EUR", GB: "GBP" }
  for (const [cc, cur] of Object.entries(want)) assert.equal(currencyOf(cc), cur, cc)
})

// ---- rules the build-94/95 tests cover, in other categories, countries and currencies ---------------------------

const offerLd = (amount: string, currency: string) => offer(amount, currency)

test("their very item by its model words, a phone in English and a kettle in Japanese", async () => {
  const { sameAsSubject } = await import("../netlify/shared/similar.mts")
  const phone = plan({ subject: "Google Pixel 9 Pro", traits: ["Android smartphone", "6.3-inch display"] })
  assert.ok(sameAsSubject("Google Pixel 9 Pro 128GB, Obsidian", phone))
  assert.ok(!sameAsSubject("Google Pixel 9a 128GB", phone))
  const kettle = plan({ subject: "象印 電気ケトル CK-DAQ10", traits: ["電気ケトル", "1.0L"], language: "ja" })
  assert.ok(sameAsSubject("象印 CK-DAQ10 電気ケトル 1.0L ブラック", kettle))
  assert.ok(!sameAsSubject("タイガー 電気ケトル PCJ-A101", kettle))
})

test("their very item cheaper at another shop, in dollars: first and 100 %; the dearer shop and their own page left out", () => {
  const p = plan({ subject: "Sony WH-1000XM5", traits: ["over-ear headphones", "noise cancelling", "30-hour battery"], condition: { kind: "cheaper", maxPrice: 0, currency: "USD", language: "", place: "", soft: true }, sourcePrice: 399.99, sourceCurrency: "USD", money: { currency: "USD", rates: { EUR: 1, USD: 1.16 } } })
  const source = { title: "Sony WH-1000XM5 | Sony US", url: "https://electronics.example.com/wh1000xm5", text: "Sony WH-1000XM5" }
  const facts = { price: { amount: 399.99, currency: "USD" } }
  const at = (url: string, name: string, amount: string) => {
    const checked = describePage(html(name, offerLd(amount, "USD")), url, url, 200, 0)
    return { url, name, kind: "item" as const, resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(p, facts, checked), kept: true, why: "ok" }
  }
  const pages = [at("https://shop-a.example.com/wh1000xm5", "Sony WH-1000XM5", "279.99"), at("https://shop-b.example.com/wh1000xm5", "Sony WH-1000XM5 Wireless", "429.99"), at("https://audio.example.com/q45", "Soundcore Space Q45", "149.99")]
  const raw = { intro: "", note: "", items: [
    { page: 1, name: "Sony WH-1000XM5", why: "w", fit: "f", met: "yes", words_met: "n/a", same: true, shares: [1, 2, 3], differs: "" },
    { page: 2, name: "Sony WH-1000XM5 Wireless", why: "w", fit: "f", met: "no", words_met: "n/a", same: true, shares: [1, 2, 3], differs: "" },
    { page: 3, name: "Soundcore Space Q45", why: "w", fit: "f", met: "yes", words_met: "n/a", same: false, shares: [1, 2], differs: "" }
  ] }
  const { result } = finishItems(raw, pages, p, source)
  assert.deepEqual(result.items.map((i) => [i.host, i.same ?? false, i.similarity]), [["shop-a.example.com", true, 100], ["audio.example.com", false, 67]])
})

test("a name the writer added words to after a dash keeps the item's own name, in Japanese too", () => {
  const p = plan({ subject: "電気ケトル", traits: ["電気ケトル"] })
  const c = candidate("https://kaden.example.jp/kt1", html("象印 電気ケトル CK-DAQ10", offerLd("6980", "JPY"), "ja"), "象印 電気ケトル CK-DAQ10", p)
  const { result } = finishItems({ intro: "", note: "", items: [{ page: 1, name: "象印 電気ケトル CK-DAQ10 — 1.0L、温度調節つき", why: "", fit: "", met: "yes", words_met: "n/a", same: false, shares: [1], differs: "" }] }, [c], p, { title: "x", url: "https://other.example/x", text: "" })
  assert.equal(result.items[0].name, "象印 電気ケトル CK-DAQ10")
})

test("a rated item without reviewers' words gets a review search in the plan's language", async () => {
  const { reviewsStep } = await import("../netlify/shared/similar.mts")
  const p = plan({ subject: "電気ケトル", traits: ["電気ケトル"], language: "ja" })
  const rated = candidate("https://kaden.example.jp/kt1", html("象印 電気ケトル CK-DAQ10", `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "象印 電気ケトル CK-DAQ10", aggregateRating: { ratingValue: 4.4, reviewCount: 230 } })}</script>`, "ja"), "象印 電気ケトル CK-DAQ10", p)
  const asked: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      asked.push(JSON.stringify(body.messages))
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { headers: { "content-type": "application/json" } })
    }
    return new Response("<title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    await reviewsStep([rated], p, input({ locale: "ja-JP" }), "ja", 15_000)
    assert.match(asked[0] ?? "", /象印 電気ケトル CK-DAQ10 レビュー/)
  } finally {
    globalThis.fetch = real
  }
})

test("one marketplace listing at most in the answer, also when a review page led to the listings", () => {
  const p = plan({ subject: "Sony WH-1000XM5", traits: ["over-ear headphones", "noise cancelling"] })
  const at = (url: string, name: string) => candidate(url, html(name, offer("99", "USD")), name, p)
  const pages = [at("https://www.amazon.com/dp/B0D46JP795?tag=x-20", "KVIDIO Hybrid ANC Headphones"), at("https://www.walmart.com/ip/1", "JBL Tune 770NC"), at("https://www.amazon.co.uk/dp/B0C3HCD34R", "Soundcore Q20i"), at("https://audio.example.com/q45", "Soundcore Space Q45")]
  const raw = { intro: "", note: "", items: pages.map((c, i) => ({ page: i + 1, name: c.name, why: "w", fit: "f", met: "n/a", words_met: "n/a", same: false, shares: [1, 2], differs: "" })) }
  const { result, dropped } = finishItems(raw, pages, p, { title: "x", url: "https://electronics.example.com/x", text: "" })
  assert.deepEqual(result.items.map((i) => i.host), ["amazon.com", "audio.example.com"])
  assert.equal(dropped.filter((d) => d.why === "one marketplace listing at most").length, 2)
})
