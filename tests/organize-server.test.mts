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
let claude: { calls: number; status?: number; errorType?: string; text: string; compare?: string; stop?: string; lastBody?: Record<string, any>; bodies: Array<Record<string, any>> } = { calls: 0, text: "", bodies: [] }
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
    claude.bodies.push(body)
    if (claude.status) return json({ type: "error", error: { type: claude.errorType ?? "api_error", message: "failed" } }, claude.status)
    // The comparison of two names (2.6 (94)) has its own answer.
    const text = String(body.system).startsWith("You compare") ? claude.compare ?? '{"better":"same"}' : claude.text
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: claude.stop ?? "end_turn", stop_sequence: null, usage: { input_tokens: 1600, output_tokens: 40 } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    nano.calls++
    nano.lastBody = body
    if (nano.status) return new Response("busy", { status: nano.status })
    return json({ model: "gpt-5-nano", choices: [{ message: { content: nano.text } }], usage: { prompt_tokens: 1500, completion_tokens: 300 } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let setNameOrderForTests: (next: () => number) => void
let organize: (req: Request, ctx: any) => Promise<Response>
let status: (req: Request, ctx: any) => Promise<Response>
let config: { anthropicKey: string; organize: { enabled: boolean; embedDaily: number; tagsDaily: number; thresholds: Record<string, number> } }

before(async () => {
  ;(await import("../netlify/shared/apple.mts")).setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  config = (await import("../netlify/shared/config.mts")).config as never
  organize = (await import("../netlify/functions/v2-organize.mts")).default
  setNameOrderForTests = (await import("../netlify/shared/organize.mts")).setNameOrderForTests
  status = (await import("../netlify/functions/v2-status.mts")).default
})

beforeEach(() => {
  counters = new Map()
  events = []
  embeddings = { calls: 0 }
  claude = { calls: 0, bodies: [], text: '{"tags":[{"tag":"work","fits":true,"confidence":0.9},{"tag":"#travel","fits":false,"confidence":0.8},{"tag":"invented","fits":true,"confidence":1}]}' }
  nano = { calls: 0, text: '{"tags":[{"tag":"work","fits":true,"confidence":0.75}]}' }
  config.anthropicKey = "sk-ant-test"
  config.organize.enabled = true
  config.organize.embedDaily = 150
  config.organize.tagsDaily = 300
  ;(config.organize as Record<string, unknown>).nameDaily = 200
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

test("name (2.6): Haiku names the chat in the person's words, checks the current name, and the text never reaches the logs", async () => {
  claude.text = '{"fits":false,"title":"  «Sorting chats by topic.»  "}'
  // 2.6 (94): the new name only when the comparison of both says it's better; the new one first here (A).
  claude.compare = '{"better":"A"}'
  setNameOrderForTests(() => 0.2)
  const chat = "Page: ContextFlow\nQuestion: How do I sort my chats by topic?\nAnswer: Turn on suggestions"
  const { res, body } = await call({ op: "name", chat, current: "what is this?" })
  assert.equal(res.status, 200)
  assert.deepEqual(body, { fits: false, title: "Sorting chats by topic" })
  const [named, compared] = claude.bodies
  assert.equal(named.output_config.format.schema.required.join(), "fits,title")
  assert.match(named.messages[0].content, /<current>\nwhat is this\?\n<\/current>/)
  assert.match(named.system, /language most of the person's own questions/)
  assert.match(compared.messages[0].content, /<names>\nA: Sorting chats by topic\nB: what is this\?\n<\/names>/)
  assert.equal(compared.output_config.format.schema.properties.better.enum.join(), "A,B,same")
  assert.equal(counters.get("organize:name:tx:2000000123"), 1)
  const logged = events.find((e) => e.kind === "organize_api")!.data
  assert.equal(logged.op, "name")
  assert.equal(logged.checked, true)
  assert.equal(logged.compared, "new")
  assert.equal(logged.prompt_tokens, 3200)
  assert.ok(!JSON.stringify(events).includes("sort"))
  // The current name wins or neither is better: it stays. The other order: the current one first (A).
  setNameOrderForTests(() => 0.7)
  claude.compare = '{"better":"A"}'
  assert.deepEqual((await call({ op: "name", chat, current: "Chat sorting" })).body, { fits: true, title: "Sorting chats by topic" })
  assert.match(claude.lastBody?.messages[0].content, /A: Chat sorting\nB: Sorting chats by topic/)
  claude.compare = '{"better":"same"}'
  assert.deepEqual((await call({ op: "name", chat, current: "Chat sorting" })).body, { fits: true, title: "Sorting chats by topic" })
  claude.compare = '{"better":"B"}'
  assert.deepEqual((await call({ op: "name", chat, current: "Chat sorting" })).body, { fits: false, title: "Sorting chats by topic" })
  // The same name in other capitals: it stays, nothing compared.
  const asked = claude.calls
  assert.deepEqual((await call({ op: "name", chat, current: "sorting chats BY TOPIC" })).body, { fits: true, title: "Sorting chats by topic" })
  assert.equal(claude.calls, asked + 1)
  // It fits already: no comparison.
  claude.text = '{"fits":true,"title":"Sorting chats"}'
  const before = claude.calls
  assert.deepEqual((await call({ op: "name", chat, current: "Chat sorting" })).body, { fits: true, title: "Sorting chats" })
  assert.equal(claude.calls, before + 1)
  // A comparison that says nothing: no answer (the quota comes back).
  claude.text = '{"fits":false,"title":"Sorting chats"}'
  claude.compare = '{"better":"maybe"}'
  nano.text = '{"better":"maybe"}'
  assert.equal((await call({ op: "name", chat, current: "Chat sorting" })).res.status, 502)
  setNameOrderForTests(Math.random)
  // No current name: never "fits".
  claude.text = '{"fits":true,"title":"Sorting chats"}'
  assert.deepEqual((await call({ op: "name", chat })).body, { fits: false, title: "Sorting chats" })
  assert.match(claude.lastBody?.messages[0].content, /There is no current name/)
  // Claude down: gpt-5-nano names it.
  claude.status = 529
  nano.text = '{"fits":true,"title":"Sorting chats"}'
  assert.deepEqual((await call({ op: "name", chat, current: "Chats" })).body, { fits: true, title: "Sorting chats" })
  assert.equal(nano.lastBody?.response_format.json_schema.name, "name")
  claude.status = undefined
  // An empty title is no answer.
  claude.text = '{"fits":false,"title":"  "}'
  nano.text = '{"fits":false,"title":""}'
  assert.equal((await call({ op: "name", chat })).res.status, 502)
  assert.equal((await call({ op: "name", chat: "  " })).res.status, 400)
})

test("a request signed with the measuring key counts as a subscriber on a deploy preview, never in production", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  process.env.CF_EVAL_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const asSigned = (deploy: string, key = privateKey) => {
    const at = Date.now()
    const req = request({ op: "embed", texts: ["a"], entitlement: null })
    const signature = sign(null, Buffer.from(`${INSTALL}.${at}`), key).toString("base64url")
    const signed = new Request(req, { headers: { ...Object.fromEntries(req.headers), "x-cf-eval": `${at}.${signature}` } })
    return organize(signed, { ...ctx(), deploy: { context: deploy, id: "d1", published: false } })
  }
  assert.equal((await asSigned("deploy-preview")).status, 200)
  assert.equal(counters.get(`organize:embed:tx:eval-${INSTALL}`), 1)
  assert.equal((await asSigned("production")).status, 403)
  assert.equal((await asSigned("deploy-preview", generateKeyPairSync("ed25519").privateKey)).status, 403)
  delete process.env.CF_EVAL_PUBLIC_KEY
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
