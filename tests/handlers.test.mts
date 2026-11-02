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
// The Claude API: an answer, an HTTP error, or a stream that refuses / stays empty / hangs / breaks off.
type ClaudeFake = {
  calls: number
  answer: string
  status?: number
  errorType?: string
  error?: string
  mode?: "refusal" | "empty" | "hang" | "midstream"
  lastBody?: Record<string, any>
  lastHeaders?: Headers
}
let claude: ClaudeFake = { calls: 0, answer: "Hello from Claude" }

function claudeStream(signal?: AbortSignal | null): Response {
  const ev = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const start = ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } })
  const words = claude.answer.split(" ").map((w, i) => (i ? ` ${w}` : w))
  const text = [ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), ...words.map((w) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: w } })), ev("content_block_stop", { index: 0 })]
  const end = (reason: string, details: unknown = null) => [ev("message_delta", { delta: { stop_reason: reason, stop_sequence: null, stop_details: details }, usage: { output_tokens: 200 } }), ev("message_stop")]
  const headers = { "Content-Type": "text/event-stream" }
  if (claude.mode === "hang") {
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(start))
        signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")))
      }
    }), { headers })
  }
  const frames = claude.mode === "refusal" ? [start, ...end("refusal", { type: "refusal", category: "general_harms", explanation: "declined" })]
    : claude.mode === "empty" ? [start, ...end("end_turn")]
    : claude.mode === "midstream" ? [start, ...text.slice(0, 3), ev("error", { error: { type: "overloaded_error", message: "Overloaded" } })]
    : [start, ...text, ...end("end_turn")]
  return new Response(frames.join(""), { headers })
}

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
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    claude.calls++
    claude.lastBody = body
    claude.lastHeaders = new Headers(init?.headers)
    if (claude.status) {
      const error = { type: claude.errorType ?? "api_error", message: claude.error ?? "failed" }
      return new Response(JSON.stringify({ type: "error", error }), { status: claude.status, headers: { "Content-Type": "application/json" } })
    }
    return claudeStream(init?.signal)
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
let find: (req: Request, ctx: any) => Promise<Response>
let status: (req: Request, ctx: any) => Promise<Response>
let legacy: (req: Request, ctx: any) => Promise<Response>
let notify: (req: Request, ctx: any) => Promise<Response>
let usage: (req: Request, ctx: any) => Promise<Response>
let event: (req: Request, ctx: any) => Promise<Response>
let adminUsage: (req: Request) => Promise<Response>
let resetModelList: () => void
let resetClaudeCooldown: () => void
let serverConfig: {
  geminiKey: string; adminToken: string; ownKeyReportDailyLimit: number; eventDailyLimit: number; proOfferCode: string
  anthropicKey: string; claudeEnabled: boolean; claudeFirstTokenMs: number; claudeMinBuild: number
}

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  resetModelList = (await import("../netlify/shared/models.mts")).resetModelListForTests
  resetClaudeCooldown = (await import("../netlify/shared/answer.mts")).resetClaudeCooldownForTests
  serverConfig = (await import("../netlify/shared/config.mts")).config
  chat = (await import("../netlify/functions/v2-chat.mts")).default
  find = (await import("../netlify/functions/v2-find.mts")).default
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
  claude = { calls: 0, answer: "Hello from Claude" }
  // Without a key the server answers with OpenAI, as before; the Claude tests set one.
  serverConfig.anthropicKey = ""
  serverConfig.claudeEnabled = true
  serverConfig.claudeFirstTokenMs = 20_000
  serverConfig.claudeMinBuild = 67
  resetClaudeCooldown()
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


// ---- Pro: "Ask your chats" and AI search ---------------------------------
const HISTORY = [
  { id: "c1", title: "Four-day week research", date: "2026-10-30T10:00:00Z", text: "Q: Is a four-day week worth it?\nA: 61 companies kept it." },
  { id: "c2", title: "Pasta in 15 minutes", date: "2026-10-20T10:00:00Z", text: "Q: Quick dinner?\nA: Garlic and chili pasta." }
]
const askHistory = (extra: Record<string, unknown> = {}) => ask({ context: "history", history: HISTORY, page: null, messages: [{ role: "user", content: "What did I read about work?" }], ...extra })
const findChats = (extra: Record<string, unknown> = {}) => post("/api/v2/find", {
  installId: INSTALL, client: { version: "2.4.0", platform: "ios", locale: "en-US" }, query: "that article about working less", chats: HISTORY, ...extra
})

