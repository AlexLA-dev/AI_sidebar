// Ultra (2.6): the plan, its products, "Ultra counts as Pro", the read-aloud endpoint and its counters.
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"
process.env.GEMINI_API_KEY = "gemini-test"
const { generateKeyPairSync, sign } = await import("node:crypto")
const evalKeys = generateKeyPairSync("ed25519")
process.env.CF_EVAL_PUBLIC_KEY = evalKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64")
const evalHeader = (install: string, at = Date.now()) => `${at}.${sign(null, Buffer.from(`${install}.${at}`), evalKeys.privateKey).toString("base64url")}`
process.env.ULTRA_SPEAK_WEEKLY_SECONDS = "120"

type Item = { subject: string; period: string; limit: number | null; amount?: number }
let counters = new Map<string, number>()
let entitlements = new Map<string, Record<string, unknown>>()
let events: { kind: string; data: Record<string, unknown> }[] = []
let tts: { calls: Array<{ model: string; text: string; voice: string; mime: string }>; refuseLanguage?: string[]; pcmBytes: number; chunks: number; failAfter?: number } = { calls: [], pcmBytes: 48_000 * 3, chunks: 3 }
const MODELS = ["gemini-3.8-flash", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-3.6-flash-lite-tts"]

const rpc: Record<string, (args: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
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
  cf_log: ({ p_kind, p_data }) => {
    events.push({ kind: p_kind, data: p_data })
    return null
  },
  cf_limited_before: () => false,
  // As the 2.6 cf_entitlement_upsert: the product follows the transaction that runs longer.
  cf_entitlement_upsert: ({ p }) => {
    const prev = entitlements.get(p.original_transaction_id)
    const newer = !prev || !prev.expires_at || (p.expires_at && Date.parse(p.expires_at) >= Date.parse(String(prev.expires_at)))
    const row = prev
      ? { ...prev, ...p, product_id: newer ? p.product_id : prev.product_id, expires_at: newer ? p.expires_at : prev.expires_at, revoked_at: p.revoked_at ?? prev.revoked_at ?? null }
      : { ...p, revoked_at: p.revoked_at ?? null }
    entitlements.set(p.original_transaction_id, row)
    return row
  }
}

function ttsStream(model: string): Response {
  const per = Math.floor(tts.pcmBytes / tts.chunks)
  const frames: string[] = [`event: interaction.created\ndata: ${JSON.stringify({ interaction: { id: "v1_x", status: "in_progress", model }, event_type: "interaction.created" })}\n\n`]
  for (let i = 0; i < tts.chunks; i++) {
    if (tts.failAfter !== undefined && i >= tts.failAfter) {
      frames.push(`event: error\ndata: ${JSON.stringify({ error: { message: "overloaded", code: 503 }, event_type: "error" })}\n\n`)
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } })
    }
    // An odd length on purpose: samples cut between chunks must come out whole.
    const bytes = Buffer.alloc(i === 0 ? per + 1 : i === tts.chunks - 1 ? per - 1 : per, i + 1)
    frames.push(`event: step.delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "audio", data: bytes.toString("base64") }, event_type: "step.delta" })}\n\n`)
  }
  const audioTokens = Math.round((tts.pcmBytes / 48_000) * 25)
  frames.push(`event: interaction.completed\ndata: ${JSON.stringify({ interaction: { status: "completed", usage: { total_input_tokens: 40, total_output_tokens: audioTokens } }, event_type: "interaction.completed" })}\n\n`)
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (!rpc[fn]) return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) {
    return new Response(JSON.stringify({ models: MODELS.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: m.endsWith("tts") ? ["generateContent"] : ["generateContent", "countTokens"] })) }), { headers: { "Content-Type": "application/json" } })
  }
  if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
    const text = body.input[0].content[0].text
    tts.calls.push({ model: body.model, text, voice: body.generation_config.speech_config[0].voice, mime: body.response_format.mime_type })
    if (tts.refuseLanguage?.includes(body.model)) {
      return new Response(JSON.stringify({ error: { code: 400, message: "Language not supported by this model", status: "INVALID_ARGUMENT" } }), { status: 400 })
    }
    return ttsStream(body.model)
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

