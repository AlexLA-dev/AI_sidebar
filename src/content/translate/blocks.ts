// The page's text as blocks for translating in place (2.7), and the translation written back into the same nodes.
//
// A block is a run of inline content: a paragraph, heading, list item, table cell, caption, or the words between two
// block elements. Inline elements inside it (links, emphasis) become numbered tags; what must stay as it is (an image, a
// line break, code, a button) becomes `<n/>`. The translation is written back word by word into the block's own text
// nodes, and its elements stay the same elements, with the same addresses and listeners: a link only changes its words.
// Elements move only when the translation puts them in another order. Everything changed is recorded, so "Original"
// puts each word and element back.
//
// The page's interface too (2.7, build 107, the owner: «В меню и некоторые кнопки типо «заказать» не все переводится»):
// menus, the site's header and footer, buttons, tabs, labels, and the placeholders of fields and the words on button
// inputs (as attributes). A button stays the same element with its listeners; only its words change.
//
// Never touched: what the person types in (fields, editors), code, icon-font ligatures («shopping_cart»), what the
// page marks as not to be translated, what carries the `hidden` attribute (until the page takes it off), and
// ContextFlow itself.
//
// Tooltips (build 109, the owner: «не переводятся… никакие тултипы (а это было бы очень полезно)»): the words a
// pointer or a screen reader gets from an attribute. A control with no words of its own (an icon button) has its
// label and tooltip translated with the page; any other element's tooltip when the pointer or the focus comes to it
// (tipBlocks), so a page of links with titles doesn't cost twice.
//
// System lists (build 110, the owner: «системный выпадающий список не переводится… это важно»): a <select>'s rows.
// The translation goes into the row's `label` attribute, which is what the list shows (closed and open). The row's
// text and its value stay as the page wrote them: without a value attribute the text is what the form sends and what
// the site's scripts read, so it's never rewritten.

import { escapeText, parseMarked, TRANSLATE_LIMITS, type Piece } from "../../shared/translate"

/** Inline elements whose words are translated (each a tag pair). */
const INLINE = new Set([
  "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "CITE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "INS", "LABEL",
  "MARK", "NOBR", "Q", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TIME", "U"
])
/** Inline elements kept as they are, in their place among the words (`<n/>`). */
const KEEP = new Set([
  "BR", "WBR", "IMG", "PICTURE", "SVG", "MATH", "CODE", "KBD", "SAMP", "VAR", "TT", "INPUT", "SELECT", "TEXTAREA",
  "RUBY", "METER", "PROGRESS", "OUTPUT"
])
/** Never shown or never words: left where they are, not sent. */
const QUIET = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NOFRAMES", "NOEMBED", "TEMPLATE", "LINK", "META"])
/** Block elements left alone with everything inside them. */
const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "NOFRAMES", "NOEMBED", "XMP", "PLAINTEXT", "TEMPLATE", "HEAD", "SVG", "MATH", "CODE", "PRE",
  "TEXTAREA", "INPUT", "SELECT", "OPTION", "IFRAME", "VIDEO", "AUDIO", "CANVAS", "OBJECT", "EMBED"
])
/** A tag's name in capitals: an inline svg's (and what's inside it) is lowercase in an HTML page. */
const tagOf = (el: Element) => el.tagName.toUpperCase()
/** What the person types or picks a value in: its words are the value. */
const SKIP_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"])
/** Icon fonts draw a picture from a word («shopping_cart», «menu»): translated, the picture is gone. Their classes
 *  (a text button's «btn-icon» class isn't one)... */
const ICON_CLASS = /(^|\s)(material-(icons|symbols)[\w-]*|google-symbols|glyphicon|fa[srlbd]?|mdi|ionicon)(\s|$)/i
/** ...or one lowercase word drawn in an icon font. */
const ICON_WORD = /^[a-z][a-z0-9_]{1,39}$/
const ICON_FONT = /icon|symbol|material|glyph/i

function iconFont(el: Element): boolean {
  const cls = el.getAttribute("class")
  if (cls && ICON_CLASS.test(cls)) return true
  if (el.tagName !== "I" && el.tagName !== "SPAN") return false
  if (!ICON_WORD.test((el.textContent ?? "").trim())) return false
  const style = el.ownerDocument.defaultView?.getComputedStyle?.(el)
  return !!style && ICON_FONT.test(style.fontFamily ?? "")
}

