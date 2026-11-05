// Where the button by a field goes (iPhone and iPad): never inside the field, never over anything of the
// site's. Sites keep their own buttons at a field's right edge (search, ×, the microphone, Send), and a
// single-line field's end is where the caret is; so the button sits outside the field, above its top-right
// corner, else beside it, else below it, at the first spot where nothing of the page lies underneath. When
// there's no such spot, there's no button: "/" and ⌃⇧V still open the list.

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
 * corner, to its right, below its bottom-right corner; each must be inside the view and free at its centre
 * and its four corners.
 */
export function buttonSpot(field: Rect, view: Box, free: Probe): { top: number; left: number } | null {
  if (field.bottom <= 0 || field.top >= view.height) return null
  const right = Math.min(field.right, view.width - GAP)
  const middle = field.top + Math.min(field.height, 44) / 2 - BUTTON / 2
  const spots = [
    { top: field.top - GAP - BUTTON, left: right - BUTTON },
    { top: middle, left: field.right + GAP },
    { top: field.bottom + GAP, left: right - BUTTON }
  ]
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

// A control anywhere up the tree (the icon inside a button); the rest only when it's the element itself (a
// focusable container or a page-wide click handler doesn't make every point taken).
const CONTROL = "a,button,label,summary,select,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],[role=slider]"
const MEDIA = "svg,img,picture,video,audio,canvas,iframe"
const ITSELF = "input,textarea,[contenteditable=''],[contenteditable='true'],[role=textbox],[role=combobox],[onclick],[tabindex]:not([tabindex='-1'])"

/**
 * A page point with nothing of the site's under it: no control, link, picture or frame, and no text of the
 * element there. Our own elements (the panel's host) don't count.
 */
export function pagePointFree(host: Element | null): Probe {
  return (x, y) => {
    const els = document.elementsFromPoint(x, y).filter((el) => el !== host && !host?.contains(el))
    const top = els[0] ? innermostAt(els[0], x, y) : undefined
    if (!top || top === document.documentElement || top === document.body) return true
    if (closestComposed(top, CONTROL) || closestComposed(top, MEDIA) || top.matches(ITSELF)) return false
    // Text right under the point: covering it hides what someone reads (a label, a hint, a price).
    for (const node of Array.from(top.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of Array.from(range.getClientRects())) {
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return false
      }
    }
    return true
  }
}

type PointScope = ShadowRoot & { elementsFromPoint?: (x: number, y: number) => Element[] }

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