const apple = await import("../netlify/shared/apple.mts")
apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
const { PRODUCTS } = await import("../netlify/shared/config.mts")
const { resolveAccess, countersFor, searchCountersFor, visibleUsage } = await import("../netlify/shared/plan.mts")
const { hasPro, isUltra, planOfProduct, productOf, PLAN_RANK, watchLimit } = await import("../src/shared/plan.ts")
const { speechText, speechParts, speechSeconds, speechKind } = await import("../src/shared/speech.ts")
const { newestGeminiTts } = await import("../src/shared/models.ts")
const { tourAsked } = await import("../netlify/shared/tour.mts")
const speak = (await import("../netlify/functions/v2-speak.mts")).default
const status = (await import("../netlify/functions/v2-status.mts")).default

const INSTALL = "7b3c9a0e-1d2f-4a5b-8c6d-9e0f1a2b3c4d"
const ultraJws = (o: Record<string, unknown> = {}) => signJws(transaction({ productId: "com.contextflow.ultra.monthly", originalTransactionId: "3000000001", ...o }))
const ctx = () => {
  const waits: Promise<unknown>[] = []
  return { ip: "203.0.113.9", waitUntil: (p: Promise<unknown>) => void waits.push(p), waits } as any
}
const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

beforeEach(() => {
  counters = new Map()
  entitlements = new Map()
  events = []
  tts = { calls: [], pcmBytes: 48_000 * 3, chunks: 3 }
  delete (globalThis as { Netlify?: unknown }).Netlify
})

// ---- the plan --------------------------------------------------------------

test("every product maps to its plan, and Ultra counts as Pro", () => {
  assert.deepEqual(PRODUCTS, {
    "com.contextflow.ultra.monthly": "ultra", "com.contextflow.ultra.yearly": "ultra",
    "com.contextflow.pro.monthly": "pro", "com.contextflow.pro.yearly": "pro",
    "com.contextflow.byok.monthly": "byok", "com.contextflow.byok.yearly": "byok"
  })
  assert.equal(planOfProduct("com.contextflow.ultra.yearly"), "ultra")
  assert.equal(planOfProduct("com.contextflow.byok.yearly"), "byok")
  assert.equal(planOfProduct("com.other.app"), "free")
  assert.equal(productOf("pro", "yearly"), "com.contextflow.pro.yearly")
  assert.deepEqual(["free", "byok", "pro", "ultra"].map((p) => hasPro(p as never)), [false, false, true, true])
  assert.deepEqual(["free", "byok", "pro", "ultra"].map((p) => isUltra(p as never)), [false, false, false, true])
  assert.ok(PLAN_RANK.ultra > PLAN_RANK.pro && PLAN_RANK.pro > PLAN_RANK.byok)
  assert.deepEqual([watchLimit("free"), watchLimit("byok"), watchLimit("pro"), watchLimit("ultra")], [5, 20, 20, 50])
  // The guided first request's free answers are for plans without Pro's weekly allowance.
  assert.equal(tourAsked({ tour: true }, "ultra", false, false), false)
})

test("an Ultra transaction resolves to Ultra with Pro's answer counter", async () => {
  const access = await resolveAccess(ultraJws(), INSTALL)
  assert.equal(access.plan, "ultra")
  const items = countersFor(access, INSTALL, "ip:x")
  assert.equal(items[0].subject, "tx:3000000001")
  assert.equal(items[0].limit, 375)
  assert.equal(searchCountersFor(access, INSTALL)[0].subject, "search:tx:3000000001")
  const usage = visibleUsage(access, [{ subject: "tx:3000000001", period: "week", n: 12, limit: 375 }])
  assert.deepEqual([usage.used, usage.limit, usage.period], [12, 375, "week"])
})

test("yearly Pro and yearly Own key resolve to their plans", async () => {
  assert.equal((await resolveAccess(signJws(transaction({ productId: "com.contextflow.pro.yearly" })), INSTALL)).plan, "pro")
  assert.equal((await resolveAccess(signJws(transaction({ productId: "com.contextflow.byok.yearly", originalTransactionId: "3000000009" })), INSTALL)).plan, "byok")
})

test("Ultra → Pro at renewal: an old signed Ultra transaction doesn't keep Ultra going", async () => {
  const now = Date.now()
  // The renewal into Pro reached the server first (notification or another device).
  await resolveAccess(signJws(transaction({ productId: "com.contextflow.pro.monthly", originalTransactionId: "3000000002", transactionId: "3000000202", expiresDate: now + 30 * 86_400_000 })), INSTALL)
  const stale = await resolveAccess(signJws(transaction({ productId: "com.contextflow.ultra.monthly", originalTransactionId: "3000000002", transactionId: "3000000201", expiresDate: now - 3600_000 })), INSTALL)
  assert.equal(stale.plan, "pro")
  assert.equal(stale.entitlement?.productId, "com.contextflow.pro.monthly")
})

