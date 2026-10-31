import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"
process.env.FREE_DAILY_LIMIT = "5"
process.env.GEMINI_API_KEY = "gemini-test"

// ---- in-memory stand-in for the cf_* RPCs --------------------------------
type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let entitlements = new Map<string, Record<string, unknown>>()
let events: { kind: string; install?: string | null; data: Record<string, unknown>; at: number }[] = []
const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-pro", "gpt-5.2-2026-01-10", "o3"]
let openai: { failModels: string[]; status?: number; listStatus?: number; answer: string; lastBody?: Record<string, unknown> } = { failModels: [], answer: "Hello world" }
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash-tts", "gemini-4-argon"]
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models"
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/"
let gemini: { lastUrl?: string; lastBody?: Record<string, any>; lastKey?: string | null } = {}

function geminiStream(): Response {
  const frames = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Paris is the capital of France. " }] } }] },
    {
      candidates: [{
        content: { role: "model", parts: [{ text: "It has about 2 million residents." }] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["capital of France"],
          searchEntryPoint: { renderedContent: "<style>.chip{color:#000}</style><div class=\"container\"><a class=\"chip\" href=\"https://www.google.com/search?q=capital+of+France\">capital of France</a></div>" },
          groundingChunks: [{ web: { uri: `${REDIRECT}a`, title: "wikipedia.org" } }, { web: { uri: `${REDIRECT}b`, title: "britannica.com" } }],
          groundingSupports: [
            { segment: { startIndex: 0, endIndex: 31, text: "Paris is the capital of France." }, groundingChunkIndices: [0] },
            { segment: { startIndex: 32, endIndex: 65, text: "It has about 2 million residents." }, groundingChunkIndices: [1, 0] }
          ]
        }
      }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 }
    }
  ]
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
}

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
  cf_log: ({ p_kind, p_install, p_data }) => {
    events.push({ kind: p_kind, install: p_install, data: p_data, at: Date.now() })
    return null
  },
  cf_limited_before: ({ p_install }) => limitedBefore(p_install),
  cf_entitlement_upsert: ({ p }) => {
    const prev = entitlements.get(p.original_transaction_id) ?? {}
    const row = { ...prev, ...p, revoked_at: p.revoked_at ?? prev.revoked_at ?? null }
    entitlements.set(p.original_transaction_id, row)
    return row
  },
  cf_entitlement_get: ({ p_original_transaction_id }) => entitlements.get(p_original_transaction_id) ?? null,
  cf_entitlement_by_token: () => null,
  cf_usage_report: ({ p_days }) => ({ days: p_days, segments: [{ key: "ours", segment: "ai", requests: 3 }] }),
  cf_setup_funnel: () => [{ day: "2026-10-30", app_opened: 4, extension_on: 3, panel_opened: 2 }]
}

// Same rule as cf_limited_before: a free limit hit on an earlier UTC day.
function limitedBefore(install: string) {
  const today = Date.parse(new Date().toISOString().slice(0, 10))
  return events.some((e) => e.kind === "limit" && e.install === install && e.data.plan === "free" &&
    ["limit", "search"].includes(String(e.data.reason)) && e.at < today)
}

