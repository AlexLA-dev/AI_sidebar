// Find similar's access (2.6 release candidate): Ultra only, answered ULTRA_ONLY like read aloud; Ultra's weekly
// searches charged before anything runs (with the engine's daily safety caps), given back when nothing came, and
// LIMIT_REACHED with the week's usage once they're used.
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
})

test("Free and Pro: ULTRA_ONLY (403), nothing charged, nothing asked", async () => {
  for (const entitlement of [null, jws("com.contextflow.pro.monthly"), jws("com.contextflow.byok.monthly")]) {
    const res = await ask(entitlement)
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, "ULTRA_ONLY")
    assert.equal(body.feature, "similar")
  }
  assert.equal(consumed.length, 0)
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
