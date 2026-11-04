// Highlights in an answer (2.5): what the user marked as important for themselves. Kept on the message,
// synced with the chat, sent to the model as <mark>…</mark>, copied as bold and shared as **…**.
// Pure helpers shared by the panel, the background and tests.

/**
 * One highlight: `s`…`e` in the answer's text as shown (the rendered Markdown's text, without the
 * syntax), and that text itself, to find it again if the offsets no longer fit.
 */
export interface Mark {
  s: number
  e: number
  q: string
}

const MAX_MARKS = 40

/** Adds a highlight; overlapping or touching ones merge into one (`text`: the answer's shown text). */
export function addMark(marks: Mark[] | undefined, s: number, e: number, text: string): Mark[] {
  if (!(e > s)) return marks ?? []
  let start = s
  let end = e
  const kept: Mark[] = []
  for (const m of marks ?? []) {
    if (m.e >= start && m.s <= end) {
      start = Math.min(start, m.s)
      end = Math.max(end, m.e)
    } else kept.push(m)
  }
  const merged = { s: start, e: end, q: text.slice(start, end) }
  return [...kept, merged].sort((a, b) => a.s - b.s).slice(0, MAX_MARKS)
}

/**
 * The pieces of the highlights `placed` (placeMarks) in one text node holding the answer's text from `from` to `to`:
 * where each piece starts and ends in the node, and whether its highlight starts (`first`) or ends (`last`) there.
 * A highlight across bold text or a link is several pieces side by side; only its outer ends are rounded, and the
 * pieces don't overlap (2.5 (75): overlapping pieces showed darker yellow stripes where they met).
 */
export function markPieces(placed: Mark[], from: number, to: number): Array<{ i: number; s: number; e: number; first: boolean; last: boolean }> {
  const out: Array<{ i: number; s: number; e: number; first: boolean; last: boolean }> = []
  let cut = 0
  placed.forEach((m, i) => {
    const s = Math.max(m.s, from, from + cut) - from
    const e = Math.min(m.e, to) - from
    if (e <= s) return
    out.push({ i, s, e, first: m.s >= from, last: m.e <= to })
    cut = e
  })
  return out
}

export function removeMark(marks: Mark[] | undefined, index: number): Mark[] {
  return (marks ?? []).filter((_, i) => i !== index)
}

/**
 * The highlights as they fit `text` now: kept where the text still matches, else found again by their
 * text (the nearest occurrence), else dropped.
 */
export function placeMarks(marks: Mark[] | undefined, text: string): Mark[] {
  const out: Mark[] = []
  for (const m of marks ?? []) {
    if (!m.q) continue
    if (text.slice(m.s, m.e) === m.q) {
      out.push(m)
      continue
    }
    let best = -1
    for (let at = text.indexOf(m.q); at >= 0; at = text.indexOf(m.q, at + 1)) {
      if (best < 0 || Math.abs(at - m.s) < Math.abs(best - m.s)) best = at
    }
    if (best >= 0) out.push({ s: best, e: best + m.q.length, q: m.q })
  }
  return out.sort((a, b) => a.s - b.s)
}

/**
 * `text` (an answer as plain text, for sharing) with the highlights wrapped in **…**: apps that read
 * Markdown (Telegram, Discord, Notion, Obsidian) show them in bold. In order; one not found is skipped.
 */
export function starMarks(text: string, marks: Mark[] | undefined): string {
  let out = ""
  let rest = text
  for (const m of [...(marks ?? [])].sort((a, b) => a.s - b.s)) {
    const q = m.q.trim()
    const at = q ? rest.indexOf(q) : -1
    if (at < 0) continue
    out += `${rest.slice(0, at)}**${q}**`
    rest = rest.slice(at + q.length)
  }
  return out + rest
}

// What may stand between two shown characters in the Markdown source: spaces and line breaks, emphasis
// and code marks, a link's brackets and address, a list bullet or number, a heading's #, a quote's >,
// a table's |.
const GAP = String.raw`(?:\s|[*_~\x60|>#]|\[|\]\([^)\s]*\)|(?<=\n\s*)(?:[-+•]|\d+[.)])(?=\s))*?`

function sourcePattern(q: string): RegExp | null {
  const chars = [...q.replace(/\s+/g, " ").trim()]
  if (!chars.length) return null
  const parts = chars.map((c) => (c === " " ? String.raw`\s+` : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  return new RegExp(parts.join(GAP), "g")
}

/**
 * The answer's Markdown with the highlights wrapped in <mark>…</mark>, for the model: each highlight is
 * found in the source by its text (Markdown signs allowed in between), the occurrence nearest to where
 * it is in the shown text. One that can't be found is left out.
 */
export function markedContent(content: string, marks: Mark[] | undefined, shownLength?: number): string {
  if (!marks?.length) return content
  const spots: Array<{ start: number; end: number }> = []
  for (const m of [...marks].sort((a, b) => a.s - b.s)) {
    const pattern = sourcePattern(m.q)
    if (!pattern) continue
    const want = shownLength ? (m.s / shownLength) * content.length : m.s
    let best: { start: number; end: number } | null = null
    for (const hit of content.matchAll(pattern)) {
      const spot = { start: hit.index, end: hit.index + hit[0].length }
      if (spots.some((x) => spot.start < x.end && spot.end > x.start)) continue
      if (!best || Math.abs(spot.start - want) < Math.abs(best.start - want)) best = spot
    }
    if (best) spots.push(best)
  }
  let out = content
  for (const x of spots.sort((a, b) => b.start - a.start)) out = `${out.slice(0, x.start)}<mark>${out.slice(x.start, x.end)}</mark>${out.slice(x.end)}`
  return out
}

/** The highlights' texts for a chat digest ("Ask your chats"): «…» · «…», at most `max` characters. */
export function marksLine(marks: Mark[] | undefined, max = 300): string {
  const quotes = (marks ?? []).map((m) => `«${m.q.replace(/\s+/g, " ").trim()}»`).filter((q) => q.length > 2)
  const line = quotes.join(" · ")
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