test("Pro → Ultra: the upgrade counts at once, the week's answers carry over", async () => {
  const now = Date.now()
  const pro = await resolveAccess(signJws(transaction({ originalTransactionId: "3000000003", expiresDate: now + 10 * 86_400_000 })), INSTALL)
  counters.set("tx:3000000003", 40)
  const ultra = await resolveAccess(signJws(transaction({ productId: "com.contextflow.ultra.monthly", originalTransactionId: "3000000003", transactionId: "3000000303", expiresDate: now + 30 * 86_400_000 })), INSTALL)
  assert.equal(pro.plan, "pro")
  assert.equal(ultra.plan, "ultra")
  assert.equal(countersFor(ultra, INSTALL, "ip:x")[0].subject, "tx:3000000003")
})

// ---- speech text -----------------------------------------------------------

test("speechText reads an answer: no code, links' words only, items as sentences", () => {
  const text = speechText("## Key points\n\n- **Fast** start [1]\n- See [the docs](https://example.com/a(b)) now\n\n```js\nconsole.log(1)\n```\n| A | B |\n|---|---|\n| 1 | 2 |\nVisit https://x.com today.")
  assert.equal(text, "Key points.\n\nFast start.\nSee the docs now.\n\nA, B.\n1, 2.\nVisit today.")
})

test("speechParts: a short first part, the rest up to the part size, nothing lost", () => {
  const sentence = (i: number) => `This is sentence number ${i} of a long article about trains. `
  const text = Array.from({ length: 80 }, (_, i) => sentence(i)).join("").trim()
  const parts = speechParts(text, 240, 1400)
  assert.ok(parts[0].length <= 240, `first ${parts[0].length}`)
  assert.ok(parts.slice(1).every((p) => p.length <= 1400))
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "))
  assert.deepEqual(speechParts("Hello."), ["Hello."])
})

test("speechSeconds: about 14 characters a second, fewer for Chinese and Japanese", () => {
  assert.equal(speechSeconds("a".repeat(140)), 10)
  assert.equal(speechSeconds("中".repeat(50)), 10)
  assert.equal(speechSeconds(""), 1)
})

test("speechKind: languages Flash-Lite lacks go to the full model", () => {
  const full = ["sv", "fi", "th", "lt", "sl", "sw"]
  assert.equal(speechKind("Hello there, this is a perfectly ordinary English sentence.", "en", full), "lite")
  assert.equal(speechKind("สวัสดีครับ นี่คือข้อความภาษาไทย", null, full), "full")
  assert.equal(speechKind("Anything at all.", "sv-SE", full), "full")
  assert.equal(speechKind("Det är en bra dag och jag har mycket att göra med det som är kvar på jobbet.", "en", full), "full")
  assert.equal(speechKind("Das ist ja nicht so, und der Hund ist nicht hier, ja.", "de", full), "lite")
  assert.equal(speechKind("Ovo je dobar dan i ja sam jako sretan što nije kiša, ali je hladno.", "hr", full), "lite")
})

test("newestGeminiTts picks stable models of each kind", () => {
  assert.equal(newestGeminiTts(MODELS, "lite"), "gemini-3.8-flash-lite-tts")
  assert.equal(newestGeminiTts(MODELS, "full"), "gemini-3.8-flash-tts")
  assert.equal(newestGeminiTts(["gemini-3.1-flash-tts-preview"], "full"), null)
})

// ---- /api/v2/speak ---------------------------------------------------------

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

test("speak: Ultra only", async () => {
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Hello.", entitlement: signJws(transaction()) }), c)
  assert.equal(res.status, 403)
  assert.equal((await res.json()).code, "ULTRA_ONLY")
  assert.equal(tts.calls.length, 0)
})

