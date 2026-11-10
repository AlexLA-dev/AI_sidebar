// Build 94, Find similar (the owner's notes on 93): near them in a country the search tool can't locate (Cyprus) the
// searches name the country; every item says how close it is (estimated when its page couldn't be opened); one line of
// what reviewers say — a rating from the page's own markup or header, likes and dislikes borne out by their words, the
// site's own reviews too; the brand's other models on its site before "it lacks X"; and a search that outlives its
// request: kept on our server, picked up from /api/v2/similar-result.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, markupRating, reviewsSection, textRating } = await import("../netlify/shared/pagecheck.mts")
const { checkCondition, finishItems, localQueries, reviewWords, searchLocation, shopifyCatalog, siblingLinks, siblingsStep, writeMessage, WRITE_SYSTEM } = await import("../netlify/shared/similar.mts")
const { jobKey, jobState, sweepJobs, useJobStore, waitForJob, JOB_STALE_MS } = await import("../netlify/shared/jobs.mts")
const { default: resultFn } = await import("../netlify/functions/v2-similar-result.mts")
const { cleanItem } = await import("../src/shared/similar.ts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate
type StoredJob = import("../netlify/shared/jobs.mts").StoredJob

const words = "A carry-on backpack with a built-in vacuum compartment that packs your clothes flat. ".repeat(5)
const html = (title: string, body = "", head = "") => `<html lang="en"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${words}</p>${body}</main></body></html>`
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const plan = (over: Partial<Plan> = {}): Plan => ({
  category: "product", subject: "Airback rollerbag", traits: ["vacuum compression", "trolley wheels", "carry-on size", "TSA lock"],
  condition: { kind: "cheaper", maxPrice: 189, currency: "EUR", language: "", place: "Cyprus" }, sourcePrice: 189, sourceCurrency: "EUR",
  queries: ["vacuum compression rolling carry-on", "Airback rollerbag alternative cheaper"], language: "en", ...over
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "Vacuum Rollerbags - Airback", url: "https://airback.store/collections/rollerbags", text: "Airback rollerbag" }, facts: {}, condition: "Cheaper, delivery to Cyprus", locale: "en-CY", ...over })

function candidate(url: string, page: string, name: string, kind: "item" | "list" = "item", why = "ok"): CheckedCandidate {
  const checked = describePage(page, url, url, 200, 0)
  return { url, name, kind, resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(plan(), {}, checked), kept: why === "ok", why }
}

const price = (amount: string, currency = "EUR", name = "") => ld({ "@type": "Product", ...(name ? { name } : {}), offers: { "@type": "Offer", price: amount, priceCurrency: currency, availability: "https://schema.org/InStock" } })

// ---- where ------------------------------------------------------------------------------------

test("near them in Cyprus (no search location there): the searches name the country, some stay open to shops that deliver", () => {
  const cy = input({ region: "local", country: "CY" })
  assert.equal(searchLocation(cy), null)
  // The planner named it already (in any language): as planned.
  const named = ["vacuum compression rolling carry-on", "βαλίτσα trolley Κύπρος"]
  assert.deepEqual(localQueries(cy, plan({ queries: named })), named)
  assert.deepEqual(localQueries(cy, plan({ queries: ["a", "b CY shop"] })), ["a", "b CY shop"])
  // No search names it: every other one does now.
  assert.deepEqual(localQueries(cy, plan({ queries: ["vacuum compression rolling carry-on", "vacuum backpack trolley", "rollerbag cheaper"] })), [
    "vacuum compression rolling carry-on", "vacuum backpack trolley Cyprus", "rollerbag cheaper"
  ])
  assert.deepEqual(localQueries(cy, plan({ queries: ["vacuum rollerbag"] })), ["vacuum rollerbag Cyprus"])
  // Where the search can be located, or worldwide: the searches as planned.
  assert.deepEqual(localQueries(input({ region: "local", country: "DE" }), plan()), plan().queries)
  assert.deepEqual(localQueries(input({ region: "world", country: "CY" }), plan()), plan().queries)
})

// ---- how close ----------------------------------------------------------------------------------

