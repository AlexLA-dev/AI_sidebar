// Read aloud (2.6, Ultra) in the background worker: the text written for the ear first (/api/v2/speak-script, when it
// has tables, lists, code… or is a page), cut into parts as it streams, then /api/v2/speak part by part, the audio
// passed to the panel (port "speak") as it comes. What was spoken is kept on this device (IndexedDB) for up to 7 days,
// what was written for the ear as long as the chats; "Delete all chats" clears both. A part is fetched only when the panel
// says what it has in hand is running short (build 92: one whole part ahead was charged even if nobody heard it), so
// stopping early doesn't spend the week's minutes on parts nobody hears.

import { API_BASE } from "../shared/config"
import { DEFAULT_VOICE, needsScript, PartSplitter, scriptChunks, SPEECH_RATE, speechParts, speechText, syncKey } from "../shared/speech"
import type { Usage } from "../shared/types"
import { coveredSeconds, listenPace, listenTotal, mergeRanges, type Ranges, slotMask } from "../shared/coverage"
import { madeTexts, voicedId, type MadeText } from "../shared/voiced"

export interface SpeakDeps {
  installId: () => Promise<string>
  client: () => Promise<Record<string, unknown>>
  // Apple's signed transaction (null: none).
  jws: () => Promise<string | null>
  // The user's iCloud through the app's extension (Safari, 2.6): a part made on another device (AAC, base64), a part
  // made here for the others (PCM), the same for texts written for the ear. Missing: no sync (Chrome).
  // When a text stops: the seconds heard and where its audio came from, in whole seconds (build 92, the minutes audit).
  report?: (counts: { what: "answer" | "page"; heard_s: number; cache_s: number; icloud_s: number; server_s: number; charged_s: number }) => void
  // Texts the server now counts as voiced (build 95): every part counted, heard on any device, in one go or more.
  voiced?: (ids: string[]) => void
  // Build 98 release: texts made in full, not all heard, with the seconds a replay would charge.
  made?: (list: MadeText[]) => void
  sync?: {
    getPart: (key: string, wait: number) => Promise<string | null>
    // `cache`: the part's key on this device (the app's too): the extension keeps a copy in the App Group, so the app on
    // this device plays it without asking iCloud or the server (build 92).
    putPart: (key: string, pcm: Uint8Array, cache?: string) => Promise<void>
    getText: (key: string, wait: number) => Promise<string | null>
    putText: (key: string, text: string) => Promise<void>
  }
}

/** Panel → background. */
export type SpeakIn =
  // text: an answer's Markdown or the page's text, as it is.
  | { type: "play"; text: string; lang: string; what: "answer" | "page" }
  // The panel started playing `part` (kept for older panels: the next part may be fetched).
  | { type: "playing"; part: number }
  // The audio in hand ahead of what's heard is running short: the next part may be fetched (build 92).
  | { type: "more" }
  // heard: seconds of audio heard, for the report of where the minutes went.
  | { type: "stop"; heard?: number }
  // What was heard of each part so far (by the part's index): the week's minutes count it (build 92). Build 98: the
  // stretches played (`r`, in the part's own seconds) and, once the whole part is in, its length (`d`); older panels
  // sent the seconds alone.
  | { type: "heard"; heard: Record<number, number | { r: Ranges; d?: number }> }

/** Background → panel. */
export type SpeakOut =
  | { type: "chunk"; part: number; data: string }
  // A whole part as AAC (from the user's iCloud): the panel decodes it.
  | { type: "aac"; part: number; data: string }
  // The parts as spoken (written for the ear when it was), and whether that's all of them: what the app needs to
  // carry on from the same second (iPhone and iPad, 2.6).
  | { type: "parts"; parts: string[]; complete: boolean }
  | { type: "partEnd"; part: number; cached: boolean }
  // Build 98: the whole text's length as it's known now (the audio made, the rest from its words at this voice's pace).
  | { type: "total"; seconds: number }
  | { type: "usage"; usage: Usage | null }
  | { type: "end" }
  | { type: "error"; code: "ULTRA_ONLY" | "LIMIT_REACHED" | "BUSY" | "NETWORK" | "UPSTREAM" | "OFF"; part: number; usage?: Usage | null }