function sse(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

// AdServices tokens the fake Apple attribution API knows (plain-text body, not JSON).
const ADS: Record<string, { status: number; body?: Record<string, unknown> }> = {
  "tok-ad": { status: 200, body: { attribution: true, orgId: 1222900, campaignId: 2145005369, adGroupId: 11, keywordId: 22, adId: 33, countryOrRegion: "US", conversionType: "Download", claimType: "Click", clickDate: "2026-10-31T10:00Z" } },
  "tok-organic": { status: 200, body: { attribution: false } }
}
let adsCalls = 0

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url === "https://api-adservices.apple.com/api/v1/") {
    adsCalls++
    const hit = ADS[String(init?.body)] ?? { status: 404 }
    return new Response(hit.body ? JSON.stringify(hit.body) : "", { status: hit.status, headers: { "Content-Type": "application/json" } })
  }
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
  if (url === `${GEMINI}?pageSize=1000`) {
    return new Response(JSON.stringify({ models: GEMINI_MODELS.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent", "countTokens"] })) }), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith(GEMINI) && url.endsWith(":streamGenerateContent?alt=sse")) {
    gemini = { lastUrl: url, lastBody: body, lastKey: new Headers(init?.headers).get("x-goog-api-key") }
    return geminiStream()
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

// --------------------------------------------------------------------------
let chat: (req: Request, ctx: any) => Promise<Response>
let status: (req: Request, ctx: any) => Promise<Response>
let legacy: (req: Request, ctx: any) => Promise<Response>
let notify: (req: Request, ctx: any) => Promise<Response>
let usage: (req: Request, ctx: any) => Promise<Response>
let event: (req: Request, ctx: any) => Promise<Response>
let adminUsage: (req: Request) => Promise<Response>
let resetModelList: () => void
let serverConfig: { geminiKey: string; adminToken: string; ownKeyReportDailyLimit: number; eventDailyLimit: number; proOfferCode: string }

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  resetModelList = (await import("../netlify/shared/models.mts")).resetModelListForTests
  serverConfig = (await import("../netlify/shared/config.mts")).config
  chat = (await import("../netlify/functions/v2-chat.mts")).default
  status = (await import("../netlify/functions/v2-status.mts")).default
  legacy = (await import("../netlify/functions/chat-proxy.mts")).default
  notify = (await import("../netlify/functions/appstore-verify.mts")).default
  usage = (await import("../netlify/functions/v2-usage.mts")).default
  event = (await import("../netlify/functions/v2-event.mts")).default
  adminUsage = (await import("../netlify/functions/v2-admin-usage.mts")).default
})

beforeEach(() => {
  counters = new Map()
  entitlements = new Map()
  events = []
  openai = { failModels: [], answer: "Hello world" }
  gemini = {}
  serverConfig.geminiKey = "gemini-test"
  serverConfig.adminToken = ""
  serverConfig.ownKeyReportDailyLimit = 1000
  serverConfig.eventDailyLimit = 30
  serverConfig.proOfferCode = "CONTEXTFLOW50"
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
  const logged = events.find((e) => e.kind === "appstore_notification")
  assert.equal(logged?.data.otid, "n1")
  assert.equal(logged?.data.type, "REFUND")
  const bad = await notify(post("/.netlify/functions/appstore-verify", { signedPayload: signJws({ notificationType: "TEST" }, { leaf: "rogue" }) }), ctx())
  assert.equal(bad.status, 400)
})

test("App Store notification names the offer code a subscription started with", async () => {
  const signedTransactionInfo = signJws(transaction({ originalTransactionId: "n2", offerType: 3, offerIdentifier: "Limit hitters: first month 50% off", offerDiscountType: "PAY_AS_YOU_GO", price: 3490 }))
  const signedPayload = signJws({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: "u2", data: { bundleId: "com.contextflow.app", signedTransactionInfo }, signedDate: Date.now() })
  assert.equal((await notify(post("/.netlify/functions/appstore-verify", { signedPayload }), ctx())).status, 200)
  const logged = events.find((e) => e.kind === "appstore_notification")
  assert.deepEqual([logged?.data.offer, logged?.data.offer_id, logged?.data.discount], [3, "Limit hitters: first month 50% off", "PAY_AS_YOU_GO"])
})

test("Google mode streams a grounded answer with citations, sources and Search Suggestions", async () => {
  const c = ctx()
  const res = await chat(ask({ mode: "google", page: { kind: "selection", title: "T", url: "https://example.com", text: "capital of France" } }), c)
  assert.equal(res.status, 200)
  const ev = await events$(res)
  await Promise.all(c.pending)
  assert.deepEqual(ev.map((e) => e.type), ["meta", "delta", "delta", "grounding", "done"])
  assert.equal(ev[0].model, "gemini-3.8-flash")
  assert.equal(gemini.lastUrl, `${GEMINI}/gemini-3.8-flash:streamGenerateContent?alt=sse`)
  assert.equal(gemini.lastKey, "gemini-test")
  assert.deepEqual(gemini.lastBody?.tools, [{ google_search: {} }])
  assert.equal(gemini.lastBody?.generationConfig.thinkingConfig.thinkingLevel, "low")
  assert.match(gemini.lastBody?.systemInstruction.parts[0].text, /selected this text/)
  assert.deepEqual(gemini.lastBody?.contents, [{ role: "user", parts: [{ text: "Summarize" }] }])

  const g = ev[3]
  assert.equal(g.text, `Paris is the capital of France.[1](${REDIRECT}a) It has about 2 million residents.[2](${REDIRECT}b)[1](${REDIRECT}a)`)
  assert.deepEqual(g.grounding.sources.map((s: { title: string }) => s.title), ["wikipedia.org", "britannica.com"])
  assert.match(g.grounding.suggestions, /google\.com\/search/)
  assert.deepEqual(g.grounding.queries, ["capital of France"])
  // Counts as a normal answer too.
  assert.equal(ev[0].usage.used, 1)
  assert.equal(counters.get(`search:install:${INSTALL}`), 1)
  assert.ok(events.some((e) => e.kind === "chat" && e.data.mode === "google" && e.data.search_queries === 1))
})

test("Google answers have their own, smaller allowance", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await chat(ask({ mode: "google" }), ctx())).status, 200)
  const c = ctx()
  const res = await chat(ask({ mode: "google" }), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 402)
  assert.equal((await res.json()).code, "SEARCH_LIMIT")
  // Limit events carry the app version and device so review traffic can be told apart.
  const limit = events.find((e) => e.kind === "limit")
  assert.deepEqual([limit?.data.reason, limit?.data.mode, limit?.data.platform, limit?.data.version], ["search", "google", "ios", "2.0.0"])
  // Regular answers still work.
  assert.equal((await chat(ask(), ctx())).status, 200)
})

