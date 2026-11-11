// Find similar's log line (2.6): tokens and dollars per step of engine A (plan, search, write) for /analytics
// «Голос и поиск похожего», also when the search stops halfway (what was spent still counts).
import assert from "node:assert/strict"
import { test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "anthropic-test"
process.env.SIMILAR_ENGINES = "a"

const logged: Array<{ kind: string; data: Record<string, any> }> = []
let anthropicCalls = 0
const plan = {
  category: "product", subject: "Acme headphones", traits: ["over-ear"], language: "en", source_price: 0, source_currency: "",
  condition: { kind: "cheaper", max_price: 0, currency: "", language: "", place: "" }, queries: ["acme headphones alternative"]
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (fn === "cf_log") logged.push({ kind: body.p_kind, data: body.p_data })
    if (fn === "cf_consume") return Response.json({ allowed: true, blocked: null, counters: body.p_items.map((i: any) => ({ ...i, n: 1 })) })
    if (fn === "cf_entitlement_upsert") return Response.json({ ...body.p, revoked_at: null })
    return Response.json(null)
  }
  if (url.startsWith("https://api.anthropic.com/")) {
    // The plan comes back; the web search after it fails.
    if (anthropicCalls++ === 0) {
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify(plan) }], usage: { input_tokens: 1200, output_tokens: 180 }
      })
    }
    return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: 500 })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

const apple = await import("../netlify/shared/apple.mts")
apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
const similar = (await import("../netlify/functions/v2-similar.mts")).default
const { config } = await import("../netlify/shared/config.mts")

test("engine A: the log carries the spend per step, the search's failure included", async () => {
  const waits: Promise<unknown>[] = []
  const ctx = { ip: "203.0.113.9", deploy: { context: "production" }, waitUntil: (p: Promise<unknown>) => void waits.push(p) } as any
  const res = await similar(new Request("https://x/api/v2/similar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installId: "7b3c9a0e-1d2f-4a5b-8c6d-9e0f1a2b3c4d", client: { version: "2.6", platform: "ios", locale: "en-US", build: "90" }, engine: "a",
      entitlement: signJws(transaction({ productId: "com.contextflow.ultra.monthly", originalTransactionId: "3000000078" })),
      page: { title: "Acme Q1", url: "https://shop.example/q1", text: "Headphones." }, condition: "cheaper"
    })
  }), ctx)
  assert.equal(res.status, 200)
  await res.text()
  await Promise.all(waits)
  const log = logged.find((e) => e.kind === "similar")?.data
  assert.equal(log?.ok, false)
  assert.deepEqual(Object.keys(log?.spend ?? {}), ["plan"])
  assert.equal(log?.spend.plan.model, config.similar.planModel)
  assert.deepEqual([log?.spend.plan.input, log?.spend.plan.output], [1200, 180])
  assert.ok(log?.spend.plan.usd > 0)
  assert.equal(log?.cost_usd, log?.spend.plan.usd)
})
