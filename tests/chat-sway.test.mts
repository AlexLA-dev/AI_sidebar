// Two chats kept swapping places in the open list, with no one touching it (the owner's recording on 2.5 (77); 2.4.1).
// Safari hands stored values back with their keys in its own order, not the order they were written in. The
// background took its own write, read back that way, for a change made elsewhere and synced again, and again, every
// second or so; each round stored the chats in the other order, and two chats with the same time traded places in
// the list, whose order then came from the keys. Now the list orders chats with the same time by id, and the
// background knows its own write in whatever order Safari returns it: the chats', and the settings it takes from the app.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { chatList, liveThreads, type Thread, type Threads } from "../src/shared/threads.ts"
import { DEFAULT_SETTINGS } from "../src/shared/types.ts"

const T = 1_800_000_000_000
const H = 3_600_000

/** Every object's keys in the reverse order (Safari's order differs from the written one; reversing is the worst case). */
function reordered<V>(value: V): V {
  if (Array.isArray(value)) return value.map(reordered) as V
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)])) as V
}

const chat = (id: string, a: number, extra: Partial<Thread> = {}): Thread => ({
  id, u: a + 5_000, a, m: [{ role: "user", content: `${id}?` }, { role: "assistant", content: `${id}.` }], ...extra
})

// Like the recording: rows 3 and 4 with the same time, 19 hours ago, under two newer chats and above an older one.
const threads: Threads = {
  car: chat("car", T - 3 * H),
  sofa: chat("sofa", T - 3 * H - 600_000),
  "6ae4-test": chat("6ae4-test", T - 19 * H),
  "1f0c-asana": chat("1f0c-asana", T - 19 * H),
  about: chat("about", T - 19.5 * H)
}

test("the list's order doesn't depend on the order the chats come in", () => {
  const ids = (list: Thread[]) => list.map((t) => t.id)
  const first = ids(chatList(threads))
  // The list is worked out again on every change: from the copy as written, then as Safari hands it back.
  for (const copy of [reordered(threads), threads, reordered(threads)]) assert.deepEqual(ids(chatList(copy)), first)
  assert.deepEqual(first, ["car", "sofa", "1f0c-asana", "6ae4-test", "about"], "the same time: by id")
  assert.deepEqual(ids(liveThreads(reordered(threads))), first)
  // Pinned chats with the same pin value (two devices pinned at once) too.
  const pinned = { ...threads, car: { ...threads.car, pin: 0 }, about: { ...threads.about, pin: 0 } }
  assert.deepEqual(ids(chatList(reordered(pinned))), ids(chatList(pinned)))
})

// ------------------------------------------------------------ the background with Safari's storage

let S: any
const store = new Map<string, string>()
const listeners: Array<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void> = []
const calls: string[] = []
// The app's copy of the settings (getSettings).
let appSettings: { settings: Record<string, unknown>; updatedAt: number } = { settings: {}, updatedAt: 0 }
// After the tests the app stops answering: a background still syncing over and over (the old code) stops too.
let closed = false
after(() => {
  closed = true
})

before(async () => {
  const read = (key: string) => (store.has(key) ? reordered(JSON.parse(store.get(key)!)) : undefined)
  ;(globalThis as any).chrome = {
    runtime: { onMessage: { addListener: () => undefined } },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {}
          for (const k of typeof keys === "string" ? [keys] : keys) if (store.has(k)) out[k] = read(k)
          return out
        },
        async set(values: Record<string, unknown>) {
          const changes: Record<string, { newValue?: unknown }> = {}
          for (const [k, v] of Object.entries(values)) {
            const json = JSON.stringify(v)
            if (store.get(k) === json) continue
            store.set(k, json)
            changes[k] = { newValue: read(k) }
          }
          if (Object.keys(changes).length) for (const l of listeners) l(changes, "local")
        }
      },
      onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l), removeListener: () => undefined }
    }
  }
  // The app: iCloud available with nothing new from other devices; its copy of the settings.
  ;(globalThis as any).browser = {
    runtime: {
      async sendNativeMessage(_: string, message: { command: string }) {
        calls.push(message.command)
        await new Promise((r) => setTimeout(r, 2))
        if (closed) return { success: false }
        if (message.command === "syncThreads") return { success: true, data: { available: true, token: "t", changed: [], deleted: [] } }
        if (message.command === "getSettings") return { success: true, data: appSettings }
        return { success: true, data: {} }
      }
    }
  }
  // The background's own timers, a hundred times faster.
  ;(globalThis as any).__fastTimeout = (fn: () => void, ms = 0) => setTimeout(fn, Math.ceil(ms / 100))
  const dir = mkdtempSync(join(tmpdir(), "cf-chat-sway-"))
  const out = join(dir, "sync.mjs")
  await build({
    stdin: { contents: `export { syncSettings, watchSettings, watchThreads } from "./src/background/sync"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", mainFields: ["module", "main"],
    define: {
      setTimeout: "globalThis.__fastTimeout",
      __API_BASE__: JSON.stringify("http://localhost"),
      __TARGET__: JSON.stringify("safari"),
      __VERSION__: JSON.stringify("2.4.1")
    }
  })
  S = await import(pathToFileURL(out).href)
})

const settle = () => new Promise((r) => setTimeout(r, 400))
const count = (command: string) => calls.filter((c) => c === command).length

test("the background syncs once after a change, not on its own write read back in Safari's key order", async () => {
  S.watchThreads()
  calls.length = 0
  // A new answer in one chat: a change iCloud doesn't have.
  await (globalThis as any).chrome.storage.local.set({ "cf:threads": threads, "cf:syncedThreads": { car: T - 3 * H } })
  await settle()
  assert.ok(count("syncThreads") >= 1, "the change goes up")
  calls.length = 0
  await settle()
  // Before: a sync every round, for as long as Safari ran, and the open list redrawn each time.
  assert.equal(count("syncThreads"), 0, "and then nothing more: the background's own write isn't a change")
})

test("settings changed in the app are taken once, not sent straight back to it", async () => {
  // This device's copy, and a newer one from the ContextFlow app (the button moved to the left).
  await (globalThis as any).chrome.storage.local.set({ "cf:settings": DEFAULT_SETTINGS, "cf:settingsUpdatedAt": T })
  appSettings = { settings: { ...DEFAULT_SETTINGS, fabSide: "left" }, updatedAt: T + 10 }
  S.watchSettings()
  calls.length = 0
  await S.syncSettings()
  await settle()
  assert.equal(count("getSettings"), 1, "taken from the app")
  assert.equal(count("setSettings"), 0, "and not sent back to it as a change made here")
})
