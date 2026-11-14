// The page's text as blocks for translating in place (2.7), and the translation written back into the same nodes.
//
// A block is a run of inline content: a paragraph, heading, list item, table cell, caption, or the words between two
// block elements. Inline elements inside it (links, emphasis) become numbered tags; what must stay as it is (an image, a
// line break, code, a button) becomes `<n/>`. The translation is written back word by word into the block's own text
// nodes, and its elements stay the same elements, with the same addresses and listeners: a link only changes its words.
// Elements move only when the translation puts them in another order. Everything changed is recorded, so "Original"
// puts each word and element back.
//
// Never touched: menus, the site's header and footer, inputs, buttons, code, editors, what the page marks as not to be
// translated, and ContextFlow itself (the owner: a long translation breaks buttons).

import { escapeText, parseMarked, TRANSLATE_LIMITS, type Piece } from "../../shared/translate"

/** Inline elements whose words are translated (each a tag pair). */
const INLINE = new Set([
  "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "CITE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "INS", "LABEL",
  "MARK", "NOBR", "Q", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TIME", "U"
])
/** Inline elements kept as they are, in their place among the words (`<n/>`). */
const KEEP = new Set([
  "BR", "WBR", "IMG", "PICTURE", "SVG", "MATH", "CODE", "KBD", "SAMP", "VAR", "TT", "INPUT", "SELECT", "TEXTAREA",
  "BUTTON", "RUBY", "METER", "PROGRESS", "OUTPUT"
])
/** Never shown or never words: left where they are, not sent. */
const QUIET = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"])
/** Block elements left alone with everything inside them. */
const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "SVG", "MATH", "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT",
  "OPTION", "BUTTON", "NAV", "IFRAME", "VIDEO", "AUDIO", "CANVAS", "OBJECT", "EMBED", "MENU"
])
const SKIP_ROLES = new Set(["navigation", "menu", "menubar", "menuitem", "toolbar", "tablist", "tab", "button", "banner", "contentinfo", "search", "switch", "slider", "textbox", "combobox", "listbox", "tree"])

const HOST = "CONTEXTFLOW-ROOT"

/** The page marks it as not to be translated, or it's something the person types in, or it's hidden from everyone. */
function marked(el: Element): boolean {
  const editable = el.getAttribute("contenteditable")
  if (editable !== null && editable !== "false") return true
  if (el.getAttribute("translate") === "no" || el.classList?.contains("notranslate")) return true
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true
  const role = el.getAttribute("role")
  return role !== null && SKIP_ROLES.has(role)
}

/** The site's own header or footer (not an article's, which holds its title or its author). */
function siteChrome(el: Element): boolean {
  if (el.tagName !== "HEADER" && el.tagName !== "FOOTER") return false
  return !el.parentElement?.closest("article,main,[role=main]")
}

/** Left alone with everything inside it. */
export function skipped(el: Element): boolean {
  return SKIP.has(el.tagName) || el.tagName === HOST || marked(el) || siteChrome(el)
}

const inlineMemo = new WeakMap<Element, boolean>()

/** An inline element with only inline content: it belongs to the words around it. */
function inlineTree(el: Element): boolean {
  if (!INLINE.has(el.tagName)) return false
  const known = inlineMemo.get(el)
  if (known !== undefined) return known
  let ok = true
  for (const child of Array.from(el.children)) {
    if (QUIET.has(child.tagName) || KEEP.has(child.tagName) || (INLINE.has(child.tagName) && marked(child))) continue
    if (!inlineTree(child)) {
      ok = false
      break
    }
  }
  inlineMemo.set(el, ok)
  return ok
}

/** Part of a run of words: text, an inline element, or one kept in its place. */
function inRun(node: Node): boolean {
  if (node.nodeType === 3 || node.nodeType === 8) return true
  if (node.nodeType !== 1) return false
  const el = node as Element
  if (el.tagName === HOST) return false
  return QUIET.has(el.tagName) || KEEP.has(el.tagName) || (INLINE.has(el.tagName) && (marked(el) || inlineTree(el)))
}

/** Nothing to translate at a run's end: spaces, comments, scripts, and what's kept as it is (a button, an icon), which
 *  then stays where it is, outside the block. */
const blank = (node: Node) => node.nodeType === 8 || (node.nodeType === 3 && !(node as Text).data.trim()) ||
  (node.nodeType === 1 && (QUIET.has((node as Element).tagName) || KEEP.has((node as Element).tagName) || marked(node as Element)))

/** A block: its element, the run of its child nodes, the elements behind its tags, and its marked text. */
export interface Block {
  parent: Element
  nodes: Node[]
  tags: Map<number, Element>
  paired: Set<number>
  text: string
}

