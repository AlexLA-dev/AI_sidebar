// Organizing in the panel's background (2.6 (92–93)): a better name is a suggestion, kept until taken or turned down,
// never put on by itself; what was worked out goes with the chat (so another device shows it at once and knows what was
// turned down); the chats list counts it, and the tags a chat last showed, without working out candidates again.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import type { Entry } from "../src/shared/conversation.ts"
import { DEFAULT_ORGANIZE, packVector } from "../src/shared/organize.ts"
import type { Thread } from "../src/shared/threads.ts"

const store = new Map<string, string>()
const calls: Array<{ op: string; current?: string }> = []
let nameReply = { fits: false, title: "Цели Plausible" }

// Texts about Plausible point one way, the rest another.
function vectorFor(text: string): number[] {
  const v = Array.from({ length: 64 }, (_, i) => (i === (/Plausible/i.test(text) ? 1 : 2) ? 1 : 0.01))
  return v
}

before(() => {
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {}
          for (const k of typeof keys === "string" ? [keys] : keys) if (store.has(k)) out[k] = JSON.parse(store.get(k)!)
          return out
        },
        async set(values: Record<string, unknown>) {
          for (const [k, v] of Object.entries(values)) store.set(k, JSON.stringify(v))
        }
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined }
    }
  }
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ op: body.op, current: body.current })
    if (body.op === "embed") return Response.json({ space: "test:64", vectors: body.texts.map((t: string) => packVector(vectorFor(t))) })
    if (body.op === "name") return Response.json(nameReply)
    return Response.json({ verdicts: [] })
  }) as typeof fetch
})

const qa = (q: string, a: string, url: string, at: number): Entry[] => [
  { role: "user", content: q, id: `q${at}`, t: at, page: { url, title: "Goals · Plausible docs", at } },
  { role: "assistant", content: a, id: `a${at}`, t: at + 10 }
]
const vague: Thread = { id: "vague", u: 1, m: [...qa("Что это вообще такое?", "Plausible goals docs", "https://plausible.io/docs/goals", 1000), ...qa("А воронку в Plausible можно?", "Plausible funnels: yes", "https://plausible.io/docs/funnels", 2000)] }
const ctx = {
  status: { plan: "ultra", organize: { on: true, space: "test:64", config: DEFAULT_ORGANIZE } },
  installId: "5f0c2a1e-6b7d-4c3e-9a8f-0e1d2c3b4a59", jws: null, client: {}, on: true
} as any

// From the bundle below (typed loosely: the extension's own types need the browser's).
type Reply = { ok: boolean; name?: string; counts: Record<string, number>; org?: unknown }
let organizeChatRaw: (chat: string, ctx: unknown) => Promise<Reply>
let organizeCounts: (ctx: unknown) => Promise<Reply>
let nameThread: (id: string, name: string, asked?: boolean) => Promise<unknown>
let settleNameSuggestion: (id: string, taken: boolean) => Promise<void>
let setOrgState: (id: string, org: unknown) => Promise<void>
// As the panel does: what the background worked out is kept with the chat.
async function organizeChat(chat: string, c: unknown): Promise<Reply> {
  const reply = await organizeChatRaw(chat, c)
  if (reply.ok && reply.org) await setOrgState(chat, reply.org)
  return reply
}