const HOST = "CONTEXTFLOW-ROOT"
const LETTERS = /\p{L}/gu

/**
 * Words kept from screen readers that are an icon's, not the page's: one lowercase word («close», «arrow_forward»)
 * with nothing else in the element. Everything else under aria-hidden is read like the rest of the page (build 109,
 * the owner's test of 108: a shop's filter list and a mailbox's dates stayed as they were; both write the words the
 * eye sees in an aria-hidden element, with a longer twin for screen readers beside it).
 */
function hiddenIcon(el: Element): boolean {
  if (el.getAttribute("aria-hidden") !== "true" || el.children.length) return false
  return ICON_WORD.test((el.textContent ?? "").trim())
}

/** The page marks it as not to be translated, or it's something the person types in, or it's hidden from everyone
 *  (the `hidden` attribute: read when the page takes it off). */
function marked(el: Element): boolean {
  const editable = el.getAttribute("contenteditable")
  if (editable !== null && editable !== "false") return true
  if (el.getAttribute("translate") === "no" || el.classList?.contains("notranslate")) return true
  if (el.hasAttribute("hidden") || hiddenIcon(el)) return true
  if (iconFont(el)) return true
  const role = el.getAttribute("role")
  return role !== null && SKIP_ROLES.has(role)
}

/** Left alone with everything inside it. */
export function skipped(el: Element): boolean {
  return SKIP.has(tagOf(el)) || el.tagName === HOST || marked(el)
}

const inlineMemo = new WeakMap<Element, boolean>()

/** An inline element with only inline content: it belongs to the words around it. */
function inlineTree(el: Element): boolean {
  if (!INLINE.has(el.tagName)) return false
  const known = inlineMemo.get(el)
  if (known !== undefined) return known
  let ok = true
  for (const child of Array.from(el.children)) {
    if (QUIET.has(tagOf(child)) || KEEP.has(tagOf(child)) || (INLINE.has(child.tagName) && marked(child))) continue
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
  return QUIET.has(tagOf(el)) || KEEP.has(tagOf(el)) || (INLINE.has(el.tagName) && (marked(el) || inlineTree(el)))
}

/** Nothing to translate at a run's end: spaces, comments, scripts, and what's kept as it is (a button, an icon), which
 *  then stays where it is, outside the block. */
const blank = (node: Node) => node.nodeType === 8 || (node.nodeType === 3 && !(node as Text).data.trim()) ||
  (node.nodeType === 1 && (QUIET.has(tagOf(node as Element)) || KEEP.has(tagOf(node as Element)) || marked(node as Element)))

/** A block: its element, the run of its child nodes, the elements behind its tags, and its marked text. An
 *  attribute's words (a field's placeholder, a button input's label) are a block of their own: no nodes, `attr` set.
 *  `seen`: the element whose place on the screen says whether the block shows, where its own doesn't (a system
 *  list's row has no box of its own: the list has). */
export interface Block {
  parent: Element
  nodes: Node[]
  tags: Map<number, Element>
  paired: Set<number>
  text: string
  attr?: string
  seen?: Element
}

/** Attributes whose words show on the page: a field's placeholder; the label of a button input that sends no value of
 *  its own (with a name, its value is what the form sends). */
const ATTRS = "input[placeholder],textarea[placeholder],input[type=submit][value]:not([name]),input[type=button][value]:not([name]),input[type=reset][value]:not([name])"

/** A tooltip's words: the browser's own (title) and the attributes the common tooltip scripts read. */
export const TIP_ATTRS = ["title", "data-tooltip", "data-title", "data-tip", "data-original-title", "data-bs-original-title", "data-bs-title", "data-tippy-content", "data-balloon", "data-hint"] as const
/** What a control with no words of its own is called: its label for screen readers, and its tooltips. */
const LABEL_ATTRS = ["aria-label", ...TIP_ATTRS] as const
/** Every attribute translation may write (the engine watches them for the site's own changes). */
export const WORD_ATTRS: readonly string[] = ["placeholder", "value", "label", ...LABEL_ATTRS]
const PRESSED = "button,a[href],summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=switch],[role=checkbox],[role=option]"
const LABELLED = LABEL_ATTRS.map((a) => PRESSED.split(",").map((c) => `${c}[${a}]`).join(",")).join(",")
/** A field's name for screen readers (what a person types into it is never read). */
const FIELDS = "input[aria-label]:not([type=hidden]),textarea[aria-label]"
const TIPPED = TIP_ATTRS.map((a) => `[${a}]`).join(",")

/** A system list's rows, and the names of its groups. */
const OPTIONS = "select option,select optgroup[label]"
/** A list longer than this (characters, all rows) is left as it is: half of it translated would be worse. */
const OPTION_CHARS = 6_000
/** The words an attribute's block stands for. A list's row without a label is called by its text. */
const attrText = (el: Element, attr: string) => {
  const words = attr === "label" && tagOf(el) === "OPTION" && !el.hasAttribute("label") ? el.textContent : el.getAttribute(attr)
  return escapeText(words ?? "").replace(/\s+/g, " ").trim()
}
/** The page says not to translate it (the attribute or the class translators honour). */
const kept = (el: Element) => el.getAttribute("translate") === "no" || !!el.classList?.contains("notranslate")
const attrBlock = (el: Element, attr: string, text: string): Block => ({ parent: el, nodes: [], tags: new Map(), paired: new Set(), text, attr })

/** A control that shows no words of its own (an icon button; an icon font's word isn't one): what it does is said
 *  only by its label or tooltip. */
function wordless(el: Element): boolean {
  let letters = 0
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (letters >= 2) return
      if (child.nodeType === 3) letters += (child as Text).data.match(LETTERS)?.length ?? 0
      else if (child.nodeType === 1 && !QUIET.has(tagOf(child as Element)) && !skipped(child as Element)) walk(child)
    }
  }
  walk(el)
  return letters < 2
}