test("Ask your chats: free and own-key plans are refused before anything is charged or asked", async () => {
  for (const entitlement of [undefined, signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "b1" }))]) {
    openai.lastBody = undefined
    const c = ctx()
    const res = await chat(askHistory({ entitlement }), c)
    await Promise.all(c.pending)
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, "PRO_ONLY")
    assert.equal(body.feature, "history")
    assert.equal(openai.lastBody, undefined, "no AI call")
    assert.equal(counters.size, 0, "nothing charged")
  }
  // A free install can't get it by also asking for Google either.
  const res = await chat(askHistory({ mode: "google" }), ctx())
  assert.equal(res.status, 403)
  assert.equal(gemini.lastUrl, undefined)
})

test("Ask your chats: Pro gets an answer from the chats, charged to the weekly allowance", async () => {
  const c = ctx()
  const ev = await events$(await chat(askHistory({ entitlement: signJws(transaction()) }), c))
  await Promise.all(c.pending)
  assert.equal(ev[0].plan, "pro")
  assert.equal(ev.at(-1).type, "done")
  const system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /earlier ContextFlow chats/)
  assert.match(system, /Four-day week research/)
  assert.doesNotMatch(system, /Some article text/)
  assert.equal(counters.get("tx:2000000123"), 1)
  assert.ok(events.some((e) => e.kind === "chat" && e.data.mode === "history" && e.data.history_chats === 2))
})

