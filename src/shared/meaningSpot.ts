// Search by meaning (2.6 (98), the owner on 98: a result that links to a chat should open it at the message the result
// refers to, highlighted like a pinned answer). The server names the chat and says why it fits, no message; the message
// is found here, on the device, by the words the description and that "why" share with it. The app does the same
// (ContextFlow/Shared (App)/MeaningSpot.swift, checked against this by tests/meaning-spot-parity.test.mts).

import type { Entry } from "./conversation.ts"
import { unaccent } from "./fold.ts"

const WORD = /[\p{L}\p{M}\p{Nd}]+/gu

type Kind = "cjk" | "hangul" | "other"
function kindOf(c: number): Kind {
  if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) return "cjk"
  if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return "hangul"
  return "other"
}

/**
 * A text's words as stems, accents off: a word's first five letters ("caffeine" and "caffeinated" meet), words of three
 * letters or more; Korean, a word's first two syllables (the particles after them go); Chinese and Japanese, with no
 * spaces between words, every two characters in a row.
 */
export function spotStems(text: string): Set<string> {
  const stems = new Set<string>()
  for (const word of unaccent(text).match(WORD) ?? []) {
    const chars = [...word]
    let i = 0
    while (i < chars.length) {
      const kind = kindOf(chars[i].codePointAt(0)!)
      let j = i
      while (j < chars.length && kindOf(chars[j].codePointAt(0)!) === kind) j++
      const run = chars.slice(i, j)
      if (kind === "cjk") for (let k = 0; k + 1 < run.length; k++) stems.add(run[k] + run[k + 1])
      else if (kind === "hangul") { if (run.length >= 2) stems.add(run.slice(0, 2).join("")) }
      else if (run.length >= 3) stems.add(run.slice(0, 5).join(""))
      i = j
    }
  }
  return stems
}

/** What a message says, for finding it: its words, the page a question was asked on, the quote a note was made from. */
export function spotText(entry: Entry): string {
  return [entry.content, entry.role === "user" ? entry.page?.title : undefined, entry.cite].filter(Boolean).join("\n")
}

/** A word of three letters ("the", "and", "day"): it counts, but never picks a message alone. */
function short(stem: string): boolean {
  const chars = [...stem]
  return chars.length === 3 && kindOf(chars[0].codePointAt(0)!) === "other"
}

/**
 * The message a meaning result refers to: the one sharing the most of the description's and the "why"'s words, a word
 * counting more the fewer messages have it. At least one shared word, longer than three letters, must be in no more
 * than half of the messages (not a word every message has); none: undefined, and the chat opens at its end, as before.
 * A tie: the earlier message.
 */
export function meaningSpot(texts: string[], query: string, why: string): number | undefined {
  const asked = spotStems(`${query}\n${why}`)
  if (!asked.size) return undefined
  const stems = texts.map((text) => [...spotStems(text)].filter((s) => asked.has(s)))
  const count = new Map<string, number>()
  for (const list of stems) for (const s of list) count.set(s, (count.get(s) ?? 0) + 1)
  const n = texts.length
  let best: number | undefined
  let bestScore = 0
  stems.forEach((list, i) => {
    let score = 0
    let rare = false
    for (const s of list) {
      const d = count.get(s)!
      score += n - d + 1
      if (d * 2 <= Math.max(n, 2) && !short(s)) rare = true
    }
    if (rare && score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return best
}

/** A chat's message for a meaning result (its index in the chat). */
export function meaningSpotIn(entries: Entry[], query: string, why: string): number | undefined {
  return meaningSpot(entries.map(spotText), query, why)
}
