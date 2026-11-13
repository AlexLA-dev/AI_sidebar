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
type Item = { subject: string; period: string; limit: number | null; amount?: number }
let counters = new Map<string, number>()
let entitlements = new Map<string, Record<string, unknown>>()
let events: { kind: string; install?: string | null; data: Record<string, unknown>; at: number }[] = []
const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-pro", "gpt-5.2-2026-01-10", "o3"]
let openai: { failModels: string[]; status?: number; listStatus?: number; answer: string; finish?: string; lastBody?: Record<string, unknown> } = { failModels: [], answer: "Hello world" }
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

/** Claude's system prompt as one text (2.5 sends it as blocks: the cached rules and page, then the rest). */
function systemText(body: Record<string, any> | undefined): string {
  return Array.isArray(body?.system) ? body.system.map((b: { text: string }) => b.text).join("\n") : body?.system
}

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
    // As cf_consume: an item counts as its amount (a long page), allowed only when all of it fits.
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) + (i.amount ?? 1) > i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + (i.amount ?? 1)))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: ({ p_items }) => {
    for (const i of p_items as Item[]) counters.set(i.subject, Math.max(0, (counters.get(i.subject) ?? 0) - (i.amount ?? 1)))
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
  cf_setup_funnel: () => [{ day: "2026-10-30", app_opened: 4, extension_on: 3, panel_opened: 2 }],
  cf_owner_insights: ({ p_days }) => ({ days: p_days, per_user: [{ plan: "free", users: 2, user_days: 3, asked_days: 2, requests: 4, max_per_day: 3 }] }),
  cf_limits_report: ({ p_days }) => ({ days: p_days, rows: [{ key: "memory_window", hits: 74, base: 311, status: "systematic" }] }),
  cf_organize_report: ({ p_days }) => ({ days: p_days, suggestions: [{ what: "move", why: "site", shown: 5, accepted: 3, dismissed: 1, undone: 1, users: 2 }], promo: [], optin: [], api: null }),
  cf_mrr_history: ({ p_days }) => ({ days: p_days, today: "2026-11-10", points: [{ day: "2026-11-10", plan: "byok", yearly: false, renewal_off: false, currency: "EUR", subs: 1, amount: 1990, ending: 0, ending_amount: 0, estimated: 0 }] }),
  cf_retention: ({ p_days }) => ({ days: p_days, today: "2026-11-10", users: { cohorts: [], cells: [] }, subscribers: { cohorts: [], cells: [], renewals: [] } }),
  cf_ultra_report: ({ p_days }) => ({ days: p_days, today: "2026-11-08", voice: { total: { texts: 3, minutes: 4.1 }, by_day: [], by_model: [], weeks: [] }, similar: { total: { searches: 4 }, by_day: [], by_model: [], weeks: [] } }),
  cf_onboarding: () => ({ people: [{ day: "2026-11-01", device: "iPhone", kind: "app", ext: 300, panel: 420, answer: 540, limit: 900, paid: 1200 }], open_reviews: [] }),
  cf_new_user_outcomes: () => [{ day: "2026-11-02", new: 12, limit_d0: 3, pro_bought: 2 }],
  cf_features: ({ p_days, p_base }) => ({ days: p_days, active: 2, features: [{ f: "ask", base: 2, people: 2 }], base: p_base }),
  cf_feature_funnels: () => [{ funnel: "purchase", steps: [{ k: 1, step: "upsell.shown", people: 1 }] }],
  cf_after_limit: () => ({ days: 7, today: "2026-11-05", people: [{ day: "2026-11-04", platform: "ios", locale: "uk-UA", before: 5, paid_after: null, back_days: 1 }], paying: [] }),
  cf_releases: () => [{ platform: "IOS", version: "2.4", approved_at: "2026-11-04T14:59:19Z" }]
}

// Same rule as cf_limited_before: a free limit hit on an earlier UTC day.
function limitedBefore(install: string) {
  const today = Date.parse(new Date().toISOString().slice(0, 10))
  return events.some((e) => e.kind === "limit" && e.install === install && e.data.plan === "free" &&
    ["limit", "search"].includes(String(e.data.reason)) && e.at < today)
}