test("A question from the app about a saved chat: charged like an answer, the prompt says where it comes from", async () => {
  const messages = [{ role: "user", content: "Summarize" }, { role: "assistant", content: "Revenue rose 1.4%." }, { role: "user", content: "And burnout?" }]
  const c = ctx()
  const ev = await events$(await chat(ask({ context: "chat", from: "app", messages, pages: [{ title: "Other", url: "https://other.example", text: "Other saved text" }] }), c))
  await Promise.all(c.pending)
  assert.equal(ev.at(-1).type, "done")
  let system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /ContextFlow app/)
  assert.match(system, /Saved text of the chat's last page/)
  assert.match(system, /Some article text/)
  assert.match(system, /Other saved text/)
  assert.equal(counters.get(`install:${INSTALL}`), 1, "one free answer")
  // An older chat without saved page texts.
  await events$(await chat(ask({ context: "chat", from: "app", messages, page: null }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /wasn't saved with it/)
  assert.doesNotMatch(system, /browser blocks access/)
  // "from" alone (not a whole-chat request) changes nothing.
  await events$(await chat(ask({ from: "app" }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.doesNotMatch(system, /ContextFlow app/)
})

test("AI search: free and own-key plans get PRO_ONLY and no AI call", async () => {
  for (const entitlement of [undefined, signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "b2" }))]) {
    openai.lastBody = undefined
    const res = await find(findChats({ entitlement }), ctx())
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "PRO_ONLY")
    assert.equal(openai.lastBody, undefined)
    assert.equal(counters.size, 0)
  }
})

test("AI search: Pro gets matching chats (only ids it sent), one answer charged; the weekly limit applies", async () => {
  openai.answer = '{"results": [{"id": "c1", "why": "The four-day week article"}, {"id": "zz", "why": "made up"}, {"id": "c1", "why": "again"}]}'
  const jws = signJws(transaction())
  const c = ctx()
  const res = await find(findChats({ entitlement: jws }), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.results, [{ id: "c1", why: "The four-day week article" }])
  assert.deepEqual([body.usage.used, body.usage.limit], [1, 375])
  assert.equal(counters.get("tx:2000000123"), 1)
  assert.match((openai.lastBody?.messages as Array<{ content: string }>)[0].content, /id=c2/)
  assert.equal(openai.lastBody?.model, "gpt-5.2-mini", "the fast model")

  counters.set("tx:2000000123", 375)
  const limited = await find(findChats({ entitlement: jws }), ctx())
  assert.equal(limited.status, 402)
  assert.equal((await limited.json()).code, "LIMIT_REACHED")
})

test("AI search: a failed answer is refunded; bad requests are refused", async () => {
  openai.status = 500
  const c = ctx()
  const res = await find(findChats({ entitlement: signJws(transaction()) }), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 502)
  assert.equal(counters.get("tx:2000000123"), 0)
  openai.status = undefined
  assert.equal((await find(findChats({ query: "  " }), ctx())).status, 400)
  assert.equal((await find(findChats({ chats: [] }), ctx())).status, 400)
})

// ---- Claude first, OpenAI when Claude can't --------------------------------
const CLAUDE_KEY = "sk-ant-test"
const deltas = (ev: Array<Record<string, any>>) => ev.filter((e) => e.type === "delta").map((e) => e.text).join("")
const chatEvent = () => events.find((e) => e.kind === "chat")!.data

async function chatOnce(req: Request) {
  const c = ctx()
  const res = await chat(req, c)
  const ev = res.status === 200 ? await events$(res) : []
  await Promise.all(c.pending)
  return { res, ev }
}

// The first app build whose consent screen names Anthropic: only these requests may go to Claude.
const NEW_CLIENT = { version: "2.4", build: "67", platform: "ios", locale: "en-US" }
const askNew = (extra: Record<string, unknown> = {}) => ask({ client: NEW_CLIENT, ...extra })

test("Claude answers first: the free plan gets Sonnet at low effort, charged once, its spend logged", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const { ev } = await chatOnce(askNew())
  assert.equal(ev[0].model, "claude-sonnet-5-5")
  assert.equal(deltas(ev), "Hello from Claude")
  assert.equal(ev.at(-1).type, "done")
  const body = claude.lastBody!
  assert.equal(body.model, "claude-sonnet-5-5")
  assert.deepEqual(body.output_config, { effort: "low" })
  assert.equal(body.max_tokens, 3000)
  assert.equal(body.thinking, undefined, "adaptive thinking, the model's default")
  assert.equal(body.temperature, undefined)
  assert.equal(body.fallbacks, "default")
  assert.match(body.system, /Some article text/)
  assert.deepEqual(body.messages, [{ role: "user", content: "Summarize" }])
  assert.equal(claude.lastHeaders?.get("authorization"), `Bearer ${CLAUDE_KEY}`)
  assert.match(claude.lastHeaders?.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/)
  assert.equal(openai.lastBody, undefined, "OpenAI not asked")
  assert.equal(counters.get(`install:${INSTALL}`), 1)
  const e = chatEvent()
  assert.deepEqual([e.provider, e.plan, e.model, e.ok, e.fallback], ["anthropic", "free", "claude-sonnet-5-5", true, undefined])
  assert.deepEqual([e.prompt_tokens, e.completion_tokens, e.cost_usd], [1000, 200, 0.004])
})

test("Claude for Pro: the same model at medium effort, with more room for the answer", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const { ev } = await chatOnce(askNew({ entitlement: signJws(transaction()) }))
  assert.equal(ev[0].plan, "pro")
  assert.equal(deltas(ev), "Hello from Claude")
  assert.equal(claude.lastBody?.model, "claude-sonnet-5-5")
  assert.deepEqual(claude.lastBody?.output_config, { effort: "medium" })
  assert.equal(claude.lastBody?.max_tokens, 8000)
  assert.equal(chatEvent().plan, "pro")
  assert.equal(counters.get("tx:2000000123"), 1)
})