/** What was heard of a part (build 98): seconds covered, its tenths heard (bits) and its length. */
export interface HeardPart {
  s: number
  c?: number
  d?: number
}

const DB = "cf-speech"
const STORE = "parts"
// What the device keeps: about 25 minutes of audio (24 kHz, 16-bit), the oldest go first, nothing older than 7 days.
const CACHE_BYTES = 75 * 1024 * 1024
const CACHE_MS = 7 * 86_400_000
// The texts written for the ear ("script|…") stay as long as the chats (build 98 release: written again, a text would
// get new parts, and a replay would count as new; "already voiced" holds only while they're the same): the newest
// SCRIPT_MAX, a few kilobytes each, outside the audio's cap.
const SCRIPT_MAX = 2000
const isScript = (key: string) => key.startsWith("script|")
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

// ---- what's heard (build 92, the owner: "30 s heard is 30 s off") ---------------------------------------------------
// Seconds heard per part key (the server's too: sha256 of "v1|<language>|<text>"), kept until the server has counted
// them: they go with the next part asked for, or on their own when a text stops, and again at the next start if they
// didn't. The server counts a part once, up to its length, so sending again never charges twice.
const HEARD = "cf:speakHeard"

async function pendingHeard(): Promise<Record<string, HeardPart>> {
  try {
    const stored = (await chrome.storage.local.get(HEARD))[HEARD] as Record<string, number | HeardPart> | undefined
    if (!stored || typeof stored !== "object") return {}
    // Kept by an earlier build as seconds alone.
    return Object.fromEntries(Object.entries(stored).map(([key, v]) => [key, typeof v === "number" ? { s: v } : v]))
  } catch {
    return {}
  }
}

// Every change to the stored map goes through this one queue (each reads, then writes, the whole map).
let heardLane: Promise<unknown> = Promise.resolve()
function changeHeard(change: (map: Record<string, HeardPart>) => boolean): Promise<void> {
  const run = heardLane.then(async () => {
    const map = await pendingHeard()
    if (!change(map)) return
    try {
      await chrome.storage.local.set({ [HEARD]: map })
    } catch {
      // No storage (a test).
    }
  })
  heardLane = run.catch(() => undefined)
  return run
}

const noteHeard = (key: string, heard: HeardPart) =>
  changeHeard((map) => {
    const was = map[key]
    const s = Math.max(was?.s ?? 0, Math.round(heard.s * 10) / 10)
    const c = (was?.c ?? 0) | (heard.c ?? 0)
    const d = heard.d ?? was?.d
    if (was && s === was.s && c === (was.c ?? 0) && d === was.d) return false
    map[key] = { s, ...(c ? { c } : {}), ...(d ? { d } : {}) }
    return true
  })

/** Takes out what the server has counted (only where nothing more was heard meanwhile). */
const heardCounted = (sent: Record<string, HeardPart>) =>
  changeHeard((map) => {
    for (const [key, done] of Object.entries(sent)) {
      const now = map[key]
      if (now && now.s <= done.s && ((now.c ?? 0) & ~(done.c ?? 0)) === 0) delete map[key]
    }
    return true
  })

/** The map once the writes queued before have landed. */
const heardNow = () => heardLane.then(pendingHeard)

const heardItems = (map: Record<string, HeardPart>) => Object.entries(map).slice(0, 80).map(([key, part]) => ({ key, ...part }))

// The voice's pace this device saw last, per language (build 98): the next text's length at its start comes from it.
const PACE = "cf:listenPace"

async function rememberedPace(lang: string): Promise<number> {
  try {
    const map = (await chrome.storage.local.get(PACE))[PACE] as Record<string, number> | undefined
    return typeof map?.[lang] === "number" ? map[lang] : 1
  } catch {
    return 1
  }
}