function sse(chunks: string[], finish?: string): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") +
    (finish ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n` : "") +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

// AdServices tokens the fake Apple attribution API knows (plain-text body, not JSON).
const ADS: Record<string, { status: number; body?: Record<string, unknown> }> = {
  "tok-ad": { status: 200, body: { attribution: true, orgId: 1222900, campaignId: 2145005369, adGroupId: 11, keywordId: 22, adId: 33, countryOrRegion: "US", conversionType: "Download", claimType: "Click", clickDate: "2026-10-31T10:00Z" } },
  "tok-organic": { status: 200, body: { attribution: false } }
}
let adsCalls = 0
// What the fake X App Conversion API was sent: the token header and the conversions of each request.
let xCalls: { token: string | null; conversions: Record<string, unknown>[] }[] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url === "https://ads-api.x.com/12/accounts/18ce55yj09v/measurement/app_conversions") {
    const conversions = JSON.parse(String(init?.body)).conversions as Record<string, unknown>[]
    xCalls.push({ token: new Headers(init?.headers).get("X-App-Conversion-Token"), conversions })
    return new Response(JSON.stringify({ data: { conversions_processed: conversions.length, debug_id: "dbg" } }), { headers: { "Content-Type": "application/json" } })
  }
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
    return sse(openai.answer.split(" ").map((w, i) => (i ? ` ${w}` : w)), openai.finish)
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
  geminiKey: string; adminToken: string; xAppConversionToken: string; ownKeyReportDailyLimit: number; eventDailyLimit: number; useEventDailyLimit: number; proOfferCode: string
  anthropicKey: string; claudeEnabled: boolean; claudeFirstTokenMs: number; claudeMinBuild: number; freeDailyLimit: number
  ultra: { speakWeeklySeconds: number; similarWeekly: number }
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
  serverConfig.useEventDailyLimit = 1000
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

test("a subscriber's answers carry the subscription id, free answers don't", async () => {
  const paid = ctx()
  await (await chat(ask({ entitlement: signJws(transaction()) }), paid)).text()
  await Promise.all(paid.pending)
  const free = ctx()
  await (await chat(ask(), free)).text()
  await Promise.all(free.pending)
  const [pro, plain] = events.filter((e) => e.kind === "chat").map((e) => e.data)
  assert.deepEqual([pro.plan, pro.otid], ["pro", "2000000123"])
  assert.deepEqual([plain.plan, "otid" in plain], ["free", false])
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

test("App Store notification: a cancellation stays the subscription's state through a refund request", async () => {
  const send = async (notificationType: string, subtype?: string) => {
    const signedTransactionInfo = signJws(transaction({ originalTransactionId: "n3" }))
    const signedPayload = signJws({ notificationType, subtype, notificationUUID: `u-${notificationType}`, data: { bundleId: "com.contextflow.app", signedTransactionInfo }, signedDate: Date.now() })
    assert.equal((await notify(post("/.netlify/functions/appstore-verify", { signedPayload }), ctx())).status, 200)
    return entitlements.get("n3")?.last_notification
  }
  assert.equal(await send("SUBSCRIBED", "INITIAL_BUY"), "SUBSCRIBED:INITIAL_BUY")
  assert.equal(await send("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED"), "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED")
  for (const informational of ["CONSUMPTION_REQUEST", "REFUND_DECLINED", "PRICE_INCREASE", "RENEWAL_EXTENDED", "METADATA_UPDATE"]) {
    assert.equal(await send(informational), "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED", `${informational} keeps the cancellation`)
  }
  assert.equal(await send("EXPIRED", "VOLUNTARY"), "EXPIRED:VOLUNTARY")
  // Every notification is still in the history.
  assert.equal(events.filter((e) => e.kind === "appstore_notification" && e.data.otid === "n3").length, 8)
})

test("App Store notification names the offer code a subscription started with", async () => {
  const signedTransactionInfo = signJws(transaction({ originalTransactionId: "n2", offerType: 3, offerIdentifier: "Limit hitters: first month 50% off", offerDiscountType: "PAY_AS_YOU_GO", price: 3490 }))
  const signedPayload = signJws({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: "u2", data: { bundleId: "com.contextflow.app", signedTransactionInfo }, signedDate: Date.now() })
  assert.equal((await notify(post("/.netlify/functions/appstore-verify", { signedPayload }), ctx())).status, 200)
  const logged = events.find((e) => e.kind === "appstore_notification")
  assert.deepEqual([logged?.data.offer, logged?.data.offer_id, logged?.data.discount], [3, "Limit hitters: first month 50% off", "PAY_AS_YOU_GO"])
})

test("App Store notification logs what the next renewal costs and whether it's on", async () => {
  const signedTransactionInfo = signJws(transaction({ originalTransactionId: "n4", offerType: 3, offerDiscountType: "PAY_AS_YOU_GO", price: 3490, currency: "USD" }))
  const signedRenewalInfo = signJws({ originalTransactionId: "n4", autoRenewStatus: 1, autoRenewProductId: "com.contextflow.pro.monthly", renewalPrice: 6990, currency: "USD", renewalDate: Date.parse("2026-12-10T10:00:00Z"), signedDate: Date.now() })
  const signedPayload = signJws({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", notificationUUID: "u4", data: { bundleId: "com.contextflow.app", signedTransactionInfo, signedRenewalInfo }, signedDate: Date.now() })
  assert.equal((await notify(post("/.netlify/functions/appstore-verify", { signedPayload }), ctx())).status, 200)
  const logged = events.find((e) => e.kind === "appstore_notification" && e.data.otid === "n4")
  assert.deepEqual(
    [logged?.data.price, logged?.data.auto_renew, logged?.data.renewal_product, logged?.data.renewal_price, logged?.data.renewal_currency, logged?.data.renewal_offer, logged?.data.renewal_at],
    [3490, true, "com.contextflow.pro.monthly", 6990, "USD", null, "2026-12-10T10:00:00.000Z"])
  // Renewal info that doesn't verify is left out; the notification still counts.
  const rogue = signJws({ autoRenewStatus: 0 }, { leaf: "rogue" })
  const second = signJws({ notificationType: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", notificationUUID: "u5", data: { bundleId: "com.contextflow.app", signedTransactionInfo, signedRenewalInfo: rogue }, signedDate: Date.now() })
  assert.equal((await notify(post("/.netlify/functions/appstore-verify", { signedPayload: second }), ctx())).status, 200)
  const off = events.find((e) => e.kind === "appstore_notification" && e.data.uuid === "u5")
  assert.equal(off?.data.type, "DID_CHANGE_RENEWAL_STATUS")
  assert.equal("auto_renew" in (off?.data ?? {}), false)
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

test("answer events mark the limits they ran into and the chat's size (2.4)", async () => {
  const one = async (body: Record<string, unknown>) => {
    events.length = 0
    counters.clear()
    const c = ctx()
    await (await chat(ask(body), c)).text()
    await Promise.all(c.pending)
    return events.find((e) => e.kind === "chat")!.data
  }
  // Nothing in the way: only the mark that the event carries the flags.
  const plain = await one({})
  assert.equal(plain.limits_v, 1)
  assert.ok(!["page_cut", "history_cut", "other_pages_cut", "answer_cut", "chat_turns"].some((k) => k in plain))
  // A page at its limit (the panel cuts it there), and a selection at its own.
  assert.equal((await one({ page: { kind: "page", title: "T", url: "https://x.example", text: "a".repeat(24_000) } })).page_cut, true)
  assert.equal((await one({ page: { kind: "selection", title: "T", url: "https://x.example", text: "a".repeat(12_000) } })).page_cut, true)
  assert.equal((await one({ page: { kind: "page", title: "T", url: "https://x.example", text: "a".repeat(23_999) } })).page_cut, undefined)
  // The server keeps the last 12 messages of a usual chat.
  const long = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }))
  assert.equal((await one({ messages: long })).history_cut, true)
  // "Whole chat" (Pro's memory, build 91): another page at the 8,000-character limit.
  const otherPages = [{ title: "O", url: "https://o.example", text: "b".repeat(8_000) }, { title: "P", url: "https://p.example", text: "short" }]
  const whole = await one({ entitlement: signJws(transaction()), context: "chat", messages: [{ role: "user", content: "q" }], pages: otherPages })
  assert.equal(whole.other_pages_cut, 1)
  assert.equal(whole.whole_chat, true)
  // Without Pro, a whole-chat request (a 2.5 panel, the app) is answered with the last 12 messages and no other pages.
  const trimmed = await one({ context: "chat", messages: long, pages: otherPages })
  assert.equal(trimmed.memory_trimmed, true)
  assert.equal(trimmed.history, 11) // the last 5 answers, their questions and the one asked now (build 92)
  assert.equal(trimmed.history_cut, true)
  assert.equal(trimmed.whole_chat, undefined)
  assert.equal(trimmed.other_pages_cut, undefined)
  // The chat's size from 2.4; anything that isn't a whole number is dropped.
  const sized = await one({ stats: { turns: 45, pages: 3, chats: 50 } })
  assert.deepEqual([sized.chat_turns, sized.chat_pages, sized.chats], [45, 3, 50])
  const junk = await one({ stats: { turns: -1, pages: "3", chats: 1.5 } })
  assert.ok(!["chat_turns", "chat_pages", "chats"].some((k) => k in junk))
  // The answer stopped at its length limit.
  openai.finish = "length"
  assert.equal((await one({})).answer_cut, true)
  openai.finish = undefined
})

test("Ask your chats marks a digest that didn't fit", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, date: "2026-10-30T10:00:00Z", text: "Q: something\nA: an answer" }))
  const c = ctx()
  await (await chat(askHistory({ entitlement: signJws(transaction()), history: many }), c)).text()
  await Promise.all(c.pending)
  assert.equal(events.find((e) => e.kind === "chat")!.data.digest_cut, true)
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
  assert.deepEqual([body.insights.days, body.insights.per_user[0].requests], [180, 4])
  assert.deepEqual([body.limits_report.days, body.limits_report.rows[0].key], [180, "memory_window"])
  assert.equal(body.onboarding.people[0].answer, 540)
  assert.deepEqual([body.onboarding.people[0].limit, body.onboarding.people[0].paid], [900, 1200])
  assert.deepEqual(body.new_outcomes[0], { day: "2026-11-02", new: 12, limit_d0: 3, pro_bought: 2 })
  assert.deepEqual([body.features.features[0].f, body.features.base.paywall, body.features.base.panel.on], ["ask", { since: "2.5", on: "app" }, "ext"])
  assert.equal(body.feature_funnels[0].funnel, "purchase")
  assert.deepEqual([body.after_limit.people[0].before, body.after_limit.paying], [5, []])
  assert.equal(body.after_limit.people[0].locale, "uk-UA")
  assert.deepEqual(body.releases, [{ platform: "IOS", version: "2.4", approved_at: "2026-11-04T14:59:19Z" }])
  assert.deepEqual([body.organize_report.days, body.organize_report.suggestions[0].accepted], [180, 3])
  // Read aloud and find similar (2.6) with the weekly allowances as configured.
  assert.deepEqual([body.ultra_report.days, body.ultra_report.voice.total.texts, body.ultra_report.similar.total.searches], [180, 3, 4])
  assert.deepEqual(body.ultra_report.allowance, { speak_minutes: serverConfig.ultra.speakWeeklySeconds / 60, similar_searches: serverConfig.ultra.similarWeekly })
  // MRR by day with the period; retention over at least 90 days.
  assert.deepEqual([body.mrr_history.days, body.mrr_history.points[0].plan], [180, "byok"])
  assert.equal(body.retention.days, 180)
  const week = await (await adminUsage(get("admin-test", "7"))).json()
  assert.deepEqual([week.mrr_history.days, week.retention.days], [7, 90])
})

test("admin usage report still answers before cf_owner_insights, cf_limits_report, cf_onboarding, cf_new_user_outcomes, the feature reports, cf_after_limit, cf_releases, cf_organize_report, cf_ultra_report, cf_mrr_history and cf_retention exist", async () => {
  serverConfig.adminToken = "admin-test"
  const saved = { ...rpc }
  for (const fn of ["cf_owner_insights", "cf_limits_report", "cf_onboarding", "cf_new_user_outcomes", "cf_features", "cf_feature_funnels", "cf_after_limit", "cf_releases", "cf_organize_report", "cf_ultra_report", "cf_mrr_history", "cf_retention"]) delete rpc[fn]
  try {
    const res = await adminUsage(new Request("https://aisidebar.netlify.app/api/v2/admin/usage", { headers: { Authorization: "Bearer admin-test" } }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(
      [body.segments[0].requests, body.insights, body.limits_report, body.onboarding, body.new_outcomes, body.features, body.feature_funnels, body.after_limit, body.releases, body.organize_report, body.ultra_report, body.mrr_history, body.retention],
      [3, null, null, null, null, null, null, null, null, null, null, null, null]
    )
  } finally {
    Object.assign(rpc, saved)
  }
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

test("a new iOS install is sent to X only with the IDFA of someone who allowed tracking", async () => {
  const APP = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  const IDFA = "38400000-8CF0-11BD-B23E-10B96E40000D"
  const sendX = async (body: Record<string, unknown>) => {
    const c = ctx()
    const res = await event(post("/api/v2/event", { kind: "app_open", appId: APP, client: { platform: "ios", version: "2.7" }, ...body }), c)
    await Promise.all(c.pending)
    return res
  }
  xCalls = []
  serverConfig.xAppConversionToken = "x-token"
  const before = Date.now()
  assert.equal((await sendX({ newInstall: true, att: "authorized", idfa: IDFA })).status, 200)
  assert.equal(xCalls.length, 1)
  assert.equal(xCalls[0].token, "x-token")
  const [sent] = xCalls[0].conversions
  assert.ok((sent.conversion_timestamp as number) >= before && (sent.conversion_timestamp as number) <= Date.now())
  assert.deepEqual({ ...sent, conversion_timestamp: 0 }, {
    app_id: "6759115793", os_type: "IOS", event_name: "INSTALL", conversion_timestamp: 0,
    identifiers: [{ device_id: IDFA }], limit_ad_tracking: false
  })
  // The IDFA goes to X only, never into our events.
  assert.ok(!JSON.stringify(events).includes(IDFA))

  // Nothing to match with, not an install, not iOS, a test build, or no token: nothing is sent.
  assert.equal((await sendX({ newInstall: true, att: "denied", idfa: IDFA })).status, 200)
  await sendX({ newInstall: true, att: "authorized", idfa: "00000000-0000-0000-0000-000000000000" })
  await sendX({ newInstall: true, att: "authorized" })
  await sendX({ att: "authorized", idfa: IDFA })
  await sendX({ newInstall: true, att: "authorized", idfa: IDFA, client: { platform: "macos", version: "2.7" } })
  await sendX({ newInstall: true, att: "authorized", idfa: IDFA, audience: "test" })
  serverConfig.xAppConversionToken = ""
  assert.equal((await sendX({ newInstall: true, att: "authorized", idfa: IDFA })).status, 200)
  assert.equal(xCalls.length, 1)
})

test("X conversions go out 500 per request; emails and phones are normalized before hashing", async () => {
  const x = await import("../netlify/shared/xconversions.mts")
  xCalls = []
  const one = x.iosInstall(new Date(1792576800000), "38400000-8cf0-11bd-b23e-10b96e40000d", "authorized")!
  const result = await x.sendXConversions(Array.from({ length: 1001 }, () => one), "x-token")
  assert.deepEqual(xCalls.map((c) => c.conversions.length), [500, 500, 1])
  assert.deepEqual(result, { processed: 1001, failed: 0 })
  assert.deepEqual(await x.sendXConversions([one], ""), { processed: 0, failed: 0, skipped: "no_token" })

  assert.equal(x.hashEmail("  John.Doe@Example.COM "), x.sha256Hex("john.doe@example.com"))
  assert.equal(x.hashEmail("not an email"), null)
  assert.equal(x.toE164("+1 (555) 123-4567"), "+15551234567")
  assert.equal(x.toE164("0049 30 1234567"), "+49301234567")
  assert.equal(x.toE164("555-1234"), null)
  assert.equal(x.hashPhone("+1 555 123 4567"), x.sha256Hex("+15551234567"))
  assert.equal(x.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
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
  // Free (build 91): the chat's memory is Pro's, so its other pages stay out.
  assert.doesNotMatch(system, /Other saved text/)
  assert.equal(counters.get(`install:${INSTALL}`), 1, "one free answer")
  const pro = signJws(transaction())
  await events$(await chat(ask({ entitlement: pro, context: "chat", from: "app", messages, pages: [{ title: "Other", url: "https://other.example", text: "Other saved text" }] }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /Other saved text/)
  // An older chat without saved page texts.
  await events$(await chat(ask({ context: "chat", from: "app", messages, page: null }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /wasn't saved with it/)
  assert.doesNotMatch(system, /browser blocks access/)
  // The app sends up to 9 other pages; the panel's "whole chat" still gets 3 (Pro).
  const pages = Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i + 1}`, url: `https://p${i + 1}.example`, text: `Saved fact ${i + 1}` }))
  await events$(await chat(ask({ entitlement: pro, context: "chat", from: "app", messages, pages }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /Saved fact 9\b/)
  assert.doesNotMatch(system, /Saved fact 10/)
  await events$(await chat(ask({ entitlement: pro, context: "chat", messages, pages }), ctx()))
  system = (openai.lastBody?.messages as Array<{ role: string; content: string }>)[0].content
  assert.match(system, /Saved fact 3\b/)
  assert.doesNotMatch(system, /Saved fact 4/)
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
  assert.match(systemText(body), /Some article text/)
  // The rules and the page in the first block, cached; the time after it (2.5).
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" })
  assert.match(body.system[0].text, /Some article text/)
  assert.doesNotMatch(body.system[0].text, /Current time/)
  assert.match(body.system.at(-1).text, /Current time/)
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
  assert.match(systemText(claude.lastBody), /earlier ContextFlow chats/)
  assert.deepEqual(claude.lastBody?.output_config, { effort: "medium" })
  assert.equal(chatEvent().mode, "history")

  events = []
  claude.answer = '{"results": [{"id": "c1", "why": "The four-day week article"}]}'
  const c = ctx()
  const res = await find(findChats({ client: NEW_CLIENT, entitlement: jws }), c)
  await Promise.all(c.pending)
  assert.deepEqual((await res.json()).results, [{ id: "c1", why: "The four-day week article" }])
  assert.deepEqual(claude.lastBody?.output_config, { effort: "low" })
  assert.match(systemText(claude.lastBody), /id=c2/)
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
  const free = systemText(claude.lastBody)
  assert.match(free, /A lecture about neural networks/)
  assert.doesNotMatch(free, /PINEAPPLE/)
  assert.doesNotMatch(free, /Revenue grew 14%/)
  assert.match(free, /a video and PDF documents that you were not given/)
  assert.deepEqual([chatEvent().skipped, chatEvent().media], ["video,pdf", undefined])

  // Pro: both go in, with the media limit and the timestamp rule.
  events = []
  await chatOnce(askNew({ page, entitlement: signJws(transaction()) }))
  const pro = systemText(claude.lastBody)
  assert.match(pro, /PINEAPPLE/)
  assert.match(pro, /Revenue grew 14%/)
  assert.match(pro, /\[m:ss\] timestamps/)
  assert.doesNotMatch(pro, /you were not given/)
  assert.deepEqual([chatEvent().media, chatEvent().skipped], ["video", undefined])

  // A PDF alone, free: left out and named as PDFs.
  events = []
  await chatOnce(askNew({ page: { ...page, attachments: [page.attachments[1]] } }))
  assert.doesNotMatch(systemText(claude.lastBody), /Revenue grew 14%/)
  assert.match(systemText(claude.lastBody), /PDF documents that you were not given/)
  assert.equal(chatEvent().skipped, "pdf")

  // A text that already carries a transcript (an earlier 2.4 test build) is cut to a page's limit for free.
  const composed = "x".repeat(30_000) + transcript
  await chatOnce(askNew({ page: { kind: "page", title: "V", url: "https://example.com/v", text: composed, media: "video" } }))
  assert.doesNotMatch(systemText(claude.lastBody), /PINEAPPLE/)
  assert.match(systemText(claude.lastBody), /a video that you were not given/)

  // The panel skipped them itself (free): nothing to drop, the answer is still told.
  await chatOnce(askNew({ page: { kind: "page", title: "T", url: "https://example.com", text: "Page text", skipped: ["video"] } }))
  assert.match(systemText(claude.lastBody), /a video that you were not given/)
  // A PDF tab with nothing but the PDF: the request still goes, with the title and the rule.
  const { res } = await chatOnce(askNew({ page: { kind: "page", title: "Report.pdf", url: "https://example.com/r.pdf", text: "", skipped: ["pdf"] } }))
  assert.equal(res.status, 200)
  assert.match(systemText(claude.lastBody), /Title: Report\.pdf[\s\S]*PDF documents that you were not given/)
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

test("the auto-renew question's answer is logged with the plan, days left and where it was asked", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  events = []
  const APP = "5b0b3c1e-2a7e-4a8f-9c55-0d6a3b2f1e77"
  assert.equal((await send({ kind: "renewal_off", appId: APP, reason: "price", product: "com.contextflow.pro.monthly", days_left: 12, from: "app", note: "secret" })).status, 200)
  assert.equal((await send({ kind: "renewal_off", installId: INSTALL, reason: "later", product: "com.contextflow.pro.yearly", days_left: -3, from: "safari" })).status, 200)
  assert.equal((await send({ kind: "renewal_off", installId: INSTALL, reason: "discount please" })).status, 400)
  assert.equal((await send({ kind: "renewal_off", installId: INSTALL })).status, 400)
  await new Promise((r) => setTimeout(r, 0))
  const logged = events.filter((e) => e.kind === "renewal_off").map((e) => e.data)
  assert.equal(logged.length, 2)
  assert.deepEqual([logged[0].reason, logged[0].product, logged[0].days_left, logged[0].from, logged[0].app], ["price", "com.contextflow.pro.monthly", 12, "app", APP])
  assert.ok(!JSON.stringify(logged[0]).includes("secret"))
  assert.deepEqual([logged[1].reason, logged[1].days_left, logged[1].from], ["later", undefined, undefined])
})

test("Own key → Pro at a discount: status says so only when it's set up, and only to Own key subscribers", async () => {
  const { generateKeyPairSync } = await import("node:crypto")
  const cfg = serverConfig as unknown as Record<string, unknown>
  const statusOf = async (entitlement?: string) => (await (await status(post("/api/v2/status", { installId: INSTALL, client: { version: "2.4", platform: "ios" }, entitlement }), ctx())).json())
  const byok = signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "2000000777" }))
  cfg.promoOfferId = ""
  assert.equal((await statusOf(byok)).upgradeOffer, null, "not set up")
  cfg.promoOfferId = "byok_upgrade"
  cfg.promoKeyId = "KEY123"
  cfg.promoPrivateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  cfg.promoDiscount = 50
  try {
    assert.deepEqual((await statusOf(byok)).upgradeOffer, { discount: 50 })
    assert.equal((await statusOf(signJws(transaction()))).upgradeOffer, null, "Pro")
    assert.equal((await statusOf()).upgradeOffer, null, "free")
  } finally {
    cfg.promoOfferId = ""
  }
})