test("Google mode without a Gemini key is unavailable and charges nothing", async () => {
  serverConfig.geminiKey = ""
  const res = await chat(ask({ mode: "google" }), ctx())
  assert.equal(res.status, 503)
  assert.equal((await res.json()).code, "SEARCH_UNAVAILABLE")
  assert.equal(counters.size, 0)
})

test("answer events record the analytics segment: our key, provider, Google or not", async () => {
  const c1 = ctx()
  await (await chat(ask(), c1)).text()
  await Promise.all(c1.pending)
  const c2 = ctx()
  await (await chat(ask({ mode: "google" }), c2)).text()
  await Promise.all(c2.pending)
  const [ai, google] = events.filter((e) => e.kind === "chat").map((e) => e.data)
  assert.deepEqual([ai.key, ai.provider, ai.mode, ai.ok], ["ours", "openai", "chat", true])
  assert.deepEqual([google.key, google.provider, google.mode, google.ok], ["ours", "gemini", "google", true])
})

const report = (extra: Record<string, unknown> = {}) => post("/api/v2/usage", {
  installId: INSTALL,
  client: { version: "2.1.1", platform: "ios", locale: "en-US" },
  usage: { provider: "anthropic", model: "claude-sonnet-5-5", tier: "smart", action: "summarize", ok: true, promptTokens: 1200, completionTokens: 300, ms: 4200, ...extra }
})

test("own-key usage reports are logged as counters only", async () => {
  const c = ctx()
  const res = await usage(report({ question: "secret", key: "sk-should-not-be-stored" }), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 204)
  const e = events.find((x) => x.kind === "chat")
  assert.deepEqual(
    [e?.data.key, e?.data.provider, e?.data.model, e?.data.ok, e?.data.prompt_tokens, e?.data.completion_tokens, e?.data.ms, e?.data.action],
    ["own", "anthropic", "claude-sonnet-5-5", true, 1200, 300, 4200, "summarize"]
  )
  assert.ok(!JSON.stringify(e?.data).includes("secret"))
  assert.equal((await usage(report({ provider: "gemini" }), ctx())).status, 400)
  assert.equal((await usage(post("/api/v2/usage", { installId: "nope", usage: {} }), ctx())).status, 400)
})

test("own-key usage reports are capped per install", async () => {
  serverConfig.ownKeyReportDailyLimit = 2
  for (let i = 0; i < 4; i++) {
    const c = ctx()
    assert.equal((await usage(report({ ok: false, error: "BUSY" }), c)).status, 204)
    await Promise.all(c.pending)
  }
  assert.equal(events.filter((x) => x.kind === "chat").length, 2)
  assert.equal(events[0].data.error, "BUSY")
})

