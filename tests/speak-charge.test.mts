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

// The server: each part's audio is 2 s of PCM (24 kHz, 16-bit), charged up front as its estimate says.
let asked: Array<{ part: number; text: string }> = []
beforeEach(() => {
  asked = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { part: number; text: string }
    asked.push({ part: body.part, text: body.text })
    return new Response(new Uint8Array(96_000), { status: 200, headers: { "X-CF-Charged": "3", "X-CF-Model": "m", "X-CF-Voice": "Kore" } })
  }) as typeof fetch
})

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
  assert.deepEqual(reports[0], { what: "answer", heard_s: 3, cache_s: 0, icloud_s: 0, server_s: 4, charged_s: 6 })
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
