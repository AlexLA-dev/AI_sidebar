// Find similar's error bank (tests/fixtures/similar-bank): every error that already happened, as our server saw it,
// with the verdict the failing step must give now. It runs offline on every PR, so an old error can't come back
// unnoticed. It is a net, not the score: a fix is measured on the eval set (tools/similar/testset.json), never tuned
// to these cases alone. A new error (from the judge, the owner or a review) goes in here in the PR that fixes it.
//   - delivery: shops abroad's delivery pages, labelled by a blind judge (tuned and held-out sets);
//   - language: the eval set's pages; the language check says yes for their own language only;
//   - price: item pages' HTML; the price, currency and stock they state for machines;
//   - rules: currency by sign and domain, marketplaces, "the very same item";
//   - answers: saved answers replayed through today's answer checks (tests/similar-bank.helpers.mts);
//   - live: the live error subset's rules, checked here on the replayed answers (tools/similar/bankchecks.mts).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage, languageCheck, readPrice } = await import("../netlify/shared/pagecheck.mts")
const { backsSame, marketplaceOf, shipsTo } = await import("../netlify/shared/similar.mts")
const { replay } = await import("./similar-bank.helpers.mts")
const { liveFailures } = await import("../tools/similar/bankchecks.mts")
type Plan = import("../netlify/shared/similar.mts").Plan

const bank = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/similar-bank/${name}`, import.meta.url), "utf8"))

test("delivery: no case that was right goes wrong, and wrong verdicts never grow (the judge's labels)", (t) => {
  const { pages, cases } = bank("delivery.json") as { pages: Record<string, { url: string; lang: string; text: string }>; cases: Array<{ id: string; set: string; page: string; country: string; truth: string; rules: string }> }
  const now = cases.map((c) => {
    const own = (() => { try { return new Intl.Locale(`und-${c.country}`).maximize().language } catch { return "" } })()
    return { ...c, now: shipsTo(pages[c.page].text, c.country, [...new Set(["en", pages[c.page].lang, own].filter(Boolean))]) }
  })
  const broke = now.filter((c) => c.rules === c.truth && c.now !== c.truth)
  assert.deepEqual(broke.map((c) => `${c.id}: ${c.truth} → ${c.now}`), [])
  for (const set of ["tuned", "held-out"]) {
    const of = (list: typeof now, key: "rules" | "now", v: string) => list.filter((c) => c.set === set && c[key] === v && c.truth !== v).length
    assert.ok(of(now, "now", "yes") <= of(now, "rules", "yes"), `${set}: more wrong "ships there"`)
    assert.ok(of(now, "now", "no") <= of(now, "rules", "no"), `${set}: more wrong "doesn't ship"`)
    const n = now.filter((c) => c.set === set)
    t.diagnostic(`${set}: ${n.filter((c) => c.now === c.truth).length}/${n.length} right; wrong "ships there" ${of(now, "now", "yes")}, wrong "doesn't ship" ${of(now, "now", "no")}`)
  }
  const fixed = now.filter((c) => c.rules !== c.truth && c.now === c.truth)
  if (fixed.length) t.diagnostic(`now right, banked wrong (update "rules" in delivery.json): ${fixed.map((c) => c.id).join(", ")}`)
})

test("language: each page passes for its own language and for no other (known misses kept as they are)", (t) => {
  const L = ["en", "ru", "uk", "de", "fr", "es", "it", "pt", "ja", "ko", "zh", "zh-Hant", "vi", "ar"]
  const { pages } = bank("language.json") as { pages: Array<{ id: string; lang: string; title: string; text: string; truth: string; known?: string }> }
  assert.ok(pages.length >= 80)
  for (const p of pages) {
    const page = { lang: p.lang, title: p.title, text: p.text, inLanguage: undefined }
    // A Traditional-Chinese page is Chinese too.
    const said = p.known ?? p.truth
    const own = said === "zh-Hant" ? ["zh-Hant", "zh"] : [said]
    const now = L.filter((l) => languageCheck(l, page) === "yes")
    if (p.known && now.includes(p.truth)) t.diagnostic(`${p.id}: now right (${p.truth}); drop "known" in language.json`)
    else for (const l of L) assert.equal(languageCheck(l, page), own.includes(l) ? "yes" : "no", `${p.id} (${p.truth}${p.known ? `, known: ${p.known}` : ""}) asked ${l}`)
  }
  t.diagnostic(`known misses: ${pages.filter((p) => p.known).map((p) => p.id).join(", ") || "none"}`)
})

test("price: what item pages state for machines, as a server gets them, in every currency", () => {
  const { cases } = bank("price.json") as { cases: Array<{ id: string; url: string; file: string; expect: { price: { amount: number; currency: string } | null; stock: string | null; lang: string } }> }
  for (const c of cases) {
    const p = describePage(readFileSync(new URL(`./fixtures/similar-bank/${c.file}`, import.meta.url), "utf8"), c.url, c.url, 200, 0)
    assert.deepEqual(p.price ? { amount: p.price.amount, currency: p.price.currency } : null, c.expect.price, `${c.id}: price`)
    assert.equal(p.stock ?? null, c.expect.stock, `${c.id}: stock`)
    assert.equal(p.lang, c.expect.lang, `${c.id}: language`)
  }
})

test("rules: currency by sign and domain, marketplaces (classifieds too), the very same item", () => {
  const rules = bank("rules.json")
  for (const c of rules.currency) assert.equal(readPrice(c.text, "", c.url)?.currency ?? "", c.expect, `${c.text} on ${c.url}`)
  const ld = `<html lang="en"><head><title>Desk</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Desk", offers: { "@type": "Offer", price: "599.99" } })}</script></head><body><main><h1>Desk</h1><p>A desk.</p></main></body></html>`
  for (const d of rules.domain) assert.equal(describePage(ld, d.url, d.url, 200, 0).price?.currency ?? "", d.expect, d.url)
  for (const m of rules.marketplace) assert.equal(marketplaceOf(m.host), m.expect, m.host)
  for (const s of rules.same) assert.equal(backsSame(s.name, { subject: s.subject, kindSearch: s.kindSearch, traits: [] } as unknown as Plan), s.expect, `${s.subject} / ${s.name}`)
})