test("Own key → Pro at a discount: the server signs Apple's promotional offer for an Own key subscription only", async () => {
  const { generateKeyPairSync, verify } = await import("node:crypto")
  const promo = (await import("../netlify/functions/v2-promo.mts")).default as unknown as typeof event
  const cfg = serverConfig as unknown as Record<string, unknown>
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const ask = (body: Record<string, unknown>) => promo(post("/api/v2/promo", { installId: INSTALL, bundleId: "com.contextflow.app", client: { platform: "ios", version: "2.4" }, ...body }), ctx())
  const byok = signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "2000000777" }))
  const token = "8f14e45f-ceea-467a-9575-cee5f2b7c2a1"

  cfg.promoOfferId = ""
  assert.equal((await ask({ entitlement: byok })).status, 404, "not set up")
  cfg.promoOfferId = "byok_upgrade"
  cfg.promoKeyId = "KEY123"
  cfg.promoPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  cfg.promoProductId = "com.contextflow.pro.monthly"
  try {
    assert.equal((await ask({ entitlement: signJws(transaction()) })).status, 403, "already Pro")
    assert.equal((await ask({})).status, 403, "free")
    assert.equal((await ask({ entitlement: byok, bundleId: "com.other.app" })).status, 400)
    assert.equal((await ask({ entitlement: byok, appAccountToken: "not-a-uuid" })).status, 400)
    events = []
    const res = await ask({ entitlement: byok, appAccountToken: token.toUpperCase() })
    assert.equal(res.status, 200)
    const s = await res.json()
    assert.deepEqual([s.offerId, s.keyId], ["byok_upgrade", "KEY123"])
    assert.match(s.nonce, /^[0-9a-f-]{36}$/)
    const payload = ["com.contextflow.app", "KEY123", "com.contextflow.pro.monthly", "byok_upgrade", token, s.nonce, String(s.timestamp)].join("⁣")
    assert.ok(verify("sha256", Buffer.from(payload, "utf8"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(s.signature, "base64")), "Apple's payload, signed")
    await new Promise((r) => setTimeout(r, 0))
    assert.ok(events.some((e) => e.kind === "byok_upsell" && e.data.action === "signed"))
    // Without an app account token the signature covers an empty one.
    const plain = await (await ask({ entitlement: byok })).json()
    const plainPayload = ["com.contextflow.app", "KEY123", "com.contextflow.pro.monthly", "byok_upgrade", "", plain.nonce, String(plain.timestamp)].join("⁣")
    assert.ok(verify("sha256", Buffer.from(plainPayload, "utf8"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(plain.signature, "base64")))
  } finally {
    cfg.promoOfferId = ""
  }
})

