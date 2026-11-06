// Where the button by a field goes (iPhone and iPad): never inside the field, never over anything of the
// site's. Sites keep their own buttons at a field's right edge (search, ×, the microphone, Send), and a
// single-line field's end is where the caret is; so the button sits outside the field, above its top-right
// corner, else beside it, else below it, at the first spot where nothing of the page lies underneath. A chat's
// reply box has all three taken (a read receipt or the last message over its corner, "expand" beside it, Send
// under it: the owner on 2.5 (77), LinkedIn's messages), so then the spots go on along its top edge and its
// bottom edge, leftwards from the corner. When those are all taken too (the suggested replies above, the keyboard
// below), a multi-line field gets the button inside its visible bottom-right corner, as Grammarly's sits (the
// director's decision: the last place tried), never over the caret, the text or anything of the site's in it;
// when the text reaches the corner, the button goes. A single-line input never gets it inside. When there's no
// spot at all, there's no button: "/" and ⌃⇧V still open the list.

import { closestComposed, shadowRootsOf } from "./shadow.ts"

/** The button's size and the gap it keeps from the field. */
export const BUTTON = 30
const GAP = 4

export interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }
export interface Box { width: number; height: number }

/** Whether a page point is free: nothing of the page's under it but its plain background. */
export type Probe = (x: number, y: number) => boolean

/**
 * The button's top-left corner (viewport coordinates), or null. Tried in order: above the field's top-right
 * corner, to its right, below its bottom-right corner; then along the field's top edge and its bottom edge,
 * leftwards from the corner a button's width at a time. Each must be inside the view and free at its centre
 * and its four corners.
 */
export function buttonSpot(field: Rect, view: Box, free: Probe): { top: number; left: number } | null {
  if (field.bottom <= 0 || field.top >= view.height) return null
  const right = Math.min(field.right, view.width - GAP)
  const middle = field.top + Math.min(field.height, 44) / 2 - BUTTON / 2
  const above = field.top - GAP - BUTTON
  const below = field.bottom + GAP
  const spots = [
    { top: above, left: right - BUTTON },
    { top: middle, left: field.right + GAP },
    { top: below, left: right - BUTTON }
  ]
  const lefts: number[] = []
  for (let left = right - 2 * BUTTON; left >= Math.max(GAP, field.left); left -= BUTTON) lefts.push(left)
  for (const top of [above, below]) for (const left of lefts) spots.push({ top, left })
  for (const s of spots) {
    if (s.top < GAP || s.left < GAP || s.top + BUTTON > view.height - GAP || s.left + BUTTON > view.width - GAP) continue
    const points = [
      [s.left + BUTTON / 2, s.top + BUTTON / 2],
      [s.left + 2, s.top + 2],
      [s.left + BUTTON - 2, s.top + 2],
      [s.left + 2, s.top + BUTTON - 2],
      [s.left + BUTTON - 2, s.top + BUTTON - 2]
    ]
    if (points.every(([x, y]) => free(x, y))) return s
  }
  return null
}

/** How far the button keeps from the field's edges inside it, and from the text and the caret. */
const INSET = 4
const CLEAR = 4

/** A multi-line field: a textarea, or an editor (contenteditable) that isn't marked single-line. */
export function multiLineField(el: Element): boolean {
  const tag = el.tagName.toUpperCase()
  if (tag === "TEXTAREA") return true
  if (tag === "INPUT") return false
  return el.getAttribute("aria-multiline") !== "false"
}

/** How far the button keeps from our panel when it's open beside the page (QuickInsert). */
export const PANEL_CLEAR = 8

/** Whether a point is inside `r` or within `margin` of it. */
export function nearRect(r: { left: number; top: number; right: number; bottom: number }, x: number, y: number, margin: number): boolean {
  return x > r.left - margin && x < r.right + margin && y > r.top - margin && y < r.bottom + margin
}

