// "Already voiced" by Listen (build 94, the owner: a mark that shows replaying costs no minutes). It goes on a text
// heard to its end, with nothing skipped, in the panel or the app on this device. The panel and the app share the list
// through the App Group. The week's minutes count each part of a text once per subscription, on any device
// (netlify/shared/heard.mts), so hearing it again adds nothing.
//
// A text's id is a 64-bit hash (cyrb53's two lanes, both kept) of "<what>|<its first 24,000 UTF-16 units>". That is
// the text the panel hands to the app. The app computes the same id: Listen.swift Voiced.id.

export const VOICED_MAX = 400
export const VOICED_TEXT_MAX = 24_000

const ids = new Map<string, string>()

/** The id of an answer's Markdown, or of a page's text, as read aloud. */
export function voicedId(what: "answer" | "page", text: string): string {
  const source = `${what}|${String(text ?? "").slice(0, VOICED_TEXT_MAX)}`
  // The panel draws every answer's tools again while an answer streams in: each text is hashed once.
  const known = ids.get(source)
  if (known) return known
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const id = (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")
  if (ids.size >= 600) ids.clear()
  ids.set(source, id)
  return id
}

/** The list with these ids added: id → when, the newest VOICED_MAX kept. */
export function withVoiced(list: Record<string, number>, add: string[], now = Date.now()): Record<string, number> {
  const next: Record<string, number> = { ...list }
  for (const id of add) if (/^[0-9a-f]{16}$/.test(id) && !next[id]) next[id] = now
  const entries = Object.entries(next)
  if (entries.length <= VOICED_MAX) return next
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, VOICED_MAX))
}

// Build 98 release (the owner: «после генерации аудио… сразу ставить такую галочку»): a text whose every part has been
// made for the subscription, but not all heard, is "already voiced" too, as the server counts it. Minutes count what's
// heard, so its mark says what a replay costs: the seconds never heard (`left`). id → { left, at }, newest kept.
export interface MadeText {
  id: string
  left: number
}
export type MadeList = Record<string, { left: number; at: number }>

/** The server's `made` as it came (anything else left out). */
export function madeTexts(raw: unknown): MadeText[] {
  const out: MadeText[] = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 80) : []) {
    const { id, left } = (item ?? {}) as { id?: unknown; left?: unknown }
    if (typeof id === "string" && /^[0-9a-f]{16}$/.test(id) && typeof left === "number" && Number.isFinite(left) && left > 0) {
      out.push({ id, left: Math.min(36_000, Math.ceil(left)) })
    }
  }
  return out
}

/** The list with these made: each one's seconds left as the server says now; the voiced ones out (heard in full). */
export function withMade(list: MadeList, add: MadeText[], voiced: Record<string, number> = {}, now = Date.now()): MadeList {
  const next: MadeList = {}
  for (const [id, row] of Object.entries(list)) if (!voiced[id]) next[id] = row
  for (const { id, left } of add) if (!voiced[id]) next[id] = { left, at: now }
  const entries = Object.entries(next)
  if (entries.length <= VOICED_MAX) return next
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, VOICED_MAX))
}

/** What Listen's mark says for a text: "free" (heard in full), the seconds a replay charges (made), or null (none). */
export function listenMark(id: string, voiced: Record<string, number>, made: MadeList): "free" | number | null {
  if (voiced[id]) return "free"
  const left = made[id]?.left
  return typeof left === "number" && left > 0 ? left : null
}

/** Seconds as the players show them (the app's ListenScrubber.clock too): 0:12, 3:05, 75:03. */
export function markClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
