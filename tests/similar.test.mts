import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const { checkPage, isBotWall, isoSeconds, nameScore, normalizeUrl, readPrice, safeUrl, softNotFound } = await import("../netlify/shared/pagecheck.mts")
const { checkCondition, finishItems, pickCandidates, resultsOf, similarEvalToken, stripUrls, checkPlan } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate
type CheckedPage = import("../netlify/shared/pagecheck.mts").CheckedPage

// ------------------------------------------------------------ addresses

test("only public http(s) addresses are opened", () => {
  assert.ok(safeUrl("https://www.example.com/a?b=1"))
  for (const bad of ["ftp://example.com", "http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "https://intranet/", "https://a.internal/x", "https://u:p@example.com/", "https://example.com:8443/"]) {
    assert.equal(safeUrl(bad), null, bad)
  }
})

test("addresses compare without tracking, fragments, www and a trailing slash", () => {
  assert.equal(normalizeUrl("https://www.Example.com/p/1/?utm_source=x&id=2#top"), normalizeUrl("http://example.com/p/1?id=2"))
  assert.notEqual(normalizeUrl("https://example.com/p/1?id=2"), normalizeUrl("https://example.com/p/1?id=3"))
})

// ------------------------------------------------------------ verdicts

test("soft-404: a deep address sent home, an error page, a 'not found' title", () => {
  assert.equal(softNotFound("https://shop.com/p/headphones-x", "https://shop.com/", "Shop", "", "welcome"), "redirected to the home page")
  assert.equal(softNotFound("https://shop.com/p/headphones-x", "https://shop.com/en-us/", "Shop", "", "welcome"), "redirected to the home page")
  assert.equal(softNotFound("https://shop.com/p/x", "https://shop.com/404.html", "Oops", "", ""), "redirected to an error page")
  assert.equal(softNotFound("https://site.ru/a/b", "https://site.ru/a/b", "Страница не найдена", "", ""), "the page says it was not found")
  assert.equal(softNotFound("https://site.com/a", "https://site.com/a", "Great headphones", "Great headphones", "x".repeat(3000)), null)
  // A page that mentions "404" deep in a long text is not a 404 page.
  assert.equal(softNotFound("https://site.com/a", "https://site.com/a", "Error codes explained", "Error codes", "Lorem ".repeat(400) + " 404 not found means"), null)
})

test("bot walls are told apart from dead pages", () => {
  assert.equal(isBotWall(403, ""), true)
  assert.equal(isBotWall(200, "<title>Just a moment...</title>"), true)
  assert.equal(isBotWall(200, "<title>Headphones</title>"), false)
})

test("prices, currencies and ISO durations", () => {
  assert.deepEqual(readPrice("129.99 USD"), { amount: 129.99, currency: "USD" })
  assert.deepEqual(readPrice("1.299,00 €"), { amount: 1299, currency: "EUR" })
  assert.equal(readPrice("call us"), undefined)
  assert.equal(isoSeconds("PT1H5M30S"), 3930)
  assert.equal(isoSeconds("PT45M"), 2700)
  assert.equal(isoSeconds("soon"), null)
})

test("name match: words of the name on the page, scripts without spaces as a whole", () => {
  const page = { title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones | Sony US", name: "", text: "" }
  assert.ok(nameScore("Sony WH-1000XM5", page) >= 0.99)
  assert.ok(nameScore("Bose QuietComfort Ultra", page) < 0.5)
  assert.ok(nameScore("ソニー ヘッドホン", { title: "ソニー ワイヤレスヘッドホン", name: "", text: "" }) >= 0.5)
})

// ------------------------------------------------------------ the checker, with a fake web

function fakeWeb(pages: Record<string, { status: number; headers?: Record<string, string>; body?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const p = pages[url]
    if (!p) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND") })
    return new Response(p.body ?? "", { status: p.status, headers: { "content-type": "text/html; charset=utf-8", ...(p.headers ?? {}) } })
  }) as typeof fetch
}

const PRODUCT = `<html lang="en"><head><title>Acme Q20 Headphones</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Q20 Headphones","offers":{"@type":"Offer","price":"79.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><main><h1>Acme Q20 Headphones</h1><p>${"Wireless noise cancelling headphones. ".repeat(20)}</p></main></body></html>`

test("redirects are followed hop by hop, and price and stock are read", async () => {
  const fetcher = fakeWeb({
    "https://a.com/q20": { status: 301, headers: { location: "/products/q20" } },
    "https://a.com/products/q20": { status: 200, body: PRODUCT }
  })
  const page = await checkPage("https://a.com/q20", { fetcher })
  assert.equal(page.status, "ok")
  assert.equal(page.finalUrl, "https://a.com/products/q20")
  assert.equal(page.hops, 1)
  assert.deepEqual(page.price, { amount: 79.99, currency: "USD" })
  assert.equal(page.stock, "in")
  assert.equal(page.lang, "en")
})

test("dead, soft-404, blocked, archived and unsafe pages", async () => {
  const fetcher = fakeWeb({
    "https://a.com/gone": { status: 404 },
    "https://a.com/old-product": { status: 302, headers: { location: "https://a.com/" } },
    "https://a.com/": { status: 200, body: "<title>A shop</title><main>" + "Welcome ".repeat(100) + "</main>" },
    "https://b.com/item": { status: 403, body: "Access Denied" },
    "https://c.com/x": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }
  })
  assert.equal((await checkPage("https://a.com/gone", { fetcher })).status, "dead")
  assert.equal((await checkPage("https://a.com/old-product", { fetcher })).status, "soft404")
  assert.equal((await checkPage("https://b.com/item", { fetcher })).status, "blocked")
  assert.equal((await checkPage("https://web.archive.org/web/2020/https://a.com/x", { fetcher })).status, "archived")
  assert.equal((await checkPage("https://c.com/x", { fetcher })).status, "unsafe")
  assert.equal((await checkPage("https://nowhere.example/x", { fetcher })).status, "dead")
})