/** The attributes' blocks of `el` named in `attrs`, one per different text (a label and a tooltip that say the same
 *  are one request; the second is written from what's kept). */
function wordAttrs(el: Element, attrs: readonly string[], out: Block[]): void {
  for (const attr of attrs) {
    if (!el.hasAttribute(attr)) continue
    const text = attrText(el, attr)
    if (text.length <= TRANSLATE_LIMITS.tipChars && worth(text, 0)) out.push(attrBlock(el, attr, text))
  }
}

function attrBlocks(root: Element | ShadowRoot, out: Block[]): void {
  const all = (sel: string): Element[] => {
    const found = Array.from(root.querySelectorAll(sel))
    // The part read again may be the element itself (its attribute changed).
    if (root.nodeType === 1 && (root as Element).matches(sel)) found.unshift(root as Element)
    return found
  }
  for (const el of all(ATTRS)) {
    if (insideSkipped(el.parentElement) || (el.getAttribute("type") === "hidden")) continue
    const attr = el.hasAttribute("placeholder") ? "placeholder" : "value"
    const text = attrText(el, attr)
    if (worth(text, 0)) out.push(attrBlock(el, attr, text))
  }
  for (const el of all(LABELLED)) {
    if (insideSkipped(el) || !wordless(el)) continue
    wordAttrs(el, LABEL_ATTRS, out)
  }
  for (const el of all(FIELDS)) {
    if (!insideSkipped(el.parentElement)) wordAttrs(el, ["aria-label"], out)
  }
  optionBlocks(all(OPTIONS), out)
}

/** The rows of each system list among `rows`: the chosen one first (it's what the closed list shows). */
function optionBlocks(rows: Element[], out: Block[]): void {
  const lists = new Map<Element, Element[]>()
  for (const el of rows) {
    const list = el.closest("select")
    if (!list) continue
    const of = lists.get(list)
    if (of) of.push(el)
    else lists.set(list, [el])
  }
  for (const [list, of] of lists) {
    if (kept(list) || list.hasAttribute("hidden") || insideSkipped(list.parentElement)) continue
    const found: Block[] = []
    let chars = 0
    for (const el of of) {
      if (kept(el) || (el.parentElement !== list && kept(el.parentElement!))) continue
      const text = attrText(el, "label")
      chars += text.length
      if (text.length <= TRANSLATE_LIMITS.tipChars && worth(text, 0)) found.push({ ...attrBlock(el, "label", text), seen: list })
    }
    if (chars > OPTION_CHARS) continue
    const chosen = (b: Block) => Number(!(b.parent as HTMLOptionElement).selected)
    out.push(...found.sort((a, b) => chosen(a) - chosen(b)))
  }
}