test("every item says how close it is; a page that wasn't opened says it's estimated from its description", () => {
  const opened = candidate("https://packntrip.store/p", html("PacknTrip ProPack", "", price("169.99", "USD", "PacknTrip ProPack")), "PacknTrip ProPack")
  const blocked: CheckedCandidate = { ...candidate("https://www.amazon.com/dp/B0X", html("x"), "Fanwoli Rolling Vacuum Backpack"), why: "unchecked", resultTitle: "Fanwoli Rolling Vacuum Backpack (54L)", kept: false }
  const { result } = finishItems({ items: [
    { page: 2, name: "Fanwoli Rolling Vacuum Backpack", why: "Rolls and compresses.", fit: "", met: "unknown", shares: [1, 2, 3], differs: "" },
    { page: 1, name: "PacknTrip ProPack", why: "Compresses.", fit: "", met: "unknown", shares: [1, 3], differs: "No trolley" }
  ], intro: "", note: "" }, [opened, blocked], plan(), input().page)
  assert.equal(result.items[0].similarity, 75)
  assert.equal(result.items[0].estimated, true)
  assert.equal(result.items[1].similarity, 50)
  assert.equal(result.items[1].estimated, undefined)
  // The panel keeps the mark.
  assert.equal(cleanItem(result.items[0])?.estimated, true)
})

// ---- what reviewers say ----------------------------------------------------------------------

test("a rating from the page's markup when its JSON-LD has none: microdata, a reviews widget with its count", () => {
  assert.deepEqual(markupRating(`<div itemprop="aggregateRating"><span itemprop="ratingValue">4.6</span> of <span itemprop="bestRating">5</span> <meta itemprop="reviewCount" content="687"></div>`), { value: 4.6, best: 5, count: 687 })
  // Judge.me's badge and Loox's: the product's own first, related products' after it.
  assert.deepEqual(markupRating(`<div class='jdgm-prev-badge' data-average-rating='4.60' data-number-of-reviews='687'></div><div class='jdgm-prev-badge' data-average-rating='5.00' data-number-of-reviews='3'></div>`), { value: 4.6, best: 5, count: 687 })
  assert.deepEqual(markupRating(`<div class="loox-rating" data-id="1" data-rating="4.9" data-raters="25,312"></div>`), { value: 4.9, best: 5, count: 25312 })
  // Stars without a count are a display, not a rating summary.
  assert.equal(markupRating(`<div class="stars" data-rating="5"></div>`), undefined)
})

test("a rating in the product's header text: the average with how many next to it", () => {
  assert.deepEqual(textRating("Backvac Pro Vacuum compression travel backpack. 4.6 of 5 rating from 687 ratings. TSA lock."), { value: 4.6, best: 5, count: 687 })
  assert.deepEqual(textRating("Rated 4,8 out of 5 stars · 1 204 reviews"), { value: 4.8, best: 5, count: 1204 })
  assert.equal(textRating("Our customers give us 5 out of 5!"), undefined)
  // Far down the page (a related product's): not the item's.
  assert.equal(textRating(`${"x ".repeat(900)} 4.2 out of 5 · 40 reviews`), undefined)
  const page = describePage(html("Backvac Pro", "<p>4.6 of 5 rating from 687 ratings</p>"), "https://mybackvac.com/products/backvacpro", "https://mybackvac.com/products/backvacpro", 200, 0)
  // The header comes after the description in this page; within the first 1500 characters it's the item's.
  assert.deepEqual(page.rating, { value: 4.6, best: 5, count: 687 })
})

test("the page's own reviews section is kept for what reviewers say", () => {
  const reviews = `<section><h2>Customer Reviews</h2>${"<div class='jdgm-rev'><p>Fits a week of clothes, the pump is quick. Zips feel cheap though.</p></div>".repeat(8)}</section>`
  const text = reviewsSection(html("Backvac Pro", reviews))
  assert.match(text ?? "", /^Customer Reviews Fits a week of clothes/)
  assert.equal(reviewsSection(html("No reviews here")), undefined)
})

test("what reviewers like and dislike: short, without numbers", () => {
  assert.deepEqual(reviewWords({ pros: "compression, sturdy zips.", cons: "" }), { pros: "compression, sturdy zips" })
  assert.deepEqual(reviewWords({ pros: "", cons: "the price" }), { cons: "the price" })
  assert.equal(reviewWords({ pros: "4.8 stars", cons: "" }), null)
  assert.equal(reviewWords({}), null)
})

