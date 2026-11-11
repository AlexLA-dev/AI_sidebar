// Build 94, Find similar: near them in a country the search tool can't locate the
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
const { Claims, distinctive, loadUnsupportedCountries, useCountryStore, traitExcerpt, checkCondition, finishItems, localQueries, reviewWords, reviewsStep, searchLocation, shopifyCatalog, siblingLinks, siblingsStep, writeMessage, WRITE_SYSTEM } = await import("../netlify/shared/similar.mts")
const { jobKey, jobState, sweepJobs, useJobStore, waitForJob, JOB_STALE_MS } = await import("../netlify/shared/jobs.mts")
const { default: resultFn } = await import("../netlify/functions/v2-similar-result.mts")
const { cleanItem } = await import("../src/shared/similar.ts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate
type StoredJob = import("../netlify/shared/jobs.mts").StoredJob

const words = "An electric standing desk with two motors and memory presets for sitting and standing heights. ".repeat(5)
const html = (title: string, body = "", head = "") => `<html lang="en"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${words}</p>${body}</main></body></html>`
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const plan = (over: Partial<Plan> = {}): Plan => ({
  category: "product", subject: "Liftdesk standing desk", traits: ["electric height adjustment", "dual motors", "140 cm desktop", "memory presets"],
  condition: { kind: "cheaper", maxPrice: 189, currency: "EUR", language: "", place: "Greece" }, sourcePrice: 189, sourceCurrency: "EUR",
  queries: ["electric standing desk dual motor", "Liftdesk standing desk alternative cheaper"], language: "en", ...over
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "Standing Desks - Liftdesk", url: "https://liftdesk.example/collections/standing-desks", text: "Liftdesk standing desk" }, facts: {}, condition: "Cheaper, delivery to Greece", locale: "en-GR", ...over })

function candidate(url: string, page: string, name: string, kind: "item" | "list" = "item", why = "ok"): CheckedCandidate {
  const checked = describePage(page, url, url, 200, 0)
  return { url, name, kind, resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(plan(), {}, checked), kept: why === "ok", why }
}

const price = (amount: string, currency = "EUR", name = "") => ld({ "@type": "Product", ...(name ? { name } : {}), offers: { "@type": "Offer", price: amount, priceCurrency: currency, availability: "https://schema.org/InStock" } })

// ---- where ------------------------------------------------------------------------------------

test("near them in a country the search tool can't locate: once learned, every search names the country", async () => {
  // Learned from the tool's refusal and kept (a store); nothing about any country is assumed beforehand.
  const kept: string[][] = []
  useCountryStore({ get: async () => ["GR"], set: async (codes) => { kept.push(codes) } })
  await loadUnsupportedCountries()
  const gr = input({ region: "local", country: "GR" })
  assert.equal(searchLocation(gr), null)
  // The planner named it already (in English, the person's language, or the country's own): as planned.
  const named = ["electric standing desk dual motor", "ηλεκτρικό γραφείο όρθιας εργασίας Ελλάδα"]
  assert.deepEqual(localQueries(gr, plan({ queries: named })), named)
  assert.deepEqual(localQueries(gr, plan({ queries: ["a", "b GR shop"] })), ["a", "b GR shop"])
  // No search names it: every one does now (shops abroad that deliver there come in a second round, if needed).
  assert.deepEqual(localQueries(gr, plan({ queries: ["electric standing desk dual motor", "standing desk cheaper"] })), [
    "electric standing desk dual motor Greece", "standing desk cheaper Greece"
  ])
  // Where the search can be located, or worldwide: the searches as planned.
  assert.deepEqual(localQueries(input({ region: "local", country: "DE" }), plan()), plan().queries)
  assert.deepEqual(localQueries(input({ region: "world", country: "GR" }), plan()), plan().queries)
  useCountryStore(null)
})

// ---- how close ----------------------------------------------------------------------------------