/** The system list's row `node` is, or is part of (its text). */
export function optionOf(node: Node): Element | null {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  return el && tagOf(el) === "OPTION" && el.closest("select") ? el : null
}

/**
 * The tooltips the pointer or the focus has come to: `el`'s own and those of the few elements around it (a title
 * sits on the link, the pointer on the picture inside it).
 */
export function tipBlocks(el: Element): Block[] {
  const out: Block[] = []
  let depth = 0
  for (let at: Element | null = el; at && depth < 4; at = at.parentElement, depth++) {
    if (!at.matches(TIPPED) || insideSkipped(at)) continue
    wordAttrs(at, TIP_ATTRS, out)
  }
  return out
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
    if (QUIET.has(tagOf(el))) continue
    const tag = tags.size + 1
    tags.set(tag, el)
    if (KEEP.has(tagOf(el)) || marked(el) || !(el.textContent ?? "").trim()) {
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

/** Worth translating: words (not a number, a price, an address or a code), not too long, not a wall of links. */
function worth(text: string, tags: number): boolean {
  const plain = text.replace(/<\/?\d+\/?>/g, " ").replace(/\s+/g, " ").trim()
  if (plain.length > TRANSLATE_LIMITS.blockChars || tags > TRANSLATE_LIMITS.blockTags) return false
  if ((plain.match(LETTERS)?.length ?? 0) < 2) return false
  if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return false
  // An icon font's word (shopping_cart, arrow_forward) or an identifier, not words.
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(plain)) return false
  return true
}

/** The blocks under `root`, in page order (an attribute's after the words); `onShadow` hears of each open shadow root
 *  read (a web component's words, a consent banner's), for watching it. */
export function collectBlocks(root: Element, onShadow?: (shadow: ShadowRoot) => void): Block[] {
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
  const shadows: ShadowRoot[] = []
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
    const shadow = el.shadowRoot
    if (shadow && el.tagName !== HOST) {
      shadows.push(shadow)
      for (const child of Array.from(shadow.children)) if (!skipped(child)) walk(child)
    }
  }
  if (!skipped(root)) {
    walk(root)
    attrBlocks(root, out)
    for (const shadow of shadows) {
      attrBlocks(shadow, out)
      onShadow?.(shadow)
    }
  }
  return out
}

// ------------------------------------------------------------------ the page's controls

const CONTROL_TAGS = new Set(["BUTTON", "LABEL", "SUMMARY", "LEGEND"])
const CONTROL_ROLES = new Set(["button", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "checkbox", "radio"])
const MENUS = "nav,menu,[role=navigation],[role=menu],[role=menubar],[role=tablist],[role=toolbar]"
const DIALOGS = "dialog,[role=dialog],[role=alertdialog],[aria-modal=true]"
/** A link that's all of its block and this short is something to press («Заказать», «В корзину»), not a headline. */
const LINK_LETTERS = 30

/**
 * A block of what the reader presses or fills in (build 107, the owner: «очень важно чтобы кнопки переводились даже
 * если это очень маленький процент страницы, так как критично важно понимать на что ты нажимаешь»): a button, a tab,
 * a menu's or the navigation's item, a short link on its own, a form's label, a placeholder, a dialog's title. They
 * are judged apart from the page's words (decide.ts judgeControls), and can be translated alone.
 */