// ------------------------------------------------------------ engine A's guards

const plan = (kind: Plan["condition"]["kind"], extra: Partial<Plan["condition"]> = {}): Plan => ({
  category: "product", subject: "Soundcore Space Q45", traits: [], sourcePrice: 0, sourceCurrency: "", queries: ["q"], language: "en",
  condition: { kind, maxPrice: 0, currency: "", language: "", place: "", ...extra }
})

const page = (over: Partial<CheckedPage> = {}): CheckedPage => ({
  url: "https://shop.com/p", finalUrl: "https://shop.com/p", status: "ok", http: 200, hops: 0, reason: "", title: "Acme Q20 Headphones",
  name: "Acme Q20 Headphones", description: "", siteName: "", types: [], lang: "en", text: "Acme Q20 Headphones wireless", ms: 1, ...over
})

test("conditions are decided from what the page states", () => {
  const facts = { price: { amount: 149.99, currency: "USD" } }
  assert.equal(checkCondition(plan("cheaper"), facts, page({ price: { amount: 79.99, currency: "USD" } })).met, "yes")
  assert.equal(checkCondition(plan("cheaper"), facts, page({ price: { amount: 199, currency: "USD" } })).met, "no")
  assert.equal(checkCondition(plan("cheaper"), facts, page({ price: { amount: 79, currency: "EUR" } })).met, "unknown")
  assert.equal(checkCondition(plan("cheaper"), facts, page()).met, "unknown")
  assert.equal(checkCondition(plan("cheaper", { maxPrice: 80 }), {}, page({ price: { amount: 80, currency: "USD" } })).met, "yes")
  assert.equal(checkCondition(plan("in_stock"), {}, page({ stock: "out" })).met, "no")
  assert.equal(checkCondition(plan("in_stock"), {}, page({ stock: "in" })).met, "yes")
  assert.equal(checkCondition(plan("none"), {}, page({ reason: "expired" })).met, "no")
  assert.equal(checkCondition(plan("language", { language: "de" }), {}, page({ lang: "de-DE" })).met, "yes")
  assert.equal(checkCondition(plan("newer"), { published: "2025-01-01T00:00:00Z" }, page({ published: "2026-02-01T00:00:00Z" })).met, "yes")
})