test("admin usage report needs ADMIN_TOKEN", async () => {
  const get = (token?: string, days = "7") => new Request(`https://aisidebar.netlify.app/api/v2/admin/usage?days=${days}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  assert.equal((await adminUsage(get("anything"))).status, 404)
  serverConfig.adminToken = "admin-test"
  assert.equal((await adminUsage(get())).status, 401)
  assert.equal((await adminUsage(get("wrong"))).status, 401)
  const res = await adminUsage(get("admin-test", "999"))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.days, 180)
  assert.equal(body.segments[0].requests, 3)
  assert.equal(body.setup_funnel[0].app_opened, 4)
})

const statusOf = async (extra: Record<string, unknown> = {}) =>
  (await status(post("/api/v2/status", { installId: INSTALL, client: { platform: "ios" }, ...extra }), ctx())).json()
async function hitFreeLimit() {
  for (let i = 0; i < 6; i++) await (await chat(ask(), ctx())).text()
  await new Promise((r) => setTimeout(r, 0))
}

test("a free install out of answers is offered the App Store code, today and on later days", async () => {
  const fresh = await statusOf()
  assert.deepEqual([fresh.limitedBefore, fresh.offer], [false, null])
  await hitFreeLimit()
  // At the limit: the 402 and today's status carry the code.
  const limited = await chat(ask(), ctx())
  assert.equal(limited.status, 402)
  assert.deepEqual((await limited.json()).offer, { code: "CONTEXTFLOW50", discount: 50 })
  assert.deepEqual([(await statusOf()).limitedBefore, (await statusOf()).offer?.code], [false, "CONTEXTFLOW50"])

  // A day later, with answers back: still offered, once more, as someone who ran out before.
  events.forEach((e) => { e.at -= 86_400_000 })
  counters.clear()
  const back = await statusOf()
  assert.deepEqual([back.plan, back.limitedBefore, back.offer?.discount], ["free", true, 50])
  // Subscribers aren't offered anything; PRO_OFFER_CODE=off stops it.
  const sub = await statusOf({ entitlement: signJws(transaction()) })
  assert.deepEqual([sub.limitedBefore, sub.offer], [false, null])
  serverConfig.proOfferCode = "off"
  assert.equal((await statusOf()).offer, null)
})

test("funnel events are logged with only the allowed fields and capped per id", async () => {
  const APP = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  const res = await send({ kind: "app_open", appId: APP, installId: INSTALL, client: { platform: "ios", version: "2.4", locale: "ru" }, extension: "off", notifications: "granted", page: "secret" })
  assert.equal(res.status, 200)
  await new Promise((r) => setTimeout(r, 0))
  const logged = events.find((e) => e.kind === "app_open")
  assert.equal(logged?.install, INSTALL)
  assert.deepEqual(logged?.data, { app: APP, platform: "ios", version: "2.4", locale: "ru", extension: "off", notifications: "granted" })

  assert.equal((await send({ kind: "ext_on", installId: INSTALL })).status, 200)
  assert.equal((await send({ kind: "chat", installId: INSTALL })).status, 400)
  assert.equal((await send({ kind: "app_open" })).status, 400)

  serverConfig.eventDailyLimit = 2
  assert.equal((await send({ kind: "app_open", appId: APP })).status, 200)
  assert.equal((await send({ kind: "app_open", appId: APP })).status, 429)
})

test("an Apple Ads attribution token is resolved and only campaign ids are kept", async () => {
  const APP = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  const ad = await send({ kind: "app_open", appId: APP, client: { platform: "ipados", version: "2.4" }, adToken: "tok-ad" })
  assert.deepEqual(await ad.json(), { ok: true, ads: "attributed" })
  await new Promise((r) => setTimeout(r, 0))
  const logged = events.find((e) => e.kind === "ads_attribution")
  assert.deepEqual(logged?.data, { app: APP, orgId: 1222900, campaignId: 2145005369, adGroupId: 11, keywordId: 22, adId: 33, countryOrRegion: "US", conversionType: "Download", claimType: "Click", clickDate: "2026-10-31T10:00Z" })

  const organic = await send({ kind: "app_open", appId: APP, adToken: "tok-organic" })
  assert.deepEqual(await organic.json(), { ok: true, ads: "organic" })
  assert.equal(events.filter((e) => e.kind === "ads_attribution").length, 1)

  // Only "app opened" carries a token; the extension's event never triggers a lookup.
  const calls = adsCalls
  assert.deepEqual(await (await send({ kind: "ext_on", installId: INSTALL, adToken: "tok-ad" })).json(), { ok: true })
  assert.equal(adsCalls, calls)
})

test("an attribution record Apple doesn't have yet is retried once, then reported as pending", async () => {
  const { resolveAdToken } = await import("../netlify/shared/adservices.mts")
  const calls = adsCalls
  assert.equal(await resolveAdToken("tok-unknown", 0), "pending")
  assert.equal(adsCalls - calls, 2)
})
