// Build 91: what an app costs, one or two pages deeper (the owner: an App Store page "free (0 USD)" said nothing about its
// subscription). The App Store's in-app purchases list, a pricing page's plans held to the page's own text, the links
// that lead there, the condition decided again with them, and the dig itself on stand-in pages.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const { appStoreLink, appStorePricing, findPrice, plansPricing, pricePoint, pricingLine, pricingLinks } = await import("../netlify/shared/apppricing.mts")
const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { checkCondition, digPricing } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

// The App Store page's data as apps.apple.com serves it (trimmed): the information section and its annotations.
const iap = (items: Array<[string, string]>) =>
  `{"$kind":"Annotation","title":"In-App Purchases","summary":"Yes","items":[${items.map(([n, p]) => `{"$kind":"textPair","leadingText":${JSON.stringify(n)},"trailingText":${JSON.stringify(p)}}`).join(",")},{"$kind":"button","action":{"title":"Learn More"}}],"shouldAlwaysPresentExpanded":false},{"$kind":"Annotation","title":"Copyright","summary":"©2026","items":[]}`
const storePage = (annotations: string, price: number, name = "Notion: Notes, Tasks, AI") => `<html lang="en"><head><title>${name} App - App Store</title>
<script id=software-application type="application/ld+json">{"@context":"http://schema.org","@type":"SoftwareApplication","name":${JSON.stringify(name)},"offers":{"@type":"Offer","price":${price},"priceCurrency":"USD"}}</script></head>
<body><h1>${name}</h1><p>${"Write, plan and organize in one place. ".repeat(12)}</p>
<script>{"shelves":[{"items":[${annotations}],"title":"Information"}]}</script></body></html>`
const STORE = "https://apps.apple.com/us/app/notion-notes-tasks-ai/id1232780281"
const usd = (amount: number) => ({ amount, currency: "USD" })

