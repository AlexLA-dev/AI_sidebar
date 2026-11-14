// 2.7, /api/v2/translate: a page is one answer (the owner's rule). Free takes it from the 5 a day, Pro and Ultra from
// the week; more of the same page (scrolling, new blocks, translating again after "Original") doesn't count again.
// Out of free answers: LIMIT_REACHED with the Pro offer. A hidden cap per page for very long ones. Lines come streamed,
// each checked against its block's tags; one that loses them is asked again, then left as it is. Nothing of the page
// in the logs.
import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "sk-ant-test"

type Item = { subject: string; period: string; limit: number | null; amount?: number }
let counters = new Map<string, number>()
let events: { kind: string; data: Record<string, unknown> }[] = []
const rpc: Record<string, (a: Record<string, any>) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    const amount = (i: Item) => Math.max(1, i.amount ?? 1)
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) + amount(i) > i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + amount(i)))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ subject: i.subject, period: i.period, limit: i.limit, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: ({ p_items }) => {
    for (const i of p_items as Item[]) counters.set(i.subject, Math.max(0, (counters.get(i.subject) ?? 0) - Math.max(1, i.amount ?? 1)))
    return null
  },
  cf_log: ({ p_kind, p_data }) => {
    events.push({ kind: p_kind, data: p_data })
    return null
  },
  cf_touch_install: () => null,
  cf_entitlement_upsert: ({ p }) => ({ ...p, revoked_at: null })
}

// ---- Claude Haiku, streamed: each "§n text" line of the request comes back as `answer(text)` -----------------------
let haiku: { calls: Array<{ model: string; system: string; content: string }>; answer: (text: string, call: number) => string | null; status?: number }
const ru: Record<string, string> = {
  "Die Stadt hat die Brücke <1>über den Fluss</1> eröffnet.": "Город открыл мост <1>через реку</1>.",
  "Mehr dazu <1>hier</1>.<2/>Neue Zeile.": "Подробнее <1>здесь</1>.<2/>Новая строка.",
  "Zweiter Absatz.": "Второй абзац."
}
function stream(content: string, call: number): Response {
  const ev = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const out = content.split("\n").map((line) => {
    const m = /^§(\d+) (.*)$/.exec(line)
    if (!m) return null
    const text = haiku.answer(m[2], call)
    return text === null ? null : `§${m[1]} ${text}`
  }).filter((l): l is string => l !== null).join("\n")
  // In small pieces, as the model writes: a line may end mid-piece.
  const pieces = out.match(/[\s\S]{1,7}/g) ?? []
  const frames = [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 700, output_tokens: 1 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...pieces.map((text) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 90 } }),
    ev("message_stop")
  ]
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
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    haiku.calls.push({ model: body.model, system: body.system, content: body.messages[0].content })
    if (haiku.status) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: haiku.status, headers: { "Content-Type": "application/json" } })
    return stream(body.messages[0].content, haiku.calls.length)
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let translate: (req: Request, ctx: any) => Promise<Response>
let readBlocks: (raw: unknown) => Array<{ id: string; text: string }>
let settings: { claudeMinBuild: number; translate: { pageChars: number; parallel: number } }

before(async () => {
  const apple = await import("../netlify/shared/apple.mts")
  apple.setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  settings = (await import("../netlify/shared/config.mts")).config
  const mod = await import("../netlify/functions/v2-translate.mts")
  translate = mod.default
  readBlocks = mod.readBlocks
})

beforeEach(() => {
  counters = new Map()
  events = []
  haiku = { calls: [], answer: (text) => ru[text] ?? `RU(${text})` }
  settings.claudeMinBuild = 67
  settings.translate.pageChars = 300_000
  settings.translate.parallel = 4
})

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const CLIENT = { version: "2.7.0", platform: "ios", locale: "ru-RU", build: "110" }
const PAGE_A = "a".repeat(32)
const BLOCKS = [
  { id: "b1", text: "Die Stadt hat die Brücke <1>über den Fluss</1> eröffnet." },
  { id: "b2", text: "Mehr dazu <1>hier</1>.<2/>Neue Zeile." },
  { id: "b3", text: "Zweiter Absatz." }
]

async function call(body: Record<string, unknown>) {
  const pending: Promise<unknown>[] = []
  const ctx = { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p) }
  const req = new Request("https://aisidebar.netlify.app/api/v2/translate", { method: "POST", body: JSON.stringify({ installId: INSTALL, client: CLIENT, to: "ru", from: "de", page: PAGE_A, blocks: BLOCKS, first: true, ...body }), headers: { "Content-Type": "application/json" } })
  const res = await translate(req, ctx)
  const text = await res.text()
  await Promise.all(pending)
  const sse = res.headers.get("Content-Type")?.startsWith("text/event-stream")
  const out = sse ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) : []
  return { res, json: sse ? null : (JSON.parse(text) as Record<string, any>), events: out as Array<Record<string, any>> }
}

const items = (evs: Array<Record<string, any>>) => Object.fromEntries(evs.filter((e) => e.type === "items").flatMap((e) => e.items).map((i: any) => [i.id, i.text]))

