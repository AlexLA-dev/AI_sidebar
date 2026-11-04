// The transcript of the YouTube video the user is watching, read from what the page itself loads.
//
// YouTube closed its caption files to direct requests (they need a token the player makes), so:
//  1. Captions: the player's own caption request (it carries the token) is visible in the page's
//     resource list; when captions are off, switching them on for a moment makes the player load
//     them. Fetching that address again gives the whole track. Works on youtube.com and m.youtube.com.
//  2. Transcript panel (youtube.com): "Show transcript" under the description, read from the page.
// Either can break when YouTube changes its pages: every step has a deadline, and the answer then
// uses what the page shows (title, description) and says the transcript couldn't be read.

export interface Segment {
  // Start, ms from the beginning of the video.
  start: number
  text: string
}

export type TranscriptRead =
  | { status: "ok"; text: string; duration: number }
  // none: the video has no captions; failed: they couldn't be read (changed page, slow network…).
  | { status: "none" | "failed"; why: string }

/** What the transcript reader needs from the page (a fake one in tests). */
export interface PageEnv {
  doc: Document
  /** Addresses the page has loaded so far. */
  resources(): string[]
  /** Calls back with addresses the page loads from now on; returns a function that stops it. */
  watchResources(onUrl: (url: string) => void): () => void
  fetchText(url: string): Promise<string | null>
  sleep(ms: number): Promise<void>
  now(): number
}