test("Own key upsell events keep only what was shown or tapped, where and from where", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  events = []
  assert.equal((await send({ kind: "byok_upsell", installId: INSTALL, action: "tap", where: "search", from: "panel", discount: true, page: "secret" })).status, 200)
  assert.equal((await send({ kind: "byok_upsell", installId: INSTALL, action: "boom", where: "nowhere" })).status, 200)
  await new Promise((r) => setTimeout(r, 0))
  const logged = events.filter((e) => e.kind === "byok_upsell").map((e) => e.data)
  assert.deepEqual([logged[0].action, logged[0].where, logged[0].from, logged[0].discount], ["tap", "search", "panel", true])
  assert.ok(!JSON.stringify(logged[0]).includes("secret"))
  assert.deepEqual([logged[1].action, logged[1].where], [undefined, undefined])
})


// ---------------------------------------------------------------- long pages count as several answers (2.5)
const longPage = (chars: number) => ({ kind: "page", title: "Long", url: "https://example.com/long", text: "a".repeat(chars) })

test("a long page counts as several answers: 200 000 characters as one, 200 001 as two, and the counter shows it", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  const first = await chatOnce(askNew({ page: longPage(200_000) }))
  assert.equal(counters.get(`install:${INSTALL}`), 1)
  assert.deepEqual([chatEvent().weight, chatEvent().page_bucket], [1, "200k"])
  events = []
  const second = await chatOnce(askNew({ page: longPage(200_001) }))
  assert.equal(counters.get(`install:${INSTALL}`), 3)
  assert.deepEqual([chatEvent().weight, chatEvent().page_bucket], [2, "400k"])
  // The allowance the panel shows comes from the counters: one, then three used.
  assert.deepEqual([first.ev[0].usage.used, second.ev[0].usage.used], [1, 3])
  // A follow-up on the same page counts the same (FOLLOW_UP_WEIGHT "page", the owner's rule now).
  counters.clear()
  events = []
  await chatOnce(askNew({ page: longPage(400_001), messages: [{ role: "user", content: "Summarize" }, { role: "assistant", content: "It's long." }, { role: "user", content: "And the end?" }] }))
  assert.equal(counters.get(`install:${INSTALL}`), 3)
  assert.equal(chatEvent().weight, 3)
})

