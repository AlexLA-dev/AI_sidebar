// The agent's page map (2.7.1): the controls a person could use on the page now, numbered, with their role, name,
// value and state, plus the words around them. The model acts by these numbers; it never sees the HTML or a picture.
// - Open shadow roots and same-origin frames are walked (sites' components, editors in frames); our own panel never.
// - Hidden things are left out (display:none, visibility, aria-hidden, inert, zero size), except a checkbox or a
//   radio a site draws over with its label (the label is what shows; the input is what's pressed).
// - A number stays with its element as long as the element lives: nothing is written into the page's DOM.
// - Secret fields (passwords, cards, codes, documents) and personal ones (names, contacts, birth dates) are in the
//   map without their values: the model sees "filled" or "empty". So what Safari AutoFill or the person typed
//   never reaches it.

import { amounts } from "../../shared/agent/taskplan"
import { isDateLabel, monthIn } from "../../shared/agent/dates"
import { wordKind, wordTest } from "../../shared/agent/match"
import { looksLikeSlot } from "../../shared/agent/rules"
import { CLOSE_WORDS, PROMO_WORDS, UNAVAILABLE_WORDS } from "../../shared/agent/words"
import { fieldLock } from "../../shared/agent/fields"
import { hostOf, sameSite } from "../../shared/agent/sites"
import type { Lock, MapItem, PageForm, PageMap, Role } from "../../shared/agent/types"
import { isOwnHost } from "../insert/field"
import { OVERLAY } from "../translate/pageControls"

const CONTROL = [
  "a[href]", "button", "input", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]",
  "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=combobox]", "[role=listbox]", "[role=slider]",
  "[role=spinbutton]", "[role=textbox]", "[role=searchbox]", "[role=treeitem]", "[role=gridcell]",
  "[contenteditable='']", "[contenteditable=true]", "[contenteditable=plaintext-only]", "[onclick]"
].join(",")

// Roles whose descendants aren't controls of their own (a link's icon, a button's label).
const LEAF_ROLES = new Set<Role>(["button", "link", "option", "menuitem", "tab", "checkbox", "radio", "switch", "textbox", "textarea", "editor", "select", "summary"])

export const PART_SIZE = 120
const TEXT_MAX = 3000
const LABEL_MAX = 120
const VALUE_MAX = 200

// ------------------------------------------------------------ numbers

let next = 1
const ids = new WeakMap<Element, string>()
const byId = new Map<string, WeakRef<Element>>()

function idOf(el: Element, frame: string): string {
  let id = ids.get(el)
  if (!id) {
    id = `${frame}${next++}`
    ids.set(el, id)
    byId.set(id, new WeakRef(el))
  }
  return id
}

// Fields the agent filled from «Мои данные»: shown to the model as filled, never with their value.
const fromData = new WeakSet<Element>()

export function markFilled(el: Element): void {
  fromData.add(el)
}

/** The element a map number names, while it's still on the page. */
export function elementOf(id: string): Element | null {
  const el = byId.get(id)?.deref() ?? null
  if (el && !el.isConnected) return null
  return el
}

// ------------------------------------------------------------ walking

interface Found {
  el: Element
  frame: string
  // The frame's offset in the top window (its elements' rects are its own).
  dx: number
  dy: number
}

function* roots(doc: Document, frame: string, dx: number, dy: number, depth = 0): Generator<{ root: Document | ShadowRoot; frame: string; dx: number; dy: number }> {
  yield { root: doc, frame, dx, dy }
  if (depth > 3) return
  const frames = Array.from(doc.querySelectorAll("iframe, frame"))
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    let inner: Document | null = null
    try {
      inner = (f as HTMLIFrameElement).contentDocument
    } catch {
      inner = null
    }
    if (!inner?.documentElement) continue
    const r = f.getBoundingClientRect()
    // f1:, f1.2: — the frame's place among the page's frames.
    const name = `${frame ? frame.slice(0, -1) + "." : "f"}${i + 1}:`
    yield* roots(inner, name, dx + r.left, dy + r.top, depth + 1)
  }
}

function collect(doc: Document): Found[] {
  const out: Found[] = []
  for (const { root, frame, dx, dy } of roots(doc, "", 0, 0)) {
    const walk = (r: Document | ShadowRoot | Element) => {
      for (const el of Array.from(r.querySelectorAll("*"))) {
        if (isOwnHost(el)) continue
        if (el.matches(CONTROL)) out.push({ el, frame, dx, dy })
        const shadow = (el as HTMLElement).shadowRoot
        if (shadow) walk(shadow)
      }
    }
    walk(root)
  }
  return out
}

// ------------------------------------------------------------ what an element is

function tag(el: Element): string {
  return el.tagName.toLowerCase()
}