test("App Store: free with a subscription — from the monthly option, the options listed", () => {
  const html = storePage(iap([["Notion – Plus Monthly", "$11.99"], ["Notion Business", "$23.99"], ["Notion – Plus Yearly", "$119.99"]]), 0)
  const p = appStorePricing(html, STORE, usd(0))!
  assert.equal(p.model, "subscription")
  assert.deepEqual(p.from, usd(11.99))
  assert.equal(p.period, "month")
  assert.equal(p.freeStart, true)
  assert.equal(p.via, "app_store")
  assert.equal(p.url, STORE)
  assert.match(pricingLine(p), /^free to download; subscription from 11\.99 USD\/month \(from the App Store's In-App Purchases list: Notion – Plus Monthly 11\.99 USD; /)
  // Only yearly: from the yearly one; weekly and yearly: the yearly (no monthly option).
  assert.equal(appStorePricing(storePage(iap([["Pro Annual", "$29.99"]]), 0), STORE, usd(0))!.period, "year")
  assert.equal(appStorePricing(storePage(iap([["Weekly", "$4.99"], ["Yearly", "$39.99"]]), 0), STORE, usd(0))!.period, "year")
})

test("App Store: nothing to buy, a lifetime unlock, coins, a paid app", () => {
  // The information section without in-app purchases: free, nothing to buy.
  const none = appStorePricing(storePage(`{"$kind":"Annotation","title":"Copyright","summary":"©2026","items":[]}`, 0), STORE, usd(0))!
  assert.equal(none.model, "free")
  assert.equal(pricingLine(none), "free, no in-app purchases (from the App Store page)")
  const lifetime = appStorePricing(storePage(iap([["Pro Lifetime", "$24.99"]]), 0), STORE, usd(0))!
  assert.equal(lifetime.model, "one_time")
  assert.equal(lifetime.freeStart, true)
  const coins = appStorePricing(storePage(iap([["100 Coins", "$0.99"], ["500 Coins", "$3.99"]]), 0), STORE, usd(0))!
  assert.equal(coins.model, "in_app")
  assert.deepEqual(coins.from, usd(0.99))
  const paid = appStorePricing(storePage(`{"$kind":"Annotation","title":"Copyright","summary":"©2026","items":[]}`, 9.99), STORE, usd(9.99))!
  assert.equal(paid.model, "one_time")
  assert.deepEqual(paid.from, usd(9.99))
  assert.equal(paid.freeStart, undefined)
})

test("App Store in another storefront's language: its in-app purchases by their title there, prices in its currency", () => {
  const ru = (annotations: string) => `<html lang="ru"><head><title>Telegram</title></head><body><h1>Telegram</h1><p>${"Быстрый мессенджер. ".repeat(20)}</p>
<script>{"shelves":[{"items":[{"$kind":"Annotation","title":"Провайдер","summary":"Telegram FZ-LLC","items":[]},{"$kind":"Annotation","title":"Размер","summary":"255,8 МБ","items":[]},${annotations}{"$kind":"Annotation","title":"Авторские права","summary":"© 2026","items":[]}],"title":"Информация"}]}</script></body></html>`
  const TG = "https://apps.apple.com/ru/app/telegram-messenger/id686449807"
  const rub = (amount: number) => ({ amount, currency: "RUB" })
  const p = appStorePricing(ru(`{"$kind":"Annotation","title":"Встроенные покупки","summary":"Да","items":[{"$kind":"textPair","leadingText":"Telegram Premium","trailingText":"329,00 ₽"},{"$kind":"textPair","leadingText":"Telegram Premium Annual","trailingText":"2\u00a0390,00 ₽"},{"$kind":"textPair","leadingText":"1x Premium (3 Months)","trailingText":"1\u00a0290,00 ₽"}]},`), TG, rub(0))!
  // "3 Months" is a pack, not a monthly price: from the yearly one.
  assert.equal(p.model, "subscription")
  assert.deepEqual(p.from, rub(2390))
  assert.equal(p.period, "year")
  assert.equal(p.freeStart, true)
  // No in-app purchases listed in its information section: free, nothing to buy.
  assert.equal(appStorePricing(ru(""), TG, rub(0))!.model, "free")
  assert.equal(appStorePricing(ru(`{"$kind":"Annotation","title":"Встроенные покупки","summary":"Нет","items":[]},`), TG, rub(0))!.model, "free")
})

test("App Store: nothing assumed off the store, without a price, or without the information section", () => {
  const html = storePage(iap([["Monthly", "$4.99"]]), 0)
  assert.equal(appStorePricing(html, "https://example.com/app", usd(0)), null)
  assert.equal(appStorePricing(html, STORE, undefined), null)
  assert.equal(appStorePricing("<html><body>An App Store page in another layout</body></html>", STORE, usd(0)), null)
})

test("the page checker reads it off an App Store page by itself", () => {
  const html = storePage(iap([["Plus Monthly", "$11.99"]]), 0)
  const page = describePage(html, STORE, STORE, 200, 0)
  assert.equal(page.status, "ok")
  assert.equal(page.pricing?.model, "subscription")
  assert.equal(page.storeLink, undefined)
})

test("prices as shown: the currency by its sign or code, a store's dollar by the store", () => {
  assert.deepEqual(pricePoint("$4.99"), usd(4.99))
  assert.deepEqual(pricePoint("$4.99", "CAD"), { amount: 4.99, currency: "CAD" })
  assert.deepEqual(pricePoint("299,00 ₽"), { amount: 299, currency: "RUB" })
  assert.deepEqual(pricePoint("€9.50"), { amount: 9.5, currency: "EUR" })
  assert.deepEqual(pricePoint("USD 12"), usd(12))
})

// A pricing page's text (Notion's, folded as the checker keeps it): plans, an add-on, a free plan.
const NOTION = "Pricing Free For individuals $0 per member / month Plus For small teams $10 per seat/month billed annually $12 billed monthly Business $20 per seat/month Enterprise Contact sales Add-ons Remove Notion branding for $8/month/domain"

test("a pricing page's plans hold only where the page bears them out", () => {
  assert.ok(findPrice(NOTION, "$10"))
  assert.equal(findPrice(NOTION, "$1"), null) // not a part of $10
  assert.equal(findPrice(NOTION, "$15"), null) // not on the page
  const p = plansPricing([
    { name: "Plus", price: "$10", period: "month" },
    { name: "Business", price: "$20", period: "month" },
    { name: "Made up", price: "$7", period: "month" },
    { name: "Plus", price: "$12", period: "year" }, // "$12 billed monthly": not yearly
    { name: "Team", price: "$20", period: "unknown" }
  ], true, NOTION, "https://www.notion.com/pricing")!
  assert.equal(p.model, "subscription")
  assert.deepEqual(p.from, usd(10))
  assert.equal(p.period, "month")
  assert.equal(p.freeStart, true)
  assert.equal(p.via, "pricing_page")
  assert.deepEqual(p.options, ["Plus $10/month", "Business $20/month"])
  // A free plan only when the page says so; a one-time price only with "lifetime", "one-time"…
  assert.equal(plansPricing([{ name: "Pro", price: "$10", period: "month" }], true, "Pro $10 / month", "u")!.freeStart, undefined)
  const once = plansPricing([{ name: "Catalyst", price: "$25", period: "one_time" }], false, "Catalyst $25 USD One-time payment", "u")!
  assert.equal(once.model, "one_time")
  assert.equal(plansPricing([{ name: "Catalyst", price: "$25", period: "one_time" }], false, "Catalyst $25 USD", "u"), null)
  assert.equal(plansPricing([], true, NOTION, "u"), null)
})

test("where to look next: the App Store page the site links to, the site's own pricing page", () => {
  const html = `<a href="https://apps.apple.com/us/app/glarity-ai/id6449000000?mt=12">Download on the App Store</a>
    <a href="/pricing">Pricing</a><a href="https://glarity.app/plans">Plans</a><a href="https://other.com/pricing">Pricing</a><a href="/blog">Blog</a><a href="/">Premium</a>`
  assert.equal(appStoreLink(html), "https://apps.apple.com/us/app/glarity-ai/id6449000000")
  assert.deepEqual(pricingLinks(html, "https://glarity.app/"), ["https://glarity.app/pricing", "https://glarity.app/plans"])
  assert.equal(appStoreLink("<a href='https://example.com'>x</a>"), null)
})

// ---- the condition, and the dig ---------------------------------------------------------------

const plan = (kind: Plan["condition"]["kind"] = "free", category: Plan["category"] = "app"): Plan => ({
  category, subject: "ContextFlow", traits: [], condition: { kind, maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "", queries: [], language: "en"
})

test("free: nothing to buy, free with a subscription, paid, a pricing page without a free plan", () => {
  const page = (pricing: any, price?: number) => ({ ...describePage("<html><title>x</title><body>" + "word ".repeat(80) + "</body></html>", STORE, STORE, 200, 0), pricing, ...(price !== undefined ? { price: usd(price) } : {}) })
  assert.equal(checkCondition(plan(), {}, page({ model: "free", options: [], url: STORE, via: "app_store" }, 0)).met, "yes")
  const sub = checkCondition(plan(), {}, page({ model: "subscription", from: usd(11.99), period: "month", freeStart: true, options: [], url: STORE, via: "app_store" }, 0))
  assert.equal(sub.met, "yes")
  assert.match(sub.note, /subscription from 11\.99 USD\/month/)
  assert.equal(checkCondition(plan(), {}, page({ model: "one_time", from: usd(9.99), options: [], url: STORE, via: "app_store" }, 9.99)).met, "no")
  assert.equal(checkCondition(plan(), {}, page({ model: "subscription", from: usd(10), period: "month", options: [], url: "u", via: "pricing_page" })).met, "unknown")
})

const SITE = "https://glarity.app/"
const sitePage = `<html lang="en"><head><title>Glarity – AI summaries for Safari</title></head><body><h1>Glarity</h1><p>${"Summarize any page in Safari. ".repeat(12)}</p>
  <a href="https://apps.apple.com/us/app/glarity-ai/id6449000000">Download on the App Store</a></body></html>`

function candidate(page: string, name = "Glarity"): CheckedCandidate {
  const p = describePage(page, SITE, SITE, 200, 0)
  return { url: SITE, name, kind: "item", resultTitle: name, pageAge: null, page: p, score: 1, condition: checkCondition(plan(), {}, p), kept: true, why: "ok" }
}

async function withPages<T>(pages: Record<string, string>, work: () => Promise<T>): Promise<{ result: T; asked: string[] }> {
  const real = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url))
    const body = pages[String(url)]
    return body ? new Response(body, { status: 200, headers: { "content-type": "text/html" } }) : new Response("Not found", { status: 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    return { result: await work(), asked }
  } finally {
    globalThis.fetch = real
  }
}

test("an app's site that doesn't say: its App Store page tells, and the verdict follows", async () => {
  const c = candidate(sitePage)
  assert.equal(c.condition.met, "unknown")
  assert.equal(c.page.storeLink, "https://apps.apple.com/us/app/glarity-ai/id6449000000")
  const store = storePage(iap([["Glarity Pro Monthly", "$9.99"], ["Glarity Pro Yearly", "$79.99"]]), 0, "Glarity - AI Summary")
  const { result, asked } = await withPages({ "https://apps.apple.com/us/app/glarity-ai/id6449000000": store }, () => digPricing([c], plan(), {}, "en", 3_000))
  assert.deepEqual(asked, ["https://apps.apple.com/us/app/glarity-ai/id6449000000"])
  assert.equal(result.dug, 1)
  const after = result.checked[0]
  assert.equal(after.page.pricing?.model, "subscription")
  assert.deepEqual(after.page.pricing?.from, usd(9.99))
  assert.equal(after.condition.met, "yes")
  assert.match(after.condition.note, /free to download; subscription from 9\.99 USD\/month/)
})

test("the store page of another app, or no answer anywhere: the verdict stays as it was", async () => {
  const c = candidate(sitePage)
  const other = storePage(iap([["Monthly", "$4.99"]]), 0, "Some Other Reader")
  const { result, asked } = await withPages({ "https://apps.apple.com/us/app/glarity-ai/id6449000000": other }, () => digPricing([c], plan(), {}, "en", 3_000))
  // The store page didn't name it; then /pricing (404): two pages at most, nothing claimed.
  assert.deepEqual(asked, ["https://apps.apple.com/us/app/glarity-ai/id6449000000", "https://glarity.app/pricing"])
  assert.equal(result.checked[0].page.pricing, undefined)
  assert.equal(result.checked[0].condition.met, "unknown")
})

test("no dig without an app and a price asked about, or when the page already said", async () => {
  const c = candidate(sitePage)
  for (const p of [plan("none"), plan("in_stock"), plan("free", "product")]) {
    const { result, asked } = await withPages({}, () => digPricing([c], p, {}, "en", 3_000))
    assert.equal(result.dug, 0)
    assert.deepEqual(asked, [])
  }
  const store = { ...c, page: describePage(storePage(iap([["Monthly", "$4.99"]]), 0), STORE, STORE, 200, 0) }
  const { result } = await withPages({}, () => digPricing([{ ...store, condition: checkCondition(plan(), {}, store.page) }], plan(), {}, "en", 3_000))
  assert.equal(result.dug, 0)
})

test("App Store: a pack of several months is bought once, in any language; one month is the subscription's period", () => {
  const ru = appStorePricing(storePage(iap([["Премиум 3 месяца", "699 ₽"], ["Премиум 1 месяц", "299 ₽"]]), 0), "https://apps.apple.com/ru/app/x/id1", { amount: 0, currency: "RUB" })!
  assert.equal(ru.model, "subscription")
  assert.deepEqual([ru.from, ru.period], [{ amount: 299, currency: "RUB" }, "month"])
  const ja = appStorePricing(storePage(iap([["プレミアム 6ヶ月", "¥3,000"], ["プレミアム 月額", "¥600"]]), 0), "https://apps.apple.com/jp/app/x/id1", { amount: 0, currency: "JPY" })!
  assert.deepEqual([ja.from, ja.period], [{ amount: 600, currency: "JPY" }, "month"])
  // Only packs: not a subscription.
  const packs = appStorePricing(storePage(iap([["Pro 3 місяці", "199 грн"], ["Pro 12 місяців", "599 грн"]]), 0), "https://apps.apple.com/ua/app/x/id1", { amount: 0, currency: "UAH" })!
  assert.notEqual(packs.model, "subscription")
  // Quarterly, in German.
  assert.equal(appStorePricing(storePage(iap([["Pro vierteljährlich", "9,99 €"]]), 0), "https://apps.apple.com/de/app/x/id1", { amount: 0, currency: "EUR" })!.model, "subscription")
})