export function controlBlock(block: Block): boolean {
  // A control's words are short; a longer label (a consent's paragraph) is the page's text (and what's free to
  // translate is short: the server checks the same length).
  const plain = block.text.replace(/<\/?\d+\/?>/g, "").replace(/\s+/g, " ").trim()
  if (plain.length > TRANSLATE_LIMITS.controlChars) return false
  if (block.attr) return true
  const el = block.parent
  let depth = 0
  for (let at: Element | null = el; at && depth < 5; at = at.parentElement, depth++) {
    if (CONTROL_TAGS.has(tagOf(at))) return true
    const role = at.getAttribute("role")
    if (role && CONTROL_ROLES.has(role)) return true
  }
  if (el.closest(MENUS)) return true
  const letters = plain.match(LETTERS)?.length ?? 0
  if (tagOf(el) === "A" && letters <= LINK_LETTERS) return true
  if (/^H[1-6]$/.test(tagOf(el)) || el.getAttribute("role") === "heading" || el.closest("h1,h2,h3,h4,h5,h6")) return !!el.closest(DIALOGS)
  return false
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
  // The block's element marked with the translation's language and direction: what its attributes were.
  marked?: { el: Element; lang: string | null; dir: string | null; now: string; turned: boolean }
  // An attribute's words (a placeholder, a button input's label): what they were and are.
  attr?: { el: Element; name: string; was: string | null; now: string }
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

/** Languages written right to left. */
const RTL = /^(ar|he|fa|ur|yi|ps|sd|ug|dv)(-|$)/i

/**
 * The translated block's element says its language, and takes its direction from its words where the translation
 * reads the other way (2.7, the director's audit: English into Arabic stayed left to right; Arabic into English put
 * the punctuation on the wrong side). Where it reads the same way as before, the direction is left as the page set it
 * (build 109: an attribute less on every block; a clamped box's direction isn't recomputed for nothing). Not on the
 * page's body or root, where it would turn the whole layout; not again when another block of it already did.
 */
function markLanguage(el: Element, lang: string, done: Applied): void {
  if (el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return
  // Without a layout to ask (tests), as when it turns.
  const now = el.ownerDocument.defaultView?.getComputedStyle?.(el)?.direction
  const turned = now === "ltr" || now === "rtl" ? (now === "rtl") !== RTL.test(lang) : true
  if (el.getAttribute("lang") === lang && (!turned || el.getAttribute("dir") === "auto")) return
  done.marked = { el, lang: el.getAttribute("lang"), dir: el.getAttribute("dir"), now: lang, turned }
  el.setAttribute("lang", lang)
  if (turned) el.setAttribute("dir", "auto")
}

/**
 * The translation written into the block (its text checked against the block's tags first), or null when it can't be
 * (tags lost or the block's elements gone from the page). `lang`: the translation's language, for the block's element.
 */
export function applyBlock(block: Block, translation: string, lang?: string): Applied | null {
  if (block.attr) return applyAttr(block, translation)
  const pieces = parseMarked(translation)
  if (!pieces) return null
  if (!block.parent.isConnected || block.nodes.some((n) => n.parentNode !== block.parent)) return null
  const done: Applied = { texts: [], added: [], moved: [] }
  write(block.parent, block.nodes, edges(block, pieces), block.tags, done)
  if (lang) markLanguage(block.parent, lang, done)
  return done
}

const unescape = (text: string) => text.replace(/‹(\/?\d{1,3}\/?)›/g, "<$1>")
const attrNow = (block: Block) => attrText(block.parent, block.attr!)

/** An attribute's translation: its words only (a tag in it means the model took it for something else). */
function applyAttr(block: Block, translation: string): Applied | null {
  const pieces = parseMarked(translation)
  if (!pieces || pieces.some((p) => typeof p !== "string") || !block.parent.isConnected || attrNow(block) !== block.text) return null
  // No attribute there before (a list's row called by its text): "Original" takes it off again.
  const was = block.parent.getAttribute(block.attr!)
  const now = unescape(pieces.join("")).trim()
  block.parent.setAttribute(block.attr!, now)
  return { texts: [], added: [], moved: [], attr: { el: block.parent, name: block.attr!, was, now } }
}

const putBack = (el: Element, name: string, value: string | null) => {
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}

/** Puts back what a translation changed: words the page hasn't changed since, the elements' order, no added nodes,
 *  the element's own language and direction (unless the page has set them since). */
export function restore(done: Applied): void {
  const a = done.attr
  if (a && a.el.getAttribute(a.name) === a.now) putBack(a.el, a.name, a.was)
  const m = done.marked
  if (m && m.el.getAttribute("lang") === m.now && (!m.turned || m.el.getAttribute("dir") === "auto")) {
    putBack(m.el, "lang", m.lang)
    if (m.turned) putBack(m.el, "dir", m.dir)
  }
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
  if (block.attr) return block.parent.isConnected
  return block.parent.isConnected && block.nodes.every((n) => n.parentNode === block.parent)
}

/** Still the words that were sent: intact, and its text unchanged (a live counter, a clock, an edited comment). */
export function blockCurrent(block: Block): boolean {
  if (!blockIntact(block)) return false
  if (block.attr) return attrNow(block) === block.text
  const tags = new Map<number, Element>()
  return mark(block.nodes, tags, new Set()).replace(/\s+/g, " ").trim() === block.text
}
