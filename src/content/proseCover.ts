// 2.6.1: Readability reads a page as one article and keeps its densest block. A "best of" page breaks that: each pick
// is a list item with a paragraph or two of its own, and one long FAQ or intro outscores every pick, so the picks are
// lost (on RTINGS' "best robot vacuums" the panel said the page had no list of the five models). Nothing here knows any
// site: when Readability's text holds too little of the page's prose, the smallest part of the page that holds most of
// that prose is read instead.

/** Never the page's prose: its menus, header, footer, side column, forms and what's hidden from everyone. */
const NOT_PROSE =
  "nav,header,footer,aside,form,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],[aria-hidden=true]"
/** A paragraph or list item this long is prose; shorter ones are labels, buttons and prices. */
const MIN_BLOCK = 80
/** Below this much prose in all, Readability's choice stands (short pages, forms, apps). */
const MIN_PROSE = 1500
/** Readability's text holds at least this share of the prose: it stands. */
const ENOUGH = 0.6
/** The part of the page that's read instead holds at least this share of the prose. */
const MOST = 0.8

const norm = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim()

/** What an element says: its text without the code of scripts and styles inside it (a shop's cart list item). */
function said(el: Element): string {
  const code = el.querySelectorAll("script,style,noscript,template")
  if (!code.length) return norm(el.textContent)
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll("script,style,noscript,template").forEach((c) => c.remove())
  return norm(clone.textContent)
}

interface Block {
  el: Element
  len: number
  /** Its first words, to look for in Readability's text. */
  head: string
}

/** The page's paragraphs and list items of prose (not menus, not mostly links), each counted once. */
export function proseBlocks(root: ParentNode, skip = ""): Block[] {
  const not = skip ? `${NOT_PROSE},${skip}` : NOT_PROSE
  const blocks: Block[] = []
  for (const el of Array.from(root.querySelectorAll("p, li"))) {
    // A list item with paragraphs or a list inside: those count, not it.
    if (el.tagName === "LI" && el.querySelector("p, li")) continue
    if (el.closest(not)) continue
    const text = said(el)
    if (text.length < MIN_BLOCK) continue
    let linked = 0
    for (const a of Array.from(el.querySelectorAll("a"))) linked += norm(a.textContent).length
    if (linked > text.length / 2) continue
    blocks.push({ el, len: text.length, head: text.slice(0, 60) })
  }
  return blocks
}

/**
 * The element to read instead of Readability's `article` text, or null when that text holds enough of the page's
 * prose. It's the deepest element that holds most of the prose (the page's body when nothing smaller does).
 */
export function proseCover(doc: Document, article: string, skip = ""): Element | null {
  if (!doc.body) return null
  const blocks = proseBlocks(doc.body, skip)
  const total = blocks.reduce((sum, b) => sum + b.len, 0)
  if (total < MIN_PROSE) return null
  const read = norm(article)
  const kept = blocks.reduce((sum, b) => sum + (read.includes(b.head) ? b.len : 0), 0)
  if (kept >= ENOUGH * total) return null
  const held = new Map<Element, { len: number; depth: number }>()
  for (const b of blocks) {
    const chain: Element[] = []
    for (let el = b.el.parentElement; el; el = el.parentElement) chain.push(el)
    chain.forEach((el, i) => {
      const now = held.get(el)
      held.set(el, { len: (now?.len ?? 0) + b.len, depth: chain.length - i })
    })
  }
  let best: Element | null = null
  let bestDepth = -1
  for (const [el, { len, depth }] of held) {
    if (len >= MOST * total && depth > bestDepth) {
      best = el
      bestDepth = depth
    }
  }
  return best
}