/** Marked text of `nodes` (tags numbered from `next`); fills `tags` and `paired`. */
function mark(nodes: Node[], tags: Map<number, Element>, paired: Set<number>): string {
  let out = ""
  for (const node of nodes) {
    if (node.nodeType === 3) {
      out += escapeText((node as Text).data)
      continue
    }
    if (node.nodeType !== 1) continue
    const el = node as Element
    if (QUIET.has(el.tagName)) continue
    const tag = tags.size + 1
    tags.set(tag, el)
    if (KEEP.has(el.tagName) || marked(el) || !(el.textContent ?? "").trim()) {
      out += `<${tag}/>`
      continue
    }
    paired.add(tag)
    out += `<${tag}>${mark(Array.from(el.childNodes), tags, paired)}</${tag}>`
  }
  return out
}

/** The run without blank nodes at its ends; inside a lone inline element when it holds all the words. */
function narrowed(parent: Element, run: Node[]): { parent: Element; nodes: Node[] } {
  let nodes = run
  let at = parent
  for (;;) {
    let start = 0
    let end = nodes.length
    while (start < end && blank(nodes[start])) start++
    while (end > start && blank(nodes[end - 1])) end--
    nodes = nodes.slice(start, end)
    const only = nodes.length === 1 && nodes[0].nodeType === 1 ? (nodes[0] as Element) : null
    if (!only || !INLINE.has(only.tagName) || marked(only) || !(only.textContent ?? "").trim()) return { parent: at, nodes }
    at = only
    nodes = Array.from(only.childNodes)
  }
}

const LETTERS = /\p{L}/gu

/** Worth translating: words (not a number, a price, an address or a code), not too long, not a wall of links. */
function worth(text: string, tags: number): boolean {
  const plain = text.replace(/<\/?\d+\/?>/g, " ").replace(/\s+/g, " ").trim()
  if (plain.length > TRANSLATE_LIMITS.blockChars || tags > TRANSLATE_LIMITS.blockTags) return false
  if ((plain.match(LETTERS)?.length ?? 0) < 2) return false
  if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return false
  return true
}

/** The blocks under `root`, in page order. */
export function collectBlocks(root: Element): Block[] {
  const out: Block[] = []
  const flush = (parent: Element, run: Node[]) => {
    if (!run.length) return
    const { parent: at, nodes } = narrowed(parent, run)
    if (!nodes.length) return
    const tags = new Map<number, Element>()
    const paired = new Set<number>()
    const text = mark(nodes, tags, paired).replace(/\s+/g, " ").trim()
    if (worth(text, tags.size)) out.push({ parent: at, nodes, tags, paired, text })
  }
  const walk = (el: Element) => {
    let run: Node[] = []
    for (const child of Array.from(el.childNodes)) {
      if (inRun(child)) {
        run.push(child)
        continue
      }
      flush(el, run)
      run = []
      if (child.nodeType === 1 && !skipped(child as Element)) walk(child as Element)
    }
    flush(el, run)
  }
  if (!skipped(root)) walk(root)
  return out
}

/** Where to read again after the site changed `el`: its nearest ancestor that isn't part of a run of words. */
export function scanRoot(el: Element): Element | null {
  let at: Element | null = el
  while (at && at.parentElement && inRun(at)) at = at.parentElement
  return at
}

/** Whether `el` sits inside something translation leaves alone (a menu, the site's header, an editor, ContextFlow). */
export function insideSkipped(el: Element | null): boolean {
  for (let at = el; at; at = at.parentElement) if (skipped(at)) return true
  return false
}

// ------------------------------------------------------------------ writing back

/** What a translation changed in the page, to put back. */
export interface Applied {
  texts: Array<{ node: Text; was: string; now: string }>
  added: Text[]
  // A group whose elements the translation put in another order: its nodes as they were.
  moved: Array<{ parent: Node; order: Node[] }>
}

/** The text node's slot: the tag of the element just before it among its siblings (0: none). */
function slots(nodes: Node[], tagOf: Map<Element, number>): Map<Text, number> {
  const out = new Map<Text, number>()
  let last = 0
  for (const node of nodes) {
    if (node.nodeType === 3) out.set(node as Text, last)
    else if (node.nodeType === 1 && tagOf.has(node as Element)) last = tagOf.get(node as Element)!
  }
  return out
}

