// Read aloud (2.6, Ultra) in the background worker: asks /api/v2/speak part by part and passes the audio to the panel
// (port "speak") as it comes. Each finished part is kept on this device (IndexedDB), so playing it again costs
// nothing. Only one part is fetched ahead of what's playing: stopping early doesn't spend the week's minutes on
// parts nobody hears.

import { API_BASE } from "../shared/config"
import type { Usage } from "../shared/types"

export interface SpeakDeps {
  installId: () => Promise<string>
  client: () => Promise<Record<string, unknown>>
  // Apple's signed transaction (null: none).
  jws: () => Promise<string | null>
}

/** Panel → background. */
export type SpeakIn =
  | { type: "play"; parts: string[]; lang: string; what: "answer" | "page" }
  // The panel started playing `part`: the next one may be fetched.
  | { type: "playing"; part: number }
  | { type: "stop" }

/** Background → panel. */
export type SpeakOut =
  | { type: "chunk"; part: number; data: string }
  | { type: "partEnd"; part: number; cached: boolean }
  | { type: "usage"; usage: Usage | null }
  | { type: "end" }
  | { type: "error"; code: "ULTRA_ONLY" | "LIMIT_REACHED" | "BUSY" | "NETWORK" | "UPSTREAM" | "OFF"; part: number; usage?: Usage | null }

const DB = "cf-speech"
const STORE = "parts"
// What the device keeps: about 25 minutes of audio (24 kHz, 16-bit), the oldest go first.
const CACHE_BYTES = 75 * 1024 * 1024
const CHUNK = 48_000

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "key" })
      store.createIndex("at", "at")
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function speechKey(text: string, lang: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`v1|${lang}|${text}`))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function cached(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result.pcm as ArrayBuffer) : null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function keep(key: string, pcm: Uint8Array): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    store.put({ key, pcm: pcm.slice().buffer, bytes: pcm.length, at: Date.now() })
    // Over the cap: the oldest parts go.
    let total = 0
    store.index("at").openCursor(null, "prev").onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
      if (!cursor) return
      const row = cursor.value as { key: string; bytes: number }
      total += row.bytes
      if (total > CACHE_BYTES) store.delete(row.key)
      cursor.continue()
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // No room or no IndexedDB: it plays, it just isn't kept.
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Serves one panel's read-aloud port. */
export function serveSpeak(port: chrome.runtime.Port, deps: SpeakDeps): void {
  let parts: string[] = []
  let lang = ""
  let what: "answer" | "page" = "answer"
  let next = 0
  let playing = -1
  let busy = false
  let stopped = false
  let controller: AbortController | null = null
  const post = (message: SpeakOut) => {
    try {
      port.postMessage(message)
    } catch {
      stopped = true
    }
  }

  const pump = async () => {
    // One part ahead of the one playing.
    while (!stopped && !busy && next < parts.length && next <= playing + 1) {
      busy = true
      const part = next++
      const ok = await fetchPart(part)
      busy = false
      if (!ok) return
    }
    if (!stopped && next >= parts.length && !busy) post({ type: "end" })
  }

  const fetchPart = async (part: number): Promise<boolean> => {
    const text = parts[part]
    const key = await speechKey(text, lang)
    const hit = await cached(key)
    if (hit) {
      for (let i = 0; i < hit.length; i += CHUNK) post({ type: "chunk", part, data: base64(hit.subarray(i, i + CHUNK)) })
      post({ type: "partEnd", part, cached: true })
      return true
    }
    controller = new AbortController()
    let res: Response
    try {
      const [installId, client, jws] = await Promise.all([deps.installId(), deps.client(), deps.jws()])
      res = await fetch(`${API_BASE}/api/v2/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installId, client, entitlement: jws, text, lang, what, part, parts: parts.length }),
        signal: controller.signal
      })
    } catch {
      if (!stopped) post({ type: "error", code: "NETWORK", part })
      return false
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; usage?: Usage | null }
      const code = (["ULTRA_ONLY", "LIMIT_REACHED", "BUSY", "OFF"] as const).find((c) => c === body.code) ?? "UPSTREAM"
      post({ type: "error", code, part, usage: body.usage ?? null })
      return false
    }
    try {
      const usage = JSON.parse(res.headers.get("X-CF-Usage") ?? "null") as Usage | null
      if (usage) post({ type: "usage", usage })
    } catch {
      // No usage header: nothing to show.
    }
    const reader = res.body.getReader()
    const pieces: Uint8Array[] = []
    let size = 0
    let pending = new Uint8Array(0)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        pieces.push(value)
        size += value.length
        // Whole samples, in pieces big enough not to flood the port.
        const joined = new Uint8Array(pending.length + value.length)
        joined.set(pending)
        joined.set(value, pending.length)
        const whole = joined.length - (joined.length % 2)
        if (whole >= 4800) {
          post({ type: "chunk", part, data: base64(joined.subarray(0, whole)) })
          pending = joined.slice(whole)
        } else pending = joined
      }
    } catch {
      if (!stopped) post({ type: "error", code: "NETWORK", part })
      return false
    }
    if (pending.length >= 2) post({ type: "chunk", part, data: base64(pending.subarray(0, pending.length - (pending.length % 2))) })
    post({ type: "partEnd", part, cached: false })
    const all = new Uint8Array(size)
    let at = 0
    for (const piece of pieces) {
      all.set(piece, at)
      at += piece.length
    }
    void keep(key, all)
    return true
  }

  port.onMessage.addListener((raw: unknown) => {
    const message = raw as SpeakIn
    if (message.type === "play") {
      parts = message.parts.filter((p) => typeof p === "string" && p.trim()).slice(0, 40)
      lang = String(message.lang ?? "").slice(0, 16)
      what = message.what === "page" ? "page" : "answer"
      next = 0
      playing = -1
      stopped = false
      void pump()
    } else if (message.type === "playing") {
      playing = Math.max(playing, message.part)
      void pump()
    } else if (message.type === "stop") {
      stopped = true
      controller?.abort()
    }
  })
  port.onDisconnect.addListener(() => {
    stopped = true
    controller?.abort()
  })
}