test("a long page with fewer answers left than it counts as: not sent, nothing charged, the weight told", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  counters.set(`install:${INSTALL}`, 4)
  const { res } = await chatOnce(askNew({ page: longPage(600_001) }))
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.deepEqual([body.code, body.weight, body.usage.used, body.usage.limit], ["LIMIT_REACHED", 4, 4, 5])
  assert.equal(counters.get(`install:${INSTALL}`), 4)
  assert.equal(claude.calls, 0, "Claude not asked")
  assert.equal(events.find((e) => e.kind === "limit")?.data.weight, 4)
  // One answer left still covers a short page.
  const short = await chatOnce(askNew())
  assert.equal(short.res.status, 200)
  assert.equal(counters.get(`install:${INSTALL}`), 5)
})

test("a long page's weight is given back in full when the answer fails", async () => {
  openai.failModels = ["gpt-5.2-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-5.2", "gpt-5"]
  const { res } = await chatOnce(askNew({ page: longPage(400_001) }))
  assert.notEqual(res.status, 200)
  assert.equal(counters.get(`install:${INSTALL}`) ?? 0, 0)
})

test("a whole page goes through: a request of a few MB is taken, the model gets all of it", async () => {
  serverConfig.anthropicKey = CLAUDE_KEY
  serverConfig.freeDailyLimit = 50
  try {
    const { res } = await chatOnce(askNew({ page: longPage(2_500_000) }))
    assert.equal(res.status, 200)
    assert.ok(systemText(claude.lastBody).includes("a".repeat(2_500_000)))
    assert.equal(counters.get(`install:${INSTALL}`), 13)
  } finally {
    serverConfig.freeDailyLimit = 5
  }
})

