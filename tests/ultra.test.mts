// Ultra (2.6): the plan, its products, "Ultra counts as Pro", the read-aloud endpoint and its counters.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"
process.env.GEMINI_API_KEY = "gemini-test"
process.env.ANTHROPIC_API_KEY = "anthropic-test"
const { generateKeyPairSync, sign } = await import("node:crypto")
const evalKeys = generateKeyPairSync("ed25519")
process.env.CF_EVAL_PUBLIC_KEY = evalKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64")
const evalHeader = (install: string, at = Date.now()) => `${at}.${sign(null, Buffer.from(`${install}.${at}`), evalKeys.privateKey).toString("base64url")}`
process.env.ULTRA_SPEAK_WEEKLY_SECONDS = "120"

type Item = { subject: string; period: string; limit: number | null; amount?: number }
let counters = new Map<string, number>()
const periods = new Map<string, string>()
// The counters table before 20261109140000 (its check takes only 'day' and 'week').
let noEver = false
let entitlements = new Map<string, Record<string, unknown>>()
let events: { kind: string; data: Record<string, unknown> }[] = []
let tts: { calls: Array<{ model: string; text: string; voice: string; mime: string }>; refuseLanguage?: string[]; pcmBytes: number; chunks: number; failAfter?: number; failStatus?: number[] } = { calls: [], pcmBytes: 48_000 * 3, chunks: 3 }
let haiku: { calls: Array<{ model: string; system: string; content: string }>; status?: number; script: string } = { calls: [], script: "The MARKUS costs 299 dollars. The Sihoo costs 169." }
function haikuStream(): Response {
  const ev = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const words = haiku.script.split(" ").map((w, i) => (i ? ` ${w}` : w))
  const frames = [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...words.map((w) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: w } })),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 120 } }),
    ev("message_stop")
  ]
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } })
}
const MODELS = ["gemini-3.8-flash", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-3.6-flash-lite-tts"]

const rpc: Record<string, (args: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    for (const i of items) periods.set(i.subject, i.period)
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
    if (noEver && (body.p_items as Item[] | undefined)?.some((i) => i.period === "ever"))
      return new Response(JSON.stringify({ code: "23514", message: 'new row violates check constraint "usage_counters_period_check"' }), { status: 400 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) {
    return new Response(JSON.stringify({ models: MODELS.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: m.endsWith("tts") ? ["generateContent"] : ["generateContent", "countTokens"] })) }), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    haiku.calls.push({ model: body.model, system: body.system.map((b: { text: string }) => b.text).join("\n"), content: body.messages[0].content })
    if (haiku.status) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: haiku.status, headers: { "Content-Type": "application/json" } })
    return haikuStream()
  }
  if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
    const text = body.input[0].content[0].text
    tts.calls.push({ model: body.model, text, voice: body.generation_config.speech_config[0].voice, mime: body.response_format.mime_type })
    const failing = tts.failStatus?.shift()
    if (failing) return new Response(JSON.stringify({ error: { code: failing, message: "Overloaded" } }), { status: failing })
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
const { speechText, speechParts, speechSeconds, speechKind, needsScript, scriptChunks, PartSplitter } = await import("../src/shared/speech.ts")
const { newestGeminiTts } = await import("../src/shared/models.ts")
const { tourAsked } = await import("../netlify/shared/tour.mts")
const speak = (await import("../netlify/functions/v2-speak.mts")).default
const speakHeard = (await import("../netlify/functions/v2-speak-heard.mts")).default
// A part's key on the devices (src/background/speak.ts speechKey, the app's cacheKey).
const partKey = (lang: string, text: string) => createHash("sha256").update(`v1|${lang}|${text}`).digest("hex")
const status = (await import("../netlify/functions/v2-status.mts")).default
const speakScript = (await import("../netlify/functions/v2-speak-script.mts")).default

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
  noEver = false
  haiku = { calls: [], script: "The MARKUS costs 299 dollars. The Sihoo costs 169." }
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
  const text = speechText("## Key points\n\n- **Fast** start [1]\n- See [the docs](https://example.com/a(b)) now\n\n```js\nconsole.log(1)\n```\n| Chair | Price | Color |\n|---|---|---|\n| **MARKUS** | $299 | dark gray |\n| Sihoo M18 | $169 | |\nVisit https://x.com today.")
  assert.equal(text, "Key points.\n\nFast start.\nSee the docs now.\n\nMARKUS: Price $299, Color dark gray.\nSihoo M18: Price $169.\nVisit today.")
  // A table without a header row: its cells in a row.
  assert.equal(speechText("| a | b |\n| c | d |"), "a, b.\nc, d.")
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