test("OpenAI answers when Claude fails before its first word: the user gets a full answer, charged once, the reason logged", async () => {
  const credits = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
  const cases: Array<[Partial<ClaudeFake>, string]> = [
    [{ status: 401, errorType: "authentication_error", error: "invalid x-api-key" }, "auth"],
    [{ status: 403, errorType: "permission_error", error: "not allowed" }, "forbidden"],
    [{ status: 429, errorType: "rate_limit_error", error: "rate limited" }, "rate_limit"],
    [{ status: 500, errorType: "api_error", error: "internal" }, "server"],
    [{ status: 529, errorType: "overloaded_error", error: "Overloaded" }, "overloaded"],
    [{ status: 400, errorType: "invalid_request_error", error: credits }, "credits"],
    [{ mode: "refusal" }, "refusal"],
    [{ mode: "empty" }, "empty"],
    [{ mode: "hang" }, "timeout"]
  ]
  for (const [fake, reason] of cases) {
    counters = new Map()
    events = []
    openai = { failModels: [], answer: "Hello world" }
    claude = { calls: 0, answer: "Hello from Claude", ...fake }
    resetClaudeCooldown()
    serverConfig.anthropicKey = CLAUDE_KEY
    serverConfig.claudeFirstTokenMs = 150
    const { res, ev } = await chatOnce(askNew())
    assert.equal(res.status, 200, reason)
    assert.equal(claude.calls, 1, `${reason}: Claude asked once`)
    assert.equal(deltas(ev), "Hello world", `${reason}: the OpenAI answer, whole`)
    assert.equal(ev.at(-1).type, "done", reason)
    assert.equal(ev[0].model, "gpt-5.2-mini", reason)
    assert.equal(counters.get(`install:${INSTALL}`), 1, `${reason}: charged once`)
    const e = chatEvent()
    assert.deepEqual([e.provider, e.fallback, e.cost_usd], ["openai", reason, undefined], reason)
  }
})

test("after Claude runs out of credits it isn't asked again for a while", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  claude.status = 400
  claude.errorType = "invalid_request_error"
  claude.error = "Your credit balance is too low to access the Anthropic API."
  await chatOnce(askNew())
  events = []
  const { ev } = await chatOnce(askNew())
  assert.equal(deltas(ev), "Hello world")
  assert.equal(claude.calls, 1, "not asked the second time")
  assert.equal(chatEvent().fallback, "cooldown_credits")

  // Credits topped up and the pause over: Claude again.
  resetClaudeCooldown()
  claude.status = undefined
  events = []
  const again = await chatOnce(askNew())
  assert.equal(deltas(again.ev), "Hello from Claude")
  assert.equal(chatEvent().provider, "anthropic")
})

test("Claude and OpenAI both down: UPSTREAM and nothing charged", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  claude.status = 500
  openai.status = 500
  const { res } = await chatOnce(askNew())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).code, "UPSTREAM")
  assert.equal(counters.get(`install:${INSTALL}`), 0)
})

test("Claude breaking off after its first words: an error and a refund, no second answer mixed in", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  claude.mode = "midstream"
  const { ev } = await chatOnce(askNew())
  assert.equal(deltas(ev), "Hello from")
  assert.equal(ev.at(-1).type, "error")
  assert.equal(ev.at(-1).code, "STREAM")
  assert.equal(openai.lastBody, undefined)
  assert.equal(counters.get(`install:${INSTALL}`), 0, "refunded")
})

test("without a key, or with CLAUDE_ANSWERS=off, OpenAI answers as before", async () => {
  await chatOnce(askNew())
  assert.deepEqual([chatEvent().provider, chatEvent().fallback], ["openai", "no_key"])
  events = []
  serverConfig.anthropicKey = CLAUDE_KEY
  serverConfig.claudeEnabled = false
  await chatOnce(askNew())
  assert.deepEqual([chatEvent().provider, chatEvent().fallback], ["openai", "off"])
  assert.equal(claude.calls, 0)
})