test("the item's reviews reach the panel as one line's parts; the writer sees likes and dislikes", () => {
  const c = candidate("https://mybackvac.com/products/backvacpro", html("Backvac Pro", "", price("179.99", "USD", "Backvac Pro")), "Backvac Pro")
  c.reviews = { rating: { value: 4.6, best: 5, count: 687 }, pros: "compression", cons: "the price", sources: ["https://mybackvac.com/products/backvacpro"] }
  const { result } = finishItems({ items: [{ page: 1, name: "Backvac Pro", why: "Vacuum backpack.", fit: "", met: "unknown", shares: [1, 3, 4], differs: "No trolley" }], intro: "", note: "" }, [c], plan(), input().page)
  assert.deepEqual(result.items[0].reviews, { rating: { value: 4.6, best: 5, count: 687 }, pros: "compression", cons: "the price", sources: ["https://mybackvac.com/products/backvacpro"] })
  assert.match(writeMessage(input(), plan(), [c]), /reviews: 4\.6 of 5 \(687 ratings\); reviewers like: compression; dislike: the price; from mybackvac\.com/)
  assert.match(WRITE_SYSTEM, /No ratings or reviews in it/)
})

// ---- the brand's other models ------------------------------------------------------------------

const backvacPro = html("Backvac Pro – BACKVAC", `
  <a href="/products/backvacpro?variant=1">Backvac Pro Black</a>
  <a href="/products/backvacpromax">Backvac Pro Max</a>
  <a href="/products/backvac-flight-carry-on">Backvac Flight Carry-On</a>
  <a href="/products/eye-mask">Eye mask</a>
  <a href="/collections/all">Shop all</a>
  <a href="https://other.example/products/backvac-clone">Backvac clone</a>
  <a href="/">Backvac</a>`, `<meta property="og:site_name" content="BACKVAC">${price("179.99", "USD", "Backvac Pro")}`)
const proMax = html("Backvac Pro Max", "<ul><li>Detachable Vacuum Bag</li><li>Built-In Trolley System</li></ul>", price("272.95", "EUR", "Backvac Pro Max"))
const flight = html("Backvac Flight Carry-On", "<p>Soft carry-on, no wheels.</p>", price("149.95", "EUR", "Backvac Flight Carry-On"))

test("the brand's other models on the item's site: named by the brand, not the item itself, the closest first", () => {
  const c = candidate("https://mybackvac.com/products/backvacpro", backvacPro, "Backvac Pro")
  assert.deepEqual(siblingLinks(c).map((l) => l.url), ["https://mybackvac.com/products/backvacpromax", "https://mybackvac.com/products/backvac-flight-carry-on"])
})

test("before the writer says an item lacks something, it sees the model that has it, with its price and the condition", async () => {
  const c = candidate("https://mybackvac.com/products/backvacpro", backvacPro, "Backvac Pro")
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url)
    const body = u.endsWith("/backvacpromax") ? proMax : u.endsWith("/backvac-flight-carry-on") ? flight : ""
    return new Response(body || "<title>Not found</title>", { status: body ? 200 : 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const out = await siblingsStep([c], plan(), {}, "en", 5_000)
    const siblings = out.checked[0].siblings!
    assert.deepEqual(siblings.map((s) => [s.page.name, s.condition.met]), [["Backvac Pro Max", "no"], ["Backvac Flight Carry-On", "yes"]])
    // The cheaper model meets the condition: an item of its own too.
    assert.deepEqual(out.added.map((a) => a.name), ["Backvac Flight Carry-On"])
    assert.deepEqual(out.stats, { items: 1, opened: 2, added: 1 })
    const message = writeMessage(input(), plan(), out.checked)
    assert.match(message, /other models on its site \(opened now\):\n {2}«Backvac Pro Max» — 272\.95 EUR — condition: no \(price 272\.95 EUR vs 189 EUR\) — .*Built-In Trolley System/)
    assert.match(WRITE_SYSTEM, /Before saying an item lacks something their item has, look at its "other models on its site"/)
  } finally {
    globalThis.fetch = real
  }
  // Apps, articles…: no siblings looked for.
  const app = await siblingsStep([c], plan({ category: "app" }), {}, "en", 5_000)
  assert.equal(app.stats.items, 0)
})