test("answers: saved answers where an error showed, replayed: what's shown and dropped, one listing per marketplace", () => {
  const { answers } = bank("answers.json") as { answers: Array<Parameters<typeof replay>[0] & { expect: { shown: string[]; dropped: Array<[string, string]> } }> }
  for (const a of answers) {
    const r = replay(a)
    assert.deepEqual(r, a.expect, a.id)
    const shown = a.items.filter((i) => r.shown.includes(i.name)).map((i) => ({ name: i.name, url: i.url }))
    assert.deepEqual(liveFailures(shown, ["one-per-marketplace"]), [], a.id)
  }
})

test("live: the error subset names pages of the eval set and rules the checks know", () => {
  const ids = new Set((JSON.parse(readFileSync(new URL("../tools/similar/testset.json", import.meta.url), "utf8")) as Array<{ id: string }>).map((c) => c.id))
  const { cases } = bank("live.json") as { cases: Array<{ id: string; checks: string[] }> }
  assert.ok(cases.length > 0 && cases.length <= 20, "at most 20 pages (about $2 a pass)")
  for (const c of cases) {
    assert.ok(ids.has(c.id), c.id)
    for (const k of c.checks) assert.match(k, /^(answer|one-per-marketplace|no-delivery-claim|chip-order|language:[a-zA-Z-]+)$/, `${c.id}: ${k}`)
  }
  // The checks themselves, on answers that break them.
  assert.deepEqual(liveFailures([], ["answer"]), ["answer: empty"])
  assert.equal(liveFailures([{ name: "A", url: "https://www.gumtree.com/a" }, { name: "B", url: "https://www.gumtree.com/b" }], ["one-per-marketplace"]).length, 1)
  assert.equal(liveFailures([{ name: "A", url: "https://a.example", why: "It delivers to Austria." }], ["no-delivery-claim"]).length, 1)
  assert.equal(liveFailures([{ name: "A", url: "https://a.example", met: "no" }, { name: "B", url: "https://b.example", met: "yes" }], ["chip-order"]).length, 1)
  assert.deepEqual(liveFailures([{ name: "A", url: "https://a.example", why: "Its delivery page lists Austria." }, { name: "B", url: "https://b.example", fit: "In stock, but delivery to the UK isn't shown." }], ["no-delivery-claim"]), [])
  assert.equal(liveFailures([{ name: "C", url: "https://c.example", fit: "Ships to the UK in 3 days." }, { name: "D", url: "https://d.example", why: "Доставляет в Россию." }], ["no-delivery-claim"]).length, 2)
})

test("the writer's 'the same item' is taken only when the names share the subject's brand or model word", async () => {
  const { pageOf } = await import("./similar-bank.helpers.mts")
  const { finishItems } = await import("../netlify/shared/similar.mts")
  const plan = { category: "product", subject: "Trailrun TR5 running shoes", traits: ["road running shoes", "neutral cushioning"], condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" }, sourcePrice: 0, sourceCurrency: "", queries: ["q"], language: "en" } as unknown as Plan
  const items = [
    { name: "Strider S9 GTX running shoes", url: "https://shoes.example.de/s9", title: "Strider S9 GTX", met: "n/a", checked: true },
    { name: "Trailrun TR5 men's", url: "https://other.example.com/tr5", title: "Trailrun TR5 men's", met: "n/a", checked: true }
  ]
  const pages = items.map((i) => pageOf(i, plan))
  const raw = { intro: "", note: "", items: items.map((i, n) => ({ page: n + 1, name: i.name, why: "w", fit: "", met: "n/a", words_met: "n/a", same: true, shares: [1], differs: "" })) }
  const { result, dropped } = finishItems(raw, pages, plan, { title: "Trailrun TR5", url: "https://brand.example.com/tr5", text: "" })
  // Another brand's shoe stays an alternative; the subject's own model at another shop is the item itself.
  assert.deepEqual(result.items.map((i) => i.name), ["Strider S9 GTX running shoes"])
  assert.deepEqual(dropped, [{ name: "Trailrun TR5 men's", why: "the item itself" }])
})
