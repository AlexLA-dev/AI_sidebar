// Matching labels against the agent's word lists (words.ts). No imports but the lists, so the tests load it as is.

import { WORDS, type WordKind } from "./words.ts"

/** A label as compared: NFKC, lower case, punctuation as spaces, one space between words. */
export function normalize(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2019\u02bc`´]/g, "'")
    .replace(/[^\p{L}\p{N}\p{M}'\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Chinese, Japanese, Korean: no spaces between words, an entry matches anywhere in the label.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

interface Entry {
  kind: WordKind
  text: string
  exact: boolean
  stem: boolean
  test: (label: string) => boolean
}

const STRICTNESS: Record<WordKind, number> = {
  account: 9, pay: 9, auth: 8, consent: 8, rate: 8, post: 8, send: 7, submit: 5, weak: 3, reject: 2, nav: 1
}

function entry(kind: WordKind, raw: string): Entry {
  const exact = raw.startsWith("=")
  const stem = raw.endsWith("*")
  const text = normalize(raw.replace(/^=/, "").replace(/\*$/, ""))
  // Signing in or up and the account's own steps are matched spaced or not (round 142, the director's item 5: a stays site's
  // «회원 가입» missed «회원가입»; «signup», «sign-in», «log in» likewise).
  const loose = kind === "auth" || kind === "account"
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, loose ? "[\\s-]*" : "[\\s-]+")
  const bare = text.replace(/[\s-]+/g, "")
  let test: (label: string) => boolean
  if (exact) test = (label) => label === text
  else if (CJK.test(text)) test = loose ? (label) => label.replace(/[\s-]+/g, "").includes(bare) : (label) => label.includes(text)
  else {
    const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}${stem ? "[\\p{L}\\p{M}]*" : ""}(?![\\p{L}\\p{N}\\p{M}])`, "u")
    test = (label) => re.test(label)
  }
  return { kind, text, exact, stem, test }
}

const ENTRIES: Entry[] = (Object.keys(WORDS) as WordKind[]).flatMap((kind) => WORDS[kind].map((w) => entry(kind, w)))

export interface WordHit {
  kind: WordKind
  word: string
}

/**
 * The kind of a control's label: the longest entry that matches (a tie: the stricter kind). An exact match of the
 * whole label beats any part of it. Null when nothing matches.
 */
export function wordKind(label: string): WordHit | null {
  const text = normalize(label)
  if (!text) return null
  let best: Entry | null = null
  for (const e of ENTRIES) {
    if (!e.test(text)) continue
    if (!best) {
      best = e
      continue
    }
    const score = (x: Entry) => (x.exact ? 1000 : 0) + x.text.length
    if (score(e) > score(best) || (score(e) === score(best) && STRICTNESS[e.kind] > STRICTNESS[best.kind])) best = e
  }
  return best ? { kind: best.kind, word: best.text } : null
}

/** Whether any of the entries is in the text (the same rules as wordKind, for lists other than WORDS). */
export function anyWord(text: string, list: string[]): string | null {
  const label = normalize(text)
  if (!label) return null
  for (const raw of list) {
    const e = entry("nav", raw)
    if (e.test(label)) return e.text
  }
  return null
}

/** anyWord with the list's entries compiled once (for lists matched against every field of a page). */
export function wordList(list: string[]): (text: string) => string | null {
  const entries = list.map((raw) => entry("nav", raw))
  return (text: string) => {
    const label = normalize(text)
    if (!label) return null
    for (const e of entries) if (e.test(label)) return e.text
    return null
  }
}

/** A tester for a word list, its entries made once (for lists read over many labels: the map's items). */
export function wordTest(list: string[]): (text: string) => boolean {
  const entries = list.map((raw) => entry("nav", raw))
  return (text: string) => {
    const label = normalize(text)
    return !!label && entries.some((e) => e.test(label))
  }
}
