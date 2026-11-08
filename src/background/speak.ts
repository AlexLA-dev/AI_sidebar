// Read aloud (2.6, Ultra) in the background worker: the text written for the ear first (/api/v2/speak-script, when it
// has tables, lists, code… or is a page), cut into parts as it streams, then /api/v2/speak part by part, the audio
// passed to the panel (port "speak") as it comes. What was written and spoken is kept on this device (IndexedDB) for
// up to 7 days, so playing it again costs nothing; "Delete all chats" clears it. Only one part is fetched ahead of
// what's playing: stopping early doesn't spend the week's minutes on parts nobody hears.

import { API_BASE } from "../shared/config"
import { needsScript, PartSplitter, scriptChunks, speechParts, speechText } from "../shared/speech"
import type { Usage } from "../shared/types"

export interface SpeakDeps {
  installId: () => Promise<string>
  client: () => Promise<Record<string, unknown>>
  // Apple's signed transaction (null: none).
  jws: () => Promise<string | null>
}

/** Panel → background. */
export type SpeakIn =
  // text: an answer's Markdown or the page's text, as it is.
  | { type: "play"; text: string; lang: string; what: "answer" | "page" }
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
// What the device keeps: about 25 minutes of audio (24 kHz, 16-bit), the oldest go first, nothing older than 7 days.
const CACHE_BYTES = 75 * 1024 * 1024
const CACHE_MS = 7 * 86_400_000
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

/** A kept part's audio, or a kept text for listening; null when there's none (or it's older than 7 days). */
async function cached(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result && Date.now() - (req.result.at as number) < CACHE_MS ? new Uint8Array(req.result.pcm as ArrayBuffer) : null)
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
    // Over the cap or older than 7 days: gone, the oldest first.
    let total = 0
    const now = Date.now()
    store.index("at").openCursor(null, "prev").onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
      if (!cursor) return
      const row = cursor.value as { key: string; bytes: number; at: number }
      total += row.bytes
      if (total > CACHE_BYTES || now - row.at > CACHE_MS) store.delete(row.key)
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

