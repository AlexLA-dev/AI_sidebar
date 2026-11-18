// Compose (2.7 (108), the owner: «Compose нужно показывать, когда окно для текста пустое, вместо Rewrite. И при ее
// нажатии нужно текстовое окно для пользователя, где он своими словами ответит, о чем ответить. Чипы стиля ответа при
// этом стоит оставить»): what the card waits for, and where the draft goes in the field. No imports but types: the tests
// load it as it is.

import type { Tone, WriteAction } from "../../shared/writing.ts"

/** What the card waits for before asking: Compose's request, a rewrite's tone (the panel's chip has none); null when it
 * asks right away. */
export function waitsFor(job: { action: WriteAction; tone?: Tone; request?: string }): "ask" | "tones" | null {
  if (job.action === "compose" && job.request === undefined) return "ask"
  if (job.action === "rewrite" && !job.tone) return "tones"
  return null
}

/**
 * Where Compose's draft goes in the field's text: at the caret the field had when Compose was opened, when it's in the
 * part being written (not inside the signature or a quoted mail); else at the top of that part (Gmail's reply box: the
 * first line, its blank line before the signature kept); else at the end.
 */
export function draftSpot(ft: { text: string; skips: Array<{ from: number; to: number }> }, caret: number | null): number {
  const inside = (at: number) => ft.skips.some((sk) => at > sk.from && at < sk.to)
  if (caret !== null && caret >= 0 && caret <= ft.text.length && !inside(caret)) return caret
  const first = [...ft.skips].sort((a, b) => a.from - b.from)[0]
  if (!first) return ft.text.length
  // A quoted mail on top: the part after it.
  return first.from > 0 ? 0 : first.to
}

/** The draft as it goes in at `at`: on a line of its own when there are words right before or after it. */
export function placedDraft(text: string, at: number, next: string): string {
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before.trim() && !/\n\s*$/.test(before) ? "\n" : ""
  const tail = after.trim() && !/^\s*\n/.test(after) ? "\n" : ""
  return `${lead}${next.trim()}${tail}`
}
