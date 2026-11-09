// Build 92, the owner: "the minutes counter takes much more than it should, and listening again takes minutes again".
// The panel's side of read aloud (src/background/speak.ts serveSpeak) on a stand-in port and server: a part is asked
// of the server only when the panel says what it has is running short; a part found in the user's iCloud is played
// without asking the server; and when a text stops, the seconds heard and where its audio came from are reported.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

import { build } from "esbuild"

type Counts = { what: string; heard_s: number; cache_s: number; icloud_s: number; server_s: number; charged_s: number }
let serveSpeak: (port: unknown, deps: Record<string, unknown>) => void

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-speak-"))
  const out = join(dir, "speak.mjs")
  await build({
    stdin: { contents: `export { serveSpeak } from "./src/background/speak"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { __API_BASE__: "\"https://api.test\"", __VERSION__: "\"2.6\"", __TARGET__: "\"safari\"", "process.env.NODE_ENV": "\"test\"" }
  })
  serveSpeak = (await import(pathToFileURL(out).href)).serveSpeak
})

// The server: each part's audio is 2 s of PCM (24 kHz, 16-bit); /api/v2/speak-heard counts what's heard. The
// extension's storage is a map.
let asked: Array<{ part: number; text: string; heard?: Array<{ key: string; s: number }> }> = []
let heardSent: Array<Array<{ key: string; s: number }>> = []
let heardFails = false
let store: Record<string, unknown> = {}
beforeEach(() => {
  asked = []
  heardSent = []
  heardFails = false
  store = {}
  ;(globalThis as { chrome?: unknown }).chrome = { storage: { local: {
    get: async (key: string) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(store, structuredClone(items))
  } } }
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { part: number; text: string; items?: Array<{ key: string; s: number }>; heard?: Array<{ key: string; s: number }> }
    if (url.endsWith("/api/v2/speak-heard")) {
      if (heardFails) return new Response("{}", { status: 500 })
      heardSent.push(body.items ?? [])
      return new Response(JSON.stringify({ ok: true, usage: { used: 3, limit: 1800, period: "week", resetsAt: "x" } }), { status: 200 })
    }
    asked.push({ part: body.part, text: body.text, heard: body.heard })
    return new Response(new Uint8Array(96_000), { status: 200, headers: { "X-CF-Charged": "0", "X-CF-Model": "m", "X-CF-Voice": "Kore" } })
  }) as typeof fetch
})
const keyOf = (text: string) => createHash("sha256").update(`v1|en|${text}`).digest("hex")

function port() {
  const out: Array<Record<string, unknown>> = []
  let onMessage: (m: unknown) => void = () => undefined
  let onDisconnect: () => void = () => undefined
  return {
    out,
    send: (m: unknown) => onMessage(m),
    disconnect: () => onDisconnect(),
    port: {
      postMessage: (m: Record<string, unknown>) => out.push(m),
      onMessage: { addListener: (f: (m: unknown) => void) => (onMessage = f) },
      onDisconnect: { addListener: (f: () => void) => (onDisconnect = f) }
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
// Three plain sentences of about 200 characters each: three parts, none written for the ear.
const sentence = (n: number) => `Sentence number ${n} goes on about electric trains and how they return energy to the grid when they brake, which a busy line does many times an hour, every day of the week.`
const TEXT = [sentence(1), sentence(2), sentence(3), sentence(4)].join(" ")

function deps(reports: Counts[], sync?: Record<string, unknown>) {
  return {
    installId: async () => "install-1",
    client: async () => ({ platform: "ios", version: "2.6" }),
    jws: async () => "jws",
    report: (c: Counts) => reports.push(c),
    ...(sync ? { sync } : {})
  }
}

test("a part is asked of the server only when the panel says what it has is running short", async () => {
  const p = port()
  const reports: Counts[] = []
  serveSpeak(p.port, deps(reports))
  p.send({ type: "play", text: TEXT, lang: "en", what: "answer" })
  await settle()
  // The first part at once, nothing ahead of it.
  assert.deepEqual(asked.map((a) => a.part), [0])
  // Playing it doesn't ask for more by itself (build 91 asked for the next one as soon as a part started).
  p.send({ type: "playing", part: 0 })
  await settle()
  assert.deepEqual(asked.map((a) => a.part), [0])
  // Running short: one more.
  p.send({ type: "more" })
  await settle()
  assert.deepEqual(asked.map((a) => a.part), [0, 1])
  // Stopped after 3 s heard: no more parts, and where the minutes went is reported once.
  p.send({ type: "stop", heard: 3.2 })
  p.disconnect()
  await settle()
  assert.deepEqual(asked.map((a) => a.part), [0, 1])
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0], { what: "answer", heard_s: 3, cache_s: 0, icloud_s: 0, server_s: 4, charged_s: 0 })
})

test("parts in the user's iCloud are played without asking the server (nothing charged)", async () => {
  const p = port()
  const reports: Counts[] = []
  // 8 KB of AAC at 64 kbps: one second.
  const aac = Buffer.alloc(8_000).toString("base64")
  const sync = {
    getPart: async () => aac,
    putPart: async () => undefined,
    getText: async () => null,
    putText: async () => undefined
  }
  serveSpeak(p.port, deps(reports, sync))
  p.send({ type: "play", text: TEXT, lang: "en", what: "answer" })
  await settle()
  p.send({ type: "more" })
  await settle()
  assert.equal(asked.length, 0)
  assert.ok(p.out.some((m) => m.type === "aac"))
  p.send({ type: "stop", heard: 1 })
  await settle()
  assert.equal(reports[0].charged_s, 0)
  assert.equal(reports[0].server_s, 0)
  assert.equal(reports[0].icloud_s, 2)
})

test("a page closed mid-text (no stop) still reports, once, and asks for nothing more", async () => {
  const p = port()
  const reports: Counts[] = []
  serveSpeak(p.port, deps(reports))
  p.send({ type: "play", text: TEXT, lang: "en", what: "answer" })
  await settle()
  p.disconnect()
  p.send({ type: "more" })
  await settle()
  assert.deepEqual(asked.map((a) => a.part), [0])
  assert.equal(reports.length, 1)
  assert.equal(reports[0].heard_s, 0)
})

test("what's heard goes to the server by part key: with the next part, and on its own when the text stops", async () => {
  const p = port()
  serveSpeak(p.port, deps([]))
  p.send({ type: "play", text: TEXT, lang: "en", what: "answer" })
  await settle()
  // 1.5 s of the first part heard; the next part asked for carries it.
  p.send({ type: "heard", heard: { 0: 1.5 } })
  await settle()
  p.send({ type: "more" })
  await settle()
  const first = asked.find((a) => a.part === 0)!.text
  assert.deepEqual(asked.find((a) => a.part === 1)?.heard, [{ key: keyOf(first), s: 1.5 }])
  // Then 2 s of the first and 0.7 of the second; stopped: sent on its own.
  p.send({ type: "heard", heard: { 0: 2, 1: 0.7 } })
  p.send({ type: "stop", heard: 2.7 })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const second = asked.find((a) => a.part === 1)!.text
  assert.deepEqual(heardSent.at(-1), [{ key: keyOf(first), s: 2 }, { key: keyOf(second), s: 0.7 }])
  // Counted: nothing left waiting.
  assert.deepEqual(store["cf:speakHeard"], {})
})

test("what's heard and not sent (offline when it stopped) goes again at the next start", async () => {
  heardFails = true
  const p = port()
  serveSpeak(p.port, deps([]))
  p.send({ type: "play", text: TEXT, lang: "en", what: "answer" })
  await settle()
  p.send({ type: "heard", heard: { 0: 2 } })
  p.send({ type: "stop", heard: 2 })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(heardSent.length, 0)
  assert.equal(Object.keys(store["cf:speakHeard"] as object).length, 1)
  // Online again, another text starts: the waiting seconds go first.
  heardFails = false
  const q = port()
  serveSpeak(q.port, deps([]))
  q.send({ type: "play", text: "Another text entirely.", lang: "en", what: "answer" })
  await settle()
  assert.equal(heardSent.length, 1)
  assert.equal(heardSent[0][0].s, 2)
  q.disconnect()
})