/** "Delete all chats": what was spoken goes too. */
export async function clearSpeech(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).clear()
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Nothing kept.
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
  // The parts are all known (the text for listening is written, or wasn't needed).
  let written = false
  let controller: AbortController | null = null
  const scriptAbort = new AbortController()
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
    if (!stopped && written && next >= parts.length && !busy) post({ type: "end" })
  }

  /** The text for listening, chunk by chunk, its parts handed to the pump as each one is complete. */
  const write = async (text: string) => {
    for (const chunk of scriptChunks(text)) {
      if (stopped) return
      const splitter = new PartSplitter(parts.length === 0)
      const add = (more: string[]) => {
        if (!more.length) return
        parts.push(...more)
        void pump()
      }
      const key = `script|${what}|${await speechKey(chunk, lang)}`
      const kept = await cached(key)
      if (kept) {
        add(splitter.push(new TextDecoder().decode(kept)))
        add(splitter.end())
        continue
      }
      let script = ""
      try {
        const [installId, client, jws] = await Promise.all([deps.installId(), deps.client(), deps.jws()])
        const res = await fetch(`${API_BASE}/api/v2/speak-script`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installId, client, entitlement: jws, text: chunk, what, lang }),
          signal: scriptAbort.signal
        })
        if (res.status === 403) {
          post({ type: "error", code: "ULTRA_ONLY", part: parts.length })
          stopped = true
          return
        }
        if (!res.ok || !res.body) throw new Error(`script ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const piece = decoder.decode(value, { stream: true })
          script += piece
          add(splitter.push(piece))
        }
        add(splitter.end())
        if (script.trim()) void keep(key, new TextEncoder().encode(script))
      } catch {
        if (stopped) return
        // No text for listening (Haiku busy, offline): the device's own rules, for what wasn't written yet.
        if (!script) add(speechParts(speechText(chunk)))
        else add(splitter.end())
      }
    }
  }

  const fetchPart = async (part: number): Promise<boolean> => {
    const text = parts[part]
    // Nothing a voice can say (a dash, an emoji): skipped.
    if (!/[\p{L}\p{N}]/u.test(text)) {
      post({ type: "partEnd", part, cached: true })
      return true
    }
    const key = await speechKey(text, lang)
    const hit = await cached(key)
    if (hit) {
      for (let i = 0; i < hit.length; i += CHUNK) post({ type: "chunk", part, data: base64(hit.subarray(i, i + CHUNK)) })
      post({ type: "partEnd", part, cached: true })
      return true
    }
    // A passing failure (offline a moment, the voice busy, a download that broke off) is asked for again twice, in the
    // same voice; what the panel already has of this part is skipped in the new audio (build 90: a text never changes
    // voice, and never repeats itself).
    let sent = 0
    let last: { code: "ULTRA_ONLY" | "LIMIT_REACHED" | "BUSY" | "NETWORK" | "UPSTREAM" | "OFF"; usage?: Usage | null } = { code: "NETWORK" }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 1000 : 3000))
        if (stopped) return false
      }
      const outcome = await download(part, text, sent)
      if (outcome.ok) {
        void keep(key, outcome.all)
        return true
      }
      sent = outcome.sent
      last = outcome
      if (stopped) return false
      if (outcome.code !== "NETWORK" && outcome.code !== "UPSTREAM" && outcome.code !== "BUSY") break
    }
    if (!stopped) post({ type: "error", code: last.code, part, usage: last.usage ?? null })
    return false
  }

  type Downloaded =
    | { ok: true; all: Uint8Array }
    | { ok: false; code: "ULTRA_ONLY" | "LIMIT_REACHED" | "BUSY" | "NETWORK" | "UPSTREAM" | "OFF"; usage?: Usage | null; sent: number }

  /** One attempt at a part: its audio to the panel as it comes, the first `skip` bytes left out (sent before). */
  const download = async (part: number, text: string, skip: number): Promise<Downloaded> => {
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
      return { ok: false, code: "NETWORK", sent: skip }
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; usage?: Usage | null }
      const code = (["ULTRA_ONLY", "LIMIT_REACHED", "BUSY", "OFF"] as const).find((c) => c === body.code) ?? "UPSTREAM"
      return { ok: false, code, usage: body.usage ?? null, sent: skip }
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
    let sent = skip
    let pending = new Uint8Array(0)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        pieces.push(value)
        size += value.length
        if (size <= skip) continue
        // What an earlier attempt sent stays out; then whole samples, in pieces big enough not to flood the port.
        const fresh = size - value.length < skip ? value.subarray(skip - (size - value.length)) : value
        const joined = new Uint8Array(pending.length + fresh.length)
        joined.set(pending)
        joined.set(fresh, pending.length)
        const whole = joined.length - (joined.length % 2)
        if (whole >= 4800) {
          post({ type: "chunk", part, data: base64(joined.subarray(0, whole)) })
          sent += whole
          pending = joined.slice(whole)
        } else pending = joined
      }
    } catch {
      return { ok: false, code: "NETWORK", sent }
    }
    if (pending.length >= 2) post({ type: "chunk", part, data: base64(pending.subarray(0, pending.length - (pending.length % 2))) })
    post({ type: "partEnd", part, cached: false })
    const all = new Uint8Array(size)
    let at = 0
    for (const piece of pieces) {
      all.set(piece, at)
      at += piece.length
    }
    return { ok: true, all }
  }

  port.onMessage.addListener((raw: unknown) => {
    const message = raw as SpeakIn
    if (message.type === "play") {
      const text = String(message.text ?? "").slice(0, 24_000)
      lang = String(message.lang ?? "").slice(0, 16)
      what = message.what === "page" ? "page" : "answer"
      next = 0
      playing = -1
      stopped = false
      // A page always (captions, credits, its tables), an answer when it has more than plain sentences.
      if (what === "page" || needsScript(text)) {
        parts = []
        written = false
        void write(text).finally(() => {
          written = true
          void pump()
        })
      } else {
        parts = speechParts(speechText(text)).slice(0, 40)
        written = true
        void pump()
      }
    } else if (message.type === "playing") {
      playing = Math.max(playing, message.part)
      void pump()
    } else if (message.type === "stop") {
      stopped = true
      controller?.abort()
      scriptAbort.abort()
    }
  })
  port.onDisconnect.addListener(() => {
    stopped = true
    controller?.abort()
    scriptAbort.abort()
  })
}