// ---- a search that outlives its request ----------------------------------------------------------

function memoryStore() {
  const map = new Map<string, StoredJob>()
  return {
    map,
    get: async (k: string) => (map.has(k) ? structuredClone(map.get(k)!) : null),
    set: async (k: string, v: StoredJob) => void map.set(k, structuredClone(v)),
    delete: async (k: string) => void map.delete(k),
    keys: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p))
  }
}

const INSTALL = "5e1f0c2a-6b1d-4c3e-9a7f-2d6c0e8b4a10"

test("a kept job: running, then its answer; a running one past its time counts as failed", async () => {
  const store = memoryStore()
  const key = jobKey(INSTALL, "abc123def456")
  await store.set(key, { state: "running", at: Date.now() })
  setTimeout(() => void store.set(key, { state: "done", at: Date.now(), end: Date.now(), result: { intro: "", items: [], note: "", condition: "none" } }), 30)
  const job = await waitForJob(store, key, 2_000, undefined, 10)
  assert.equal(job?.state, "done")
  assert.equal(jobState({ state: "running", at: Date.now() - JOB_STALE_MS - 1 })?.state, "failed")
  assert.equal(await waitForJob(store, jobKey(INSTALL, "unknownjob12"), 0), null)
  // A day later the install's old jobs go.
  await store.set(jobKey(INSTALL, "oldjob123456"), { state: "done", at: Date.now() - 2 * 86_400_000, end: Date.now() - 2 * 86_400_000 })
  assert.equal(await sweepJobs(store, INSTALL), 1)
  assert.equal(store.map.size, 1)
})

test("/api/v2/similar-result: the answer once it's there, taken away when the chat has it", async () => {
  const store = memoryStore()
  useJobStore(store)
  try {
    const ask = async (q: string, method = "GET") => {
      const res = await resultFn(new Request(`https://x.test/api/v2/similar-result?${q}`, { method }))
      return { status: res.status, body: JSON.parse(await res.text()) }
    }
    assert.equal((await ask(`install=${INSTALL}&job=bad`)).status, 400)
    assert.deepEqual((await ask(`install=${INSTALL}&job=abc123def456`)).body, { state: "unknown" })
    await store.set(jobKey(INSTALL, "abc123def456"), { state: "running", at: Date.now() })
    assert.deepEqual((await ask(`install=${INSTALL}&job=abc123def456`)).body, { state: "running" })
    // Held open until it ends (spaces first, then the JSON).
    setTimeout(() => void store.set(jobKey(INSTALL, "abc123def456"), { state: "done", at: Date.now(), end: Date.now(), result: { intro: "Bags.", items: [], note: "", condition: "cheaper" } }), 50)
    const waited = await ask(`install=${INSTALL}&job=abc123def456&wait=5`)
    assert.deepEqual(waited.body, { state: "done", result: { intro: "Bags.", items: [], note: "", condition: "cheaper" } })
    assert.equal(store.map.size, 1)
    await ask(`install=${INSTALL}&job=abc123def456&take=1`)
    assert.equal(store.map.size, 0)
  } finally {
    useJobStore(null)
  }
})

test("a name the writer added words to after a dash: the item's own name is kept", () => {
  const c = candidate("https://ecomelani.com/p/mark-ryden", html("Mark Ryden Infinity XL Air Bag", "", price("89", "EUR", "Mark Ryden Infinity XL Air Bag")), "Mark Ryden Infinity XL Air Bag")
  const { result, dropped } = finishItems({ items: [{ page: 1, name: "Mark Ryden Infinity XL Air Bag — рюкзак с вакуумным сжатием 35 л", why: "", fit: "", met: "yes", shares: [1], differs: "" }], intro: "", note: "" }, [c], plan(), input().page)
  assert.deepEqual(dropped, [])
  assert.equal(result.items[0].name, "Mark Ryden Infinity XL Air Bag")
})

