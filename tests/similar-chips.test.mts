// Find similar (build 98): several chips at once ("cheaper" and "in stock"). The planner plans with the first, every
// one is checked on every page: a miss of any is a miss, all met is met, else not confirmed. Chips stay soft, their own
// words strict.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { checkCondition, checkPlan, writeMessage } = await import("../netlify/shared/similar.mts")
const { describePage } = await import("../netlify/shared/pagecheck.mts")

const input = (over: Record<string, unknown> = {}) => ({ page: { title: "Kettle K", url: "https://shop.example.de/k", text: "Kettle" }, facts: { price: { amount: 60, currency: "EUR" } }, condition: "Günstiger, Auf Lager", locale: "de-DE", chip: "cheaper" as const, chips: ["cheaper" as const, "in_stock" as const], ...over })
const raw = { category: "product", subject: "Kettle K", traits: ["electric kettle"], condition: { kind: "cheaper", max_price: 0, currency: "", language: "", place: "" }, source_price: 60, source_currency: "EUR", queries: ["Wasserkocher günstig"], kind_search: "Wasserkocher", plans: [], language: "de" }
const offer = (price: string, stock: string) => `<html><head><title>Kettle</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Kettle", offers: { "@type": "Offer", price, priceCurrency: "EUR", availability: `https://schema.org/${stock}` } })}</script></head><body><h1>Kettle</h1></body></html>`
const page = (html: string) => describePage(html, "https://other.example.de/k", "https://other.example.de/k", 200, 0)

test("both chips planned: the first leads, the others are checked too, all soft", () => {
  const plan = checkPlan(raw, input())
  assert.equal(plan.condition.kind, "cheaper")
  assert.deepEqual(plan.condition.also, ["in_stock"])
  assert.equal(plan.condition.soft, true)
  // One chip: as before.
  assert.equal(checkPlan(raw, input({ chips: undefined })).condition.also, undefined)
  assert.match(writeMessage(input(), plan, []), /Their condition: quick choices they tapped, each one checked — cheaper, in_stock \(weighed softly\)/)
})

test("every chip checked on the page: a miss of any is a miss, all met is met, else not confirmed", () => {
  const plan = checkPlan(raw, input())
  const facts = { price: { amount: 60, currency: "EUR" } }
  const both = checkCondition(plan, facts, page(offer("45", "InStock")))
  assert.equal(both.met, "yes")
  assert.match(both.note, /^cheaper: yes \(price 45 EUR vs 60 EUR\); in_stock: yes/)
  assert.equal(checkCondition(plan, facts, page(offer("45", "OutOfStock"))).met, "no")
  assert.equal(checkCondition(plan, facts, page(offer("75", "InStock"))).met, "no")
  // No stock stated: cheaper is met, in stock isn't known.
  assert.equal(checkCondition(plan, facts, page(`<html><head><title>Kettle</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Kettle", offers: { "@type": "Offer", price: "45", priceCurrency: "EUR" } })}</script></head><body><h1>Kettle</h1></body></html>`)).met, "unknown")
})
