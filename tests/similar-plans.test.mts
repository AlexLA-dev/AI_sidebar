// Find similar (build 98): "cheaper" for apps and services compared plan with plan — free with free, paid with paid,
// one-time with one-time; one's own API key is its own kind. The error bank's cases: apps, SaaS, streaming, VPN.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { checkCondition, checkPlan, comparePlans, writeMessage } = await import("../netlify/shared/similar.mts")
const { describePage } = await import("../netlify/shared/pagecheck.mts")
type Plan = import("../netlify/shared/similar.mts").Plan

const bank = JSON.parse(readFileSync(new URL("./fixtures/similar-bank/plans.json", import.meta.url), "utf8"))

test("the error bank: plan with plan, never a paid plan against a free one; the note names the plans", () => {
  for (const c of bank.cases) {
    const r = comparePlans(c.mine, { options: [], url: "https://x.example/pricing", ...c.theirs }, bank.rates)
    assert.equal(r?.met, c.expect, `${c.id}: ${r?.note}`)
    for (const m of c.mentions) assert.ok(r?.note.includes(m), `${c.id}: "${m}" in "${r?.note}"`)
  }
  assert.equal(comparePlans([], { model: "free", options: [], url: "", via: "app_store" }, null), null)
})

test("the planner's plans are checked; the condition and the writer use them", () => {
  const input = { page: { title: "Notes", url: "https://notes.example", text: "Plans" }, facts: {}, condition: "Cheaper", chip: "cheaper" as const, locale: "en-US" }
  const raw = {
    category: "app", subject: "Notes", traits: ["notes app"], condition: { kind: "cheaper", max_price: 0, currency: "", language: "", place: "" }, source_price: 0, source_currency: "", queries: ["q"], kind_search: "notes app", language: "en",
    plans: [{ kind: "free", price: 0, currency: "", period: "month" }, { kind: "paid", price: 8, currency: "usd", period: "month" }, { kind: "own_key", price: 3, currency: "USD", period: "month" }, { kind: "paid", price: -1, currency: "USD", period: "month" }, { kind: "paid", price: 5, currency: "", period: "month" }]
  }
  const plan = checkPlan(raw, input) as Plan
  assert.deepEqual(plan.plans, [{ kind: "free", amount: 0, currency: "", period: "month" }, { kind: "paid", amount: 8, currency: "USD", period: "month" }, { kind: "own_key", amount: 3, currency: "USD", period: "month" }])
  // An App Store page's pricing: free to download, a yearly subscription — compared with the paid plan, not the free one.
  const page = { ...describePage("<html><head><title>Other Notes</title></head><body><h1>Other Notes</h1></body></html>", "https://apps.apple.com/us/app/id1", "https://apps.apple.com/us/app/id1", 200, 0),
    pricing: { model: "subscription" as const, from: { amount: 59.99, currency: "USD" }, period: "year" as const, freeStart: true, options: [], url: "https://apps.apple.com/us/app/id1", via: "app_store" as const } }
  const met = checkCondition(plan, {}, page)
  assert.equal(met.met, "yes")
  assert.match(met.note, /free: both have a free plan; paid: theirs from 59\.99 USD\/year \(≈ 5(?:\.00)? USD\/month\) vs your cheapest paid plan 8(?:\.00)? USD\/month/)
  assert.match(writeMessage(input, plan, []), /Their item's plans: free; paid 8 USD\/month; with their own API key 3 USD\/month/)
})
