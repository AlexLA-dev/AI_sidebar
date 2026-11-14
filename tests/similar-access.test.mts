// Find similar's access: Ultra's full search (2.6) and, since 2.7, the light one for everyone else. The week's searches
// (Ultra's per subscription, the light search's per device) are charged before anything runs (with the engine's daily
// safety caps), given back when nothing came, and LIMIT_REACHED comes with the week's usage once they're used.
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "anthropic-test"
process.env.GEMINI_API_KEY = "gemini-test"
process.env.SIMILAR_ENGINES = "a"

type Item = { subject: string; period: string; limit: number | null; amount?: number }
let counters = new Map<string, number>()
let consumed: string[][] = []
let anthropicCalls = 0
let anthropicBodies: Array<Record<string, any>> = []
// The plan step answers (2.7's light search test): the run reaches its search, which fails.
let planAnswers = false

const rpc: Record<string, (args: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    consumed.push(items.map((i) => i.subject))
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) + (i.amount ?? 1) > i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + (i.amount ?? 1)))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: ({ p_items }) => {
    for (const i of p_items as Item[]) counters.set(i.subject, Math.max(0, (counters.get(i.subject) ?? 0) - (i.amount ?? 1)))
    return null
  },
  cf_touch_install: () => null,
  cf_log: () => null,
  cf_entitlement_upsert: ({ p }) => ({ ...p, revoked_at: null })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (!rpc[fn]) return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/")) {
    // The engine's first step fails: the run ends with nothing, and the search is given back.
    anthropicCalls++
    anthropicBodies.push(body)
    if (planAnswers && body.output_config?.format) {
      const plan = { category: "product", subject: "Acme Q1 headphones", traits: ["wireless headphones"], condition: { kind: "cheaper", max_price: 0, currency: "", language: "", place: "" }, source_price: 0, source_currency: "", queries: ["q one", "q two", "q three", "q four"], kind_search: "wireless headphones", plans: [], language: "en" }
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(plan) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } }), { headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

const apple = await import("../netlify/shared/apple.mts")
apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
const similar = (await import("../netlify/functions/v2-similar.mts")).default

const INSTALL = "7b3c9a0e-1d2f-4a5b-8c6d-9e0f1a2b3c4d"
const OTID = "3000000077"
const jws = (productId: string) => signJws(transaction({ productId, originalTransactionId: OTID }))
const ctx = () => {
  const waits: Promise<unknown>[] = []
  return { ip: "203.0.113.9", deploy: { context: "production" }, waitUntil: (p: Promise<unknown>) => void waits.push(p), waits } as any
}
const ask = (entitlement: string | null, c = ctx()) =>
  similar(new Request("https://x/api/v2/similar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installId: INSTALL, client: { version: "2.6", platform: "ios", locale: "en-US", build: "88" }, engine: "a", entitlement, page: { title: "Acme Q1", url: "https://shop.example/q1", text: "Headphones." }, condition: "cheaper" })
  }), c)

beforeEach(() => {
  counters = new Map()
  consumed = []
  anthropicCalls = 0
  anthropicBodies = []
  planAnswers = false
})

test("2.7, Free and Pro: the light search, one of the week's free searches per device charged first, given back when nothing came", async () => {
  for (const entitlement of [null, jws("com.contextflow.pro.monthly"), jws("com.contextflow.byok.monthly")]) {
    counters = new Map()
    consumed = []
    const c = ctx()
    const res = await ask(entitlement, c)
    assert.equal(res.status, 200)
    assert.deepEqual(consumed[0].slice(0, 3), [`similarfree:${INSTALL}`, "similarfree:ip:203.0.113.9", "global:similarfree"].map((s) => (s.includes(":ip:") ? consumed[0][1] : s)))
    assert.match(consumed[0][1], /^similarfree:ip:/)
    assert.equal(counters.get(`similarfree:${INSTALL}`), 1)
    assert.ok(!consumed[0].some((s) => s.startsWith("similar:tx:")), "not Ultra's allowance")
    await res.text()
    await Promise.all(c.waits)
    assert.equal(counters.get(`similarfree:${INSTALL}`), 0)
  }
})