test("candidates keep only addresses that came back from the search", () => {
  const results = [
    { url: "https://shop.com/acme-q20?utm_source=x", title: "Acme Q20", pageAge: null, query: "q" },
    { url: "https://soundcore.com/products/space-q45", title: "Space Q45", pageAge: null, query: "q" }
  ]
  const picked = pickCandidates({
    candidates: [
      { url: "https://shop.com/acme-q20", name: "Acme Q20", kind: "item" },
      { url: "https://made-up.com/brand-new", name: "Invented", kind: "item" },
      { url: "https://soundcore.com/products/space-q45", name: "Space Q45", kind: "item" }
    ]
  }, results, { title: "Space Q45", url: "https://www.soundcore.com/products/space-q45", text: "" }, 12)
  assert.deepEqual(picked.map((c) => c.name), ["Acme Q20"])
  assert.equal(picked[0].url, results[0].url)
  // No usable JSON: the results themselves.
  assert.equal(pickCandidates(null, results, { title: "", url: "", text: "" }, 12).length, 2)
})

test("search results are read from the response blocks", () => {
  const content = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "cheap anc headphones" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.com/x", title: "X", page_age: "2 days ago", encrypted_content: "" }] },
    { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }
  ] as unknown as Parameters<typeof resultsOf>[0]
  assert.deepEqual(resultsOf(content), [{ url: "https://a.com/x", title: "X", pageAge: "2 days ago", query: "cheap anc headphones" }])
})

test("the writer's items: our links, the name on the page, no duplicates, not the item itself, no failed conditions", () => {
  const cand = (n: number, over: Partial<CheckedCandidate> = {}): CheckedCandidate => ({
    url: `https://shop${n}.com/p`, name: `Acme Q${n}`, kind: "item", resultTitle: `Acme Q${n}`, pageAge: null,
    page: page({ url: `https://shop${n}.com/p`, finalUrl: `https://shop${n}.com/final`, title: `Acme Q${n} Headphones`, name: `Acme Q${n}`, price: { amount: 79, currency: "USD" } }),
    score: 1, condition: { met: "yes", note: "" }, kept: true, why: "ok", ...over
  })
  const pages = [cand(1), cand(2), cand(3, { condition: { met: "no", note: "" } }), cand(4, { kind: "list", page: page({ title: "Best budget headphones", text: "Our picks: Acme Q1, Zeta Z9, Soundcore Space Q45 and more" }) })]
  const { result, dropped } = finishItems({
    intro: "Here are some, see https://evil.example/x",
    items: [
      { page: 1, name: "Acme Q1", why: "Same features (www.spam.com/buy)", fit: "cheaper", met: "yes" },
      { page: 1, name: "Acme Q1", why: "again", fit: "", met: "yes" },
      { page: 2, name: "Totally Different Thing", why: "", fit: "", met: "yes" },
      { page: 3, name: "Acme Q3", why: "", fit: "", met: "yes" },
      { page: 9, name: "Ghost", why: "", fit: "", met: "yes" },
      { page: 4, name: "Zeta Z9", why: "named in a review", fit: "", met: "unknown" },
      { page: 4, name: "Soundcore Space Q45", why: "", fit: "", met: "yes" }
    ],
    note: ""
  }, pages, plan("cheaper"), { title: "", url: "", text: "" })
  assert.deepEqual(result.items.map((i) => i.name), ["Acme Q1", "Zeta Z9"])
  assert.equal(result.items[0].url, "https://shop1.com/final")
  assert.equal(result.items[0].price, "79 USD")
  assert.equal(result.items[1].source, "list")
  assert.ok(!/https?:|www\./.test(result.intro + result.items[0].why))
  assert.deepEqual(dropped.map((d) => d.why).sort(), ["duplicate", "fails the condition", "no checked page", "the item itself", "the page doesn't name it"].sort())
})