/** Puts `want` in this order inside `parent`, moving only what's out of place (other nodes stay where they are). */
function place(parent: Node, want: Node[], head: Node | null, done: Applied | null, nodes: Node[] = []): void {
  const wanted = new Set(want)
  const nextWanted = (from: Node | null): Node | null => {
    let at = from
    while (at && !wanted.has(at)) at = at.nextSibling
    return at
  }
  let inOrder = want.every((n) => n.parentNode === parent)
  if (inOrder) {
    let at = nextWanted(want[0] ?? null)
    for (const node of want) {
      if (at !== node) {
        inOrder = false
        break
      }
      at = nextWanted(node.nextSibling)
    }
  }
  if (inOrder) return
  done?.moved.push({ parent, order: nodes })
  let prev: Node | null = null
  for (const node of want) {
    const target: Node | null = prev ? prev.nextSibling : head && head.parentNode === parent ? head : parent.firstChild
    if (node !== target && !(prev === null && node === nextWanted(target))) parent.insertBefore(node, target)
    prev = node
  }
}

/**
 * Writes `pieces` (a group's translation) over the group's original `nodes` inside `parent`: words into its text nodes
 * (by their place between its elements), its elements in the translation's order.
 */
function write(parent: Node, nodes: Node[], pieces: Piece[], tags: Map<number, Element>, done: Applied): void {
  const tagOf = new Map<Element, number>()
  for (const [tag, el] of tags) tagOf.set(el, tag)
  const slotOf = slots(nodes, tagOf)
  const free = [...slotOf.keys()]
  const want: Node[] = []
  let slot = 0
  const setText = (node: Text, value: string) => {
    if (node.data === value) return
    done.texts.push({ node, was: node.data, now: value })
    node.data = value
  }
  for (const piece of pieces) {
    if (typeof piece === "string") {
      const i = free.findIndex((t) => slotOf.get(t) === slot)
      let node: Text
      if (i >= 0) node = free.splice(i, 1)[0]
      else {
        node = (parent.ownerDocument ?? document).createTextNode("")
        done.added.push(node)
      }
      setText(node, piece)
      want.push(node)
      continue
    }
    const el = tags.get(piece.tag)
    if (!el) continue
    if (!("void" in piece)) write(el, Array.from(el.childNodes), piece.kids, tags, done)
    want.push(el)
    slot = piece.tag
  }
  // Words with no place in the translation: emptied, kept (Original fills them again).
  for (const node of free) setText(node, "")
  place(parent, want, nodes[0] ?? null, done, nodes)
}

/** The original's spaces at the block's ends, around the translation (between blocks of words they matter). */
function edges(block: Block, pieces: Piece[]): Piece[] {
  const first = block.nodes[0]
  const last = block.nodes[block.nodes.length - 1]
  const lead = first?.nodeType === 3 ? /^\s*/.exec((first as Text).data)?.[0] ?? "" : ""
  const trail = last?.nodeType === 3 ? /\s*$/.exec((last as Text).data)?.[0] ?? "" : ""
  const out = [...pieces]
  if (lead) out.unshift(lead)
  if (trail) out.push(trail)
  // Neighbouring words merged: one piece of text per stretch.
  return out.reduce<Piece[]>((acc, p) => {
    const prev = acc[acc.length - 1]
    if (typeof p === "string" && typeof prev === "string") acc[acc.length - 1] = prev + p
    else acc.push(p)
    return acc
  }, [])
}

/**
 * The translation written into the block (its text checked against the block's tags first), or null when it can't be
 * (tags lost or the block's elements gone from the page).
 */
export function applyBlock(block: Block, translation: string): Applied | null {
  const pieces = parseMarked(translation)
  if (!pieces) return null
  if (!block.parent.isConnected || block.nodes.some((n) => n.parentNode !== block.parent)) return null
  const done: Applied = { texts: [], added: [], moved: [] }
  write(block.parent, block.nodes, edges(block, pieces), block.tags, done)
  return done
}

/** Puts back what a translation changed: words the page hasn't changed since, the elements' order, no added nodes. */
export function restore(done: Applied): void {
  for (let i = done.texts.length - 1; i >= 0; i--) {
    const { node, was, now } = done.texts[i]
    if (node.data === now) node.data = was
  }
  for (const node of done.added) node.parentNode?.removeChild(node)
  for (let i = done.moved.length - 1; i >= 0; i--) {
    const { parent, order } = done.moved[i]
    const here = order.filter((n) => n.parentNode === parent)
    place(parent, here, here[0] ?? null, null)
  }
}

/** The block's text nodes and elements are where they were (the site hasn't rebuilt it). */
export function blockIntact(block: Block): boolean {
  return block.parent.isConnected && block.nodes.every((n) => n.parentNode === block.parent)
}

/** Still the words that were sent: intact, and its text unchanged (a live counter, a clock, an edited comment). */
export function blockCurrent(block: Block): boolean {
  if (!blockIntact(block)) return false
  const tags = new Map<number, Element>()
  return mark(block.nodes, tags, new Set()).replace(/\s+/g, " ").trim() === block.text
}
