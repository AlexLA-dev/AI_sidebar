// "Copied": the last few pieces of text copied on pages in Safari (⌘C, "Copy" in the edit menu) and from
// ContextFlow's own answers and notes. Kept on this device only, never sent anywhere, gone after a day.

export interface CopiedItem {
  id: string
  text: string
  // The site it was copied on ("" for ContextFlow's own answers and notes).
  host: string
  at: number
  from: "page" | "contextflow"
}

export const COPIED_SLOTS = 5
export const COPIED_TTL_MS = 24 * 3600_000

// The owner's open decision: Copied is on until the user turns it off (one switch in the list and in Settings).
export const COPIED_DEFAULT_ON = true

/** What's still fresh, newest first. */
export function liveCopied(list: CopiedItem[], now: number): CopiedItem[] {
  return list.filter((c) => now - c.at < COPIED_TTL_MS && c.at <= now + 60_000).sort((a, b) => b.at - a.at)
}

/** A new copy goes on top; the same text copied again moves up instead of taking a second slot. */
export function addCopied(list: CopiedItem[], item: Omit<CopiedItem, "id">, now: number): CopiedItem[] {
  const text = item.text.trim()
  if (!text) return liveCopied(list, now)
  const rest = liveCopied(list, now).filter((c) => c.text.trim() !== text)
  const id = `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  return [{ ...item, text, id }, ...rest].slice(0, COPIED_SLOTS)
}

/** A site in its plain form ("www.Example.com" → "example.com"), as the exclusions keep it. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "")
}

/** The user excluded this site (or a parent domain of it). */
export function siteExcluded(host: string, excluded: string[]): boolean {
  const h = siteKey(host)
  return excluded.some((e) => h === e || h.endsWith(`.${e}`))
}