test("needsScript: tables, lists, code, headings and symbols go to Haiku; plain prose goes straight to the voice", () => {
  assert.equal(needsScript("The train leaves at nine. It arrives a little after noon."), false)
  assert.equal(needsScript("Short list:\n- one\n- two"), false)
  assert.equal(needsScript("| A | B |\n|---|---|\n| 1 | 2 |"), true)
  assert.equal(needsScript("Steps:\n1. a\n2. b\n3. c\n4. d"), true)
  assert.equal(needsScript("Run this:\n```sh\nnpm i\n```"), true)
  assert.equal(needsScript("## One\ntext\n## Two\ntext"), true)
  assert.equal(needsScript("From 5–10 °C, ±2%, about 3 € → 4 €, then 7–9 km at 20–30 km/h"), true)
})

test("scriptChunks: a long page in pieces cut between paragraphs, nothing lost", () => {
  const paragraph = (i: number) => `Paragraph ${i}. ` + "Words that go on for a while. ".repeat(20)
  const text = Array.from({ length: 20 }, (_, i) => paragraph(i)).join("\n\n")
  const chunks = scriptChunks(text, 2000)
  assert.ok(chunks.length > 3 && chunks.every((c) => c.length <= 2000))
  assert.equal(chunks.join("\n\n").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim())
})

test("PartSplitter: the first part as soon as a sentence is said, then full parts, nothing lost", () => {
  const splitter = new PartSplitter()
  const parts: string[] = []
  const stream = "The MARKUS costs 299 dollars and comes in dark gray. " + "The Sihoo M18 costs 169 dollars and it is in stock right now. ".repeat(40) + "That's all."
  for (let i = 0; i < stream.length; i += 17) parts.push(...splitter.push(stream.slice(i, i + 17)))
  assert.equal(parts[0], "The MARKUS costs 299 dollars and comes in dark gray.")
  parts.push(...splitter.end())
  assert.ok(parts.slice(1).every((p) => p.length <= 1400))
  assert.equal(parts.join(" ").replace(/\s+/g, " "), stream.replace(/\s+/g, " ").trim())
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

test("speak: streams whole PCM samples; making a part costs the user nothing, our cap holds its real length", async () => {
  const c = ctx()
  const text = "A".repeat(70) // 5 s estimated
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", what: "answer", entitlement: ultraJws(), client: { platform: "macos", version: "2.6" } }), c)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("Content-Type") ?? "", /audio\/L16; rate=24000/)
  // Build 92: the week's minutes count what's heard, not what's made.
  assert.equal(res.headers.get("X-CF-Charged"), "0")
  assert.deepEqual(JSON.parse(res.headers.get("X-CF-Usage") ?? "null").used, 0)
  const pcm = await readAll(res)
  assert.equal(pcm.length, 48_000 * 3)
  await Promise.all(c.waits)
  assert.equal(tts.calls[0].model, "gemini-3.8-flash-lite-tts")
  assert.equal(tts.calls[0].mime, "audio/l16")
  // 3 s of audio came: our cap holds 3, not the 5 estimated; the user's minutes are untouched; the part's length is kept.
  assert.equal(counters.get("speakmade:tx:3000000001"), 3)
  assert.equal(counters.get("speak:tx:3000000001") ?? 0, 0)
  assert.equal(counters.get(`speakpart:3000000001:${partKey("en", text)}`), 3)
  const log = events.find((e) => e.kind === "speak")?.data
  assert.equal(log?.charged_s, 0)
  assert.equal(log?.est_s, 5)
  assert.equal(log?.ok, true)
  assert.equal(log?.audio_s, 3)
  assert.equal(log?.output_tokens, 75)
  // 40 text tokens at $0.50 and 75 audio tokens at $6 per million; twice that from 2027.
  assert.equal(log?.cost_usd, 0.00047)
  assert.equal(log?.cost_usd_2027, 0.00094)
  assert.equal(log?.audience, undefined)
})

test("speak: the week's heard minutes used up → 402 with the usage; a minute short of it, a new text still starts", async () => {
  counters.set("speak:tx:3000000001", 119)
  const near = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "B".repeat(70), entitlement: ultraJws() }), ctx())
  assert.equal(near.status, 200)
  await readAll(near)
  counters.set("speak:tx:3000000001", 120)
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "B".repeat(70), entitlement: ultraJws() }), ctx())
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.deepEqual([body.usage.used, body.usage.limit], [120, 120])
  assert.equal(tts.calls.length, 1)
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
  assert.equal(counters.get("speakmade:tx:3000000001"), 1)
  assert.equal(events.find((e) => e.kind === "speak")?.data.ok, false)
})