test("2.7, the light search: two searches, no follow-ups, no search beside them, anywhere (no \"near me\")", async () => {
  planAnswers = true
  const c = ctx()
  const res = await similar(new Request("https://x/api/v2/similar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installId: INSTALL, client: { version: "2.7", platform: "ios", locale: "en-US", build: "1" }, engine: "a", entitlement: null, region: "local", country: "DE", page: { title: "Acme Q1", url: "https://shop.example/q1", text: "Headphones." }, chip: "cheaper", words: "" })
  }), c)
  await res.text()
  await Promise.all(c.waits)
  const searches = anthropicBodies.filter((b) => Array.isArray(b.tools) && b.tools.some((t: { name?: string }) => t.name === "web_search"))
  // The one search call (the client tries a failed call once more): no search for alternatives beside it.
  assert.ok(searches.length >= 1)
  for (const call of searches) {
    assert.equal(call.tools[0].max_uses, 2, "the plan's first two searches, no follow-ups")
    assert.equal(call.tools[0].user_location, undefined, "anywhere")
    const asked = JSON.stringify(call.messages)
    assert.match(asked, /q one/)
    assert.doesNotMatch(asked, /q three|1\. wireless headphones/, "only the plan's first two; no search for alternatives")
  }
})

test("2.7, the light search's week used: LIMIT_REACHED, light, with the week's usage; nothing asked", async () => {
  counters.set(`similarfree:${INSTALL}`, 3)
  const res = await ask(null)
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.equal(body.light, true)
  assert.deepEqual([body.usage.used, body.usage.limit, body.usage.period], [3, 3, "week"])
  assert.equal(anthropicCalls, 0)
})

test("Ultra: one of the week's searches is charged before anything runs, and given back when nothing came", async () => {
  const c = ctx()
  const res = await ask(jws("com.contextflow.ultra.monthly"), c)
  assert.equal(res.status, 200)
  assert.deepEqual(consumed[0].slice(0, 1), [`similar:tx:${OTID}`])
  assert.equal(counters.get(`similar:tx:${OTID}`), 1)
  const text = await res.text()
  assert.match(text, /"type":"error"/)
  await Promise.all(c.waits)
  assert.equal(counters.get(`similar:tx:${OTID}`), 0)
})

test("Ultra with the week's searches used: LIMIT_REACHED with the week's usage, nothing asked", async () => {
  counters.set(`similar:tx:${OTID}`, 10)
  const res = await ask(jws("com.contextflow.ultra.yearly"))
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.equal(body.usage.used, 10)
  assert.equal(body.usage.limit, 10)
  assert.equal(body.usage.period, "week")
  assert.equal(anthropicCalls, 0)
})

test("2.7, an evaluation asking for the light search gets it whole (its unset switches don't undo the light search's)", async () => {
  planAnswers = true
  process.env.CONTEXT = "deploy-preview"
  const { similarEvalToken } = await import("../netlify/shared/similar.mts")
  const c = { ...ctx(), deploy: { context: "deploy-preview" } }
  const res = await similar(new Request("https://x/api/v2/similar", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${similarEvalToken("service-key")}` },
    body: JSON.stringify({ installId: INSTALL, client: { version: "2.7", platform: "ios", locale: "en-US", build: "1" }, engine: "a", page: { title: "Acme Q1", url: "https://shop.example/q1", text: "Headphones." }, chip: "cheaper", words: "", options: { light: "on" } })
  }), c)
  await res.text()
  delete process.env.CONTEXT
  const searches = anthropicBodies.filter((b) => Array.isArray(b.tools) && b.tools.some((t: { name?: string }) => t.name === "web_search"))
  assert.ok(searches.length >= 1)
  for (const call of searches) assert.equal(call.tools[0].max_uses, 2)
  assert.equal(consumed.length, 0, "an evaluation counts nothing")
})