export function roleOf(el: Element): Role | null {
  const role = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0]
  switch (role) {
    case "button": return "button"
    case "link": return "link"
    case "checkbox": case "menuitemcheckbox": return "checkbox"
    case "radio": case "menuitemradio": return "radio"
    case "switch": return "switch"
    case "tab": return "tab"
    case "menuitem": return "menuitem"
    case "option": case "treeitem": return "option"
    // A calendar's day cell (a grid of days): a choice when it holds a short number and no button of its own.
    case "gridcell": return !el.querySelector("button, a, [role=button], [role=option]") && /^\s*\D{0,12}\d{1,2}\D{0,12}\s*$/.test(el.textContent ?? "") ? "option" : null
    case "combobox": return "combobox"
    case "listbox": return "listbox"
    case "slider": return "slider"
    case "spinbutton": case "textbox": case "searchbox": return (el as HTMLElement).isContentEditable ? "editor" : "textbox"
    case "presentation": case "none": break
  }
  switch (tag(el)) {
    case "a": return "link"
    case "button": return "button"
    case "summary": return "summary"
    case "select": return (el as HTMLSelectElement).multiple ? "listbox" : "select"
    case "textarea": return "textarea"
    case "input": {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase()
      if (type === "hidden") return null
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "file") return "file"
      if (type === "range") return "slider"
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button"
      return el.getAttribute("list") ? "combobox" : "textbox"
    }
  }
  if ((el as HTMLElement).isContentEditable) {
    // Only an editor's root: the elements inside it are its text.
    const parent = el.parentElement
    return parent && (parent as HTMLElement).isContentEditable ? null : "editor"
  }
  if (el.hasAttribute("onclick")) return "other"
  return null
}

const squash = (s: string | null | undefined, max = LABEL_MAX) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max)

function textOf(el: Element): string {
  const html = el as HTMLElement
  // innerText follows what's shown (no hidden spans, CSS text-transform aside); textContent where there's no layout.
  const raw = typeof html.innerText === "string" && html.innerText ? html.innerText : el.textContent
  return squash(raw)
}

function byIds(el: Element, attr: string): string {
  const list = (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)
  if (!list.length) return ""
  const root = el.getRootNode() as Document | ShadowRoot
  return squash(list.map((id) => (root.getElementById?.(id) ?? el.ownerDocument.getElementById(id))?.textContent ?? "").join(" "))
}

function labelFor(el: Element): string {
  const id = el.id
  if (id) {
    const root = el.getRootNode() as Document | ShadowRoot
    try {
      const label = root.querySelector?.(`label[for="${CSS.escape(id)}"]`)
      if (label) return textOf(label)
    } catch {
      // an id CSS.escape can't make a selector of
    }
  }
  const wrap = el.closest("label")
  return wrap ? textOf(wrap) : ""
}

/** A field with no label of its own: the short text just before it in its container ("Name", "Дата"). */
function textBefore(el: Element): string {
  let n: Element | null = el
  for (let up = 0; n && up < 3; up++, n = n.parentElement) {
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
      const t = textOf(s)
      if (t) return t.length <= 60 ? t : ""
    }
  }
  return ""
}

/** The element's name as a person reads it (an approximation of its accessible name); a calendar's bare day number
 *  with its month and year (the director's real-site run on 10eed066: a grid of «26»s whose month was only in its header,
 *  so neither the device nor the model knew which month a day was in). */
export function nameOf(el: Element, role: Role): string {
  const own = ownName(el, role)
  return /^\s*(0?[1-9]|[12]\d|3[01])\s*$/.test(own) ? `${own.trim()} ${monthOfCell(el)}`.trim() : own
}

// A month's name with a four-digit year («November 2026», «noviembre de 2026», «2026年11月»).
const MONTH_YEAR = (t: string) => /(?<!\d)(19|20)\d{2}(?!\d)/.test(t) && monthIn(t) >= 0

/** The month and year of the calendar a day cell is in: the nearest enclosing part that names exactly one («» for none). */
function monthOfCell(el: Element): string {
  let at: Element | null = el.parentElement
  for (let depth = 0; at && depth < 8; depth++, at = at.parentElement) {
    const own = squash(at.getAttribute("aria-label"))
    if (own && own.length <= 40 && MONTH_YEAR(own)) return own
    const heads = Array.from(at.querySelectorAll("caption, h1, h2, h3, h4, h5, h6, [role=heading], [aria-live], legend, strong, [class*=month i], [class*=caption i], [class*=title i]"))
      .map((h) => squash(h.textContent))
      .filter((t, i, all) => t.length <= 40 && MONTH_YEAR(t) && all.indexOf(t) === i)
    if (heads.length === 1) return heads[0]
    if (heads.length > 1) return ""
  }
  return ""
}

function ownName(el: Element, role: Role): string {
  const labelled = byIds(el, "aria-labelledby")
  if (labelled) return labelled
  const aria = squash(el.getAttribute("aria-label"))
  if (aria) return aria
  const field = role === "textbox" || role === "textarea" || role === "select" || role === "listbox" || role === "combobox" || role === "checkbox" || role === "radio" || role === "switch" || role === "file" || role === "slider"
  if (field && tag(el) !== "button") {
    const label = labelFor(el)
    if (label) return label
  }
  if (tag(el) === "input") {
    const input = el as HTMLInputElement
    const type = input.type.toLowerCase()
    if (type === "submit" || type === "button" || type === "reset") return squash(input.value) || squash(input.title) || (type === "submit" ? "Submit" : "")
    if (type === "image") return squash(input.alt) || squash(input.title)
  }
  if (!field || role === "checkbox" || role === "radio" || role === "switch") {
    const text = textOf(el)
    if (text) return text
    const img = el.querySelector("img[alt], svg title, [aria-label]")
    const inner = img ? squash(img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? img.textContent) : ""
    if (inner) return inner
  }
  const rest = squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title")) || squash(el.getAttribute("data-placeholder"))
  if (rest) return rest
  return field ? textBefore(el) : ""
}