test("speak: a text already playing finishes over the week's minutes (300 s more), a new one doesn't", async () => {
  counters.set("speak:tx:3000000001", 120)
  // Its third part: allowed into the finishing room, and the usage still shows the week's 120.
  const later = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "B".repeat(70), part: 2, parts: 3, entitlement: ultraJws() }), ctx())
  assert.equal(later.status, 200)
  assert.deepEqual(JSON.parse(later.headers.get("X-CF-Usage") ?? "null").limit, 120)
  await readAll(later)
  // A new text (part 0) over the limit: refused, as before.
  const fresh = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "D".repeat(70), part: 0, entitlement: ultraJws() }), ctx())
  assert.equal(fresh.status, 402)
  // The finishing room has an end: 300 s past the week's minutes, even for later parts.
  counters.set("speak:tx:3000000001", 120 + 300)
  const beyond = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "E".repeat(70), part: 5, parts: 9, entitlement: ultraJws() }), ctx())
  assert.equal(beyond.status, 402)
})

test("speak: a part with nothing to say is an empty 200, uncharged; a passing 503 is asked again in the same voice", async () => {
  const empty = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "— …", part: 4, parts: 5, entitlement: ultraJws() }), ctx())
  assert.equal(empty.status, 200)
  assert.equal((await readAll(empty)).length, 0)
  assert.equal(tts.calls.length, 0)
  assert.equal(counters.get("speak:tx:3000000001") ?? 0, 0)
  assert.equal(counters.get("speakmade:tx:3000000001") ?? 0, 0)
  tts.failStatus = [503]
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Some words.", lang: "en", entitlement: ultraJws() }), c)
  assert.equal(res.status, 200)
  await readAll(res)
  assert.deepEqual(tts.calls.map((x) => [x.model, x.voice]), [["gemini-3.8-flash-lite-tts", "Kore"], ["gemini-3.8-flash-lite-tts", "Kore"]])
})

test("speak: the same part made again costs the user nothing; our cap counts both makings; logged as a repeat", async () => {
  const body = { installId: INSTALL, text: "F".repeat(70), lang: "en", part: 1, parts: 3, entitlement: ultraJws() }
  const c1 = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", body), c1))
  await Promise.all(c1.waits)
  assert.equal(counters.get("speakmade:tx:3000000001"), 3)
  // The download broke off on the device and it asks again: the audio comes again, the week's minutes stay at 0.
  const c2 = ctx()
  const again = await speak(post("https://x/api/v2/speak", body), c2)
  assert.equal(again.status, 200)
  assert.equal(again.headers.get("X-CF-Charged"), "0")
  assert.equal((await readAll(again)).length, 48_000 * 3)
  await Promise.all(c2.waits)
  assert.equal(counters.get("speak:tx:3000000001") ?? 0, 0)
  assert.equal(counters.get("speakmade:tx:3000000001"), 6)
  assert.equal(tts.calls.length, 2)
  assert.equal(events.filter((e) => e.kind === "speak").at(-1)?.data.repeat, true)
  // Counted by the week the minutes are counted in, not by the day.
  assert.equal(periods.get([...counters.keys()].find((k) => k.startsWith("speakrep:")) ?? ""), "week")
})

