// Build 93, Find similar (the owner's notes on 92): where to look (worldwide or near them) for the search and the answer;
// an App Store item not sold in their country marked, one that is linked to their store; how close each item is and how
// it differs; what reviewers say, every rating from a page's own markup and every summary borne out by words on the
// page; an intro that never says how many.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { checkCondition, finishItems, planMessage, regionCheck, reviewsStep, saysCount, searchLocation, whereLine, writeMessage } = await import("../netlify/shared/similar.mts")
const { closeAndLess } = await import("../src/shared/similar.ts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

const words = "A good description of the item, what it does and who it is for. ".repeat(6)
const html = (title: string, body = "", head = "") => `<html lang="en"><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${words}</p>${body}</body></html>`
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const plan = (category: Plan["category"] = "app", traits = ["summarizes pages", "works in Safari", "translates", "explains terms"]): Plan => ({
  category, subject: "ContextFlow", traits, condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "", queries: ["q"], language: "en"
})
const input = (over: Record<string, unknown> = {}) => ({ page: { title: "ContextFlow", url: "https://context-flow.app", text: "An AI assistant in Safari." }, facts: {}, condition: "", locale: "ru-RU", ...over })

function candidate(url: string, page: string, name: string, kind: "item" | "list" = "item"): CheckedCandidate {
  const checked = describePage(page, url, url, 200, 0)
  return { url, name, kind, resultTitle: name, pageAge: null, page: checked, score: 1, condition: checkCondition(plan(), {}, checked), kept: true, why: "ok" }
}

/** Stand-in pages and model: a search call gets `results` as the search tool's results; a reading call gets `reply`. */
async function withWeb<T>(pages: Record<string, string | number>, model: { results?: Array<{ query: string; url: string; title: string }>; reply?: unknown }, work: () => Promise<T>) {
  const real = globalThis.fetch
  const opened: string[] = []
  const calls: Array<{ tools: boolean }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      const tools = Array.isArray(body.tools) && body.tools.length > 0
      calls.push({ tools })
      const content = tools
        ? (model.results ?? []).flatMap((r, i) => [
            { type: "server_tool_use", id: `s${i}`, name: "web_search", input: { query: r.query } },
            { type: "web_search_tool_result", tool_use_id: `s${i}`, content: [{ type: "web_search_result", url: r.url, title: r.title, page_age: null, encrypted_content: "x" }] }
          ]).concat([{ type: "text", text: "done" }] as never[])
        : [{ type: "text", text: JSON.stringify(model.reply ?? {}) }]
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 80, server_tool_use: { web_search_requests: tools ? (model.results ?? []).length : 0 } } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    opened.push(url)
    const body = pages[url]
    if (typeof body === "number") return new Response("<title>Not found</title>", { status: body, headers: { "content-type": "text/html" } })
    return body ? new Response(body, { status: 200, headers: { "content-type": "text/html" } }) : new Response("<title>Not found</title>Not found", { status: 404, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  try {
    return { result: await work(), opened, calls }
  } finally {
    globalThis.fetch = real
  }
}

// ---- where to look ------------------------------------------------------------------------------

test("where to look: worldwide searches from nowhere, near them from their country; an older panel from the locale", () => {
  assert.equal(searchLocation(input({ region: "world", country: "RU" })), null)
  assert.equal(searchLocation(input({ region: "local", country: "DE" })), "DE")
  assert.equal(searchLocation(input()), "RU")
  assert.match(whereLine(input({ region: "local", country: "DE" })), /near them, in Germany \(DE\)/)
  assert.match(whereLine(input({ region: "world" })), /anywhere in the world/)
  assert.equal(whereLine(input()), "")
  // Build 94: their country's own shops mixed with shops that deliver there (a small country's may have nothing like it).
  assert.match(planMessage(input({ region: "local", country: "RU" })), /Where: near them, in Russia \(RU\).*Mix searches for that country's own shops/)
  assert.match(writeMessage(input({ region: "world" }), plan(), []), /Where: anywhere in the world/)
  // The writer gets the traits numbered: it says which an item shares.
  assert.match(writeMessage(input(), plan(), []), /What makes an alternative:\n1\. summarizes pages\n2\. works in Safari/)
})

// ---- their country's App Store ----------------------------------------------------------------

const appPage = (name: string) => html(`${name} App - App Store`, "", ld({ "@type": "SoftwareApplication", name, offers: { "@type": "Offer", price: 0, priceCurrency: "USD" }, aggregateRating: { "@type": "AggregateRating", ratingValue: 4.6, ratingCount: 1234 } }))

test("an App Store app from another store: not sold in theirs (marked), or linked to theirs", async () => {
  const locked = candidate("https://apps.apple.com/us/app/glarity/id111", appPage("Glarity"), "Glarity")
  const sold = candidate("https://apps.apple.com/us/app/merlin/id222", appPage("Merlin"), "Merlin")
  const theirs = candidate("https://apps.apple.com/ru/app/zeki/id333", appPage("Zeki"), "Zeki")
  const web = candidate("https://example.com/tool", html("Some Tool"), "Some Tool")
  const { result, opened } = await withWeb({
    "https://apps.apple.com/ru/app/id111": 404,
    "https://apps.apple.com/ru/app/id222": appPage("Merlin")
  }, {}, () => regionCheck([locked, sold, theirs, web], "RU", "ru", 3_000))
  assert.deepEqual(opened.sort(), ["https://apps.apple.com/ru/app/id111", "https://apps.apple.com/ru/app/id222"])
  assert.equal(result[0].region?.available, false)
  assert.equal(result[1].region?.available, true)
  assert.equal(result[2].region, undefined)
  assert.equal(result[3].region, undefined)
  // The items: the locked one marked, the sold one linked to their store.
  const { result: written } = finishItems({ items: [
    { page: 1, name: "Glarity", why: "Summarizes pages.", fit: "", met: "n/a", shares: [1, 2], differs: "No translation" },
    { page: 2, name: "Merlin", why: "Summarizes pages.", fit: "", met: "n/a", shares: [1, 2, 3, 4], differs: "" }
  ], intro: "Apps like ContextFlow.", note: "" }, result, plan(), { title: "ContextFlow", url: "https://context-flow.app", text: "" })
  assert.equal(written.items[0].regionLocked, true)
  assert.equal(written.items[1].url, "https://apps.apple.com/ru/app/id222")
  assert.equal(written.items[1].regionLocked, undefined)
})

// ---- how close ------------------------------------------------------------------------------------

test("how close: the share of the traits it has too, how it differs; the panel keeps the less similar apart", () => {
  const a = candidate("https://a.example/app", html("Alpha"), "Alpha")
  const b = candidate("https://b.example/app", html("Beta"), "Beta")
  const c = candidate("https://c.example/app", html("Gamma"), "Gamma")
  const { result } = finishItems({ items: [
    { page: 1, name: "Alpha", why: "Summarizes in Safari.", fit: "", met: "n/a", shares: [1, 2, 3, 4], differs: "" },
    { page: 2, name: "Beta", why: "Summarizes pages.", fit: "", met: "n/a", shares: [1, 9, 1], differs: "Chrome only, no translation" },
    { page: 3, name: "Gamma", why: "Explains terms.", fit: "", met: "n/a", shares: [4, 2], differs: "No summaries" }
  ], intro: "Here are a couple of options.", note: "" }, [a, b, c], plan(), { title: "ContextFlow", url: "https://context-flow.app", text: "" })
  assert.deepEqual(result.items.map((i) => i.similarity), [100, 25, 50])
  assert.equal(result.items[1].differs, "Chrome only, no translation")
  // "a couple": the intro never says how many.
  assert.equal(result.intro, "")
  const { close, less } = closeAndLess(result.items)
  assert.deepEqual(close.map((i) => i.name), ["Alpha"])
  assert.deepEqual(less.map((i) => i.name), ["Beta", "Gamma"])
  // Three close ones: the less similar aren't needed; none close: the best leads.
  const many = [100, 90, 80, 30].map((n, i) => ({ ...result.items[0], name: `I${i}`, similarity: n }))
  assert.deepEqual(closeAndLess(many).less, [])
  assert.deepEqual(closeAndLess([30, 50].map((n, i) => ({ ...result.items[0], name: `J${i}`, similarity: n }))).close.map((i) => i.name), ["J0"])
})

test("an intro that says how many is dropped, in any of the languages we know", () => {
  for (const t of ["Here are a couple of options.", "Вот два варианта, похожих на ваш.", "Нашёл несколько альтернатив.", "Voici deux options.", "3 apps like it."]) assert.equal(saysCount(t), true, t)
  for (const t of ["Apps like ContextFlow that read pages for you.", "Похожие помощники для Safari.", "Someone who reads a lot will like these."]) assert.equal(saysCount(t), false, t)
})

// ---- what reviewers say -------------------------------------------------------------------------

test("reviews: the item's own rating, a review page found and checked, what reviewers like and dislike borne out by the page", async () => {
  const rated = candidate("https://apps.apple.com/us/app/merlin/id222", appPage("Merlin"), "Merlin")
  const unrated = candidate("https://glarity.app/", html("Glarity – summaries for Safari"), "Glarity")
  const review = html("Glarity review: a fast summarizer", "<p>Reviewers say the summaries are fast and accurate, but the free plan is limited.</p>", ld({ "@type": "Review", itemReviewed: { "@type": "SoftwareApplication", name: "Glarity", aggregateRating: { "@type": "AggregateRating", ratingValue: "4.2", bestRating: "5", reviewCount: "87" } } }))
  const { result, calls } = await withWeb(
    { "https://techreview.example/glarity-review": review },
    {
      results: [{ query: "Glarity review", url: "https://techreview.example/glarity-review", title: "Glarity review: a fast summarizer" }],
      reply: { items: [
        { item: 2, page: 3, pros: "fast, accurate summaries", cons: "the free plan is limited.", quote: "the summaries are fast and accurate, but the free plan is limited" },
        { item: 1, page: 1, pros: "people love it", cons: "", quote: "words that are not on the page at all" }
      ] }
    },
    () => reviewsStep([rated, unrated], plan(), input(), "en", 10_000)
  )
  // One search call (for the unrated one), one reading.
  assert.deepEqual(calls.map((c) => c.tools), [true, false])
  assert.deepEqual(result.checked[0].reviews, { rating: { value: 4.6, best: 5, count: 1234 }, sources: ["https://apps.apple.com/us/app/merlin/id222"] })
  const g = result.checked[1].reviews!
  assert.deepEqual(g.rating, { value: 4.2, best: 5, count: 87 })
  // Build 94: likes and dislikes apart (a trailing stop dropped), no one-sentence summary.
  assert.equal(g.pros, "fast, accurate summaries")
  assert.equal(g.cons, "the free plan is limited")
  assert.equal(g.summary, undefined)
  assert.deepEqual(g.sources, ["https://techreview.example/glarity-review"])
  assert.deepEqual(result.stats, { items: 2, searches: 1, pages: 1, summaries: 1 })
})

test("no reviews for kinds nobody reviews, and nothing claimed when nothing holds up", async () => {
  const article = candidate("https://news.example/a", html("An article"), "An article")
  const { result, calls } = await withWeb({}, {}, () => reviewsStep([article], plan("article"), input(), "en", 10_000))
  assert.equal(calls.length, 0)
  assert.equal(result.checked[0].reviews, undefined)
  // A review page that doesn't name the item is not used; a summary with numbers is not taken.
  const unrated = candidate("https://glarity.app/", html("Glarity – summaries"), "Glarity")
  const other = html("Best note apps reviewed", "<p>Notion and Bear are great note apps with fast sync.</p>")
  const { result: r2 } = await withWeb(
    { "https://reviews.example/notes": other },
    { results: [{ query: "Glarity review", url: "https://reviews.example/notes", title: "Best note apps reviewed" }], reply: { items: [{ item: 1, page: 1, pros: "Rated 4.5 by 200 people", cons: "", quote: "A good description of the item" }] } },
    () => reviewsStep([unrated], plan(), input(), "en", 10_000)
  )
  assert.equal(r2.checked[0].reviews, undefined)
})

test("the item's own rating comes from its page's markup", () => {
  const page = describePage(appPage("Merlin"), "https://apps.apple.com/us/app/merlin/id222", "https://apps.apple.com/us/app/merlin/id222", 200, 0)
  assert.deepEqual(page.rating, { value: 4.6, best: 5, count: 1234 })
  const bad = describePage(html("X", "", ld({ "@type": "Product", name: "X", aggregateRating: { ratingValue: 7, bestRating: 5 } })), "https://x.example", "https://x.example", 200, 0)
  assert.equal(bad.rating, undefined)
})
