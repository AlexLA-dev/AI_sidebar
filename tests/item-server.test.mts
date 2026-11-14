// /api/v2/item (2.7, Calendar and Reminders): the date and time of a reminder or an event read out of a text, in the
// device's own time; nothing stored, counts in the logs. Stand-ins as in watch-server.test.mts.
import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { TEST_ROOT_FINGERPRINT } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "sk-ant-test"

// ---- in-memory stand-in for the cf_* RPCs --------------------------------
type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let events: { kind: string; install?: string | null; data: Record<string, unknown> }[] = []
const rpc: Record<string, (a: any) => unknown> = {
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
  cf_log: ({ p_kind, p_install_id, p_data }) => {
    events.push({ kind: p_kind, install: p_install_id, data: p_data })
    return null
  },
  cf_touch_install: () => null,
  cf_entitlement_upsert: ({ p }) => ({ ...p, revoked_at: null }),
  cf_entitlement_get: () => null
}

// ---- the Claude API: a JSON answer (structured output), an error, or a refusal --------
let claude: { calls: number; answer: unknown; status?: number; stop?: string; lastBody?: Record<string, any> } = { calls: 0, answer: {} }

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    if (!rpc[fn]) return new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    return new Response(JSON.stringify(rpc[fn](body)), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    claude.calls++
    claude.lastBody = body
    if (claude.status) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: claude.status, headers: { "Content-Type": "application/json" } })
    const message = {
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(claude.answer) }],
      stop_reason: claude.stop ?? "end_turn", stop_sequence: null,
      ...(claude.stop === "refusal" ? { stop_details: { type: "refusal", category: "general_harms", explanation: "declined" } } : {}),
      usage: { input_tokens: 3000, output_tokens: 80 }
    }
    return new Response(JSON.stringify(message), { headers: { "Content-Type": "application/json" } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let item: (req: Request, ctx: any) => Promise<Response>
let serverConfig: { items: { installDaily: number } }

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  serverConfig = (await import("../netlify/shared/config.mts")).config
  item = (await import("../netlify/functions/v2-item.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  claude = { calls: 0, answer: {} }
  serverConfig.items.installDaily = 60
})

function ctx() {
  const pending: Promise<unknown>[] = []
  return { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const CLIENT = { version: "2.7.0", platform: "ios", locale: "ru-RU", build: "101" }
const NOW = { now: "2026-11-14T13:05", weekday: "Saturday", tz: "Europe/Moscow" }
const call = async (body: Record<string, unknown>) => {
  const c = ctx()
  const req = new Request("https://aisidebar.netlify.app/api/v2/item", { method: "POST", body: JSON.stringify({ installId: INSTALL, client: CLIENT, ...NOW, ...body }), headers: { "Content-Type": "application/json" } })
  const res = await item(req, c)
  await Promise.all(c.pending)
  return { res, body: (await res.json()) as Record<string, any> }
}

test("a request in the chat: Haiku in JSON, the device's own now and zone in the prompt, items checked; counts only in the logs", async () => {
  claude.answer = { items: [
    { kind: "reminder", title: "Забронировать отель", date: "2026-11-20", time: "09:00", confidence: "guess" },
    { kind: "event", title: "Без даты", confidence: "sure" }
  ] }
  const { res, body } = await call({ words: "напомни в пятницу забронировать отель", text: "Хорошо, напомню в пятницу.", title: "Отели в Сочи" })
  assert.equal(res.status, 200)
  assert.deepEqual(body, { ok: true, items: [{ kind: "reminder", title: "Забронировать отель", confidence: "guess", date: "2026-11-20", time: "09:00" }] })
  const sent = claude.lastBody!
  assert.equal(sent.model, "claude-haiku-5-5")
  assert.equal(sent.output_config.format.type, "json_schema")
  assert.match(sent.system, /never convert to UTC/i)
  const prompt = JSON.stringify(sent.messages)
  assert.ok(prompt.includes("Saturday, 2026-11-14T13:05 (Europe/Moscow)"), "the device's wall clock and zone")
  assert.ok(prompt.includes("напомни в пятницу") && prompt.includes("Отели в Сочи"))
  const log = events.find((e) => e.kind === "item_ai")!
  assert.deepEqual([log.data.items, log.data.reminders, log.data.events, log.data.guessed, log.data.words], [1, 1, 0, 1, 1])
  assert.ok(!JSON.stringify(log.data).includes("отель"), "no text, title or request in the logs")
  assert.equal(counters.get(`item:${INSTALL}`), 1)
})

test("the kind the person asked for wins; an unknown zone falls back to UTC; no items is an answer too", async () => {
  claude.answer = { items: [{ kind: "event", title: "Pay rent", date: "2026-12-01", confidence: "sure" }] }
  const { body } = await call({ text: "Rent is due on 1 December", kind: "reminder", tz: "Nowhere/Land" })
  assert.equal(body.items[0].kind, "reminder")
  assert.ok(JSON.stringify(claude.lastBody!.messages).includes("(UTC)"))
  assert.ok(JSON.stringify(claude.lastBody!.messages).includes("a reminder in Reminders"))
  claude.answer = { items: [] }
  assert.deepEqual((await call({ text: "Hello" })).body, { ok: true, items: [] })
})

test("bad requests, the daily safety cap and the model's failures", async () => {
  assert.equal((await call({ text: "", words: "" })).res.status, 400)
  assert.equal((await call({ text: "x", now: "tomorrow" })).res.status, 400)
  assert.equal((await call({ text: "x", installId: "nope" })).res.status, 400)
  assert.equal(claude.calls, 0)
  serverConfig.items.installDaily = 1
  claude.answer = { items: [] }
  assert.equal((await call({ text: "x" })).res.status, 200)
  const busy = await call({ text: "x" })
  assert.equal(busy.res.status, 503)
  assert.equal(busy.body.code, "BUSY")
  serverConfig.items.installDaily = 60
  counters = new Map()
  claude.status = 529
  const failed = await call({ text: "x" })
  assert.equal(failed.res.status, 502)
  assert.equal(counters.get(`item:${INSTALL}`), 0, "refunded")
})
