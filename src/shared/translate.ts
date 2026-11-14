// Page translation in place (2.7, plan section 11, the owner's decisions of 13–14 November): the page's text is
// translated in its own elements, so links and buttons stay the same elements with the same addresses and listeners.
// What the page and the server share: the marked text of a block, the line format the model reads and writes, the
// limits of a request, and the messages between the page, the background and the server.
//
// A block is a paragraph, heading, list item, table cell or caption. Inline elements inside it (links, emphasis) go
// to the model as numbered tags, `<1>…</1>`, and what must stay as it is (an image, a line break, code) as `<2/>`.
// The translation must keep every tag once, of the same kind, inside the same tag as before; the page then writes the
// words back into the original text nodes and the same elements (src/content/translate/blocks.ts).

/** One piece of a block's marked text: words, an inline element with its own pieces, or one kept as it is. */
export type Piece = string | { tag: number; kids: Piece[] } | { tag: number; void: true }

export const TRANSLATE_LIMITS = {
  // A block longer than this stays as it is (a whole article in one element: no tags could be kept over that much).
  blockChars: 4_000,
  // What one request to /api/v2/translate carries at most; the first one of a page (what's on screen) less, for speed.
  requestChars: 10_000,
  requestBlocks: 60,
  firstChars: 3_500,
  // Tags in one block (a list of 50 links in one paragraph is a menu, not prose).
  blockTags: 40
} as const

const TAG = /<(\/?)(\d{1,3})(\/?)>/g

/** Text as it goes between tags: a literal "<12>" in the page's words can't pass for a tag. */
export function escapeText(text: string): string {
  return text.replace(/<(\/?\d{1,3}\/?)>/g, "‹$1›")
}

/**
 * Marked text → pieces, or null when the tags aren't well formed (a closing tag without its opening one, a tag left
 * open, the same number twice).
 */
export function parseMarked(text: string): Piece[] | null {
  const root: Piece[] = []
  const stack: Array<{ tag: number; kids: Piece[] }> = []
  const seen = new Set<number>()
  const here = () => (stack.length ? stack[stack.length - 1].kids : root)
  let at = 0
  for (const m of text.matchAll(TAG)) {
    const index = m.index ?? 0
    if (index > at) here().push(text.slice(at, index))
    at = index + m[0].length
    const [, close, digits, selfClose] = m
    const tag = Number(digits)
    if (close && selfClose) return null
    if (close) {
      const open = stack.pop()
      if (!open || open.tag !== tag) return null
      continue
    }
    if (seen.has(tag) || tag < 1) return null
    seen.add(tag)
    if (selfClose) {
      here().push({ tag, void: true })
      continue
    }
    const piece = { tag, kids: [] as Piece[] }
    here().push(piece)
    stack.push(piece)
  }
  if (stack.length) return null
  if (at < text.length) here().push(text.slice(at))
  return root
}

/** Marked text without its tags (the words only). */
export function plainText(text: string): string {
  return text.replace(TAG, "")
}

/** Each tag's parent tag (0: the block itself) and kind, for comparing a translation with its source. */
export function outline(pieces: Piece[], parent = 0, into = new Map<number, string>()): Map<number, string> {
  for (const p of pieces) {
    if (typeof p === "string") continue
    into.set(p.tag, `${parent}:${"void" in p ? "v" : "p"}`)
    if (!("void" in p)) outline(p.kids, p.tag, into)
  }
  return into
}

/**
 * Whether `translation` keeps `source`'s tags: each one once, of the same kind, inside the same tag. Their order may
 * change (word order does). A translation that keeps them can be written back into the same elements.
 */
export function sameTags(source: string, translation: string): boolean {
  const a = parseMarked(source)
  const b = parseMarked(translation)
  if (!a || !b) return false
  const x = outline(a)
  const y = outline(b)
  if (x.size !== y.size) return false
  for (const [tag, where] of x) if (y.get(tag) !== where) return false
  return true
}

/**
 * A translation that lost only some `<n/>` (an icon, a line break) gets them back at the end of their parent's words.
 * Anything else lost or moved: null.
 */
export function restoreVoids(source: string, translation: string): string | null {
  if (sameTags(source, translation)) return translation
  const a = parseMarked(source)
  const b = parseMarked(translation)
  if (!a || !b) return null
  const x = outline(a)
  const y = outline(b)
  for (const [tag, where] of y) if (x.get(tag) !== where) return null
  const missing = [...x].filter(([tag]) => !y.has(tag))
  if (!missing.length || missing.some(([, where]) => where.endsWith(":p"))) return null
  // Each lost void at the end of its parent's text.
  let out = translation
  for (const [tag, where] of missing) {
    const parent = Number(where.split(":")[0])
    if (parent === 0) out = `${out}<${tag}/>`
    else {
      const close = `</${parent}>`
      const i = out.indexOf(close)
      if (i < 0) return null
      out = `${out.slice(0, i)}<${tag}/>${out.slice(i)}`
    }
  }
  return sameTags(source, out) ? out : null
}

// ------------------------------------------------------------------ the model's lines

/** One block as the model reads it: "§7 text". Blocks are whitespace-collapsed, so a line never breaks. */
export function modelLine(n: number, text: string): string {
  return `§${n} ${text.replace(/\s+/g, " ").trim()}`
}

/** A line of the model's answer → its number and text, or null when it isn't one. */
export function readModelLine(line: string): { n: number; text: string } | null {
  const m = /^\s*§\s?(\d{1,4})[:.]?\s?(.*)$/.exec(line)
  if (!m) return null
  const text = m[2].trim()
  return text ? { n: Number(m[1]), text } : null
}

// ------------------------------------------------------------------ messages

/** A block sent for translation: its id on this page and its marked text. */
export interface TranslateBlock {
  id: string
  text: string
}

/** The page → the background, on the "translate" port. `url` stays on the device (only a hash of it is sent). */
export interface TranslateAsk {
  type: "translate"
  req: number
  url: string
  to: string
  from: string | null
  blocks: TranslateBlock[]
  first: boolean
}

/** The background → the page, for request `req`. */
export type TranslateReply =
  | { type: "items"; req: number; items: TranslateBlock[] }
  // Blocks that couldn't be translated with their tags kept: they stay as they are.
  | { type: "skip"; req: number; ids: string[] }
  | { type: "done"; req: number; charged: boolean }
  | { type: "error"; req: number; code: TranslateError }

/**
 * LIMIT_REACHED: the free answers of the day (or the week's) are used up, nothing was translated. PAGE_CAP: the page's
 * hidden safety cap, the rest of it stays as it is. CONSENT: the one AI consent isn't given (the page asks it).
 */
export type TranslateError = "LIMIT_REACHED" | "PAGE_CAP" | "BUSY" | "UPSTREAM" | "NETWORK" | "UNAVAILABLE" | "BAD_REQUEST" | "CONSENT"

/** A step of the in-page translation for the feature counters (usage.ts "translate_page"): counts only. */
export interface TranslateStep {
  type: "trEvent"
  a: "shown" | "tap" | "consent" | "done" | "original" | "dismiss" | "limit" | "plans" | "error"
}

/** The language a page is translated into, for the model: a base code, with the script for Chinese. */
export function targetCode(ui: string): string {
  const [base, ...rest] = ui.replace(/_/g, "-").split("-")
  const lang = (base ?? "").toLowerCase()
  if (lang !== "zh") return lang
  const tail = rest.join("-").toLowerCase()
  return /hant|tw|hk|mo/.test(tail) ? "zh-Hant" : "zh-Hans"
}