function valueOf(el: Element, role: Role): string | undefined {
  if (role === "textbox" || role === "textarea" || role === "combobox") {
    if (tag(el) === "input" || tag(el) === "textarea") return squash((el as HTMLInputElement).value, VALUE_MAX) || undefined
    return squash(el.getAttribute("aria-valuetext") ?? el.textContent, VALUE_MAX) || undefined
  }
  if (role === "editor") return squash(el.textContent, VALUE_MAX) || undefined
  if (role === "select") {
    const s = el as HTMLSelectElement
    return squash(s.selectedOptions?.[0]?.textContent ?? s.options?.[s.selectedIndex]?.textContent, VALUE_MAX) || undefined
  }
  if (role === "slider") return squash(el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? (el as HTMLInputElement).value, 40) || undefined
  return undefined
}

function stateOf(el: Element, role: Role): string[] {
  const s: string[] = []
  const a = (name: string) => el.getAttribute(name)
  const input = el as HTMLInputElement
  if (role === "checkbox" || role === "radio" || role === "switch") {
    const checked = tag(el) === "input" ? input.checked : a("aria-checked") === "true"
    s.push(checked ? "checked" : "unchecked")
  }
  if (a("aria-selected") === "true") s.push("selected")
  // (A control that opens a popup — a date picker's button showing today's date — says so: it isn't the choice itself.)
  const popup = a("aria-haspopup")
  if (popup && popup !== "false") s.push("popup")
  if (a("aria-expanded") === "true") s.push("expanded")
  if (a("aria-expanded") === "false") s.push("collapsed")
  if (tag(el) === "summary") s.push((el.parentElement as HTMLDetailsElement | null)?.open ? "expanded" : "collapsed")
  if ((el as HTMLButtonElement).disabled || a("aria-disabled") === "true" || el.closest("fieldset[disabled]")) s.push("disabled")
  if (input.required || a("aria-required") === "true") s.push("required")
  if (a("aria-invalid") === "true") s.push("invalid")
  if (input.readOnly || a("aria-readonly") === "true") s.push("readonly")
  if (a("aria-pressed") === "true") s.push("pressed")
  if (a("aria-current") && a("aria-current") !== "false") s.push("current")
  return s
}

// Class names sites give a day or a slot that can't be chosen.
const UNAVAILABLE_CLASS = /(^|[-_\s])(disabled|unavailable|not-?available|inactive|blocked|sold-?out|booked|is-?full|outside)([-_\s]|$)/i

const struck = (style: CSSStyleDeclaration) => /line-through/.test(`${style.textDecorationLine ?? ""} ${style.textDecoration ?? ""}`)

/** Whether the page shows this control as not choosable: its class, faded (opacity), not taking presses, a not-allowed
 *  cursor, or its text struck through. */
function unavailableByLook(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  let opacity = 1
  let e: Element | null = el
  for (let i = 0; e && i < 3; i++, e = e.parentElement) {
    const cls = typeof (e as HTMLElement).className === "string" ? (e as HTMLElement).className : e.getAttribute("class") ?? ""
    if (i < 2 && UNAVAILABLE_CLASS.test(cls)) return true
    const style = view?.getComputedStyle?.(e)
    if (!style) continue
    opacity *= Number(style.opacity || "1")
    if (i === 0 && (style.pointerEvents === "none" || style.cursor === "not-allowed")) return true
    if (i === 0 && struck(style)) return true
  }
  // A day number struck through inside its tile (a calendar crossing out full days).
  for (const child of Array.from(el.children).slice(0, 3)) {
    const style = view?.getComputedStyle?.(child)
    if (style && struck(style) && (child.textContent ?? "").trim()) return true
  }
  return opacity < 0.6
}

// A day or a time that says it's not choosable, in its name or its title, in any of the 15 languages (the lexicon's
// UNAVAILABLE_WORDS): read on day and time controls only (a short number, a date, a time).
const unavailableWord = wordTest(UNAVAILABLE_WORDS)
function unavailableBySaying(el: Element, label: string): boolean {
  if (!(isDateLabel(label) || looksLikeSlot(label) || /^\s*\d{1,2}\b/.test(label))) return false
  return unavailableWord(`${label} ${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-description") ?? ""}`)
}

// A rating («4.8», «9,1», «★») and a count of reviews («(851)», «1 178 reviews», «отзывов»…) in a card's text.
const CARD_RATING = /(?<![\d.,])\d[.,]\d(?![\d.,])|★|⭐/
const CARD_REVIEWS = /\(\s*\d[\d,. \u00a0]{0,8}\)|\d\s*(reviews?|ratings?|отзыв|оцен|avis|bewertung|reseñ|valoraci|recension|avalia|yorum|değerlendirme|件|レビュー|리뷰|후기|评论|評論|評價|تقييم|مراجع|đánh giá)/i