test("speak: streams whole PCM samples, charges the estimate, then the real length", async () => {
  const c = ctx()
  const text = "A".repeat(70) // 5 s estimated
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", what: "answer", entitlement: ultraJws(), client: { platform: "macos", version: "2.6" } }), c)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("Content-Type") ?? "", /audio\/L16; rate=24000/)
  assert.equal(res.headers.get("X-CF-Charged"), "5")
  assert.deepEqual(JSON.parse(res.headers.get("X-CF-Usage") ?? "null").used, 5)
  const pcm = await readAll(res)
  assert.equal(pcm.length, 48_000 * 3)
  await Promise.all(c.waits)
  assert.equal(tts.calls[0].model, "gemini-3.8-flash-lite-tts")
  assert.equal(tts.calls[0].mime, "audio/l16")
  // 3 s of audio came: the counter holds 3, not the 5 estimated.
  assert.equal(counters.get("speak:tx:3000000001"), 3)
  const log = events.find((e) => e.kind === "speak")?.data
  assert.equal(log?.ok, true)
  assert.equal(log?.audio_s, 3)
  assert.equal(log?.output_tokens, 75)
  // 40 text tokens at $0.50 and 75 audio tokens at $6 per million; twice that from 2027.
  assert.equal(log?.cost_usd, 0.00047)
  assert.equal(log?.cost_usd_2027, 0.00094)
})

test("speak: the week's seconds run out → 402 with the usage", async () => {
  counters.set("speak:tx:3000000001", 118)
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "B".repeat(70), entitlement: ultraJws() }), ctx())
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.deepEqual([body.usage.used, body.usage.limit], [118, 120])
  assert.equal(tts.calls.length, 0)
})

test("speak: Flash-Lite refusing the language moves to the full model", async () => {
  tts.refuseLanguage = ["gemini-3.8-flash-lite-tts"]
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Some words.", lang: "en", entitlement: ultraJws() }), c)
  assert.equal(res.status, 200)
  await readAll(res)
  await Promise.all(c.waits)
  assert.deepEqual(tts.calls.map((x) => x.model), ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"])
  assert.equal(events.find((e) => e.kind === "speak")?.data.kind, "full")
})

test("speak: Swedish goes straight to the full model", async () => {
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Hej och välkommen.", lang: "sv", entitlement: ultraJws() }), c)
  await readAll(res)
  await Promise.all(c.waits)
  assert.deepEqual(tts.calls.map((x) => x.model), ["gemini-3.8-flash-tts"])
})

test("speak: a stream that breaks off is charged only for what was said", async () => {
  tts.failAfter = 1
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "C".repeat(140), entitlement: ultraJws() }), c)
  await assert.rejects(readAll(res))
  await Promise.all(c.waits)
  assert.equal(counters.get("speak:tx:3000000001"), 1)
  assert.equal(events.find((e) => e.kind === "speak")?.data.ok, false)
})

test("speak: a signed measuring request stands in for Ultra on a deploy preview only", async () => {
  const req = () => post("https://x/api/v2/speak", { installId: INSTALL, text: "Eval." }, { "x-cf-eval": evalHeader(INSTALL) })
  assert.equal((await speak(req(), ctx())).status, 403)
  ;(globalThis as { Netlify?: unknown }).Netlify = { context: { deploy: { context: "production" } } }
  assert.equal((await speak(req(), ctx())).status, 403)
  ;(globalThis as { Netlify?: unknown }).Netlify = { context: { deploy: { context: "deploy-preview" } } }
  // Another install's signature, an old one, or none of ours.
  for (const header of [evalHeader("00000000-0000-4000-8000-000000000000"), evalHeader(INSTALL, Date.now() - 11 * 60_000), "123.abc"]) {
    const bad = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Eval." }, { "x-cf-eval": header }), ctx())
    assert.equal(bad.status, 403)
    assert.equal((await bad.json()).eval, "token")
  }
  const c = ctx()
  const res = await speak(req(), c)
  assert.equal(res.status, 200)
  await readAll(res)
  await Promise.all(c.waits)
  assert.ok(counters.has(`speak:tx:eval-${INSTALL}`))
})

test("status: an Ultra subscriber sees the week's read-aloud seconds and the allowances", async () => {
  counters.set("speak:tx:3000000001", 30)
  const res = await status(post("https://x/api/v2/status", { installId: INSTALL, entitlement: ultraJws() }), ctx())
  const body = await res.json()
  assert.equal(body.plan, "ultra")
  assert.deepEqual([body.ultra.speak.used, body.ultra.speak.limit], [30, 120])
  assert.equal(body.ultra.similar.limit, 10)
  assert.equal(body.limits.speakWeeklySeconds, 120)
  assert.deepEqual(body.limits.watch, { free: 5, byok: 20, pro: 20, ultra: 50 })
  const pro = await (await status(post("https://x/api/v2/status", { installId: INSTALL, entitlement: signJws(transaction()) }), ctx())).json()
  assert.equal(pro.ultra, null)
})
