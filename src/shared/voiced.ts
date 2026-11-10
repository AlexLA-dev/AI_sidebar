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