// ---- build 92: the minutes count what's heard ----------------------------------

const heardReq = (items: unknown, installId = INSTALL) => post("https://x/api/v2/speak-heard", { installId, entitlement: ultraJws(), items })

test("heard: the week's minutes count what's heard (30 s heard of 43 s made is 30 s), once a part, up to its length", async () => {
  // Two parts made: 3 s each (the stand-in voice), 6 s in all; only the first one heard, 2 s of it.
  const a = "G".repeat(70), b = "H".repeat(70)
  for (const text of [a, b]) {
    const c = ctx()
    await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
    await Promise.all(c.waits)
  }
  assert.equal(counters.get("speakmade:tx:3000000001"), 6)
  const first = await (await speakHeard(heardReq([{ key: partKey("en", a), s: 1.2 }]), ctx())).json()
  assert.equal(first.added, 1)
  assert.deepEqual([first.usage.used, first.usage.limit], [1, 120])
  assert.equal(counters.get("speak:tx:3000000001"), 1)
  // The same report again (a batch sent twice): nothing more.
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", a), s: 1.2 }]), ctx())).json()).added, 0)
  // Heard to the end and past it (a report can't count more than the part's 3 s).
  const last = ctx()
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", a), s: 40 }]), last)).json()).added, 2)
  await Promise.all(last.waits)
  assert.equal(counters.get("speak:tx:3000000001"), 3)
  assert.equal(events.filter((e) => e.kind === "speak_heard").at(-1)?.data.added_s, 2)
})

test("heard: a part heard to its end, give or take a second, adds nothing when heard again a little longer (build 94)", async () => {
  // 3 s made; the first listen's clock said 2.4 s (counted 2), the replay's 2.6 s (it would round to 3).
  const text = "Q".repeat(70)
  const c = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
  await Promise.all(c.waits)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 2.4 }]), ctx())).json()).added, 2)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 2.6 }]), ctx())).json()).added, 0)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 3 }]), ctx())).json()).added, 0)
  assert.equal(counters.get("speak:tx:3000000001"), 2)
  // Half of a part heard is not "to its end": the rest counts when it's heard.
  const long = "R".repeat(70)
  const c2 = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: long, lang: "en", entitlement: ultraJws() }), c2))
  await Promise.all(c2.waits)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", long), s: 1 }]), ctx())).json()).added, 1)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", long), s: 3 }]), ctx())).json()).added, 2)
})

test("heard: a replay costs nothing, on this device or another of the subscriber's", async () => {
  const text = "J".repeat(70)
  const c = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
  await Promise.all(c.waits)
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 3 }]), ctx())).json()).added, 3)
  // From the device's copy again, and on another device (another install, the same subscription, from iCloud).
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 3 }]), ctx())).json()).added, 0)
  const other = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b"
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 3 }], other), ctx())).json()).added, 0)
  assert.equal(counters.get("speak:tx:3000000001"), 3)
})

test("heard: a text is voiced once every part is counted, over any listens and devices; then its id alone answers (build 95)", async () => {
  const p1 = "S".repeat(70), p2 = "T".repeat(70)
  for (const text of [p1, p2]) {
    const c = ctx()
    await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
    await Promise.all(c.waits)
  }
  const id = "0123456789abcdef"
  const keys = [partKey("en", p1), partKey("en", p2)]
  const ask = (body: Record<string, unknown>, installId = INSTALL) => post("https://x/api/v2/speak-heard", { installId, entitlement: ultraJws(), ...body })
  // Nothing heard yet: not voiced. A query only (texts, no items) reads no minutes.
  const none = await (await speakHeard(ask({ texts: [{ id, keys }] }), ctx())).json()
  assert.deepEqual([none.ok, none.voiced, none.usage], [true, [], undefined])
  // The first part heard on this device, a little of the second on another: not yet.
  const other = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b"
  assert.deepEqual((await (await speakHeard(ask({ items: [{ key: keys[0], s: 3 }], texts: [{ id, keys }] }), ctx())).json()).voiced, [])
  assert.deepEqual((await (await speakHeard(ask({ items: [{ key: keys[1], s: 1 }], texts: [{ id, keys }] }, other), ctx())).json()).voiced, [])
  // The rest of the second part, later, give or take a second: voiced, and kept.
  const done = await (await speakHeard(ask({ items: [{ key: keys[1], s: 2.4 }], texts: [{ id, keys }] }, other), ctx())).json()
  assert.deepEqual(done.voiced, [id])
  assert.equal(counters.get(`speakvoiced:3000000001:${id}`), 1)
  // From then on its id alone answers, on any device; another text, a part never made or a bad id: no.
  const later = await (await speakHeard(ask({ texts: [{ id }, { id: "fedcba9876543210", keys: [partKey("en", "never made")] }, { id: "nothex" }] }), ctx())).json()
  assert.deepEqual(later.voiced, [id])
  // Neither list: a 400; without Ultra: 403.
  assert.equal((await speakHeard(ask({ texts: [] }), ctx())).status, 400)
  assert.equal((await speakHeard(post("https://x/api/v2/speak-heard", { installId: INSTALL, entitlement: signJws(transaction()), texts: [{ id }] }), ctx())).status, 403)
})