// The background and the panel's store as the extension builds them (their imports have no ".ts").
before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-org-bg-")), "org.mjs")
  await build({
    stdin: { contents: `export { organizeChat, organizeCounts } from "./src/background/organize"; export { nameThread, settleNameSuggestion, setOrgState } from "./src/content/store"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"],
    define: { __API_BASE__: JSON.stringify("http://localhost"), __TARGET__: JSON.stringify("safari"), __VERSION__: JSON.stringify("2.6.0"), __SHADOW_MODE__: JSON.stringify("closed"), __WATCH_EVERY_S__: "900" }
  })
  ;({ organizeChat: organizeChatRaw, organizeCounts, nameThread, settleNameSuggestion, setOrgState } = await import(pathToFileURL(out).href))
})

beforeEach(() => {
  store.clear()
  calls.length = 0
  nameReply = { fits: false, title: "Цели Plausible" }
  store.set("cf:threads", JSON.stringify({ vague }))
})

const threads = () => JSON.parse(store.get("cf:threads")!) as Record<string, Thread>

test("a better name is suggested, not put on; it stays suggested; turned down, it goes", async () => {
  const first = await organizeChat("vague", ctx)
  assert.ok(first.ok)
  assert.equal(first.ok && first.name, "Цели Plausible")
  assert.equal(threads().vague.title, undefined, "never renamed by itself")
  // It's kept with the chat: what the check was about and the name, for every device.
  assert.equal(threads().vague.org?.nm?.t, "Цели Plausible")
  assert.deepEqual(calls.filter((c) => c.op === "name"), [{ op: "name", current: "Что это вообще такое?" }])
  // Opened again: still suggested, nothing asked again.
  const again = await organizeChat("vague", ctx)
  assert.equal(again.ok && again.name, "Цели Plausible")
  assert.equal(calls.filter((c) => c.op === "name").length, 1)
  const counts = await organizeCounts(ctx)
  assert.equal(counts.ok && counts.counts.vague, 1)
  // ✕: gone, not counted, and never suggested again, even when the chat changes and the check suggests it once more.
  await settleNameSuggestion("vague", false)
  assert.deepEqual(threads().vague.org?.nm?.no, ["Цели Plausible"])
  const after = await organizeChat("vague", ctx)
  assert.equal(after.ok && after.name, undefined)
  const none = await organizeCounts(ctx)
  assert.equal(none.ok && none.counts.vague, undefined)
  const grown = { ...threads().vague, m: [...threads().vague.m, ...qa("И цели на клики?", "Plausible goals on clicks: yes", "https://plausible.io/docs/custom-event-goals", 3000)] }
  store.set("cf:threads", JSON.stringify({ vague: grown }))
  const again2 = await organizeChat("vague", ctx)
  assert.equal(calls.filter((c) => c.op === "name").length, 2, "the chat changed: checked again")
  assert.equal(again2.ok && again2.name, undefined, "the same name, turned down before, isn't suggested")
})

test("a chat whose record another device wrote: its name is suggested at once, nothing asked again", async () => {
  const key = (await import("../src/shared/organize.ts")).nameCheckKey(vague)
  store.set("cf:threads", JSON.stringify({ vague: { ...vague, org: { n: vague.m.length, k: "a2000", nm: { k: key, t: "Воронки Plausible" } } } }))
  const reply = await organizeChat("vague", ctx)
  assert.equal(reply.ok && reply.name, "Воронки Plausible")
  assert.equal(calls.filter((c) => c.op === "name").length, 0)
  const counts = await organizeCounts(ctx)
  assert.equal(counts.ok && counts.counts.vague, 1)
})

test("taken, it's the chat's name (the AI's, so it may be checked again); a name the user typed is never touched", async () => {
  await organizeChat("vague", ctx)
  await settleNameSuggestion("vague", true)
  await nameThread("vague", "Цели Plausible")
  assert.deepEqual([threads().vague.title, threads().vague.aiTitle], ["Цели Plausible", "Цели Plausible"])
  nameReply = { fits: true, title: "Цели Plausible" }
  const next = await organizeChat("vague", ctx)
  assert.equal(next.ok && next.name, undefined)
  // Typed by the user: no check, no suggestion, and a suggested name can't go over it.
  store.set("cf:threads", JSON.stringify({ vague: { ...vague, title: "Мои заметки" } }))
  calls.length = 0
  const typed = await organizeChat("vague", ctx)
  assert.equal(typed.ok && typed.name, undefined)
  assert.equal(calls.filter((c) => c.op === "name").length, 0)
  assert.equal(await nameThread("vague", "Другое"), null)
  assert.equal(threads().vague.title, "Мои заметки")
})

test("the list counts the tags a chat last showed while they're open, without working out candidates again", async () => {
  nameReply = { fits: true, title: "x" }
  store.set("cf:threads", JSON.stringify({ vague: { ...vague, org: { n: vague.m.length, k: "a2000", tg: [["a1000", "work"], ["a2000", "read"]] } } }))
  const counts = await organizeCounts(ctx)
  assert.equal(counts.ok && counts.counts.vague, 2)
  // One taken (the message has it now), one turned down: none open.
  const m = vague.m.map((e) => (e.id === "a1000" ? { ...e, tags: ["Work"] } : e.id === "a2000" ? { ...e, dismissed: { tags: ["read"] } } : e))
  store.set("cf:threads", JSON.stringify({ vague: { ...vague, m, org: { n: vague.m.length, k: "a2000", tg: [["a1000", "work"], ["a2000", "read"]] } } }))
  const later = await organizeCounts(ctx)
  assert.equal(later.ok && later.counts.vague, undefined)
  assert.equal(calls.filter((c) => c.op === "tags").length, 0)
})