test("an item named on a list page doesn't take that page's price, stock or condition", () => {
  const list = `<html lang="en"><head><title>Travel Bags</title></head><body><main><h1>Travel Bags</h1><p>${words}</p>
    <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Luggage tag</span><span itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="0.89"><meta itemprop="priceCurrency" content="EUR"></span></div>
    <p>PACK&GO Backpack with Vacuum Pocket 24L 49.99 EUR</p></main></body></html>`
  const page = describePage(list.replace("</head>", `${price("0.89", "EUR", "Luggage tag")}</head>`), "https://superhome.example/travel-bags", "https://superhome.example/travel-bags", 200, 0)
  const c = candidate("https://superhome.example/travel-bags", list, "PACK&GO Backpack with Vacuum Pocket 24L", "list")
  const checked = { ...c, page, condition: { met: "unknown" as const, note: "" } }
  const { result } = finishItems({ items: [{ page: 1, name: "PACK&GO Backpack with Vacuum Pocket 24L", why: "", fit: "", met: "yes", shares: [1], differs: "" }], intro: "", note: "" }, [checked], plan(), input().page)
  assert.equal(result.items[0].price, undefined)
  assert.equal(result.items[0].met, "unknown")
  assert.doesNotMatch(writeMessage(input(), plan(), [checked]), /price 0\.89/)
})

// The real Backvac catalog's names (mybackvac.com/products.json, 2026-11-10), the Pro page linking none of its models.
const CATALOG = [
  ["Linen Laundry Bag", "linen-laundry-bag"], ["Blackout Mask", "eye-mask"], ["Backvac Flight Bundle", "backvac-flight-bundle"],
  ["Backvac Flight Carry-on", "backvac-flight-carry-on"], ["Backvac Overnight Bag", "backvac-overnight-bag"], ["Backvac Vacuum Kit", "backvac-vacuum-kit"],
  ["Backvac Pro", "backvacv1"], ["Backvac Pro Max Complete Kit", "backvac-pro-max-complete-travel-kit"], ["Backvac Pro Max - Travel Bundle", "backvac-pro-max-travel-bundle"],
  ["Backvac Pro Max", "backvacpromax"], ["Backvac Pro Travel Cover", "travelcover"], ["Backvac® Pro", "backvacpro"], ["Portable Air Pump", "airpump"]
].map(([title, handle]) => ({ title, handle }))

test("a Shopify shop: the brand's other models from its catalog when the page links none (the owner's Backvac Pro)", async () => {
  const proPage = html("Backvac® Pro | Backvac", `<button>Compare Models</button><script src="https://cdn.shopify.com/s/files/theme.js"></script>`, `<meta property="og:site_name" content="Backvac">${price("179.99", "USD", "Backvac® Pro")}`)
  const c = candidate("https://mybackvac.com/products/backvacpro", proPage, "Backvac® Pro")
  assert.equal(c.page.shopify, true)
  assert.deepEqual(siblingLinks(c), [])
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u === "https://mybackvac.com/products.json?limit=250") return new Response(JSON.stringify({ products: CATALOG }), { headers: { "content-type": "application/json; charset=utf-8" } })
    const body = u.endsWith("/backvacpromax") ? proMax : u.endsWith("/backvac-flight-carry-on") ? flight : ""
    return new Response(body || "<title>Not found</title>", { status: body ? 200 : 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const catalog = await shopifyCatalog("https://mybackvac.com", 3_000)
    // The model first; the item itself (an older listing of its name) left out; kits, bundles and covers after models.
    assert.deepEqual(siblingLinks(c, catalog).slice(0, 3).map((l) => l.text), ["Backvac Pro Max", "Backvac Flight Carry-on", "Backvac Overnight Bag"])
    const out = await siblingsStep([c], plan(), {}, "en", 5_000)
    assert.deepEqual(out.checked[0].siblings!.map((s) => s.page.name), ["Backvac Pro Max", "Backvac Flight Carry-On"])
    assert.match(writeMessage(input(), plan(), out.checked), /«Backvac Pro Max» — 272\.95 EUR — condition: no .*Built-In Trolley System/)
  } finally {
    globalThis.fetch = real
  }
})