test("Ask your chats (Pro settings) and AI search (free settings) go to Claude too", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const jws = signJws(transaction())
  const { ev } = await chatOnce(askHistory({ client: NEW_CLIENT, entitlement: jws }))
  assert.equal(deltas(ev), "Hello from Claude")
  assert.match(claude.lastBody?.system, /earlier ContextFlow chats/)
  assert.deepEqual(claude.lastBody?.output_config, { effort: "medium" })
  assert.equal(chatEvent().mode, "history")

  events = []
  claude.answer = '{"results": [{"id": "c1", "why": "The four-day week article"}]}'
  const c = ctx()
  const res = await find(findChats({ client: NEW_CLIENT, entitlement: jws }), c)
  await Promise.all(c.pending)
  assert.deepEqual((await res.json()).results, [{ id: "c1", why: "The four-day week article" }])
  assert.deepEqual(claude.lastBody?.output_config, { effort: "low" })
  assert.match(claude.lastBody?.system, /id=c2/)
  assert.deepEqual([chatEvent().provider, chatEvent().mode, chatEvent().cost_usd], ["anthropic", "find", 0.004])
  assert.equal(counters.get("tx:2000000123"), 2)
})

test("AI search falls back to OpenAI the same way", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  claude.status = 429
  claude.errorType = "rate_limit_error"
  openai.answer = '{"results": [{"id": "c2", "why": "Pasta"}]}'
  const c = ctx()
  const res = await find(findChats({ client: NEW_CLIENT, entitlement: signJws(transaction()) }), c)
  await Promise.all(c.pending)
  assert.deepEqual((await res.json()).results, [{ id: "c2", why: "Pasta" }])
  assert.deepEqual([chatEvent().provider, chatEvent().fallback], ["openai", "rate_limit"])
  assert.equal(counters.get("tx:2000000123"), 1)
})

test("Claude answers only build 67 and later: older builds and requests without a build stay on OpenAI", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const cases: Array<[Record<string, unknown> | undefined, string, number | null]> = [
    [{ version: "2.4", build: "66", platform: "ios", locale: "en-US" }, "openai", 66],
    [{ version: "2.3", platform: "macos", locale: "en-US" }, "openai", null],
    [{ version: "2.4.0", platform: "ios", locale: "en-US" }, "openai", null],
    [undefined, "openai", null],
    [{ version: "2.4", build: "67", platform: "ios", locale: "en-US" }, "anthropic", 67],
    [{ version: "2.5", build: 70, platform: "macos", locale: "en-US" }, "anthropic", 70]
  ]
  for (const [client, provider, build] of cases) {
    counters = new Map()
    events = []
    claude.calls = 0
    const { ev } = await chatOnce(ask({ client }))
    const label = JSON.stringify(client)
    assert.equal(deltas(ev), provider === "anthropic" ? "Hello from Claude" : "Hello world", label)
    assert.equal(claude.calls, provider === "anthropic" ? 1 : 0, `${label}: Claude asked only for new builds`)
    const e = chatEvent()
    assert.deepEqual([e.provider, e.fallback, e.build], [provider, provider === "anthropic" ? undefined : "old_client", build], label)
  }

  // AI search from an old build: OpenAI.
  events = []
  claude.calls = 0
  openai.answer = '{"results": [{"id": "c2", "why": "Pasta"}]}'
  const c = ctx()
  await find(findChats({ client: { version: "2.4", build: "66", platform: "ios", locale: "en-US" }, entitlement: signJws(transaction()) }), c)
  await Promise.all(c.pending)
  assert.deepEqual([chatEvent().provider, chatEvent().fallback, claude.calls], ["openai", "old_client", 0])

  // The legacy endpoint only serves builds from before 2.0: always OpenAI.
  openai.answer = "Hello world"
  const lc = ctx()
  const legacyRes = await legacy(post("/.netlify/functions/chat-proxy", {
    anonymous: true,
    messages: [{ role: "system", content: "You are ContextFlow" }, { role: "user", content: "hi" }]
  }), lc)
  const text = await legacyRes.text()
  await Promise.all(lc.pending)
  assert.match(text, /data: \{"content":"Hello"\}/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal(claude.calls, 0)
  assert.deepEqual((openai.lastBody?.messages as Array<{ content: string }>)[0].content, "You are ContextFlow")

  // CLAUDE_MIN_BUILD=0 (the local stand): no check, a request without a build goes to Claude.
  serverConfig.claudeMinBuild = 0
  counters = new Map()
  events = []
  const { ev } = await chatOnce(ask({ client: undefined }))
  assert.equal(deltas(ev), "Hello from Claude")
  assert.deepEqual([chatEvent().provider, chatEvent().build], ["anthropic", null])
})