test("addresses a model writes are removed", () => {
  assert.equal(stripUrls("Buy it at [Acme](https://acme.com/x) or https://b.com/y now"), "Buy it at Acme or now")
  assert.equal(stripUrls("Notion.so is fine; see example.com/page"), "Notion.so is fine; see")
})

test("the plan is checked: known kinds, no condition when none was asked, at most 4 queries", () => {
  const input = { page: { title: "T", url: "", text: "" }, facts: {}, condition: "", locale: "en-US" }
  const p = checkPlan({ category: "weird", subject: "", condition: { kind: "cheaper" }, queries: ["a", "a", "b", "c", "d", "e"] }, input)
  assert.equal(p.category, "other")
  assert.equal(p.condition.kind, "none")
  assert.deepEqual(p.queries, ["a", "b", "c", "d"])
  assert.equal(p.subject, "T")
})

test("the evaluation token is derived, never configured", () => {
  assert.equal(similarEvalToken("k"), similarEvalToken("k"))
  assert.notEqual(similarEvalToken("k"), similarEvalToken("other"))
})

test("soft-404: a redirect that drops the item's id or slug, or lands on ?error=true", () => {
  assert.equal(softNotFound("https://www.ikea.com/us/en/p/markus-office-chair-vissle-dark-gray-70261150/", "https://www.ikea.com/us/en/cat/products-products/", "Products - IKEA", "", ""), "redirected away from the item")
  assert.equal(softNotFound("https://job-boards.greenhouse.io/contentful/jobs/7725939", "https://job-boards.greenhouse.io/contentful?error=true", "Jobs at Contentful", "", ""), "redirected to an error page")
  assert.equal(softNotFound("https://job-boards.greenhouse.io/greenhouse/jobs/7846916", "https://www.greenhouse.com/careers/opportunities", "Opportunities", "", ""), "redirected away from the item")
  // A successor that keeps words of the slug, a locale added, a short link: left to the name check.
  assert.equal(softNotFound("https://www.soundcore.com/products/space-q45-a3040011", "https://www.soundcore.com/products/d1402-space-2-comfortable-noise-cancelling-headphones", "soundcore Space 2", "", ""), null)
  assert.equal(softNotFound("https://shop.com/p/acme-q20-black", "https://shop.com/en-us/p/acme-q20-black", "Acme Q20", "", ""), null)
  assert.equal(softNotFound("https://amzn.to/3xYz", "https://www.amazon.com/dp/B0C1234567", "Acme", "", ""), null)
  assert.equal(softNotFound("https://www.nature.com/articles/s41586-021-03819-2", "https://www.nature.com/articles/s41586-021-03819-2?error=cookies_not_supported&code=x", "Highly accurate protein structure prediction with AlphaFold | Nature", "", ""), null)
  assert.equal(isBotWall(200, "<title>Client Challenge</title>"), true)
})

test("language: the content's own, else the script of its title and text, the site's only to confirm", async () => {
  const { languageCheck } = await import("../netlify/shared/pagecheck.mts")
  const yt = (title: string) => ({ lang: "en", title, text: "", inLanguage: undefined })
  assert.equal(languageCheck("ru", yt("Нейронные сети с нуля: пишем GPT своими руками и разбираемся")), "yes")
  assert.equal(languageCheck("ru", yt("Let's build GPT: from scratch, in code, spelled out by Andrej")), "no")
  assert.equal(languageCheck("de", yt("Python lernen für Anfänger – der komplette Kurs auf Deutsch")), "unknown")
  // A Russian repository on GitHub: its title is Russian, the interface around it English.
  assert.equal(languageCheck("ru", { lang: "en", title: "Математика LLM — Создаём ChatGPT своими руками", text: "Skip to content Navigation Menu Product Solutions Resources Open Source Enterprise Pricing Sign in Sign up", inLanguage: undefined }), "yes")
  assert.equal(languageCheck("de", { lang: "de", title: "Python lernen für Anfänger – der komplette Kurs", text: "", inLanguage: undefined }), "yes")
  assert.equal(languageCheck("de", { lang: "de", title: "x", text: "", inLanguage: "en" }), "no")
})