test("a page is one answer: charged on its first request, its tags kept, streamed; nothing of the page in the logs", async () => {
  const { res, events: out } = await call({})
  assert.equal(res.status, 200)
  assert.deepEqual(out[0], { type: "meta", charged: true, usage: out[0].usage })
  assert.equal(out[0].usage.used, 1)
  assert.equal(out[0].usage.limit, 5)
  assert.deepEqual(items(out), { b1: ru[BLOCKS[0].text], b2: ru[BLOCKS[1].text], b3: ru[BLOCKS[2].text] })
  assert.equal(out.at(-1)!.type, "done")
  assert.equal(counters.get(`install:${INSTALL}`), 1)
  assert.equal(haiku.calls[0].model, "claude-haiku-5-5")
  assert.ok(haiku.calls[0].system.includes("into Russian") && haiku.calls[0].system.includes("mostly in German"))
  assert.ok(haiku.calls[0].content.startsWith("§1 Die Stadt"))
  const log = events.find((e) => e.kind === "translate")!
  assert.equal(log.data.charged, true)
  assert.equal(log.data.done, 3)
  assert.equal(log.data.to, "ru")
  assert.ok(!JSON.stringify(log.data).includes("Brücke") && !JSON.stringify(log.data).includes(PAGE_A), "no text, no page id in the logs")
})

test("the same page again (more blocks, after Original) doesn't count; another page does", async () => {
  await call({})
  const again = await call({ first: false, blocks: [{ id: "b9", text: "Zweiter Absatz." }] })
  assert.equal(again.events[0].charged, false)
  assert.equal(counters.get(`install:${INSTALL}`), 1)
  const other = await call({ page: "b".repeat(32) })
  assert.equal(other.events[0].charged, true)
  assert.equal(counters.get(`install:${INSTALL}`), 2)
})

test("free answers used up: LIMIT_REACHED with the Pro offer, nothing translated; a page counted before still translates", async () => {
  counters.set(`install:${INSTALL}`, 4)
  await call({})
  const out = await call({ page: "c".repeat(32) })
  assert.equal(out.res.status, 402)
  assert.equal(out.json!.code, "LIMIT_REACHED")
  assert.equal(out.json!.usage.used, 5)
  assert.equal(out.json!.offer.code, "CONTEXTFLOW50")
  assert.equal(counters.get(`trpage:install:${INSTALL}:${"c".repeat(32)}`) ?? 0, 0, "the page wasn't counted")
  assert.ok(events.some((e) => e.kind === "limit" && e.data.mode === "translate"))
  const before = await call({ first: false })
  assert.equal(before.res.status, 200, "the page already counted this week goes on")
  assert.equal(before.events[0].charged, false)
})

test("Pro: the page comes out of the subscription's week, on any of its devices", async () => {
  const jws = signJws(transaction({ productId: "com.contextflow.pro.monthly", originalTransactionId: "7000000001" }))
  const first = await call({ entitlement: jws })
  assert.equal(first.events[0].charged, true)
  assert.equal(counters.get("tx:7000000001"), 1)
  assert.equal(first.events[0].usage.period, "week")
  const other = await call({ entitlement: jws, installId: "9d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f02", first: false })
  assert.equal(other.events[0].charged, false, "the same page on the subscription's other device")
  assert.equal(counters.get("tx:7000000001"), 1)
})

test("the page's hidden cap: PAGE_CAP, and the answer it would have counted is given back", async () => {
  settings.translate.pageChars = 60
  const out = await call({})
  assert.equal(out.res.status, 413)
  assert.equal(out.json!.code, "PAGE_CAP")
  assert.equal(counters.get(`install:${INSTALL}`) ?? 0, 0)
})

test("a line that loses its link's tags is asked once more; still lost: left as it is", async () => {
  haiku.answer = (text, n) => text.startsWith("Mehr dazu") ? (n === 1 ? "Подробнее здесь.<2/>Новая строка." : "Подробнее <1>здесь.<2/>Новая строка.") : ru[text] ?? null
  const out = await call({})
  assert.deepEqual(Object.keys(items(out.events)).sort(), ["b1", "b3"])
  assert.deepEqual(out.events.find((e) => e.type === "skip")!.ids, ["b2"])
  assert.ok(haiku.calls.some((c) => c.content === "§1 Mehr dazu <1>hier</1>.<2/>Neue Zeile."), "asked again alone")

  haiku = { calls: [], answer: (text, n) => text.startsWith("Mehr dazu") && n === 1 ? "Подробнее здесь." : ru[text] ?? null }
  const fixed = await call({ page: "d".repeat(32) })
  assert.equal(items(fixed.events).b2, ru[BLOCKS[1].text], "the second try kept them")
})

test("nothing translated (Claude down): an error, and the page, the answer and the caps are given back", async () => {
  haiku.status = 529
  const out = await call({})
  assert.equal(out.events.at(-1)!.type, "error")
  assert.equal(counters.get(`install:${INSTALL}`) ?? 0, 0)
  assert.equal(counters.get(`trpage:install:${INSTALL}:${PAGE_A}`) ?? 0, 0)
  assert.equal(counters.get(`trday:install:${INSTALL}`) ?? 0, 0)
})

test("checked before anything is charged: the page id, the language, the blocks, the build", async () => {
  assert.equal((await call({ page: "https://example.com" })).res.status, 400)
  assert.equal((await call({ to: "Russian" })).res.status, 400)
  assert.equal((await call({ blocks: [] })).res.status, 400)
  assert.equal((await call({ client: { ...CLIENT, build: "60" } })).json!.code, "UNAVAILABLE")
  assert.equal(counters.size, 0)
  const kept = readBlocks([{ id: "a", text: "x".repeat(5000) }, { id: "b", text: "  ok \n text " }, { id: "b", text: "dup" }, { text: "no id" }])
  assert.deepEqual(kept, [{ id: "b", text: "ok text" }])
})