test("a 2.4 panel's page (cut at 24 000 characters) counts as one", async () => {
  await chatOnce(ask({ page: longPage(24_000) }))
  assert.equal(counters.get(`install:${INSTALL}`), 1)
  assert.deepEqual([chatEvent().weight, chatEvent().page_bucket], [1, "24k"])
})

test("an answer with the user's own key is only reported: the answer limit isn't touched, whatever the page", async () => {
  const c = ctx()
  const res = await usage(post("/api/v2/usage", { installId: INSTALL, client: NEW_CLIENT, usage: { provider: "anthropic", model: "claude-sonnet-5-5", ok: true, promptTokens: 400_000, completionTokens: 300, ms: 9000, tier: "smart" } }), c)
  await Promise.all(c.pending)
  assert.equal(res.status, 204)
  assert.equal(counters.get(`install:${INSTALL}`), undefined)
  assert.equal(events.find((e) => e.kind === "chat")?.data.weight, undefined)
})

test("a page reminder from \"Come back later\" is counted as how: later; the menu, the window and watching aren't ux_* kinds", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", body), ctx())
  events = []
  await send({ kind: "ux_remind", installId: INSTALL, action: "set", what: "page", how: "later", preset: "evening", text: "secret" })
  await new Promise((r) => setTimeout(r, 0))
  const remind = events.find((e) => e.kind === "ux_remind")!.data
  assert.deepEqual([remind.how, remind.preset], ["later", "evening"])
  assert.ok(!JSON.stringify(events).includes("secret"))
  // The analytics registry's "use" kind counts them (PR #32).
  for (const kind of ["ux_menu", "ux_later", "ux_watch"]) assert.equal((await send({ kind, installId: INSTALL, action: "opened" })).status, 400)
})

