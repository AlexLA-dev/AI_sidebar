// The cookie closer's choice among a banner's buttons (2.7.1): the privacy-minded one, «Reject all» or «Only
// necessary», and never «Accept». A banner that offers only «Accept» (and maybe its settings) is left to the person:
// nothing pressed, nothing hidden. Pure, so the tests load it as is.

import { normalize } from "../agent/match.ts"
import { ACCEPT_LABELS, CONSENT_WORD, COOKIE_WORD, REJECT_LABELS, SETTINGS_LABELS } from "./words.ts"

export type LabelKind = "reject" | "accept" | "settings"

// Chinese, Japanese, Korean: no spaces between words, an entry matches anywhere in the label.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

// Longer than this, it's a sentence of the banner, not a button's label.
export const MAX_LABEL = 60

interface Entry {
  text: string
  test: (label: string) => boolean
}

function compile(raw: string): Entry {
  const exact = raw.startsWith("=")
  const text = normalize(raw.replace(/^=/, ""))
  if (exact) return { text, test: (label) => label === text }
  if (CJK.test(text)) return { text, test: (label) => label.includes(text) }
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+")
  const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, "u")
  return { text, test: (label) => re.test(label) }
}

const LISTS: Array<[LabelKind, Entry[]]> = [
  ["reject", [...new Set(REJECT_LABELS)].map(compile)],
  ["accept", [...new Set(ACCEPT_LABELS)].map(compile)],
  ["settings", [...new Set(SETTINGS_LABELS)].map(compile)]
]

/** The longest entry of each list that's in the label (0: none). */
function lengths(label: string): Record<LabelKind, number> {
  const out: Record<LabelKind, number> = { reject: 0, accept: 0, settings: 0 }
  for (const [kind, entries] of LISTS) {
    for (const e of entries) if (e.text.length > out[kind] && e.test(label)) out[kind] = e.text.length
  }
  return out
}

/**
 * What a button of a cookie banner says: reject (the privacy-minded answer), accept, or the way to its settings.
 * Reject wins over the words it holds («Accept only necessary», «Continue without accepting», «Do not accept»).
 */
export function labelKind(label: string): LabelKind | null {
  const text = normalize(label)
  if (!text || text.length > MAX_LABEL) return null
  const len = lengths(text)
  // «Manage or reject cookies» opens the settings: it rejects nothing by itself.
  if (len.reject && len.settings) return "settings"
  if (len.reject) return "reject"
  if (len.accept && len.accept >= len.settings) return "accept"
  if (len.settings) return "settings"
  return null
}

/** How sure a reject label is: the whole label one of ours beats one that holds it among other words. */
function rejectScore(label: string): number {
  const text = normalize(label)
  const len = lengths(text).reject
  return (len === text.length ? 1000 : 0) + len
}

export type Choice =
  | { press: number; label: string }
  // only_accept: «Accept» (and maybe settings) and nothing else — the person's own choice; none: no button we know.
  | { leave: "only_accept" | "none" }

/** The button to press among a banner's labels, or why none is pressed. */
export function chooseButton(labels: readonly string[]): Choice {
  let best = -1
  let bestScore = -1
  let accept = false
  labels.forEach((label, i) => {
    const kind = labelKind(label)
    if (kind === "reject") {
      const score = rejectScore(label)
      if (score > bestScore) {
        best = i
        bestScore = score
      }
    } else if (kind === "accept") accept = true
  })
  if (best >= 0) return { press: best, label: labels[best] }
  return { leave: accept ? "only_accept" : "none" }
}

/** A banner's text is about cookies (or, with a consent platform's sign on the page, about consent to data use). */
export function aboutCookies(text: string, platformSign = false): boolean {
  if (!text) return false
  const head = text.slice(0, 3000)
  return COOKIE_WORD.test(head) || (platformSign && CONSENT_WORD.test(head))
}
