import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

import { signJws, TEST_ROOT_FINGERPRINT, transaction } from "./helpers.mts"
import { unpackVector } from "../src/shared/organize.ts"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.OPENAI_API_KEY = "sk-test"
process.env.ORGANIZE_THRESHOLDS = '{"moveT":0.5,"bogus":3,"tagT":"x"}'

type Item = { subject: string; period: string; limit: number | null }
let counters = new Map<string, number>()
let events: Array<{ kind: string; data: Record<string, unknown> }> = []
let embeddings: { calls: number; status?: number; lastBody?: Record<string, any> } = { calls: 0 }
let claude: { calls: number; status?: number; errorType?: string; text: string; stop?: string; lastBody?: Record<string, any> } = { calls: 0, text: "" }
let nano: { calls: number; status?: number; text: string; lastBody?: Record<string, any> } = { calls: 0, text: "" }

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
  cf_limited_before: () => false,
  cf_log: ({ p_kind, p_data }) => {
    events.push({ kind: p_kind, data: p_data })
    return null
  },
  cf_entitlement_upsert: ({ p }) => p
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (url.startsWith("https://db.test/rest/v1/rpc/")) return json(rpc[url.split("/rpc/")[1].split("?")[0]](body))
  if (url === "https://api.openai.com/v1/embeddings") {
    embeddings.calls++
    embeddings.lastBody = body
    if (embeddings.status) return new Response("busy", { status: embeddings.status })
    // Unit vectors pointing one way per text: the n-th text along axis n.
    return json({ data: (body.input as string[]).map((_, i) => ({ index: i, embedding: Array.from({ length: body.dimensions }, (_, d) => (d === i ? 0.9 : 0.01)) })).reverse(), usage: { total_tokens: 40 } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    claude.calls++
    claude.lastBody = body
    if (claude.status) return json({ type: "error", error: { type: claude.errorType ?? "api_error", message: "failed" } }, claude.status)
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: claude.text }], stop_reason: claude.stop ?? "end_turn", stop_sequence: null, usage: { input_tokens: 1600, output_tokens: 40 } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    nano.calls++
    nano.lastBody = body
    if (nano.status) return new Response("busy", { status: nano.status })
    return json({ model: "gpt-5-nano", choices: [{ message: { content: nano.text } }], usage: { prompt_tokens: 1500, completion_tokens: 300 } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let organize: (req: Request, ctx: any) => Promise<Response>
let status: (req: Request, ctx: any) => Promise<Response>
let config: { anthropicKey: string; organize: { enabled: boolean; embedDaily: number; tagsDaily: number; thresholds: Record<string, number> } }

before(async () => {
  ;(await import("../netlify/shared/apple.mts")).setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  config = (await import("../netlify/shared/config.mts")).config as never
  organize = (await import("../netlify/functions/v2-organize.mts")).default
  status = (await import("../netlify/functions/v2-status.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  embeddings = { calls: 0 }
  claude = { calls: 0, text: '{"tags":[{"tag":"work","fits":true,"confidence":0.9},{"tag":"#travel","fits":false,"confidence":0.8},{"tag":"invented","fits":true,"confidence":1}]}' }
  nano = { calls: 0, text: '{"tags":[{"tag":"work","fits":true,"confidence":0.75}]}' }
  config.anthropicKey = "sk-ant-test"
  config.organize.enabled = true
  config.organize.embedDaily = 150
  config.organize.tagsDaily = 300
})

function ctx() {
  const pending: Promise<unknown>[] = []
  return { ip: "203.0.113.7", waitUntil: (p: Promise<unknown>) => pending.push(p), pending }
}

const INSTALL = "8d7b3f2e-1c4a-4e9b-9f0a-2b6c7d8e9f01"
const PRO = signJws(transaction())
const request = (body: Record<string, unknown>) => new Request("https://aisidebar.netlify.app/api/v2/organize", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ installId: INSTALL, client: { version: "2.5", platform: "ios", locale: "en-US" }, entitlement: PRO, ...body })
})
const CHECK = {
  op: "tags",
  message: "Sprint review: move the release to Friday",
  candidates: [{ tag: "work", examples: ["Standup notes", "Q3 roadmap"] }, { tag: "travel", examples: ["Kyoto temples"] }]
}

async function call(body: Record<string, unknown>) {
  const c = ctx()
  const res = await organize(request(body), c)
  await Promise.all(c.pending)
  return { res, body: await res.json() }
}

test("embed: vectors for the texts in their order, packed, one request charged per day; no text in the logs", async () => {
  const { res, body } = await call({ op: "embed", texts: ["Kyoto temples", "Sourdough starter", "x".repeat(5_000)] })
  assert.equal(res.status, 200)
  assert.equal(body.space, "text-embedding-3-small:256")
  assert.equal(body.vectors.length, 3)
  body.vectors.forEach((packed: string, i: number) => {
    const v = unpackVector(packed)!
    assert.equal(v.length, 256)
    assert.ok(v[i] > 0.99, `text ${i} points along axis ${i}`)
  })
  assert.equal(embeddings.lastBody?.dimensions, 256)
  assert.equal((embeddings.lastBody?.input as string[])[2].length, 1_200)
  assert.equal(counters.get("organize:embed:tx:2000000123"), 1)
  const logged = events.find((e) => e.kind === "organize_api")!.data
  assert.equal(logged.op, "embed")
  assert.equal(logged.n, 3)
  assert.ok(!JSON.stringify(events).includes("Kyoto"))
})

test("tags: Claude Haiku 5.5 without thinking, a fixed JSON answer; only the tags asked about come back", async () => {
  const { res, body } = await call(CHECK)
  assert.equal(res.status, 200)
  assert.deepEqual(body.verdicts, [{ tag: "work", fits: true, confidence: 0.9 }, { tag: "travel", fits: false, confidence: 0.8 }])
  assert.equal(claude.lastBody?.model, "claude-haiku-5-5")
  assert.deepEqual(claude.lastBody?.thinking, { type: "disabled" })
  assert.equal(claude.lastBody?.output_config.effort, "low")
  assert.equal(claude.lastBody?.output_config.format.type, "json_schema")
  assert.match(claude.lastBody?.messages[0].content, /<examples tag="work">/)
  assert.equal(nano.calls, 0)
  const logged = events.find((e) => e.kind === "organize_api")!.data
  assert.equal(logged.provider, "anthropic")
  assert.ok(!JSON.stringify(events).includes("Sprint"))
})

test("tags: when Claude fails, refuses or has no key, gpt-5-nano answers; both down is UPSTREAM and refunded", async () => {
  claude.status = 529
  claude.errorType = "overloaded_error"
  let r = await call(CHECK)
  assert.deepEqual(r.body.verdicts, [{ tag: "work", fits: true, confidence: 0.75 }])
  assert.equal(nano.lastBody?.model, "gpt-5-nano")
  assert.equal(nano.lastBody?.response_format.type, "json_schema")
  assert.equal(events.find((e) => e.kind === "organize_api")!.data.fallback, "overloaded")

  claude.status = undefined
  claude.stop = "refusal"
  r = await call(CHECK)
  assert.equal(r.res.status, 200)
  assert.equal(events.filter((e) => e.kind === "organize_api").at(-1)!.data.fallback, "refusal")

  config.anthropicKey = ""
  const before = claude.calls
  r = await call(CHECK)
  assert.equal(claude.calls, before)
  assert.equal(events.filter((e) => e.kind === "organize_api").at(-1)!.data.fallback, "no_key")

  nano.status = 500
  r = await call(CHECK)
  assert.equal(r.res.status, 502)
  assert.equal(r.body.code, "UPSTREAM")
  assert.equal(counters.get("organize:tags:tx:2000000123"), 3)
})

test("only Pro: free and Own key get PRO_ONLY before anything is charged or sent", async () => {
  for (const entitlement of [null, signJws(transaction({ productId: "com.contextflow.byok.monthly", originalTransactionId: "b2" }))]) {
    const { res, body } = await call({ op: "embed", texts: ["a"], entitlement })
    assert.equal(res.status, 403)
    assert.equal(body.code, "PRO_ONLY")
  }
  assert.equal(embeddings.calls, 0)
  assert.equal(counters.size, 0)
})

test("its own daily limit, a switch, and malformed requests", async () => {
  config.organize.tagsDaily = 1
  assert.equal((await call(CHECK)).res.status, 200)
  const limited = await call(CHECK)
  assert.equal(limited.res.status, 429)
  assert.equal(limited.body.code, "LIMIT_REACHED")

  config.organize.enabled = false
  const off = await call({ op: "embed", texts: ["a"] })
  assert.equal(off.res.status, 503)
  assert.equal(off.body.code, "OFF")
  config.organize.enabled = true

  for (const bad of [{ op: "embed", texts: [] }, { op: "embed", texts: Array(129).fill("a") }, { op: "embed", texts: ["a", 3] }, { op: "tags", message: "x", candidates: [] }, { op: "nope" }]) {
    assert.equal((await call(bad)).res.status, 400, JSON.stringify(bad).slice(0, 60))
  }
  embeddings.status = 500
  const failed = await call({ op: "embed", texts: ["a"] })
  assert.equal(failed.res.status, 502)
  assert.equal(counters.get("organize:embed:tx:2000000123") ?? 0, 0)
})

test("calibration: the eval token stands in for Pro on a deploy preview, never in production", async () => {
  ;(config.organize as Record<string, unknown>).evalToken = "eval-secret"
  const asEval = (deploy: string, token = "eval-secret") => {
    const req = request({ op: "embed", texts: ["a"], entitlement: null })
    const signed = new Request(req, { headers: { ...Object.fromEntries(req.headers), Authorization: `Bearer ${token}` } })
    const c = { ...ctx(), deploy: { context: deploy, id: "d1", published: false } }
    return organize(signed, c)
  }
  assert.equal((await asEval("deploy-preview")).status, 200)
  assert.equal(counters.get("organize:embed:eval"), 1)
  assert.equal((await asEval("production")).status, 403)
  assert.equal((await asEval("deploy-preview", "wrong-secret")).status, 403)
  ;(config.organize as Record<string, unknown>).evalToken = ""
  assert.equal((await asEval("deploy-preview")).status, 403)
})

test("status gives the switch, the vector space and the thresholds (known numbers from ORGANIZE_THRESHOLDS)", async () => {
  const res = await status(new Request("https://aisidebar.netlify.app/api/v2/status", { method: "POST", body: JSON.stringify({ installId: INSTALL, client: {} }) }), ctx())
  const body = await res.json()
  assert.equal(body.organize.on, true)
  assert.equal(body.organize.space, "text-embedding-3-small:256")
  assert.equal(body.organize.config.moveT, 0.5)
  assert.equal(body.organize.config.tagT, 0.3)
  assert.equal(body.organize.config.bogus, undefined)
})