export function browserEnv(): PageEnv {
  return {
    doc: document,
    resources: () => {
      try {
        return performance.getEntriesByType("resource").map((e) => e.name)
      } catch {
        return []
      }
    },
    watchResources: (onUrl) => {
      if (typeof PerformanceObserver === "undefined") return () => undefined
      try {
        const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => onUrl(e.name)))
        observer.observe({ type: "resource" })
        return () => observer.disconnect()
      } catch {
        return () => undefined
      }
    },
    fetchText: async (url) => {
      try {
        const res = await fetch(url, { credentials: "include" })
        return res.ok ? await res.text() : null
      } catch {
        return null
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

// ------------------------------------------------------------------ pure helpers

/** The id of the video a YouTube watch page shows, or null for any other page. */
export function youtubeVideoId(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname) || /^music\./i.test(url.hostname)) return null
  const id = url.pathname === "/watch"
    ? url.searchParams.get("v")
    : url.pathname.match(/^\/(?:live|shorts|embed)\/([^/?#]+)/)?.[1] ?? null
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

/** "4:05", "1:02:03". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

/** "4:05" → ms (NaN when it isn't a time). */
export function parseClock(text: string): number {
  const parts = text.trim().split(":").map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return NaN
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000
}

/** Segments of YouTube's json3 caption format ({events: [{tStartMs, segs: [{utf8}]}]}). */
export function parseJson3(raw: string): Segment[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const events = (data as { events?: unknown })?.events
  if (!Array.isArray(events)) return []
  const segments: Segment[] = []
  for (const event of events as Array<{ tStartMs?: unknown; segs?: Array<{ utf8?: unknown }> }>) {
    if (!Array.isArray(event?.segs)) continue
    const text = event.segs.map((s) => (typeof s?.utf8 === "string" ? s.utf8 : "")).join("").replace(/\s+/g, " ").trim()
    if (text) segments.push({ start: typeof event.tStartMs === "number" ? event.tStartMs : 0, text })
  }
  return segments
}

/** The transcript as paragraphs of about `everyMs`, each starting with its time: "[4:05] …". */
export function formatTranscript(segments: Segment[], everyMs = 30_000): string {
  const paragraphs: string[] = []
  let current: string[] = []
  let from = -Infinity
  for (const seg of segments) {
    if (seg.start >= from + everyMs) {
      if (current.length) paragraphs.push(current.join(" "))
      from = seg.start
      current = [`[${clock(seg.start)}]`]
    }
    current.push(seg.text)
  }
  if (current.length) paragraphs.push(current.join(" "))
  return paragraphs.join("\n")
}

// ------------------------------------------------------------------ reading

const DEFAULT_TIMEOUT_MS = 9_000
// Captions switched on: the player asks for them within a second or two.
const CAPTIONS_WAIT_MS = 4_000

function isTimedText(url: string, videoId: string): boolean {
  try {
    const u = new URL(url)
    return u.pathname.endsWith("/api/timedtext") && u.searchParams.get("v") === videoId
  } catch {
    return false
  }
}

function json3(url: string): string {
  const u = new URL(url)
  u.searchParams.set("fmt", "json3")
  return u.toString()
}

async function waitFor<T>(env: PageEnv, deadline: number, check: () => T | null | undefined, every = 150): Promise<T | null> {
  for (;;) {
    const value = check()
    if (value) return value
    if (env.now() >= deadline) return null
    await env.sleep(Math.min(every, Math.max(0, deadline - env.now())))
  }
}

function pressed(button: Element): boolean {
  return button.getAttribute("aria-pressed") === "true"
}

/** The player's captions button (youtube.com or m.youtube.com), if the page shows one. */
async function captionsButton(env: PageEnv, deadline: number): Promise<HTMLElement | null> {
  const find = () => env.doc.querySelector<HTMLElement>("#movie_player .ytp-subtitles-button, ytm-closed-captioning-button button")
  let button = find()
  if (!button) {
    // m.youtube.com builds the player's buttons once its controls are shown.
    env.doc.querySelector<HTMLElement>("ytm-watch-player-controls button.ytmA11yStylesHiddenButton")?.click()
    button = await waitFor(env, Math.min(deadline, env.now() + 800), find)
  }
  return button
}

function captionsUnavailable(button: HTMLElement): boolean {
  return button.getAttribute("aria-disabled") === "true" || button.hasAttribute("disabled") || button.style.display === "none"
}

/** Strategy 1: the player's own caption request. */
async function fromCaptions(env: PageEnv, videoId: string, deadline: number): Promise<TranscriptRead> {
  const read = async (url: string): Promise<TranscriptRead | null> => {
    const body = await env.fetchText(json3(url))
    const segments = body ? parseJson3(body) : []
    return segments.length ? { status: "ok", text: formatTranscript(segments), duration: segments[segments.length - 1].start } : null
  }

  // Captions already on (or switched on earlier): the request is in the page's list.
  const loaded = env.resources().filter((u) => isTimedText(u, videoId)).pop()
  if (loaded) {
    const result = await read(loaded)
    if (result) return result
  }

  const button = await captionsButton(env, deadline)
  if (!button) return { status: "failed", why: "no captions button" }
  if (captionsUnavailable(button)) return { status: "none", why: "captions unavailable" }

  let seen: string | null = null
  const stop = env.watchResources((url) => {
    if (!seen && isTimedText(url, videoId)) seen = url
  })
  const wasOn = pressed(button)
  try {
    // On → off → on makes the player ask again; off → on asks for the first time.
    if (wasOn) {
      button.click()
      await env.sleep(250)
    }
    button.click()
    seen = await waitFor(env, Math.min(deadline, env.now() + CAPTIONS_WAIT_MS), () => seen ?? env.resources().filter((u) => isTimedText(u, videoId)).pop())
  } finally {
    stop()
    // Leave captions as the user had them.
    if (pressed(button) !== wasOn) button.click()
  }
  if (!seen) return { status: "failed", why: "no caption request" }
  return (await read(seen)) ?? { status: "failed", why: "empty captions" }
}

const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'

/** Strategy 2 (youtube.com): the "Show transcript" panel. */
async function fromPanel(env: PageEnv, deadline: number): Promise<TranscriptRead> {
  const doc = env.doc
  const segments = () => doc.querySelectorAll("ytd-transcript-segment-renderer")
  let opened = false
  if (!segments().length) {
    let open = doc.querySelector<HTMLElement>("ytd-video-description-transcript-section-renderer button")
    if (!open) {
      // The button sits in the description's expanded part.
      doc.querySelector<HTMLElement>("#description-inline-expander #expand, ytd-text-inline-expander #expand")?.click()
      open = await waitFor(env, Math.min(deadline, env.now() + 1_000), () => doc.querySelector<HTMLElement>("ytd-video-description-transcript-section-renderer button"))
    }
    if (!open) return { status: "none", why: "no transcript button" }
    open.click()
    opened = true
  }
  // Wait until segments appear and stop arriving.
  let count = 0
  let steady = 0
  const ready = await waitFor(env, deadline, () => {
    const n = segments().length
    steady = n > 0 && n === count ? steady + 1 : 0
    count = n
    return steady >= 2 ? true : null
  })
  const rows = [...segments()].map((row) => ({
    start: parseClock(row.querySelector(".segment-timestamp")?.textContent ?? ""),
    text: (row.querySelector(".segment-text")?.textContent ?? "").replace(/\s+/g, " ").trim()
  })).filter((s) => s.text)
  if (opened) {
    // Close it again (the user didn't open it).
    doc.querySelector<HTMLElement>(`${PANEL} #visibility-button button`)?.click()
  }
  if (!rows.length) return { status: "failed", why: ready ? "empty transcript" : "transcript timeout" }
  const timed = rows.every((r) => Number.isFinite(r.start))
  const list: Segment[] = rows.map((r, i) => ({ start: timed ? r.start : i * 5_000, text: r.text }))
  return { status: "ok", text: timed ? formatTranscript(list) : list.map((s) => s.text).join(" "), duration: list[list.length - 1].start }
}

/** Reads the transcript of `videoId`, giving up after `timeoutMs`; never throws. */
export async function readTranscript(env: PageEnv, videoId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TranscriptRead> {
  const deadline = env.now() + timeoutMs
  let first: TranscriptRead
  try {
    first = await fromCaptions(env, videoId, deadline)
  } catch (err) {
    first = { status: "failed", why: `captions: ${String(err)}` }
  }
  if (first.status === "ok") return first
  if (env.now() >= deadline) return first.status === "none" ? first : { status: "failed", why: `${first.why}; timeout` }
  let second: TranscriptRead
  try {
    second = await fromPanel(env, deadline)
  } catch (err) {
    second = { status: "failed", why: `panel: ${String(err)}` }
  }
  if (second.status === "ok") return second
  // "No captions" only when both say so; anything else is a failure to read them.
  if (first.status === "none" && second.status === "none") return { status: "none", why: `${first.why}; ${second.why}` }
  return { status: "failed", why: `${first.why}; ${second.why}` }
}

// The same video is read once per page visit; failures are retried after a minute.
const cache = new Map<string, { at: number; result: Promise<TranscriptRead> }>()

export function cachedTranscript(videoId: string, read: () => Promise<TranscriptRead>): Promise<TranscriptRead> {
  const hit = cache.get(videoId)
  if (hit) return hit.result
  const result = read()
  const entry = { at: Date.now(), result }
  cache.set(videoId, entry)
  void result.then((r) => {
    if (r.status !== "ok") setTimeout(() => cache.get(videoId) === entry && cache.delete(videoId), 60_000)
  })
  return result
}

/** True when the transcript of `videoId` is already read (no wait to show). */
export function hasTranscript(videoId: string): boolean {
  return cache.has(videoId)
}