test("heard (build 98): a part's tenths add up over listens and devices, each counted once; then the text is voiced", async () => {
  const p1 = "U".repeat(70), p2 = "V".repeat(70)
  for (const text of [p1, p2]) {
    const c = ctx()
    await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
    await Promise.all(c.waits)
  }
  const keys = [partKey("en", p1), partKey("en", p2)]
  const id = "1123456789abcdef"
  const ask = (body: Record<string, unknown>, installId = INSTALL) => post("https://x/api/v2/speak-heard", { installId, entitlement: ultraJws(), ...body })
  const send = async (items: unknown, installId = INSTALL) => (await (await speakHeard(ask({ items, texts: [{ id, keys }] }, installId), ctx())).json()) as { added: number; voiced: string[] }
  // The first part whole; the first half of the second (its tenths 0–4): 3 s, then 1 s.
  const first = await send([{ key: keys[0], s: 3, c: 1023, d: 3 }, { key: keys[1], s: 1.5, c: 0b0000011111, d: 3 }])
  assert.deepEqual([first.added, first.voiced], [4, []])
  // The same half again: nothing more, still not voiced.
  assert.deepEqual([(await send([{ key: keys[1], s: 1.5, c: 0b0000011111, d: 3 }])).added], [0])
  // The other half on another device (the panel there after the app here): the part is whole, the text voiced.
  const other = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b"
  const done = await send([{ key: keys[1], s: 1.5, c: 0b1111100000, d: 3 }], other)
  assert.equal(done.added, 2)
  assert.deepEqual(done.voiced, [id])
  // Each of the second part's tenths is its own counter, set once.
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => counters.get(`speakslot:3000000001:${keys[1]}:${i}`)), Array(10).fill(1))
  assert.equal(counters.get("speak:tx:3000000001"), 6)
})

test("heard (build 98): a stretch skipped over never counts, so the text isn't voiced until it's heard; replays stay free", async () => {
  const text = "W".repeat(70)
  const c = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
  await Promise.all(c.waits)
  const key = partKey("en", text)
  const id = "2123456789abcdef"
  const ask = (items: unknown) => post("https://x/api/v2/speak-heard", { installId: INSTALL, entitlement: ultraJws(), items, texts: [{ id, keys: [key] }] })
  const send = async (items: unknown) => (await (await speakHeard(ask(items), ctx())).json()) as { added: number; voiced: string[] }
  // Seeked forward over tenths 5 and 6: 8 of 10 heard, not voiced (counted at least 2 s short of the part's 3 s, so
  // the allowance of a second for older devices' clocks doesn't take it as whole).
  const skipped = await send([{ key, s: 2.4, c: 0b1110011111, d: 3 }])
  assert.deepEqual([skipped.added, skipped.voiced], [1, []])
  // A report that says more seconds but the same tenths (seconds counted by a clock that ran over the skip) adds nothing.
  assert.deepEqual([(await send([{ key, s: 3, c: 0b1110011111, d: 3 }])).added], [0])
  // The skipped stretch heard later: voiced, the last second counted.
  const later = await send([{ key, s: 0.6, c: 0b0001100000, d: 3 }])
  assert.deepEqual([later.added, later.voiced], [2, [id]])
  // Heard again whole: free.
  assert.deepEqual([(await send([{ key, s: 3, c: 1023, d: 3 }])).added], [0])
  assert.equal(counters.get("speak:tx:3000000001"), 3)
})