const meets = (a: Rect | { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/**
 * The button inside a multi-line field, at the bottom-right corner of the part of it in view; or null when the
 * field is too small for it, when the text or the caret (`text`, viewport rects) come near that corner, or when
 * something of the site's lies there.
 */
export function cornerSpot(field: Rect, view: Box, free: Probe, text: Array<{ left: number; top: number; right: number; bottom: number }>): { top: number; left: number } | null {
  const bottom = Math.min(field.bottom, view.height - GAP)
  const right = Math.min(field.right, view.width - GAP)
  // A reply box one line tall (a phone's chat) takes it in the middle of its height; shorter than that, none.
  const inset = Math.min(INSET, (bottom - Math.max(field.top, GAP) - BUTTON) / 2)
  if (inset < 2) return null
  const s = { top: bottom - inset - BUTTON, left: right - INSET - BUTTON }
  if (s.left < Math.max(field.left + INSET, GAP)) return null
  const zone = { left: s.left - CLEAR, top: s.top - CLEAR, right: s.left + BUTTON + CLEAR, bottom: s.top + BUTTON + CLEAR }
  if (text.some((r) => meets(r, zone))) return null
  const points = [
    [s.left + BUTTON / 2, s.top + BUTTON / 2],
    [s.left + 2, s.top + 2],
    [s.left + BUTTON - 2, s.top + 2],
    [s.left + 2, s.top + BUTTON - 2],
    [s.left + BUTTON - 2, s.top + BUTTON - 2]
  ]
  return points.every(([x, y]) => free(x, y)) ? s : null
}

/**
 * Where the button goes, in the order settled on 2.5 (77): outside the field (above its corner, beside it, below
 * it, then along its top edge and its bottom edge), and only then inside a multi-line field's corner (`inside`,
 * null for a one-line input). The text is measured only when it comes to that.
 */
export function buttonPlace(field: Rect, view: Box, outside: Probe, inside: { free: Probe; text: () => Array<{ left: number; top: number; right: number; bottom: number }> } | null): { top: number; left: number; inside: boolean } | null {
  const out = buttonSpot(field, view, outside)
  if (out) return { ...out, inside: false }
  if (!inside) return null
  const corner = cornerSpot(field, view, inside.free, inside.text())
  return corner ? { ...corner, inside: true } : null
}

// A control anywhere up the tree (the icon inside a button); the rest only when it's the element itself (a
// focusable container or a page-wide click handler doesn't make every point taken).
const CONTROL = "a,button,label,summary,select,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],[role=slider]"
const MEDIA = "svg,img,picture,video,audio,canvas,iframe"
const ITSELF = "input,textarea,[contenteditable=''],[contenteditable='true'],[role=textbox],[role=combobox],[onclick],[tabindex]:not([tabindex='-1'])"

/**
 * A page point with nothing of the site's under it: no control, link, picture or frame, and no text of the
 * element there. Our own elements (the panel's host) don't count. A same-origin frame is looked into: what's at
 * that point in it counts (2.5 (83), the owner: LinkedIn's messages, opened from the feed, are drawn in a frame the
 * size of the page, and every point over it counted as taken, so the button by the reply box never came).
 */
export function pagePointFree(host: Element | null): Probe {
  return (x, y) => {
    const hit = hitAt(x, y, host)
    const top = hit?.el
    const doc = top?.ownerDocument
    if (!top || !doc || top === doc.documentElement || top === doc.body) return true
    if (closestComposed(top, CONTROL) || closestComposed(top, MEDIA) || top.matches(ITSELF)) return false
    // Text right under the point: covering it hides what someone reads (a label, a hint, a price).
    for (const node of Array.from(top.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
      const range = doc.createRange()
      range.selectNodeContents(node)
      for (const r of Array.from(range.getClientRects())) {
        if (hit.x >= r.left - 2 && hit.x <= r.right + 2 && hit.y >= r.top - 2 && hit.y <= r.bottom + 2) return false
      }
    }
    return true
  }
}

/**
 * A point inside the field with only the field there: its own surface, not a control, a picture or a widget of the
 * site's inside it, and not something of the site's lying over it. (Its text is checked apart, by its rects.)
 */
export function fieldPointFree(field: Element, host: Element | null): Probe {
  return (x, y) => {
    const top = hitAt(x, y, host)?.el
    if (!top || (top !== field && !field.contains(top))) return false
    // Only what's inside the field counts (a label around a textarea doesn't make it taken).
    for (let el: Element | null = top; el && el !== field; el = el.parentElement) {
      if (el.matches(CONTROL) || el.matches(MEDIA) || el.matches("[contenteditable=false]")) return false
    }
    return true
  }
}

type PointScope = ShadowRoot & { elementsFromPoint?: (x: number, y: number) => Element[] }

/** A frame's document when it's the page's own origin (an ad's about:blank too), else null. */
function frameDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

/**
 * What's at a page point (viewport coordinates of the top page, our host left out), through open shadow roots and
 * into same-origin frames; with the point in that element's own document.
 */
function hitAt(x: number, y: number, host: Element | null): { el: Element; x: number; y: number } | null {
  let doc: Document = document
  for (let n = 0; n < 4; n++) {
    const els = doc.elementsFromPoint(x, y).filter((el) => el !== host && !host?.contains(el))
    if (!els[0]) return null
    const el = innermostAt(els[0], x, y)
    const inner = el.tagName === "IFRAME" ? frameDocument(el as HTMLIFrameElement) : null
    if (!inner) return { el, x, y }
    const r = el.getBoundingClientRect()
    x -= r.left + el.clientLeft
    y -= r.top + el.clientTop
    doc = inner
  }
  return null
}

/** What's at a point inside open shadow roots: the document finds their host only. */
function innermostAt(top: Element, x: number, y: number): Element {
  let el = top
  for (let n = 0; n < 16; n++) {
    const root = el.shadowRoot as PointScope | null
    const inner = root?.elementsFromPoint?.(x, y).find((e) => e !== el && root.contains(e))
    if (!inner) break
    el = inner
  }
  return el
}

const SEARCH_WORDS = /search|query|\bq\b|поиск|найти|пошук|suche|suchen|recherche|rechercher|buscar|búsqueda|cerca|ricerca|pesquis|busca|検索|검색|搜索/i

/**
 * Fields the button stays away from: searches (a template is rarely what goes there, and the site's own
 * search button sits at the end of it), and short single values: an email, a phone, a link, a number, a code.
 */
export function noButtonField(el: Element): boolean {
  if (el.tagName.toUpperCase() === "INPUT") {
    const input = el as HTMLInputElement
    if (input.type !== "text" && input.type !== "") return true // search, email, url, tel (and others aren't fields here)
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase()
    if (/\b(one-time-code|email|username|tel|url)\b/.test(auto)) return true
    if (/^(numeric|decimal|tel|email|url|search)$/.test(el.getAttribute("inputmode") ?? "")) return true
    if (el.getAttribute("enterkeyhint") === "search") return true
  }
  const role = el.getAttribute("role") ?? ""
  if (role === "searchbox" || closestComposed(el, "[role=search],search,form[action*=search i],form[role=search]")) return true
  // A search component of a design system, the field inside its own root (Reddit's faceplate-search-input; not
  // a research-notes editor).
  if (shadowRootsOf(el).some((root) => /(^|-)search(-|$)/i.test(root.host.tagName))) return true
  const named = `${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`
  return el.tagName.toUpperCase() === "INPUT" && SEARCH_WORDS.test(named)
}

// ------------------------------------------------------------ quick insert's windows (place.ts)

type Edges = { left: number; top: number; right: number; bottom: number }

const SIDE_GAP = 8
// The narrowest a window beside the field gets; narrower, it goes by the caret or as a sheet.
export const SIDE_MIN = 300

/**
 * A window for a field, beside it rather than over it (2.5 (83), the owner: over a chat's reply box it hid the box;
 * beside it where there's room, else over the field as before, never over the conversation above it). Right of the
 * field first, then left, its bottom level with the field's (kept on screen); never on `avoid` (our panel open beside
 * the page) nor right against it. Null when neither side has room for SIDE_MIN.
 */
export function besideSpot(field: Edges, view: { width: number; height: number }, width: number, height: number, avoid: Edges | null): { left: number; top: number; width: number } | null {
  if (field.bottom <= SIDE_GAP || field.top >= view.height - SIDE_GAP) return null
  const top = Math.max(SIDE_GAP, Math.min(field.bottom, view.height - SIDE_GAP) - height)
  const bottom = top + height
  const clear = (left: number, right: number) =>
    !avoid || right <= avoid.left - SIDE_GAP || left >= avoid.right + SIDE_GAP || bottom <= avoid.top || top >= avoid.bottom
  // The room on each side: up to the screen's edge, or to the panel when it's on that side, level with the window.
  const level = Boolean(avoid && avoid.top < bottom && avoid.bottom > top)
  const rightEnd = level && avoid!.left >= field.right ? Math.min(view.width - SIDE_GAP, avoid!.left - SIDE_GAP) : view.width - SIDE_GAP
  const leftEnd = level && avoid!.right <= field.left ? Math.max(SIDE_GAP, avoid!.right + SIDE_GAP) : SIDE_GAP
  const right = { left: field.right + SIDE_GAP, width: Math.min(width, rightEnd - field.right - SIDE_GAP) }
  if (right.width >= SIDE_MIN && clear(right.left, right.left + right.width)) return { top, ...right }
  const w = Math.min(width, field.left - SIDE_GAP - leftEnd)
  const left = { left: field.left - SIDE_GAP - w, width: w }
  if (left.width >= SIDE_MIN && clear(left.left, left.left + left.width)) return { top, ...left }
  return null
}