test("streamed items: each object of the array as soon as its brace closes, strings and escapes respected", async () => {
  const { ArrayScanner } = await import("../netlify/shared/similar.mts")
  const s = new ArrayScanner("items")
  const json = JSON.stringify({ items: [{ page: 1, name: 'A "quoted" {brace}', why: "x\\y" }, { page: 2, name: "B" }], intro: "hi", note: "" })
  const got: unknown[] = []
  for (let i = 0; i < json.length; i += 7) got.push(...s.feed(json.slice(i, i + 7)))
  assert.deepEqual(got, [{ page: 1, name: 'A "quoted" {brace}', why: "x\\y" }, { page: 2, name: "B" }])
})

test("parallel search: picks interleaved by rank; each address and item once; at most 3 a site; follow-ups only for items not covered", async () => {
  const { Claims, interleave } = await import("../netlify/shared/similar.mts")
  assert.deepEqual(interleave([[1, 2, 3], [10], [20, 21]]), [1, 10, 20, 2, 21, 3])
  const claims = new Claims({ title: "", url: "https://self.com/p", text: "" })
  const c = (url: string, name: string, kind: "item" | "list" = "item") => ({ url, name, kind, resultTitle: name, pageAge: null })
  const first = claims.take([c("https://self.com/p", "Self"), c("https://a.com/1", "Acme Q1"), c("https://a.com/2", "Acme Q2"), c("https://a.com/3", "Acme Q3"), c("https://a.com/4", "Acme Q4")])
  assert.deepEqual(first.map((x) => x.name), ["Acme Q1", "Acme Q2", "Acme Q3"])
  const second = claims.take([c("https://a.com/1?utm_source=x", "Acme Q1 again"), c("https://b.com/q1", "Acme Q1"), c("https://b.com/list", "Best list", "list")])
  assert.deepEqual(second.map((x) => x.name), ["Best list"])
  assert.equal(claims.covers("Acme Q2"), true)
  assert.equal(claims.covers("Zeta Z9 headphones"), false)
})

test("production serves only the engines in SIMILAR_ENGINES: with \"a\", a request for B is refused before anything runs", async () => {
  const { spawnSync } = await import("node:child_process")
  const script = `
    process.env.SIMILAR_ENGINES = "a"
    process.env.SUPABASE_URL = "https://db.test"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
    process.env.GEMINI_API_KEY = "g"
    process.env.ANTHROPIC_API_KEY = "a"
    globalThis.fetch = async () => { throw new Error("nothing may be fetched") }
    const { default: handler } = await import(${JSON.stringify(new URL("../netlify/functions/v2-similar.mts", import.meta.url).href)})
    const ask = (engine) => handler(new Request("http://x/api/v2/similar", { method: "POST", body: JSON.stringify({ engine, installId: "5e1f0c2a-6b1d-4c3e-9a7f-2d6c0e8b4a10", page: { title: "T", text: "x" } }) }), { deploy: { context: "production" }, waitUntil() {}, ip: "1.2.3.4" })
    const b = await ask("b")
    console.log(JSON.stringify({ status: b.status, body: await b.json() }))
  `
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" })
  const out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}")
  assert.equal(out.status, 404, run.stderr)
  assert.equal(out.body.code, "UNAVAILABLE")
})