async function rememberPace(lang: string, pace: number): Promise<void> {
  try {
    const map = ((await chrome.storage.local.get(PACE))[PACE] as Record<string, number> | undefined) ?? {}
    map[lang] = Math.round(pace * 100) / 100
    await chrome.storage.local.set({ [PACE]: map })
  } catch {
    // Not kept: the next text starts from the words alone.
  }
}

// What this device heard of each part over its listens (build 98): the stretches, joined, kept as long as the parts'
// audio (7 days), so pieces heard on different listens here add up exactly before they go to the server.
const COVER = "cf:speakCover"
const COVER_MAX = 400
type Cover = Record<string, { r: Ranges; d?: number; at: number }>
let coverLane: Promise<unknown> = Promise.resolve()

/** The part's stretches heard here with these too: what goes to the server (seconds covered, tenths, length). */
function heardWith(key: string, ranges: Ranges, length?: number): Promise<HeardPart> {
  const run = coverLane.then(async () => {
    let map: Cover = {}
    try {
      map = ((await chrome.storage.local.get(COVER))[COVER] as Cover | undefined) ?? {}
    } catch {
      // No storage (a test): this listen alone.
    }
    const now = Date.now()
    const was = map[key] && now - map[key].at < CACHE_MS ? map[key] : null
    const r = mergeRanges(was?.r ?? [], ranges)
    const d = length ?? was?.d
    map[key] = { r, ...(d ? { d } : {}), at: now }
    const keys = Object.keys(map)
    if (keys.length > COVER_MAX) for (const old of keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - COVER_MAX)) delete map[old]
    try {
      await chrome.storage.local.set({ [COVER]: map })
    } catch {
      // Not kept: counted all the same.
    }
    return { s: coveredSeconds(r), ...(d ? { c: slotMask(r, d), d: Math.round(d * 10) / 10 } : {}) }
  })
  coverLane = run.catch(() => undefined)
  return run
}

// The texts heard from since the last report, with all their parts' keys (build 95): the server says which of them are
// voiced now, counting every listen, on every device. Kept in memory only: a chat shown asks again anyway.
const heardTexts = new Map<string, string[]>()

