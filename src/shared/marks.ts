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