/** A box's text with its pieces apart («Italian 9.1 (320)», not «Italian9.1(320)» as textContent joins them), cut at max. */
function wordsOf(box: Element, max: number): string {
  const doc = box.ownerDocument
  const walker = doc.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */)
  const parts: string[] = []
  let size = 0
  for (let n = walker.nextNode(); n && size <= max; n = walker.nextNode()) {
    const t = (n.nodeValue ?? "").replace(/\s+/g, " ").trim()
    if (!t) continue
    parts.push(t)
    size += t.length + 1
  }
  return parts.join(" ")
}

/** The card a link heads, when the link carries only a name: the nearest box around it (up to five levels) that holds a
 *  rating and a count of reviews and no more than one place's links; else the widest box with one place's links and more
 *  words than the name (a card without a rating). Its text, or "". */
function cardOf(el: Element, label: string): string {
  if (label.length > 80 || (CARD_RATING.test(label) && CARD_REVIEWS.test(label))) return ""
  // A whole card that is one link named by its aria-label («Trattoria Uno»): its own text is the card.
  const own = wordsOf(el, 600)
  if (own.length <= 400 && own !== label && CARD_RATING.test(own) && CARD_REVIEWS.test(own)) return own.slice(0, 240)
  let box: Element | null = el.parentElement
  // A card without a rating (a clinic's directory: the doctor, the address, the next free times, 126): the widest box
  // around the link that still holds one place's links and a card's worth of text (a script-drawn card nests deep).
  let plain = ""
  for (let i = 0; box && i < 10; i++, box = box.parentElement) {
    const hrefs = new Set(Array.from(box.querySelectorAll("a[href]")).map((a) => (a.getAttribute("href") ?? "").split(/[?#]/)[0]).filter((h) => h && h !== "/"))
    if (hrefs.size > 3) break
    const text = wordsOf(box, 600)
    if (text.length > 400) break
    if (i < 5 && CARD_RATING.test(text) && CARD_REVIEWS.test(text)) return text.slice(0, 240)
    if (text.length >= label.length + 15) plain = text
  }
  return plain.slice(0, 240)
}

const rgb = (c: string): [number, number, number, number] | null => {
  const m = /rgba?\(([^)]+)\)/.exec(c)
  if (!m) return null
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}
const lum = ([r, g, b]: [number, number, number, number]) => {
  const f = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** The contrast of a control's text against the background behind it (0 when it can't be told). */
function textContrast(el: Element): number {
  const view = el.ownerDocument.defaultView
  const style = view?.getComputedStyle?.(el)
  const fg = style ? rgb(style.color) : null
  if (!fg) return 0
  let bg: [number, number, number, number] | null = null
  for (let e: Element | null = el; e && !bg; e = e.parentElement) {
    const c = rgb(view?.getComputedStyle?.(e).backgroundColor ?? "")
    if (c && c[3] > 0.5) bg = c
  }
  bg = bg ?? [255, 255, 255, 1]
  // A see-through text colour is its blend with the background.
  const mix: [number, number, number, number] = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1]
  const a = lum(mix)
  const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function hiddenByStyle(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  for (let e: Element | null = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)) {
    // aria-hidden on the body or the root is a modal library's mistake (react-modal on tiki.vn): the screen shows it all.
    const top = e === el.ownerDocument.body || e === el.ownerDocument.documentElement
    if ((!top && e.getAttribute("aria-hidden") === "true") || e.hasAttribute("inert") || (e as HTMLElement).hidden) return true
    const style = view?.getComputedStyle?.(e)
    if (style && (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden")) return true
    if (e === el.ownerDocument.body) break
  }
  return false
}

interface Box {
  top: number
  bottom: number
  width: number
  height: number
  // Left and right in the top window: a strip scrolled sideways keeps its far items out of the screen.
  left: number
  right: number
}

/** Where the element shows, in the top window: its own box, or its label's for an input a site draws over. */
function boxOf(f: Found, role: Role): Box | null {
  const r = f.el.getBoundingClientRect()
  let box: Box = { top: r.top + f.dy, bottom: r.bottom + f.dy, width: r.width, height: r.height, left: r.left + f.dx, right: r.right + f.dx }
  const tiny = r.width < 2 || r.height < 2
  const noLayout = r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0
  if (tiny && (role === "checkbox" || role === "radio" || role === "switch")) {
    const label = f.el.closest("label") ?? (f.el.id ? f.el.ownerDocument.querySelector(`label[for="${CSS.escape(f.el.id)}"]`) : null)
    if (label) {
      const l = label.getBoundingClientRect()
      if (l.width >= 2 && l.height >= 2) box = { top: l.top + f.dy, bottom: l.bottom + f.dy, width: l.width, height: l.height, left: l.left + f.dx, right: l.right + f.dx }
      else if (!noLayout) return null
    } else if (!noLayout) return null
  } else if (tiny && !noLayout) return null
  return box
}

function inDialog(el: Element): boolean {
  for (let e: Element | null = el, n = 0; e && n < 40; n++) {
    if (e.closest(OVERLAY)) return true
    e = (e.getRootNode() as ShadowRoot).host ?? null
  }
  return false
}

/** The fixed or sticky box an element is in, when it's not the page's own header (a banner, a bar at the bottom). */
function fixedBanner(el: Element): Element | null {
  const view = el.ownerDocument.defaultView
  if (!view) return null
  for (let e: Element | null = el; e && e !== el.ownerDocument.body; e = e.parentElement) {
    const position = view.getComputedStyle(e).position
    if (position === "fixed" || position === "sticky") {
      const r = e.getBoundingClientRect()
      // A header at the very top is the site's own bar; anything else fixed is drawn over the page.
      return r.top <= 1 && r.height < 160 ? null : e
    }
  }
  return null
}

function hrefOf(el: Element, pageHost: string): string | undefined {
  const raw = el.getAttribute("href")
  if (!raw || /^\s*javascript:/i.test(raw)) return undefined
  let url: URL
  try {
    url = new URL(raw, el.ownerDocument.baseURI)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  const path = `${url.pathname}${url.search}`.slice(0, 120)
  return sameSite(host, pageHost) ? path : `${host}${path}`.slice(0, 140)
}

/** An option as the model reads it: marked when the page shows it can't be chosen (a dropdown of times with full ones). */
function optionText(o: Element): string {
  const text = squash(o.textContent, 60)
  if (!text) return ""
  const off = (o as HTMLOptionElement).disabled || o.hasAttribute("disabled") || o.getAttribute("aria-disabled") === "true" || unavailableBySaying(o, text)
  return off ? `${text} [unavailable]` : text
}

function optionsOf(el: Element, role: Role): string[] | undefined {
  if (role === "select" || (role === "listbox" && tag(el) === "select")) {
    return Array.from((el as HTMLSelectElement).options).slice(0, 30).map(optionText).filter(Boolean)
  }
  if (role === "listbox") {
    const list = Array.from(el.querySelectorAll("[role=option]")).slice(0, 30).map(optionText).filter(Boolean)
    return list.length ? list : undefined
  }
  return undefined
}

// ------------------------------------------------------------ the page's words

const MESSAGES_MAX = 8
const MESSAGE = "[role=alert], [role=status], [aria-live=assertive], [aria-live=polite], .error, .errors, .invalid-feedback, .field-error, .form-error"

function pageText(doc: Document, overlays: Element[]): string {
  const view = doc.defaultView
  const height = view?.innerHeight ?? 800
  const parts: string[] = []
  let size = 0
  const add = (s: string) => {
    const t = squash(s, 600)
    if (!t || size > TEXT_MAX || parts.includes(t)) return
    parts.push(t)
    size += t.length + 1
  }
  for (const o of overlays) add(`[over the page] ${textOf(o).slice(0, 500)}`)
  // A page's messages, not its controls (a salon booking site marks a year of date buttons aria-live: they filled the text before
  // the time slots, TestFlight 118). A few, on the screen's width.
  const width = view?.innerWidth ?? 400
  let messages = 0
  for (const m of Array.from(doc.querySelectorAll(MESSAGE))) {
    if (messages >= MESSAGES_MAX) break
    if (m.matches(CONTROL) || hiddenByStyle(m)) continue
    const r = m.getBoundingClientRect()
    if (r.width > 0 && (r.right < 0 || r.left > width)) continue
    const before = parts.length
    add(`[message] ${textOf(m)}`)
    if (parts.length > before) messages++
  }
  for (const h of Array.from(doc.querySelectorAll("h1, h2, h3"))) {
    const r = h.getBoundingClientRect()
    if (r.bottom > -height && r.top < height * 2 && !hiddenByStyle(h)) add(`# ${textOf(h)}`)
  }
  for (const p of Array.from(doc.querySelectorAll("p, li, td, th, dt, dd, label, legend, figcaption, [class*=price], [class*=Price]"))) {
    if (size > TEXT_MAX) break
    const r = p.getBoundingClientRect()
    if (r.bottom < 0 || r.top > height) continue
    if (p.closest("a, button")) continue
    add(textOf(p))
  }
  return parts.join("\n").slice(0, TEXT_MAX)
}

// ------------------------------------------------------------ the map

export interface MapOptions {
  part?: number
  size?: number
  // Every amount on the whole page (the plan's price check): read only when asked — it reads the whole page's text,
  // which makes the browser lay the page out (2.7.1, the owner on 117: the phone got hot while Do ran).
  money?: boolean
}

/** The page's map now (one part of it: PART_SIZE controls, those over the page and on the screen first). */
export function buildMap(doc: Document = document, opts: MapOptions = {}): PageMap {
  const view = doc.defaultView
  const height = view?.innerHeight ?? 800
  const pageHost = hostOf(doc.location?.href ?? "")
  const found = collect(doc)
  const forms = new Map<Element, PageForm>()
  const formOf = (el: Element): number | undefined => {
    const form = (el as HTMLInputElement).form ?? el.closest("form")
    if (!form) return undefined
    let f = forms.get(form)
    if (!f) {
      f = { n: forms.size }
      const action = form.getAttribute("action")
      if (action) {
        try {
          const host = new URL(action, doc.baseURI).hostname.toLowerCase().replace(/^www\./, "")
          if (host && !sameSite(host, pageHost)) f.otherSite = host
        } catch {
          // a relative action that isn't a URL: this site
        }
      }
      forms.set(form, f)
    }
    return f.n
  }

  const width = view?.innerWidth ?? 400
  const items: Array<MapItem & { order: number; side?: boolean }> = []
  const looks: Array<{ item: MapItem; el: Element; group: Element | null; contrast: number }> = []
  const overlays = new Set<Element>()
  const seen = new Set<Element>()
  found.forEach((f, order) => {
    const { el } = f
    if (seen.has(el)) return
    const role = roleOf(el)
    if (!role) return
    // Inside a control that's a leaf (a link's span with onclick, a button's icon): the outer one stands for it.
    const outer = el.parentElement?.closest(CONTROL)
    if (outer && role === "other") return
    if (outer && outer !== el) {
      const outerRole = roleOf(outer)
      if (outerRole && LEAF_ROLES.has(outerRole) && outerRole !== "editor" && role !== "textbox" && role !== "checkbox" && role !== "radio") return
    }
    if ((el as HTMLElement).isContentEditable && el.parentElement && (el.parentElement as HTMLElement).isContentEditable) return
    if (hiddenByStyle(el)) return
    const box = boxOf(f, role)
    if (!box) return
    seen.add(el)

    const input = el as HTMLInputElement
    const label = nameOf(el, role)
    const type = tag(el) === "input" ? (input.type || "text").toLowerCase() : tag(el) === "button" ? ((el as HTMLButtonElement).type || "submit").toLowerCase() : undefined
    const field = role === "textbox" || role === "textarea" || role === "editor" || role === "combobox" || role === "select"
    const lock: Lock | null = field || role === "listbox"
      ? fieldLock({ tag: tag(el), type, autocomplete: el.getAttribute("autocomplete") ?? "", name: el.getAttribute("name") ?? "", id: el.id, label }) ?? (fromData.has(el) ? "personal" : null)
      : null
    const item: MapItem & { order: number; side?: boolean } = { id: idOf(el, f.frame), role, label, order }
    if (type && type !== "text" && type !== "submit" && role !== "checkbox" && role !== "radio") item.type = type
    else if (type === "submit" && tag(el) !== "button") item.type = "submit"
    else if (tag(el) === "button" && type === "submit" && (input.form || el.closest("form"))) item.type = "submit"
    else if (tag(el) === "button" && type !== "submit") item.type = type
    const auto = el.getAttribute("autocomplete")
    if (auto && field && auto !== "off" && auto !== "on") item.auto = auto.slice(0, 40)
    if (lock) item.lock = lock
    const value = valueOf(el, role)
    if (lock) {
      if (field) item.state = [value ? "filled" : "empty"]
    } else if (value) item.value = value
    const state = stateOf(el, role)
    if (state.length) item.state = [...(item.state ?? []), ...state]
    const banner = inDialog(el) ? el.closest(OVERLAY) ?? el : fixedBanner(el)
    if (banner) {
      item.where = "dialog"
      overlays.add(banner)
    } else if (box.top > height) item.where = "below"
    else if (box.bottom < 0) item.where = "above"
    else if (box.width > 0 && (box.right < 0 || box.left > width)) item.side = true
    const form = formOf(el)
    if (form !== undefined) item.form = form
    if (role === "link") {
      const href = hrefOf(el, pageHost)
      if (href) item.href = href
      if (href && !item.lock && item.label.trim().length >= 2) {
        const card = cardOf(el, item.label)
        if (card) item.card = card
      }
    }
    const options = optionsOf(el, role)
    if (options?.length) item.options = options
    // A date or a time that can't be chosen, as the page shows it (124, the owner: «по яркости даты видно доступна ли
    // она»): its class, its fading, or later its text against its siblings'.
    const choice = !item.lock && (role === "button" || role === "option" || role === "radio" || role === "link")
    if (choice && !item.state?.includes("disabled") && (unavailableByLook(el) || unavailableBySaying(el, item.label))) item.state = [...(item.state ?? []), "unavailable"]
    // (Only dates and times — a short label with a number — are compared with their siblings: a nav bar's styling isn't.)
    if (!item.lock && (role === "button" || role === "option" || role === "radio" || role === "link") && /\d/.test(item.label) && item.label.length <= 30) looks.push({ item, el, group: el.parentElement?.parentElement ?? el.parentElement, contrast: textContrast(el) })
    items.push(item)
  })
  // Greyed among its own: a control whose text is much fainter than its siblings' (a date strip where the days that
  // can't be booked are light grey), when the strip has four or more and some are clearly darker.
  const byGroup = new Map<Element | null, typeof looks>()
  for (const l of looks) byGroup.set(l.group, [...(byGroup.get(l.group) ?? []), l])
  for (const group of byGroup.values()) {
    const known = group.filter((l) => l.contrast > 0)
    if (known.length < 4) continue
    const best = Math.max(...known.map((l) => l.contrast))
    if (best < 3) continue
    for (const l of known) {
      if (l.contrast < best * 0.55 && !l.item.state?.some((x) => x === "unavailable" || x === "disabled" || x === "selected" || x === "pressed" || x === "current")) l.item.state = [...(l.item.state ?? []), "unavailable"]
    }
  }

  // The forms: what they hold (a password or a card makes a form secret; a field to fill makes it fillable).
  const byForm = new Map<number, PageForm>()
  for (const f of forms.values()) byForm.set(f.n, f)
  for (const it of items) {
    if (it.form === undefined) continue
    const f = byForm.get(it.form)!
    if (it.lock === "secret") f.secret = true
    const search = it.type === "search" || /search|поиск|suche|recherche|buscar|cerca|pesquisa|ara|検索|검색|搜索|搜尋|tìm/i.test(it.label)
    if ((it.role === "textbox" || it.role === "textarea" || it.role === "editor" || it.role === "select") && !search) f.fillable = true
  }
  // Forms with a password field the map doesn't show (hidden behind a step) count too.
  for (const [form, f] of forms) {
    if (form.querySelector("input[type=password], [autocomplete~=cc-number], [autocomplete~=one-time-code]")) f.secret = true
  }

  // On the screen first; then what a sideways strip keeps out of it (a year of dates), then below and above.
  // A search box above the screen (a page scrolled past its header) stays with what's on the screen: a restaurant site, round 3 —
  // the agent couldn't search again once the list was scrolled.
  const searchBox = (i: MapItem) => (i.role === "textbox" || i.role === "combobox") && (i.type === "search" || SEARCH_WORDS.test(i.label))
  // So does a booking's own setting scrolled past (2.7.1, B3: a widget's date, party and time fields at the top of the
  // page dropped out of the map once the agent scrolled to the slots): fields, a form's controls, a day.
  const setting = (i: MapItem) => searchBox(i) || FIELD_ROLES.has(i.role) || i.form !== undefined || isDateLabel(i.label)
  const rank = (i: MapItem & { side?: boolean }) => (i.where === "dialog" ? 0 : i.where === undefined ? (i.side ? 1.5 : 1) : i.where === "above" && setting(i) ? 1.2 : i.where === "below" ? 2 : 3)
  items.sort((a, b) => rank(a) - rank(b) || a.order - b.order)
  const size = opts.size ?? PART_SIZE
  const parts = Math.max(1, Math.ceil(items.length / size))
  const part = Math.min(Math.max(1, opts.part ?? 1), parts)
  const slice = items.slice((part - 1) * size, part * size).map(({ order: _order, side: _side, ...rest }) => rest)
  const overlayList = [...overlays]
  const consent = overlayList.some((o) => /cookie|куки|çerez|クッキー|쿠키|consent|gdpr|privacy|datenschutz|confidentialit|privacidad|privacidade|riservatezza|конфиденциальн|ملفات تعريف الارتباط|隐私|隱私|プライバシー|개인정보|quyền riêng tư/i.test(o.textContent ?? ""))

  return {
    url: doc.location?.href ?? "",
    title: squash(doc.title, 200),
    lang: squash(doc.documentElement.lang, 12),
    items: slice,
    forms: [...byForm.values()].map((f) => ({ ...f })),
    more: Math.max(0, items.length - part * size),
    part,
    parts,
    text: pageText(doc, overlayList.slice(0, 2)),
    ...(overlayList.length ? { overlay: true } : {}),
    ...(consent ? { consent: true } : {}),
    ...((() => {
      const promo = consent ? null : promoLayer(overlayList, items)
      return promo ? { promo } : {}
    })()),
    ...(opts.money ? { money: pageMoney(doc) } : {}),
    ...(takesPayment(doc) ? { pay: true } : {}),
    ...(opts.money && asksDeposit(doc) ? { deposit: true } : {}),
    ...(otherFrames(doc).length ? { frames: otherFrames(doc) } : {})
  }
}

// A layer over the page that isn't the task: its meaning (rewards, newsletter, the app, notifications, location), and
// the control that closes it without agreeing (lexicon). Never a sign-in, a payment or the task's own dialog (a field
// for a password or a card, a day or a time to choose, a sign-in's words).
// The roles a page's settings take (a field, a picker, a list to choose from).
const FIELD_ROLES = new Set<Role>(["textbox", "combobox", "select", "listbox", "slider", "switch", "checkbox", "radio"])

const promoWord = wordTest(PROMO_WORDS)
const closeWord = wordTest(CLOSE_WORDS)
const WORDLESS_CLOSE = /^\s*[×✕✖xX]?\s*$/

function promoLayer(overlays: Element[], items: Array<MapItem & { order: number }>): { id: string; label: string } | null {
  for (const o of overlays) {
    if (o.querySelector("input[type=password], [autocomplete~=cc-number], [autocomplete~=one-time-code]")) continue
    const text = wordsOf(o, 1500)
    if (!promoWord(text)) continue
    const inside = items.filter((i) => {
      const el = byId.get(i.id)?.deref()
      return !!el && o.contains(el)
    })
    // The task's own dialog (a date picker, slots, a sign-in) isn't a promotion, whatever else it says.
    if (inside.some((i) => isDateLabel(i.label) || looksLikeSlot(i.label) || i.lock === "secret")) continue
    if (inside.some((i) => { const k = wordKind(i.label)?.kind; return k === "auth" || k === "account" })) continue
    const close =
      inside.find((i) => (i.role === "button" || i.role === "link") && closeWord(i.label) && !blocksClose(i.label)) ??
      inside.find((i) => i.role === "button" && WORDLESS_CLOSE.test(i.label) && i.form === undefined && i.type !== "submit")
    if (close) return { id: close.id, label: close.label || "×" }
  }
  return null
}

/** A close word next to an agreeing one («Close and subscribe») doesn't close. */
function blocksClose(label: string): boolean {
  const k = wordKind(label)?.kind
  return k === "consent" || k === "submit" || k === "pay" || k === "account" || k === "send" || k === "post"
}

/** Another site's frames on the screen, big enough to be a form (their insides aren't readable from here). */
function otherFrames(doc: Document): Array<{ src: string; host: string; w: number; h: number; title?: string }> {
  const here = doc.location?.hostname ?? ""
  const out: Array<{ src: string; host: string; w: number; h: number; title?: string }> = []
  for (const f of Array.from(doc.querySelectorAll("iframe"))) {
    const src = (f as HTMLIFrameElement).src
    if (!/^https:\/\//.test(src)) continue
    let host = ""
    try {
      host = new URL(src).hostname
    } catch {
      continue
    }
    if (!host || host === here) continue
    const r = f.getBoundingClientRect()
    if (r.width < 240 || r.height < 240 || r.bottom < 0 || r.top > (doc.defaultView?.innerHeight ?? 800)) continue
    const title = squash(f.getAttribute("title") || f.getAttribute("aria-label") || f.getAttribute("name") || "", 120)
    out.push({ src: src.split("#")[0].slice(0, 500), host, w: Math.round(r.width), h: Math.round(r.height), ...(title ? { title } : {}) })
  }
  return out.slice(0, 3)
}

const SEARCH_WORDS = /search|find|cuisine|restaurant name|location|where|what are you looking|поиск|найти|искать|suche|recherch|buscar|cerca|pesquis|ara|検索|검색|搜索|搜尋|بحث|tìm/i

// Payment providers' frames and buttons, and addresses of checkout and payment pages (2.7.1, the security review: card
// fields in another site's frame never made a form secret).
const PAY_FRAME = /(^|\.)(stripe\.com|stripe\.network|adyen\.com|adyenpayments\.com|braintreegateway\.com|braintree-api\.com|paypal\.com|paypalobjects\.com|checkout\.com|squareup\.com|squarecdn\.com|klarna\.com|klarnacdn\.net|mollie\.com|worldpay\.com|authorize\.net|cybersource\.com|razorpay\.com|payu\.[a-z.]+|yookassa\.ru|cloudpayments\.ru|iyzipay\.com|apple\.com|pay\.google\.com|recurly\.com|chargebee\.com|paddle\.com|2checkout\.com|bluesnap\.com|globalpay[a-z]*\.com)$/
const PAY_PATH = /(^|[/._-])(checkout|payment|payments|pay|billing|kasse|zahlung|bezahlen|paiement|pago|pagamento|pagamenti|oplata|odeme|subscribe|donate|order-confirm)([/._?-]|$)|оплат|결제|支付|決済|お支払い/i

export function takesPayment(doc: Document): boolean {
  try {
    if (PAY_PATH.test(`${doc.location?.pathname ?? ""}`)) return true
    if (doc.querySelector("[autocomplete~=cc-number], [autocomplete~=cc-csc], [autocomplete~=cc-exp], apple-pay-button, [class*=apple-pay-button], gpay-button, [id*=paypal-button], [data-stripe]")) return true
    for (const f of Array.from(doc.querySelectorAll("iframe"))) {
      // Only a frame one can see: Stripe's, PayPal's and Klarna's scripts leave an invisible frame on every page of a
      // site that uses them (a restaurant site's home page read as a payment page, and its search box as «pay yourself»).
      if (!shownFrame(f)) continue
      const src = f.getAttribute("src") ?? ""
      let host = ""
      try {
        host = src ? new URL(src, doc.location?.href).hostname : ""
      } catch {
        host = ""
      }
      if (PAY_FRAME.test(host) || /card|payment|checkout|zahlung|paiement|pago|оплат/i.test(`${f.title} ${f.name}`)) return true
    }
  } catch {
    return false
  }
  return false
}

function shownFrame(f: HTMLIFrameElement): boolean {
  const r = f.getBoundingClientRect()
  if (r.width < 40 || r.height < 20) return false
  const view = f.ownerDocument.defaultView
  const cs = view?.getComputedStyle(f)
  return !cs || (cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity || "1") > 0.05)
}

/** Every amount of money the whole page shows (the plan's price check; the text above is only around the screen). */
// A booking that holds money (2.7.1): a deposit, a prepayment, a no-show or late-cancellation fee. The press that commits
// on such a page is the person's (classify.ts), whatever a plan or a rule allowed. (Only that press: a venue's policy
// line on every page mustn't stop the way to it.)
const DEPOSIT = /\b(deposit|prepay(ment)?|pre-?authori[sz]ation|no[- ]show fee|cancellation fee|late cancellation|card (is )?required to (book|reserve|hold))\b|депозит|предоплат|залог|штраф за (неявку|отмену)|списан\S* при неявке|anzahlung|kaution|no-show-gebühr|stornogebühr|acompte|frais d'annulation|frais de non-présentation|depósito|anticipo|señal|cargo por no presentarse|caparra|penale|depozito|kapora|ön ödeme|デポジット|前払い|キャンセル料|예약금|보증금|노쇼|定金|押金|订金|違約金|عربون|رسوم الإلغاء|tiền cọc|đặt cọc/i

function asksDeposit(doc: Document): boolean {
  try {
    return DEPOSIT.test((doc.body?.innerText ?? "").slice(0, 60_000))
  } catch {
    return false
  }
}

function pageMoney(doc: Document): number[] {
  try {
    return amounts((doc.body?.innerText ?? "").slice(0, 60_000)).slice(0, 80)
  } catch {
    return []
  }
}