/** Sends what's waiting to /api/v2/speak-heard; the week's minutes as the server now counts them, or null. */
async function sendHeard(deps: SpeakDeps): Promise<Usage | null> {
  const map = await heardNow()
  const texts = [...heardTexts].slice(0, 20)
  if (!Object.keys(map).length && !texts.length) return null
  try {
    const [installId, client, jws] = await Promise.all([deps.installId(), deps.client(), deps.jws()])
    const res = await fetch(`${API_BASE}/api/v2/speak-heard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId, client, entitlement: jws, items: heardItems(map), texts: texts.map(([id, keys]) => ({ id, keys })) })
    })
    if (!res.ok) return null
    await heardCounted(map)
    for (const [id] of texts) heardTexts.delete(id)
    const body = (await res.json().catch(() => null)) as { usage?: Usage | null; voiced?: unknown; made?: unknown } | null
    const voiced = Array.isArray(body?.voiced) ? body.voiced.filter((id): id is string => typeof id === "string") : []
    if (voiced.length) deps.voiced?.(voiced)
    const made = madeTexts(body?.made)
    if (made.length) deps.made?.(made)
    return body?.usage ?? null
  } catch {
    return null
  }
}

/** Something a voice can say (a part without is skipped: never made, never heard). */
const speakable = (part: string) => /[\p{L}\p{N}]/u.test(part)

/**
 * The keys of a text's parts as Listen makes them (build 95), for asking the server whether it's voiced: the same
 * parts as playing it would give. A text written for the ear has them only when its writing is kept on this device;
 * otherwise none (the server answers by the text's id alone).
 */
export async function textPartKeys(text: string, what: "answer" | "page", lang: string): Promise<string[]> {
  const source = String(text ?? "").slice(0, 24_000)
  let parts: string[] = []
  if (what === "page" || needsScript(source)) {
    for (const chunk of scriptChunks(source)) {
      const kept = await cached(`script|${what}|${await speechKey(chunk, lang)}`)
      if (!kept) return []
      const splitter = new PartSplitter(parts.length === 0)
      parts.push(...splitter.push(new TextDecoder().decode(kept)), ...splitter.end())
    }
  } else {
    parts = speechParts(speechText(source)).slice(0, 80)
  }
  return Promise.all(parts.filter(speakable).map((part) => speechKey(part, lang)))
}

/** The text's id for "already voiced" (src/shared/voiced.ts), as the panel works it out. */
export const textVoicedId = (what: "answer" | "page", text: string) => voicedId(what, text)

async function speechKey(text: string, lang: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`v1|${lang}|${text}`))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** A kept part's audio (7 days), or a kept text for listening (as long as the chats); null when there's none. */
async function cached(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result && (isScript(key) || Date.now() - (req.result.at as number) < CACHE_MS) ? new Uint8Array(req.result.pcm as ArrayBuffer) : null)
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
    // Audio over the cap or older than 7 days: gone, the oldest first. Texts written for the ear: past the newest
    // SCRIPT_MAX.
    let total = 0
    let scripts = 0
    const now = Date.now()
    store.index("at").openCursor(null, "prev").onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
      if (!cursor) return
      const row = cursor.value as { key: string; bytes: number; at: number }
      if (isScript(row.key)) {
        if (++scripts > SCRIPT_MAX) store.delete(row.key)
      } else {
        total += row.bytes
        if (total > CACHE_BYTES || now - row.at > CACHE_MS) store.delete(row.key)
      }
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

/** "Delete all chats": what was spoken goes too (and what was heard of it, build 98). */
export async function clearSpeech(): Promise<void> {
  try {
    await chrome.storage.local.remove(COVER)
  } catch {
    // No storage (a test).
  }
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

export function base64(bytes: Uint8Array): string {
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
  // The highest part the panel has asked for (build 92: on "more", not as soon as the one before starts).
  let allowed = 0
  // Where this text's audio came from, in seconds of audio, and what the server charged up front.
  const counts = { cache: 0, icloud: 0, server: 0, charged: 0 }
  let reported = false
  const report = (heard: number | null) => {
    if (reported || !deps.report) return
    reported = true
    const n = (v: number) => Math.min(9999, Math.round(v))
    deps.report({ what, heard_s: n(heard ?? 0), cache_s: n(counts.cache), icloud_s: n(counts.icloud), server_s: n(counts.server), charged_s: n(counts.charged) })
  }
  let busy = false
  let stopped = false
  // The parts are all known (the text for listening is written, or wasn't needed).
  let written = false
  // The text's id for "already voiced" (build 95).
  let textId = ""
  let controller: AbortController | null = null
  const scriptAbort = new AbortController()
  // The model the text's first part came from: every later part asks for it (one voice per text, build 91).
  let textModel = ""
  // The server's voice (X-CF-Voice): part of a part's key in the user's iCloud.
  let voice = DEFAULT_VOICE
  // Build 98, the text's length shown from the start: each whole part's seconds of audio, and the source text written
  // for the ear so far and still to be (empty for a text spoken as it is).
  let audio: Array<number | undefined> = []
  let sourceWritten = ""
  let sourceLeft = ""
  let lastTotal = -1
  let pace = 1
  let paceKept = 0
  const tellTotal = () => {
    const seconds = listenTotal({ parts, audio, unwritten: written ? "" : sourceLeft, written: sourceWritten, pace })
    // The pace this text has had, for the next one in this language.
    const seen = listenPace(parts, audio)
    if (seen !== null && Math.abs(seen - paceKept) >= 0.02) {
      paceKept = seen
      void rememberPace(lang, seen)
    }
    if (Math.abs(seconds - lastTotal) < 0.5) return
    lastTotal = seconds
    post({ type: "total", seconds })
  }
  const post = (message: SpeakOut) => {
    try {
      port.postMessage(message)
    } catch {
      stopped = true
    }
  }

  const tellParts = () => {
    post({ type: "parts", parts: [...parts], complete: written })
    tellTotal()
  }

  const pump = async () => {
    // Only the parts the panel has asked for (the first at once; each next one when what's in hand runs short).
    while (!stopped && !busy && next < parts.length && next <= allowed) {
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
    const chunks = scriptChunks(text)
    sourceLeft = chunks.join("\n")
    // A chunk counts as written once all of it is (until then its source is still to come, so the length shown is a
    // little long while it's written rather than short at the end).
    const chunkDone = (index: number) => {
      sourceWritten = chunks.slice(0, index + 1).join("\n")
      sourceLeft = chunks.slice(index + 1).join("\n")
      tellTotal()
    }
    for (const [index, chunk] of chunks.entries()) {
      if (stopped) return
      const splitter = new PartSplitter(parts.length === 0)
      const add = (more: string[]) => {
        if (!more.length) return
        parts.push(...more)
        tellParts()
        void pump()
      }
      const key = `script|${what}|${await speechKey(chunk, lang)}`
      const kept = await cached(key)
      if (kept) {
        add(splitter.push(new TextDecoder().decode(kept)))
        add(splitter.end())
        chunkDone(index)
        continue
      }
      // Written on another of the user's devices: the same words, so the same parts and their audio.
      const textKey = await syncKey(`script|${what}`, lang, chunk)
      const synced = await deps.sync?.getText(textKey, parts.length ? 1.5 : 1).catch(() => null)
      if (synced) {
        void keep(key, new TextEncoder().encode(synced))
        add(splitter.push(synced))
        add(splitter.end())
        chunkDone(index)
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
        if (script.trim()) {
          void keep(key, new TextEncoder().encode(script))
          void deps.sync?.putText(textKey, script).catch(() => undefined)
        }
      } catch {
        if (stopped) return
        // No text for listening (Haiku busy, offline): the device's own rules, for what wasn't written yet.
        if (!script) add(speechParts(speechText(chunk)))
        else add(splitter.end())
      }
      chunkDone(index)
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
      counts.cache += hit.length / (SPEECH_RATE * 2)
      for (let i = 0; i < hit.length; i += CHUNK) post({ type: "chunk", part, data: base64(hit.subarray(i, i + CHUNK)) })
      post({ type: "partEnd", part, cached: true })
      audio[part] = hit.length / (SPEECH_RATE * 2)
      tellTotal()
      return true
    }
    // Made on another of the user's devices (kept here as AAC, or in iCloud): played from there, the server not asked.
    const shared = await syncKey(voice, lang, text)
    const kept = await cached(`aac|${key}`)
    const fromCloud = kept ? null : await deps.sync?.getPart(shared, part === 0 ? 1 : 2).catch(() => null)
    if (kept || fromCloud) {
      const data = kept ? base64(kept) : (fromCloud as string)
      // AAC at 64 kbps: its length in seconds from its size (base64 is 4/3 of it).
      const seconds = ((data.length * 3) / 4) * 8 / 64_000
      if (kept) counts.cache += seconds
      else counts.icloud += seconds
      post({ type: "aac", part, data })
      post({ type: "partEnd", part, cached: true })
      audio[part] = seconds
      tellTotal()
      if (!kept) void keep(`aac|${key}`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
      return true
    }
    if (stopped) return false
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
        counts.server += outcome.all.length / (SPEECH_RATE * 2)
        audio[part] = outcome.all.length / (SPEECH_RATE * 2)
        tellTotal()
        void keep(key, outcome.all)
        // For the user's other devices (iCloud through the app): in the background.
        void deps.sync?.putPart(shared, outcome.all, key).catch(() => undefined)
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
    // What's been heard and not counted yet goes with the part (counted before the server decides).
    const heard = await heardNow()
    try {
      const [installId, client, jws] = await Promise.all([deps.installId(), deps.client(), deps.jws()])
      res = await fetch(`${API_BASE}/api/v2/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installId, client, entitlement: jws, text, lang, what, part, parts: parts.length, ...(textModel ? { model: textModel } : {}),
          ...(Object.keys(heard).length ? { heard: heardItems(heard) } : {})
        }),
        signal: controller.signal
      })
    } catch {
      return { ok: false, code: "NETWORK", sent: skip }
    }
    if (res.ok || res.status === 402) void heardCounted(heard)
    if (res.ok && !textModel) textModel = res.headers.get("X-CF-Model") ?? ""
    if (res.ok) counts.charged += Number(res.headers.get("X-CF-Charged") ?? 0) || 0
    if (res.ok) voice = res.headers.get("X-CF-Voice") || voice
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
      // Heard before and not counted (a text stopped offline, the browser closed): sent again now.
      void sendHeard(deps)
      const text = String(message.text ?? "").slice(0, 24_000)
      lang = String(message.lang ?? "").slice(0, 16)
      what = message.what === "page" ? "page" : "answer"
      textId = voicedId(what, text)
      next = 0
      playing = -1
      allowed = 0
      stopped = false
      textModel = ""
      audio = []
      sourceWritten = ""
      sourceLeft = ""
      lastTotal = -1
      pace = 1
      paceKept = 0
      // The pace seen last time in this language: the length at the start follows it (told again when it's read).
      void rememberedPace(lang).then((kept) => {
        pace = kept
        lastTotal = -1
        tellTotal()
      })
      // A page always (captions, credits, its tables), an answer when it has more than plain sentences.
      if (what === "page" || needsScript(text)) {
        parts = []
        written = false
        void write(text).finally(() => {
          written = true
          tellParts()
          void pump()
        })
      } else {
        parts = speechParts(speechText(text)).slice(0, 80)
        written = true
        tellParts()
        void pump()
      }
    } else if (message.type === "playing") {
      playing = Math.max(playing, message.part)
    } else if (message.type === "more") {
      allowed = Math.max(allowed, next)
      void pump()
    } else if (message.type === "heard") {
      const forParts = message.heard && typeof message.heard === "object" ? Object.entries(message.heard) : []
      void Promise.all(forParts.map(async ([index, value]) => {
        const text = parts[Number(index)]
        if (typeof text !== "string") return
        const key = await speechKey(text, lang)
        if (typeof value === "number") {
          if (value > 0) await noteHeard(key, { s: value })
          return
        }
        const ranges = value && typeof value === "object" && Array.isArray(value.r)
          ? value.r.filter((x): x is [number, number] => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number" && x[1] > x[0])
          : []
        if (!ranges.length) return
        const heard = await heardWith(key, ranges, typeof value.d === "number" && value.d > 0 ? value.d : undefined)
        if (heard.s > 0) await noteHeard(key, heard)
      }))
      // Which text these parts are of, once all of its parts are known: the server says whether it's voiced now.
      if (written && textId && forParts.length) {
        const all = parts.slice()
        void Promise.all(all.filter(speakable).map((part) => speechKey(part, lang))).then((keys) => {
          if (keys.length) heardTexts.set(textId, keys)
        })
      }
    } else if (message.type === "stop") {
      stopped = true
      controller?.abort()
      scriptAbort.abort()
      report(typeof message.heard === "number" ? message.heard : null)
      void settleHeard()
    }
  })
  port.onDisconnect.addListener(() => {
    stopped = true
    controller?.abort()
    scriptAbort.abort()
    report(null)
    void settleHeard()
  })
  // When a text stops: what was heard goes to the server now (its "heard" message comes just before), and the minutes
  // shown follow.
  const settleHeard = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const usage = await sendHeard(deps)
    if (usage) post({ type: "usage", usage })
  }
}