test("heard (build 98): nonsense tenths are left out (the seconds still count, as before)", async () => {
  const text = "X".repeat(70)
  const c = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws() }), c))
  await Promise.all(c.waits)
  const key = partKey("en", text)
  for (const bad of [-1, 1024, 2.5, "1023"]) {
    const res = await (await speakHeard(heardReq([{ key, s: 1, c: bad, d: 3 }]), ctx())).json()
    assert.equal(counters.get(`speakslot:3000000001:${key}:0`), undefined, String(bad))
    assert.ok(res.ok)
  }
  assert.equal(counters.get("speak:tx:3000000001"), 1)
})

test("heard: reports come with the next part too, and count before it's decided; a part not on record counts at most 60 s", async () => {
  counters.set("speak:tx:3000000001", 100)
  // A part made before its length was kept: at most 60 s of it count; nonsense is left out.
  const old = "a".repeat(64)
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", {
    installId: INSTALL, text: "K".repeat(70), lang: "en", entitlement: ultraJws(),
    heard: [{ key: old, s: 90 }, { key: "nope", s: 5 }, { key: "b".repeat(64), s: -3 }]
  }), c)
  // 100 + 60 heard is past the week's 120: this new text is refused.
  assert.equal(res.status, 402)
  await Promise.all(c.waits)
  assert.equal(counters.get("speak:tx:3000000001"), 160)
})

test("heard: our cap on audio made (150% of the allowance) stops a device that never reports; the minutes it shows are untouched", async () => {
  counters.set("speakmade:tx:3000000001", 178)
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "L".repeat(70), entitlement: ultraJws() }), c)
  assert.equal(res.status, 402)
  await Promise.all(c.waits)
  const body = await res.json()
  assert.equal(body.code, "LIMIT_REACHED")
  assert.equal(body.usage.used, 0)
  assert.equal(events.filter((e) => e.kind === "limit").at(-1)?.data.reason, "speak_made")
  assert.equal(tts.calls.length, 0)
})

test("heard: before the 'ever' counters are set up, read aloud still plays and a report is 'busy' (the device sends it again)", async () => {
  noEver = true
  const text = "J".repeat(70)
  const c = ctx()
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text, lang: "en", entitlement: ultraJws(), heard: [{ key: partKey("en", text), s: 2 }] }), c)
  assert.equal(res.status, 200)
  await readAll(res)
  await Promise.all(c.waits)
  assert.equal(counters.get("speakmade:tx:3000000001"), 3)
  const report = await speakHeard(heardReq([{ key: partKey("en", text), s: 2 }]), ctx())
  assert.equal(report.status, 503)
  assert.equal((await report.json()).code, "BUSY")
  assert.equal(counters.get("speak:tx:3000000001"), undefined)
  // Set up: the same report counts.
  noEver = false
  assert.equal((await (await speakHeard(heardReq([{ key: partKey("en", text), s: 2 }]), ctx())).json()).added, 2)
})

test("heard: Ultra only, and nothing to count is a 400", async () => {
  const pro = await speakHeard(post("https://x/api/v2/speak-heard", { installId: INSTALL, entitlement: signJws(transaction()), items: [{ key: "c".repeat(64), s: 3 }] }), ctx())
  assert.equal(pro.status, 403)
  assert.equal((await speakHeard(heardReq([]), ctx())).status, 400)
})

test("speak: a text keeps its first part's model; a 400 never moves it to another model", async () => {
  // The device sends the model its first part came from: the next part is asked of that one first.
  const c = ctx()
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Next part.", lang: "en", part: 1, parts: 2, model: "gemini-3.1-flash-tts-preview", entitlement: ultraJws() }), c))
  assert.equal(tts.calls[0].model, "gemini-3.1-flash-tts-preview")
  // Another refusal (not "no such model"): passed on, no second model tried.
  tts.calls = []
  tts.failStatus = [400]
  const res = await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Too long a part.", lang: "en", entitlement: ultraJws() }), ctx())
  assert.equal(res.status, 502)
  assert.deepEqual(tts.calls.map((x) => x.model), ["gemini-3.8-flash-lite-tts"])
})