test("every item says how close it is; a page that wasn't opened says it's estimated from its description", () => {
  const opened = candidate("https://deskwise.example/p", html("Deskwise Pro", "", price("169.99", "USD", "Deskwise Pro")), "Deskwise Pro")
  const blocked: CheckedCandidate = { ...candidate("https://www.amazon.com/dp/B0X", html("x"), "Ergoplus Electric Standing Desk"), why: "unchecked", resultTitle: "Ergoplus Electric Standing Desk (160 cm)", kept: false }
  const { result } = finishItems({ items: [
    { page: 2, name: "Ergoplus Electric Standing Desk", why: "Two motors, memory presets.", fit: "", met: "unknown", shares: [1, 2, 3], differs: "" },
    { page: 1, name: "Deskwise Pro", why: "Two motors.", fit: "", met: "unknown", shares: [1, 3], differs: "No presets" }
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
  assert.deepEqual(markupRating(`<div itemprop="aggregateRating"><span itemprop="ratingValue">4.6</span> of <span itemprop="bestRating">5</span> <meta itemprop="reviewCount" content="412"></div>`), { value: 4.6, best: 5, count: 412 })
  // Judge.me's badge and Loox's: the product's own first, related products' after it.
  assert.deepEqual(markupRating(`<div class='jdgm-prev-badge' data-average-rating='4.60' data-number-of-reviews='412'></div><div class='jdgm-prev-badge' data-average-rating='5.00' data-number-of-reviews='3'></div>`), { value: 4.6, best: 5, count: 412 })
  assert.deepEqual(markupRating(`<div class="loox-rating" data-id="1" data-rating="4.9" data-raters="25,312"></div>`), { value: 4.9, best: 5, count: 25312 })
  // Stars without a count are a display, not a rating summary.
  assert.equal(markupRating(`<div class="stars" data-rating="5"></div>`), undefined)
})

test("a rating in the product's header text: the average with how many next to it", () => {
  assert.deepEqual(textRating("Deskora Pro electric standing desk. 4.6 of 5 rating from 412 ratings. Memory presets."), { value: 4.6, best: 5, count: 412 })
  assert.deepEqual(textRating("Rated 4,8 out of 5 stars · 1 204 reviews"), { value: 4.8, best: 5, count: 1204 })
  assert.equal(textRating("Our customers give us 5 out of 5!"), undefined)
  // Far down the page (a related product's): not the item's.
  assert.equal(textRating(`${"x ".repeat(900)} 4.2 out of 5 · 40 reviews`), undefined)
  const page = describePage(html("Deskora Pro", "<p>4.6 of 5 rating from 412 ratings</p>"), "https://deskora.example/products/deskorapro", "https://deskora.example/products/deskorapro", 200, 0)
  // The header comes after the description in this page; within the first 1500 characters it's the item's.
  assert.deepEqual(page.rating, { value: 4.6, best: 5, count: 412 })
})

test("the page's own reviews section is kept for what reviewers say — only one that reads like reviews", () => {
  const reviews = `<section><h2>Customer Reviews</h2>${"<div class='jdgm-rev'><span>★★★★★</span><b>Anna K. Verified Buyer</b><p>Goes up quietly, the presets work. The tray feels cheap though.</p><small>03/10/2026 · Was this helpful?</small></div>".repeat(8)}</section>`
  const text = reviewsSection(html("Deskora Pro", reviews))
  assert.match(text ?? "", /^Customer Reviews ★★★★★ Anna K\. Verified Buyer Goes up quietly/)
  assert.equal(reviewsSection(html("No reviews here")), undefined)
  // A header's count and a marketing block: not reviews.
  const marketing = `<p>4.9 · 25,000 reviews</p><section><h2>Built for real offices</h2>${"<p>Stand up with our patented dual-motor lift and work better than ever before.</p>".repeat(8)}</section>`
  assert.equal(reviewsSection(html("Deskora Pro Max", marketing)), undefined)
})

test("what reviewers like and dislike: short, without numbers", () => {
  assert.deepEqual(reviewWords({ pros: "quiet motors, sturdy frame.", cons: "" }), { pros: "quiet motors, sturdy frame" })
  assert.deepEqual(reviewWords({ pros: "", cons: "the price" }), { cons: "the price" })
  assert.equal(reviewWords({ pros: "4.8 stars", cons: "" }), null)
  assert.equal(reviewWords({}), null)
})

test("the item's reviews reach the panel as one line's parts; the writer sees likes and dislikes", () => {
  const c = candidate("https://deskora.example/products/deskorapro", html("Deskora Pro", "", price("179.99", "USD", "Deskora Pro")), "Deskora Pro")
  c.reviews = { rating: { value: 4.6, best: 5, count: 412 }, pros: "quiet motors", cons: "the price", sources: ["https://deskora.example/products/deskorapro"] }
  const { result } = finishItems({ items: [{ page: 1, name: "Deskora Pro", why: "Standing desk.", fit: "", met: "unknown", shares: [1, 3, 4], differs: "No presets" }], intro: "", note: "" }, [c], plan(), input().page)
  assert.deepEqual(result.items[0].reviews, { rating: { value: 4.6, best: 5, count: 412 }, pros: "quiet motors", cons: "the price", sources: ["https://deskora.example/products/deskorapro"] })
  assert.match(writeMessage(input(), plan(), [c]), /reviews: 4\.6 of 5 \(412 ratings\); reviewers like: quiet motors; dislike: the price; from deskora\.example/)
  assert.match(WRITE_SYSTEM, /No ratings or reviews in it/)
})

// ---- the brand's other models ------------------------------------------------------------------

const deskoraPro = html("Deskora Pro – DESKORA", `
  <a href="/products/deskorapro?variant=1">Deskora Pro Black</a>
  <a href="/products/deskorapromax">Deskora Pro Max</a>
  <a href="/products/deskora-compact">Deskora Compact</a>
  <a href="/products/desk-mat">Eye mask</a>
  <a href="/collections/all">Shop all</a>
  <a href="https://other.example/products/deskora-clone">Deskora clone</a>
  <a href="/">Deskora</a>`, `<meta property="og:site_name" content="DESKORA">${price("179.99", "USD", "Deskora Pro")}`)
const proMax = html("Deskora Pro Max", "<ul><li>Memory Keypad</li><li>Dual Motors Lift System</li></ul>", price("272.95", "EUR", "Deskora Pro Max"))
const flight = html("Deskora Compact", "<p>One motor, no presets.</p>", price("149.95", "EUR", "Deskora Compact"))

test("the brand's other models on the item's site: named by the brand, not the item itself, the closest first", () => {
  const c = candidate("https://deskora.example/products/deskorapro", deskoraPro, "Deskora Pro")
  assert.deepEqual(siblingLinks(c).map((l) => l.url), ["https://deskora.example/products/deskorapromax", "https://deskora.example/products/deskora-compact"])
})

test("before the writer says an item lacks something, it sees the model that has it, with its price and the condition", async () => {
  const c = candidate("https://deskora.example/products/deskorapro", deskoraPro, "Deskora Pro")
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url)
    const body = u.endsWith("/deskorapromax") ? proMax : u.endsWith("/deskora-compact") ? flight : ""
    return new Response(body || "<title>Not found</title>", { status: body ? 200 : 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const out = await siblingsStep([c], plan(), {}, "en", 5_000)
    const siblings = out.checked[0].siblings!
    assert.deepEqual(siblings.map((s) => [s.page.name, s.condition.met]), [["Deskora Pro Max", "no"], ["Deskora Compact", "yes"]])
    // The cheaper model meets the condition: an item of its own too.
    assert.deepEqual(out.added.map((a) => a.name), ["Deskora Compact"])
    assert.deepEqual(out.stats, { items: 1, opened: 2, added: 1 })
    const message = writeMessage(input(), plan(), out.checked)
    assert.match(message, /other models on its site \(opened now\):\n {2}«Deskora Pro Max» — 272\.95 EUR — condition: no \(price 272\.95 EUR vs 189 EUR\) — .*Dual Motors Lift System/)
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
  const c = candidate("https://moebel.example/p/nordwerk", html("Nordwerk Studio Desk XL", "", price("89", "EUR", "Nordwerk Studio Desk XL")), "Nordwerk Studio Desk XL")
  const { result, dropped } = finishItems({ items: [{ page: 1, name: "Nordwerk Studio Desk XL — стол с электроприводом 160 см", why: "", fit: "", met: "yes", shares: [1], differs: "" }], intro: "", note: "" }, [c], plan(), input().page)
  assert.deepEqual(dropped, [])
  assert.equal(result.items[0].name, "Nordwerk Studio Desk XL")
})

test("an item named on a list page doesn't take that page's price, stock or condition", () => {
  const list = `<html lang="en"><head><title>Desk Frames</title></head><body><main><h1>Desk Frames</h1><p>${words}</p>
    <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Cable clip</span><span itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="0.89"><meta itemprop="priceCurrency" content="EUR"></span></div>
    <p>ERGO&GO Desk Frame 120 cm 49.99 EUR</p></main></body></html>`
  const page = describePage(list.replace("</head>", `${price("0.89", "EUR", "Cable clip")}</head>`), "https://office.example/desk-frames", "https://office.example/desk-frames", 200, 0)
  const c = candidate("https://office.example/desk-frames", list, "ERGO&GO Desk Frame 120 cm", "list")
  const checked = { ...c, page, condition: { met: "unknown" as const, note: "" } }
  const { result } = finishItems({ items: [{ page: 1, name: "ERGO&GO Desk Frame 120 cm", why: "", fit: "", met: "yes", shares: [1], differs: "" }], intro: "", note: "" }, [checked], plan(), input().page)
  assert.equal(result.items[0].price, undefined)
  assert.equal(result.items[0].met, "unknown")
  assert.doesNotMatch(writeMessage(input(), plan(), [checked]), /price 0\.89/)
})

// A shop's catalog as /products.json gives it (names, handles, product types, variant prices), the item's page linking
// none of its models. Accessories are told by their product type and price, not by their names.
const CATALOG = ([
  ["Cable Tray", "cable-tray", "Accessories", "19"], ["Desk Mat", "desk-mat", "Accessories", "15"],
  ["Deskora Compact Bundle", "deskora-compact-bundle", "Bundles", "249"], ["Deskora Compact", "deskora-compact", "Desks", "199"],
  ["Deskora Mini", "deskora-mini", "Desks", "149"], ["Deskora Cable Kit", "deskora-cable-kit", "Accessories", "39"],
  ["Deskora Pro", "deskorav1", "Desks", "179.99"], ["Deskora Pro Max Complete Kit", "deskora-pro-max-complete-office-kit", "Bundles", "399"],
  ["Deskora Pro Max - Office Bundle", "deskora-pro-max-office-bundle", "Bundles", "349"], ["Deskora Pro Max", "deskorapromax", "Desks", "299.99"],
  ["Deskora Pro Cover", "procover", "Accessories", "29"], ["Deskora® Pro", "deskorapro", "Desks", "179.99"], ["Monitor Arm", "monitor-arm", "Accessories", "25"]
] as const).map(([title, handle, product_type, price]) => ({ title, handle, product_type, variants: [{ price }] }))

test("a Shopify shop: the brand's other models from its catalog when the page links none (a desk shop)", async () => {
  const proPage = html("Deskora® Pro | Deskora", `<button>Compare Models</button><script src="https://cdn.shopify.com/s/files/theme.js"></script>`, `<meta property="og:site_name" content="Deskora">${price("179.99", "USD", "Deskora® Pro")}`)
  const c = candidate("https://deskora.example/products/deskorapro", proPage, "Deskora® Pro")
  assert.equal(c.page.shopify, true)
  assert.deepEqual(siblingLinks(c), [])
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u === "https://deskora.example/products.json?limit=250") return new Response(JSON.stringify({ products: CATALOG }), { headers: { "content-type": "application/json; charset=utf-8" } })
    const body = u.endsWith("/deskorapromax") ? proMax : u.endsWith("/deskora-compact") ? flight : ""
    return new Response(body || "<title>Not found</title>", { status: body ? 200 : 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const catalog = await shopifyCatalog("https://deskora.example", 3_000)
    // The model first; the item itself (an older listing of its name) left out; other product types (bundles, accessories) after models.
    assert.deepEqual(siblingLinks(c, catalog).slice(0, 3).map((l) => l.text), ["Deskora Pro Max", "Deskora Compact", "Deskora Mini"])
    const out = await siblingsStep([c], plan(), {}, "en", 5_000)
    assert.deepEqual(out.checked[0].siblings!.map((s) => s.page.name), ["Deskora Pro Max", "Deskora Compact"])
    assert.match(writeMessage(input(), plan(), out.checked), /«Deskora Pro Max» — 272\.95 EUR — condition: no .*Dual Motors Lift System/)
  } finally {
    globalThis.fetch = real
  }
})

test("one marketplace listing at most across all searches: their pages can't be checked", () => {
  const claims = new Claims({ title: "", url: "https://liftdesk.example/collections/standing-desks", text: "" })
  const c = (url: string, name: string) => ({ url, name, kind: "item" as const, resultTitle: name, pageAge: null })
  const taken = claims.take([
    c("https://www.amazon.com/Ergoplus/dp/B0GJ5BMQH9", "Ergoplus Electric Standing Desk"),
    c("https://us.amazon.com/Airpack/dp/B0DMW5GSPD", "Ergodesk Duo"),
    c("https://www.ebay.com/itm/1", "Marketron Desk"),
    c("https://deskwise.example/p", "Deskwise Pro"),
    c("https://deskora.example/products/deskorapro", "Deskora Pro")
  ])
  assert.deepEqual(taken.map((t) => new URL(t.url).hostname), ["www.amazon.com", "deskwise.example", "deskora.example"])
})

test("a rated item without reviewers' words on its page still gets a review page looked for (412 ratings, no words)", async () => {
  const rated = candidate("https://deskora.example/products/deskorapro", html("Deskora Pro", "", ld({ "@type": "Product", name: "Deskora Pro", aggregateRating: { ratingValue: 4.6, reviewCount: 412 } })), "Deskora Pro")
  const withWords = candidate("https://deskwise.example/p", html("Deskwise Pro", `<section><h2>Customer Reviews</h2>${"<p>Verified Buyer · 2 weeks ago</p><p>Lift works, sturdy at full height.</p>".repeat(10)}</section>`), "Deskwise Pro")
  assert.ok(withWords.page.reviewsText)
  const asked: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      asked.push(JSON.stringify(body.messages))
      const content = [{ type: "text", text: Array.isArray(body.tools) && body.tools.length ? "done" : JSON.stringify({ items: [{ item: 2, page: 2, pros: "lift works", cons: "", quote: "Lift works, sturdy at full height." }] }) }]
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { headers: { "content-type": "application/json" } })
    }
    return new Response("<title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const out = await reviewsStep([rated, withWords], plan(), input(), "en", 15_000)
    // One search, for the rated one only (the other has its reviewers' words on its own page).
    assert.match(asked[0], /Deskora Pro review/)
    assert.doesNotMatch(asked[0], /Deskwise Pro review/)
    assert.deepEqual(out.checked[0].reviews?.rating, { value: 4.6, best: 5, count: 412 })
    assert.equal(out.checked[1].reviews?.pros, "lift works")
  } finally {
    globalThis.fetch = real
  }
})

test("a name repeated after a dash is the name once, and a duplicate of an item already listed", () => {
  const home = candidate("https://getlumo.example/", html("Lumo", "", price("29.99", "USD", "Lumo")), "Lumo")
  const product = candidate("https://getlumo.example/products/lumo", html("Lumo", "", price("24.99", "USD", "Lumo")), "Lumo")
  const { result, dropped } = finishItems({ items: [
    { page: 1, name: "Lumo", why: "", fit: "", met: "unknown", shares: [1], differs: "" },
    { page: 2, name: "Lumo — Lumo", why: "", fit: "", met: "unknown", shares: [1], differs: "" }
  ], intro: "", note: "" }, [home, product], plan(), input().page)
  assert.deepEqual(result.items.map((i) => i.name), ["Lumo"])
  assert.deepEqual(dropped.map((d) => d.why), ["duplicate"])
})

test("a model's excerpt keeps what it says of the traits, however far down the page", () => {
  const text = `DESKORA PRO MAX Excellent 4.9 | Loved By 25,000+ Customers 272,95 € Compare Models Size Guide ${"Black Friday gifts and free shipping on every order. ".repeat(12)} Memory Keypad Dual Motors Lift System USB-C Charging Anti-Collision Sensor`
  const out = traitExcerpt(text, ["electric height adjustment", "dual motors", "140 cm desktop", "anti-collision sensor"])
  assert.ok(out.length <= 450)
  assert.match(out, /^DESKORA PRO MAX/)
  assert.match(out, /Dual Motors Lift System/)
  assert.match(out, /Anti-Collision Sensor/)
})

test("a review page is an item's when it names what sets the item apart, and when it isn't about two items at once", async () => {
  // What the other names here share (a kind of thing) tells no item apart; worked out from this answer's own names.
  const names = ["Discoverer 160 Standing Desk", "Pioneer 140 Standing Desk"]
  assert.deepEqual(distinctive("Discoverer 160 Standing Desk", plan(), names), ["discoverer"])
  assert.deepEqual(distinctive("Deskora Pro Max", plan(), names), ["deskora", "pro", "max"])
  const a = candidate("https://deskshop.example/discoverer", html("Discoverer 160 Standing Desk", "", price("119.99", "USD", "Discoverer 160 Standing Desk")), "Discoverer 160 Standing Desk")
  const b = candidate("https://deskshop.example/pioneer", html("Pioneer 140 Standing Desk", "", price("139.99", "USD", "Pioneer 140 Standing Desk")), "Pioneer 140 Standing Desk")
  const generic = html("Electric Standing Desk reviews", "<p>Customers rate this standing desk 3.9 out of 5.</p>", ld({ "@type": "Product", name: "Electric Standing Desk", aggregateRating: { ratingValue: 3.9, reviewCount: 101 } }))
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      const q = JSON.stringify(body.messages).match(/Run this search: ([^"\\]+)/)?.[1] ?? ""
      const content = Array.isArray(body.tools) && body.tools.length
        ? [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: q } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.walmart.com/reviews/product/1", title: "Standing Desk 160 140 reviews", page_age: null, encrypted_content: "x" }] }, { type: "text", text: "done" }]
        : [{ type: "text", text: "{\"items\":[]}" }]
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } }), { headers: { "content-type": "application/json" } })
    }
    return new Response(u.includes("walmart") ? generic : "<title>x</title>", { status: u.includes("walmart") ? 200 : 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    const out = await reviewsStep([a, b], plan(), input(), "en", 15_000)
    assert.equal(out.checked[0].reviews, undefined)
    assert.equal(out.checked[1].reviews, undefined)
    assert.equal(out.stats.pages, 0)
  } finally {
    globalThis.fetch = real
  }
})

test("an item that shares none of the traits isn't an alternative (0 %)", () => {
  const gym = candidate("https://nordwerk.example/cruise", html("Office Chair Nordwerk Cruise", "", price("99", "EUR", "Office Chair Nordwerk Cruise")), "Office Chair Nordwerk Cruise")
  const pack = candidate("https://nordwerk.example/infinity", html("Standing Desk Nordwerk Infinity Duo", "", price("129", "EUR", "Standing Desk Nordwerk Infinity Duo")), "Standing Desk Nordwerk Infinity Duo")
  const { result, dropped } = finishItems({ items: [
    { page: 1, name: "Office Chair Nordwerk Cruise", why: "", fit: "", met: "yes", shares: [], differs: "An office chair" },
    { page: 2, name: "Standing Desk Nordwerk Infinity Duo", why: "", fit: "", met: "yes", shares: [1, 3], differs: "No presets" }
  ], intro: "", note: "" }, [gym, pack], plan(), input().page)
  assert.deepEqual(result.items.map((i) => i.name), ["Standing Desk Nordwerk Infinity Duo"])
  assert.deepEqual(dropped.map((d) => d.why), ["shares none of the traits"])
})