test("videos and PDFs are Pro: for anyone else the server leaves them out, whatever the panel sent", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const transcript = "[0:05] The secret word is PINEAPPLE."
  const pdf = "[Page 1] Revenue grew 14% in the second quarter."
  const page = {
    kind: "page", title: "Lecture", url: "https://example.com/lecture", text: "A lecture about neural networks.",
    attachments: [
      { kind: "video", heading: "Captions of the video \"Lecture\" (timestamps in [m:ss]):", text: transcript },
      { kind: "pdf", heading: "PDF \"Slides\" (3 pages, https://example.com/slides.pdf):", text: pdf }
    ]
  }
  // Free: neither the transcript nor the PDF reaches the model, which is told not to pretend it saw them.
  events = []
  await chatOnce(askNew({ page }))
  const free = claude.lastBody?.system as string
  assert.match(free, /A lecture about neural networks/)
  assert.doesNotMatch(free, /PINEAPPLE/)
  assert.doesNotMatch(free, /Revenue grew 14%/)
  assert.match(free, /a video and PDF documents that you were not given/)
  assert.deepEqual([chatEvent().skipped, chatEvent().media], ["video,pdf", undefined])

  // Pro: both go in, with the media limit and the timestamp rule.
  events = []
  await chatOnce(askNew({ page, entitlement: signJws(transaction()) }))
  const pro = claude.lastBody?.system as string
  assert.match(pro, /PINEAPPLE/)
  assert.match(pro, /Revenue grew 14%/)
  assert.match(pro, /\[m:ss\] timestamps/)
  assert.doesNotMatch(pro, /you were not given/)
  assert.deepEqual([chatEvent().media, chatEvent().skipped], ["video", undefined])

  // A PDF alone, free: left out and named as PDFs.
  events = []
  await chatOnce(askNew({ page: { ...page, attachments: [page.attachments[1]] } }))
  assert.doesNotMatch(claude.lastBody?.system as string, /Revenue grew 14%/)
  assert.match(claude.lastBody?.system as string, /PDF documents that you were not given/)
  assert.equal(chatEvent().skipped, "pdf")

  // A text that already carries a transcript (an earlier 2.4 test build) is cut to a page's limit for free.
  const composed = "x".repeat(30_000) + transcript
  await chatOnce(askNew({ page: { kind: "page", title: "V", url: "https://example.com/v", text: composed, media: "video" } }))
  assert.doesNotMatch(claude.lastBody?.system as string, /PINEAPPLE/)
  assert.match(claude.lastBody?.system as string, /a video that you were not given/)

  // The panel skipped them itself (free): nothing to drop, the answer is still told.
  await chatOnce(askNew({ page: { kind: "page", title: "T", url: "https://example.com", text: "Page text", skipped: ["video"] } }))
  assert.match(claude.lastBody?.system as string, /a video that you were not given/)
  // A PDF tab with nothing but the PDF: the request still goes, with the title and the rule.
  const { res } = await chatOnce(askNew({ page: { kind: "page", title: "Report.pdf", url: "https://example.com/r.pdf", text: "", skipped: ["pdf"] } }))
  assert.equal(res.status, 200)
  assert.match(claude.lastBody?.system as string, /Title: Report\.pdf[\s\S]*PDF documents that you were not given/)
})

test("the skipped video/PDF line's events keep only which media", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  events = []
  assert.equal((await send({ kind: "media_notice", installId: INSTALL, client: { platform: "ios", version: "2.4" }, media: "video,pdf" })).status, 200)
  assert.equal((await send({ kind: "media_notice_pro", installId: INSTALL, media: "pdf", page: "secret" })).status, 200)
  assert.equal((await send({ kind: "media_notice", installId: INSTALL, media: "audio" })).status, 200)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(events.map((e) => [e.kind, e.data?.media]), [["media_notice", "video,pdf"], ["media_notice_pro", "pdf"], ["media_notice", undefined]])
})
