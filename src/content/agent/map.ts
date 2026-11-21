// The agent's page map (2.7.1): the controls a person could use on the page now, numbered, with their role, name,
// value and state, plus the words around them. The model acts by these numbers; it never sees the HTML or a picture.
// - Open shadow roots and same-origin frames are walked (sites' components, editors in frames); our own panel never.
// - Hidden things are left out (display:none, visibility, aria-hidden, inert, zero size), except a checkbox or a
//   radio a site draws over with its label (the label is what shows; the input is what's pressed).
// - A number stays with its element as long as the element lives: nothing is written into the page's DOM.
// - Secret fields (passwords, cards, codes, documents) and personal ones (names, contacts, birth dates) are in the
//   map without their values: the model sees "filled" or "empty". So what Safari AutoFill or the person typed
//   never reaches it.

import { fieldLock } from "../../shared/agent/fields"
import { hostOf, sameSite } from "../../shared/agent/sites"
import type { Lock, MapItem, PageForm, PageMap, Role } from "../../shared/agent/types"
import { isOwnHost } from "../insert/field"
import { OVERLAY } from "../translate/pageControls"

const CONTROL = [
  "a[href]", "button", "input", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]",
  "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=combobox]", "[role=listbox]", "[role=slider]",
  "[role=spinbutton]", "[role=textbox]", "[role=searchbox]", "[role=treeitem]",
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

/** The element's name as a person reads it (an approximation of its accessible name). */
export function nameOf(el: Element, role: Role): string {
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
}

/** Where the element shows, in the top window: its own box, or its label's for an input a site draws over. */
function boxOf(f: Found, role: Role): Box | null {
  const r = f.el.getBoundingClientRect()
  let box: Box = { top: r.top + f.dy, bottom: r.bottom + f.dy, width: r.width, height: r.height }
  const tiny = r.width < 2 || r.height < 2
  const noLayout = r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0
  if (tiny && (role === "checkbox" || role === "radio" || role === "switch")) {
    const label = f.el.closest("label") ?? (f.el.id ? f.el.ownerDocument.querySelector(`label[for="${CSS.escape(f.el.id)}"]`) : null)
    if (label) {
      const l = label.getBoundingClientRect()
      if (l.width >= 2 && l.height >= 2) box = { top: l.top + f.dy, bottom: l.bottom + f.dy, width: l.width, height: l.height }
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

function optionsOf(el: Element, role: Role): string[] | undefined {
  if (role === "select" || (role === "listbox" && tag(el) === "select")) {
    return Array.from((el as HTMLSelectElement).options).slice(0, 30).map((o) => squash(o.textContent, 60)).filter(Boolean)
  }
  if (role === "listbox") {
    const list = Array.from(el.querySelectorAll("[role=option]")).slice(0, 30).map((o) => squash(o.textContent, 60)).filter(Boolean)
    return list.length ? list : undefined
  }
  return undefined
}

// ------------------------------------------------------------ the page's words

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
  for (const m of Array.from(doc.querySelectorAll(MESSAGE))) if (!hiddenByStyle(m)) add(`[message] ${textOf(m)}`)
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

  const items: Array<MapItem & { order: number }> = []
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
    const item: MapItem & { order: number } = { id: idOf(el, f.frame), role, label, order }
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
    const form = formOf(el)
    if (form !== undefined) item.form = form
    if (role === "link") {
      const href = hrefOf(el, pageHost)
      if (href) item.href = href
    }
    const options = optionsOf(el, role)
    if (options?.length) item.options = options
    items.push(item)
  })

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

  const rank = (i: MapItem) => (i.where === "dialog" ? 0 : i.where === undefined ? 1 : i.where === "below" ? 2 : 3)
  items.sort((a, b) => rank(a) - rank(b) || a.order - b.order)
  const size = opts.size ?? PART_SIZE
  const parts = Math.max(1, Math.ceil(items.length / size))
  const part = Math.min(Math.max(1, opts.part ?? 1), parts)
  const slice = items.slice((part - 1) * size, part * size).map(({ order: _order, ...rest }) => rest)
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
    ...(consent ? { consent: true } : {})
  }
}