test("Own key upsell from Settings keeps where it was tapped", async () => {
  events = []
  assert.equal((await event(post("/api/v2/event", { kind: "byok_upsell", installId: INSTALL, action: "tap", where: "settings", from: "panel" }), ctx())).status, 200)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(events.find((e) => e.kind === "byok_upsell")?.data.where, "settings")
})

const SID = "5b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"
const PSID = "6c1b2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e"
const APP_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

test("feature steps: only registry features, actions and values are kept, with the session they belong to", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", { installId: INSTALL, client: { platform: "ios", version: "2.5.0", locale: "en-US", build: "71" }, ...body }), ctx())
  events = []
  assert.equal((await send({ kind: "use", f: "chat", a: "open", via: "search", sid: SID, n: 5, prev: "search.run", dt: 7.4, s: "panel", page: "https://secret.example", title: "secret" })).status, 200)
  assert.equal((await send({ kind: "use", f: "settings", a: "change", key: "theme", val: "on", sid: SID, n: 6, prev: "chat.open", dt: 99999 })).status, 200)
  assert.equal((await send({ kind: "use", f: "settings", a: "change", key: "my notes", val: "hello" })).status, 200)
  assert.equal((await send({ kind: "use", f: "tour", a: "step", step: 3, n: 0, prev: "nonsense.step", sid: "not-a-uuid", s: "desktop" })).status, 200)
  // The app sends its fields as strings.
  assert.equal((await send({ kind: "use", f: "later", a: "list", via: "link", reminders: "3", watches: "12345", s: "panel" })).status, 200)
  // Not in the registry, an action the feature doesn't have, or a feature with its own kind: refused.
  assert.equal((await send({ kind: "use", f: "spyware", a: "open" })).status, 400)
  assert.equal((await send({ kind: "use", f: "chat", a: "delete_everything" })).status, 400)
  assert.equal((await send({ kind: "use", f: "insert", a: "copied" })).status, 400)
  await new Promise((r) => setTimeout(r, 0))
  const logged = events.filter((e) => e.kind === "use").map((e) => e.data)
  assert.equal(logged.length, 5)
  assert.deepEqual([logged[4].a, logged[4].reminders, logged[4].watches, logged[4].via], ["list", 3, undefined, "link"])
  assert.deepEqual(logged[0], { platform: "ios", version: "2.5.0", locale: "en-US", build: 71, f: "chat", a: "open", via: "search", sid: SID, n: 5, prev: "search.run", dt: 7, s: "panel" })
  assert.deepEqual([logged[1].key, logged[1].val, logged[1].dt], ["theme", "on", 3600])
  assert.deepEqual([logged[2].key, logged[2].val], [undefined, undefined])
  assert.deepEqual([logged[3].step, logged[3].n, logged[3].prev, logged[3].sid, logged[3].s], [3, undefined, undefined, undefined, undefined])
  assert.ok(!JSON.stringify(events).includes("secret"))
})

