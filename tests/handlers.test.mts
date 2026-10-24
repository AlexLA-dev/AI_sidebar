import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"
process.env.FREE_DAILY_LIMIT = "5"

// ---- in-memory stand-in for the cf_* RPCs --------------------------------
type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let entitlements = new Map<string, Record<string, unknown>>()
let events: { kind: string; data: Record<string, unknown> }[] = []
const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-pro", "gpt-5.2-2026-01-10", "o3"]
let openai: { failModels: string[]; status?: number; listStatus?: number; answer: string; lastBody?: Record<string, unknown> } = { failModels: [], answer: "Hello world" }

const rpc: Record<string, (args: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) >= i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + 1))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: ({ p_items }) => {
    for (const i of p_items as Item[]) counters.set(i.subject, Math.max(0, (counters.get(i.subject) ?? 0) - 1))
    return null
  },
  cf_peek: ({ p_items }) => (p_items as Item[]).map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })),
  cf_touch_install: () => null,
  cf_log: ({ p_kind, p_data }) => {
    events.push({ kind: p_kind, data: p_data })
    return null
  },
  cf_entitlement_upsert: ({ p }) => {
    const prev = entitlements.get(p.original_transaction_id) ?? {}
    const row = { ...prev, ...p, revoked_at: p.revoked_at ?? prev.revoked_at ?? null }
    entitlements.set(p.original_transaction_id, row)
    return row
  },
  cf_entitlement_get: ({ p_original_transaction_id }) => entitlements.get(p_original_transaction_id) ?? null,
  cf_entitlement_by_token: () => null
}