test("speak: a text begun on the full model keeps it for a part Flash-Lite could say (build 95: one voice per text)", async () => {
  tts.calls = []
  tts.failStatus = undefined
  // The text's first part went to the full model (a language Flash-Lite lacks); this part is plain English.
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Plain English this time.", lang: "en", part: 2, parts: 3, model: "gemini-3.8-flash-tts", entitlement: ultraJws() }), ctx()))
  assert.deepEqual(tts.calls.map((x) => x.model), ["gemini-3.8-flash-tts"])
  // Without a model of its own (a first part), plain English goes to Flash-Lite as before.
  tts.calls = []
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "Plain English this time.", lang: "en", entitlement: ultraJws() }), ctx()))
  assert.deepEqual(tts.calls.map((x) => x.model), ["gemini-3.8-flash-lite-tts"])
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
  assert.ok(counters.has(`speakmade:tx:eval-${INSTALL}`))
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

// ---- /api/v2/speak-script ----------------------------------------------------

test("speak-script: Haiku writes a table for the ear, streamed; an answer may be rephrased, a page keeps its words", async () => {
  const c = ctx()
  const table = "| Chair | Price |\n|---|---|\n| MARKUS | $299 |\n| Sihoo | $169 |"
  const res = await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: table, what: "answer", lang: "en", entitlement: ultraJws() }), c)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "The MARKUS costs 299 dollars. The Sihoo costs 169.")
  await Promise.all(c.waits)
  assert.equal(haiku.calls[0].model, "claude-haiku-5-5")
  assert.match(haiku.calls[0].system, /Tables: say them as short sentences/)
  assert.match(haiku.calls[0].system, /you may rephrase/)
  assert.ok(haiku.calls[0].content.includes(table))
  const log = events.find((e) => e.kind === "speak_script")?.data
  assert.equal(log?.ok, true)
  assert.equal(log?.chars_out, 50)
  // 900 tokens in at $0.10 and 120 out at $0.50 per million.
  assert.equal(log?.cost_usd, 0.00015)
  // Not counted against the week's minutes.
  assert.equal(counters.get("speak:tx:3000000001") ?? 0, 0)

  const page = await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: "Some article text.", what: "page", entitlement: ultraJws() }), ctx())
  await page.text()
  assert.match(haiku.calls[1].system, /keep the author's own sentences word for word/)
})

test("speak and speak-script: a debug or TestFlight build's traffic is marked test (/analytics leaves it out)", async () => {
  const c = ctx()
  const client = { platform: "ios", version: "2.6", audience: "test" }
  await readAll(await speak(post("https://x/api/v2/speak", { installId: INSTALL, text: "A".repeat(70), lang: "en", entitlement: ultraJws(), client }), c))
  await (await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: "Some article text.", what: "page", entitlement: ultraJws(), client }), c)).text()
  await Promise.all(c.waits)
  assert.equal(events.find((e) => e.kind === "speak")?.data.audience, "test")
  assert.equal(events.find((e) => e.kind === "speak_script")?.data.audience, "test")
})

test("speak-script: Ultra only; too long refused; Haiku failing gives UPSTREAM and the cap back", async () => {
  assert.equal((await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: "Hi.", entitlement: signJws(transaction()) }), ctx())).status, 403)
  assert.equal((await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: "x".repeat(6001), entitlement: ultraJws() }), ctx())).status, 400)
  haiku.status = 529
  const c = ctx()
  const res = await speakScript(post("https://x/api/v2/speak-script", { installId: INSTALL, text: "| a | b |", entitlement: ultraJws() }), c)
  assert.equal(res.status, 502)
  assert.equal((await res.json()).code, "UPSTREAM")
  await Promise.all(c.waits)
  assert.equal(counters.get("script:tx:3000000001"), 0)
})
