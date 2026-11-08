// Build 91, the owner: «делать такое в принципе для всего где возможно». An item whose first page doesn't show the
// person's condition gets one or two pages more: which links, what a quote proves, and the dig on stand-in pages and a
// stand-in model (its words count only when they're on the page; what they prove is read by our code).
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { nextPages, quoteFacts, quoteOn } = await import("../netlify/shared/dig.mts")
const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { checkCondition, digDeeper, finishItems } = await import("../netlify/shared/similar.mts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

const words = "Lorem ipsum dolor sit amet, the details of the item as a page describes them. ".repeat(6)
const html = (title: string, body: string, head = "") => `<html lang="en"><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${words}</p>${body}</body></html>`
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const plan = (kind: Plan["condition"]["kind"], category: Plan["category"] = "product", extra: Partial<Plan["condition"]> = {}): Plan => ({
  category, subject: "Aero 2", traits: [], condition: { kind, maxPrice: 0, currency: "", language: "", place: "", ...extra }, sourcePrice: 129, sourceCurrency: "USD", queries: [], language: "en"
})
const usd = (amount: number) => ({ amount, currency: "USD" })

function candidate(url: string, page: string, name: string, kind: "item" | "list", p: Plan): CheckedCandidate {
  const checked = describePage(page, url, url, 200, 0)
  return { url, name, kind, resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(p, { price: usd(129) }, checked), kept: true, why: "ok" }
}

/** Stand-in pages, and a stand-in model answering `reply` (null: no model call expected). */
async function withWeb<T>(pages: Record<string, string>, reply: Record<string, unknown> | null, work: () => Promise<T>): Promise<{ result: T; opened: string[]; model: number }> {
  const real = globalThis.fetch
  const opened: string[] = []
  let model = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith("https://api.anthropic.com/")) {
      model++
      if (!reply) throw new Error("no model call expected")
      return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(reply) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1800, output_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    opened.push(url)
    const body = pages[url]
    return body ? new Response(body, { status: 200, headers: { "content-type": "text/html" } }) : new Response("<title>Not found</title>Not found", { status: 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    return { result: await work(), opened, model }
  } finally {
    globalThis.fetch = real
  }
}

// ---- which pages ------------------------------------------------------------------------------

test("which pages: a review's link to the item, the page in their language, the same site's price or rates page", () => {
  const review = describePage(html("Best budget headphones", `<a href="https://electronics.sony.com/p/whch720n">Sony WH-CH720N</a> <a href="https://www.jbl.com/tune">JBL Tune 770NC</a> <a href="/about">About us</a>`), "https://soundguys.example/best", "https://soundguys.example/best", 200, 0)
  assert.deepEqual(nextPages(review, "cheaper", "Sony WH-CH720N", true), [{ url: "https://electronics.sony.com/p/whch720n", why: "item" }])
  const article = describePage(html("How to sleep", "", `<link rel="alternate" hreflang="ru" href="/ru/sleep"><link rel="alternate" hreflang="x-default" href="/sleep">`), "https://site.example/sleep", "https://site.example/sleep", 200, 0)
  assert.deepEqual(nextPages(article, "language", "How to sleep", false, "ru-RU"), [{ url: "https://site.example/ru/sleep", why: "language" }])
  const course = describePage(html("Python for everyone", `<a href="/blog">Blog</a><a href="/courses/python/tuition">Tuition &amp; fees</a><a href="https://other.example/pricing">Pricing</a><a href="/login">Log in</a><a href="/courses/python/syllabus">Syllabus</a>`), "https://school.example/courses/python", "https://school.example/courses/python", 200, 0)
  assert.deepEqual(nextPages(course, "cheaper", "Python for everyone", false).map((n) => n.url), ["https://school.example/courses/python/tuition"])
  assert.deepEqual(nextPages(course, "shorter", "Python for everyone", false).map((n) => n.url), ["https://school.example/courses/python/syllabus"])
  assert.deepEqual(nextPages(course, "nearby", "Python for everyone", false), [])
  assert.deepEqual(nextPages(course, "none", "Python for everyone", false), [])
})

test("a model's words count only when they're on the page; what they prove is read by our code", () => {
  const text = "Pro plan:   $49 per year.\nShips within 2 days. In stock."
  assert.equal(quoteOn(text, "pro plan: $49 per year"), true)
  assert.equal(quoteOn(text, "Pro plan: $39 per year"), false)
  assert.equal(quoteOn(text, "$49"), false) // too short to stand for anything
  assert.deepEqual(quoteFacts("cheaper", "Pro plan: $49 per year"), { price: usd(49) })
  assert.deepEqual(quoteFacts("cheaper", "Tuition: 1,200 EUR"), { price: { amount: 1200, currency: "EUR" } })
  assert.deepEqual(quoteFacts("free", "Free to enroll, no payment needed"), { price: { amount: 0, currency: "" } })
  assert.equal(quoteFacts("free", "Free shipping on all orders"), null)
  assert.deepEqual(quoteFacts("free", "Enrollment costs $99"), { price: usd(99) })
  assert.deepEqual(quoteFacts("in_stock", "Sold out — back soon"), { stock: "out" })
  assert.deepEqual(quoteFacts("in_stock", "In stock, ships today"), { stock: "in" })
  assert.deepEqual(quoteFacts("newer", "Updated March 4, 2026"), { published: "2026-03-04T00:00:00.000Z" })
  assert.deepEqual(quoteFacts("newer", "Published 4 March 2026"), { published: "2026-03-04T00:00:00.000Z" })
  assert.deepEqual(quoteFacts("shorter", "Total time: 1 hr 20 mins"), { duration: 4800 })
  assert.equal(quoteFacts("shorter", "Serves 4"), null)
})

// ---- the dig -----------------------------------------------------------------------------------

test("a review names the item: its own page settles the price, and the item is its own page now", async () => {
  const p = plan("cheaper")
  const review = candidate("https://soundguys.example/best", html("Best budget headphones 2026", `<a href="https://electronics.sony.com/p/whch720n">Sony WH-CH720N</a>`), "Sony WH-CH720N", "list", p)
  assert.equal(review.condition.met, "unknown")
  const own = html("Sony WH-CH720N Wireless Noise Cancelling Headphones", "", ld({ "@type": "Product", name: "Sony WH-CH720N", offers: { "@type": "Offer", price: 89.99, priceCurrency: "USD", availability: "https://schema.org/InStock" } }))
  const { result, opened, model } = await withWeb({ "https://electronics.sony.com/p/whch720n": own }, null, () => digDeeper([review], p, "cheaper", { price: usd(129) }, "en", 6_000))
  assert.deepEqual(opened, ["https://electronics.sony.com/p/whch720n"])
  assert.equal(model, 0)
  const after = result.checked[0]
  assert.equal(after.kind, "item")
  assert.equal(after.page.finalUrl, "https://electronics.sony.com/p/whch720n")
  assert.equal(after.condition.met, "yes")
  assert.deepEqual(result.stats, { items: 1, opened: 1, read: 0, settled: 1 })
  // The item the writer names links to that page, with its price.
  const { result: written } = finishItems({ items: [{ page: 1, name: "Sony WH-CH720N", why: "Light ANC.", fit: "Cheaper: $89.99.", met: "yes" }] }, result.checked, p, { title: "Aero 2", url: "https://shop.example/aero-2", text: "" })
  assert.equal(written.items[0].url, "https://electronics.sony.com/p/whch720n")
  assert.equal(written.items[0].price, "89.99 USD")
  assert.equal(written.items[0].met, "yes")
})

test("a course without a price on its page: its tuition page shows it, and the item links there as proof", async () => {
  const p = plan("cheaper", "course")
  const course = candidate("https://school.example/courses/python", html("Python for everyone", `<a href="/courses/python/tuition">Tuition</a>`), "Python for everyone", "item", p)
  const tuition = html("Python for everyone — tuition", "", ld({ "@type": "Course", name: "Python for everyone", offers: { "@type": "Offer", price: 99, priceCurrency: "USD" } }))
  const { result } = await withWeb({ "https://school.example/courses/python/tuition": tuition }, null, () => digDeeper([course], p, "cheaper", { price: usd(129) }, "en", 6_000))
  const after = result.checked[0]
  assert.equal(after.condition.met, "yes")
  assert.equal(after.proof?.url, "https://school.example/courses/python/tuition")
  const { result: written } = finishItems({ items: [{ page: 1, name: "Python for everyone", why: "Same level.", fit: "Cheaper: $99.", met: "yes" }] }, result.checked, p, { title: "Aero 2", url: "https://x.example", text: "" })
  assert.equal(written.items[0].url, "https://school.example/courses/python")
  assert.equal(written.items[0].proof, "https://school.example/courses/python/tuition")
  assert.equal(written.items[0].price, "99 USD")
})

test("no structured price anywhere: the model points at the words, our code reads the price and decides", async () => {
  const p = plan("cheaper", "course")
  const course = candidate("https://school.example/courses/python", html("Python for everyone", `<a href="/courses/python/tuition">Tuition</a>`), "Python for everyone", "item", p)
  const tuition = html("Tuition", "<p>The full course costs $149 for the year, payable once.</p>")
  // The price is above the person's $129: settled "no", the item goes.
  const { result, model } = await withWeb({ "https://school.example/courses/python/tuition": tuition }, { page: 2, quote: "The full course costs $149 for the year", verdict: "yes" }, () => digDeeper([course], p, "cheaper", { price: usd(129) }, "en", 6_000))
  assert.equal(model, 1)
  const after = result.checked[0]
  assert.equal(after.condition.met, "no")
  assert.equal(after.kept, false)
  assert.match(after.why, /fails the condition/)
  assert.equal(after.proof?.quote, "The full course costs $149 for the year")
})

test("words that aren't on the page, or a verdict without words: nothing is settled", async () => {
  const p = plan("cheaper", "course")
  const course = candidate("https://school.example/courses/python", html("Python for everyone", `<a href="/courses/python/tuition">Tuition</a>`), "Python for everyone", "item", p)
  const tuition = html("Tuition", "<p>Contact us for prices.</p>")
  for (const reply of [{ page: 2, quote: "The full course costs $49", verdict: "yes" }, { page: 0, quote: "", verdict: "yes" }]) {
    const { result } = await withWeb({ "https://school.example/courses/python/tuition": tuition }, reply, () => digDeeper([course], p, "cheaper", { price: usd(129) }, "en", 6_000))
    assert.equal(result.checked[0].condition.met, "unknown")
    assert.equal(result.checked[0].kept, true)
    assert.equal(result.checked[0].proof, undefined)
  }
})

test("a condition in the person's own words: settled by the words the model points at, quoted", async () => {
  const p = plan("other", "job")
  const job = candidate("https://jobs.example/123", html("Senior iOS engineer", `<a href="https://jobs.example/123/details">Details</a>`), "Senior iOS engineer", "item", p)
  const details = html("Senior iOS engineer — details", "<p>This role is fully remote within Europe.</p>")
  const { result } = await withWeb({ "https://jobs.example/123/details": details }, { page: 2, quote: "This role is fully remote within Europe.", verdict: "yes" }, () => digDeeper([job], p, "remote", {}, "en", 6_000))
  assert.equal(result.checked[0].condition.met, "yes")
  assert.match(result.checked[0].condition.note, /fully remote/)
  assert.equal(result.checked[0].proof?.url, "https://jobs.example/123/details")
})

test("nothing deeper for no condition, nearby, a settled item, or one the checks dropped", async () => {
  const p = plan("cheaper")
  const settled = candidate("https://shop.example/a", html("A", "", ld({ "@type": "Product", name: "A", offers: { "@type": "Offer", price: 99, priceCurrency: "USD" } })), "A", "item", p)
  assert.equal(settled.condition.met, "yes")
  const dropped = { ...candidate("https://shop.example/b", html("B", `<a href="/b/price">Price</a>`), "B", "item", p), kept: false, why: "not the item it was picked for" }
  for (const [pl, list] of [[plan("none"), [dropped]], [plan("nearby"), [dropped]], [p, [settled, dropped]]] as const) {
    const { result, opened, model } = await withWeb({}, null, () => digDeeper([...list], pl, "", { price: usd(129) }, "en", 6_000))
    assert.deepEqual(opened, [])
    assert.equal(model, 0)
    assert.equal(result.stats.items, 0)
  }
})