function sse(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (!rpc[fn]) return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url === "https://api.openai.com/v1/models") {
    if (openai.listStatus) return new Response("unavailable", { status: openai.listStatus })
    return new Response(JSON.stringify({ data: OPENAI_MODELS.map((id) => ({ id, object: "model" })) }), { headers: { "Content-Type": "application/json" } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    openai.lastBody = body
    if (openai.failModels.includes(body.model)) return new Response(`{"error":{"message":"The model ${body.model} does not exist"}}`, { status: 404 })
    if (openai.status) return new Response("overloaded", { status: openai.status })
    return sse(openai.answer.split(" ").map((w, i) => (i ? ` ${w}` : w)))
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

// --------------------------------------------------------------------------
let chat: (req: Request, ctx: any) => Promise<Response>
let status: (req: Request, ctx: any) => Promise<Response>
let legacy: (req: Request, ctx: any) => Promise<Response>
let notify: (req: Request, ctx: any) => Promise<Response>
let resetModelList: () => void

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  resetModelList = (await import("../netlify/shared/models.mts")).resetModelListForTests
  chat = (await import("../netlify/functions/v2-chat.mts")).default
  status = (await import("../netlify/functions/v2-status.mts")).default
  legacy = (await import("../netlify/functions/chat-proxy.mts")).default
  notify = (await import("../netlify/functions/appstore-verify.mts")).default
})

beforeEach(() => {
  counters = new Map()
  entitlements = new Map()
  events = []
  openai = { failModels: [], answer: "Hello world" }
  resetModelList()
})

function ctx() {
  const pending: Promise<unknown>[] = []
  return { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://aisidebar.netlify.app${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } })

async function events$(res: Response) {
  const text = await res.text()
  return text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")))
}

const ask = (extra: Record<string, unknown> = {}) => post("/api/v2/chat", {
  installId: INSTALL,
  client: { version: "2.0.0", platform: "ios", locale: "en-US" },
  messages: [{ role: "user", content: "Summarize" }],
  page: { kind: "page", title: "T", url: "https://example.com", text: "Some article text" },
  ...extra
})

test("free plan streams an answer and enforces the daily limit", async () => {
  for (let i = 1; i <= 5; i++) {
    const c = ctx()
    const res = await chat(ask(), c)
    assert.equal(res.status, 200)
    const ev = await events$(res)
    await Promise.all(c.pending)
    assert.equal(ev[0].type, "meta")
    assert.equal(ev[0].plan, "free")
    assert.equal(ev[0].usage.used, i)
    assert.equal(ev.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Hello world")
    assert.equal(ev.at(-1).type, "done")
  }
  const res = await chat(ask(), ctx())
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.deepEqual([body.usage.used, body.usage.limit, body.usage.period], [5, 5, "day"])
  assert.ok(events.some((e) => e.kind === "chat" && e.data.prompt_tokens === 100))
})

test("free plan uses the newest mini model as a reasoning model", async () => {
  const ev = await events$(await chat(ask(), ctx()))
  assert.equal(ev[0].model, "gpt-5.2-mini")
  assert.equal(openai.lastBody?.reasoning_effort, "low")
  assert.equal(openai.lastBody?.temperature, undefined)
})

test("falls back to the next model when the first is unavailable", async () => {
  openai.failModels = ["gpt-5.2-mini"]
  const ev = await events$(await chat(ask(), ctx()))
  assert.equal(ev[0].model, "gpt-5-mini")
})

test("uses the fallback models when the model list can't be fetched", async () => {
  openai.listStatus = 500
  const ev = await events$(await chat(ask(), ctx()))
  assert.equal(ev[0].model, "gpt-5-mini")
})

test("upstream failure refunds the request", async () => {
  openai.status = 500
  const c = ctx()
  const res = await chat(ask(), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 502)
  assert.equal(counters.get(`install:${INSTALL}`), 0)
})

test("a verified Pro transaction switches to the weekly Pro allowance", async () => {
  const jws = signJws(transaction())
  const ev = await events$(await chat(ask({ entitlement: jws }), ctx()))
  assert.equal(ev[0].plan, "pro")
  assert.equal(ev[0].model, "gpt-5.2")
  assert.deepEqual([ev[0].usage.used, ev[0].usage.limit, ev[0].usage.period], [1, 375, "week"])
  assert.equal(counters.get("tx:2000000123"), 1)
  assert.equal(counters.get(`install:${INSTALL}`), undefined)
})

test("forged, expired and refunded transactions fall back to free", async () => {
  const forged = await events$(await chat(ask({ entitlement: signJws(transaction(), { leaf: "rogue" }) }), ctx()))
  assert.equal(forged[0].plan, "free")
  assert.match(forged[0].entitlementError, /App Store signing certificate/)

  const expired = signJws(transaction({ originalTransactionId: "e1", expiresDate: Date.now() - 5 * 86_400_000 }))
  assert.equal((await events$(await chat(ask({ entitlement: expired }), ctx())))[0].plan, "free")

  entitlements.set("r1", { original_transaction_id: "r1", revoked_at: new Date().toISOString() })
  const refunded = signJws(transaction({ originalTransactionId: "r1" }))
  const ev = await events$(await chat(ask({ entitlement: refunded }), ctx()))
  assert.equal(ev[0].plan, "free")
  assert.equal(ev[0].entitlementError, "revoked")
})

test("status reports plan and remaining allowance without consuming", async () => {
  await (await chat(ask(), ctx())).text()
  const res = await status(post("/api/v2/status", { installId: INSTALL, client: { platform: "macos" } }), ctx())
  const body = await res.json()
  assert.equal(body.plan, "free")
  assert.equal(body.usage.used, 1)
  assert.equal(counters.get(`install:${INSTALL}`), 1)
})

test("rejects malformed requests", async () => {
  assert.equal((await chat(post("/api/v2/chat", { installId: "nope", messages: [] }), ctx())).status, 400)
  assert.equal((await chat(ask({ messages: [{ role: "system", content: "x" }] }), ctx())).status, 400)
  assert.equal((await chat(new Request("https://x/api/v2/chat", { method: "OPTIONS" }), ctx())).status, 204)
})

test("legacy chat-proxy keeps old builds working (anonymous)", async () => {
  const res = await legacy(post("/.netlify/functions/chat-proxy", {
    anonymous: true,
    messages: [{ role: "system", content: "You are ContextFlow" }, { role: "user", content: "hi" }]
  }), ctx())
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \{"content":"Hello"\}/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal((await legacy(post("/.netlify/functions/chat-proxy", { messages: [{ role: "user", content: "hi" }] }), ctx())).status, 401)
})

test("App Store notification records a refund", async () => {
  const signedTransactionInfo = signJws(transaction({ originalTransactionId: "n1", revocationDate: Date.now() }))
  const signedPayload = signJws({ notificationType: "REFUND", notificationUUID: "u1", data: { bundleId: "com.contextflow.app", signedTransactionInfo }, signedDate: Date.now() })
  const res = await notify(post("/.netlify/functions/appstore-verify", { signedPayload }), ctx())
  assert.equal(res.status, 200)
  assert.ok(entitlements.get("n1")?.revoked_at)
  const bad = await notify(post("/.netlify/functions/appstore-verify", { signedPayload: signJws({ notificationType: "TEST" }, { leaf: "rogue" }) }), ctx())
  assert.equal(bad.status, 400)
})