test("feature steps in a batch: each kept or left out on its own, one request counted, the app's session linked", async () => {
  events = []
  const body = {
    appId: APP_ID, installId: INSTALL, audience: "test",
    client: { platform: "ios", version: "2.5", locale: "en" },
    batch: [
      { kind: "use", f: "paywall", a: "shown", via: "deeplink", sid: SID, n: 1, psid: PSID, s: "app" },
      { kind: "use", f: "paywall", a: "plan", plan: "yearly", sid: SID, n: 2, prev: "paywall.shown", dt: 3 },
      { kind: "use", f: "nope", a: "x" },
      { kind: "chat", ok: true },
      "garbage",
      { kind: "renewal_off", reason: "price", product: "com.contextflow.pro.monthly", from: "app", sid: SID, n: 3 }
    ]
  }
  const res = await event(post("/api/v2/event", body), ctx())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, kept: 3, left_out: 3 })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(events.map((e) => [e.kind, e.data.f ?? e.data.reason, e.data.n]), [["use", "paywall", 1], ["use", "paywall", 2], ["renewal_off", "price", 3]])
  assert.ok(events.every((e) => e.install === INSTALL && e.data.app === APP_ID && e.data.audience === "test"))
  assert.equal(events[0].data.psid, PSID)
  // A batch with a funnel kind counts against the small allowance, once.
  assert.equal(counters.get(`event:${APP_ID}`), 1)
  // Nothing allowed in it: refused.
  assert.equal((await event(post("/api/v2/event", { installId: INSTALL, batch: [{ kind: "x" }] }), ctx())).status, 400)
  assert.equal((await event(post("/api/v2/event", { installId: INSTALL, batch: [] }), ctx())).status, 400)
  // At most 25 steps are read.
  events = []
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: "use", f: "panel", a: "open", n: i + 1 }))
  assert.deepEqual(await (await event(post("/api/v2/event", { installId: INSTALL, batch: many }), ctx())).json(), { ok: true, kept: 25, left_out: 0 })
})

test("feature steps have their own daily allowance, apart from the funnel events", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", { installId: INSTALL, ...body }), ctx())
  serverConfig.eventDailyLimit = 1
  serverConfig.useEventDailyLimit = 2
  assert.equal((await send({ kind: "ext_on" })).status, 200)
  assert.equal((await send({ kind: "ext_on" })).status, 429)
  assert.equal((await send({ kind: "use", f: "panel", a: "open" })).status, 200)
  assert.equal((await send({ batch: [{ kind: "use", f: "panel", a: "close" }, { kind: "use", f: "chats", a: "open" }] })).status, 200)
  assert.equal((await send({ kind: "use", f: "panel", a: "open" })).status, 429)
  assert.equal(counters.get(`event:use:${INSTALL}`), 2)
})

test("answers, refusals and AI searches carry the session step they were; app questions say so", async () => {
  const c = ctx()
  await events$(await chat(ask({ ui: { sid: SID, n: 3, prev: "bubble.question", dt: 2, s: "page", via: "bubble", junk: "secret" } }), c))
  await Promise.all(c.pending)
  const answered = events.find((e) => e.kind === "chat")?.data
  assert.deepEqual([answered?.sid, answered?.n, answered?.prev, answered?.dt, answered?.s, answered?.via], [SID, 3, "bubble.question", 2, "page", "bubble"])
  assert.ok(!JSON.stringify(answered).includes("secret"))

  events = []
  const fromApp = ctx()
  await events$(await chat(ask({ context: "chat", from: "app", messages: [{ role: "user", content: "And?" }] }), fromApp))
  await Promise.all(fromApp.pending)
  assert.equal(events.find((e) => e.kind === "chat")?.data.s, "app")

  events = []
  const refused = ctx()
  await chat(askHistory({ ui: { sid: SID, n: 9, via: "chip" }, client: { platform: "ios", version: "2.5.0", audience: "test" } }), refused)
  await Promise.all(refused.pending)
  const pro = events.find((e) => e.kind === "pro_only")?.data
  assert.deepEqual([pro?.sid, pro?.n, pro?.via, pro?.audience], [SID, 9, undefined, "test"], "Ask your chats has no ways in of its own")

  events = []
  const search = ctx()
  await find(post("/api/v2/find", { installId: INSTALL, query: "q", chats: [{ id: "c1", title: "T", text: "x" }], ui: { sid: SID, n: 4, prev: "ai_search.on" } }), search)
  await Promise.all(search.pending)
  assert.deepEqual([events[0]?.kind, events[0]?.data.sid, events[0]?.data.prev], ["pro_only", SID, "ai_search.on"])
})

test("rows written by a deploy preview or our own scripts are marked as tests", async () => {
  const send = (body: Record<string, unknown>) => event(post("/api/v2/event", { installId: INSTALL, ...body }), ctx())
  events = []
  process.env.CONTEXT = "deploy-preview"
  try {
    await send({ kind: "ext_on", client: { version: "2.5.0" } })
  } finally {
    delete process.env.CONTEXT
  }
  await send({ kind: "ext_on", client: { version: "calibrate" } })
  await send({ kind: "ext_on", client: { version: "2.5.0" } })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(events.map((e) => [e.data.audience, e.data.deploy]), [["test", "deploy-preview"], ["test", undefined], [undefined, undefined]])
})
