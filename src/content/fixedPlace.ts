// Where our `position: fixed` elements count from, against where the page's rects count from (2.7, the owner on an
// iPad mini in portrait, Gmail: the ring sat a quarter of the screen above the selection and the selection buttons
// under the system menu). Safari gives getBoundingClientRect from the visible part of the page, and places fixed
// elements from the layout viewport; the two part whenever the visible part is moved inside the page: a page zoomed
// with two fingers, a desktop page wider than a portrait iPad that was zoomed to read it, the keyboard up (quick
// insert's viewport() covers that case for its own windows). Chrome gives both from the layout viewport.
//
// Measured, not guessed from the browser: a zero-size fixed element of ours at 0,0 says where fixed coordinates start
// in rect coordinates, whatever the engine, the zoom, the orientation, or a transform around our root.

interface Probe {
  isConnected: boolean
  getBoundingClientRect(): { left: number; top: number }
}

let probe: Probe | null = null

/** The panel's own fixed element at 0,0 (App renders it), or null when the panel goes. */
export function setFixedProbe(el: Probe | null): void {
  probe = el
}

/** What to add to a rect's left and top to get the same place in `position: fixed` coordinates. */
export function fixedShift(): { dx: number; dy: number } {
  if (!probe?.isConnected) return { dx: 0, dy: 0 }
  const at = probe.getBoundingClientRect()
  // Whole pixels aside, a still page gives exactly 0: no new rect then.
  return { dx: Math.abs(at.left) < 0.01 ? 0 : -at.left, dy: Math.abs(at.top) < 0.01 ? 0 : -at.top }
}

/** A rect from the page (getBoundingClientRect) in `position: fixed` coordinates. */
export function toFixed(rect: DOMRect): DOMRect {
  const { dx, dy } = fixedShift()
  return dx === 0 && dy === 0 ? rect : new DOMRect(rect.left + dx, rect.top + dy, rect.width, rect.height)
}

/** The visible part of the page in `position: fixed` coordinates. */
export interface VisibleBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** The system edit menu on iPhone and iPad: centred on the selection, kept on screen; about this wide (Cut … Format ›). */
const MENU_WIDTH = 520

/**
 * Where the selection buttons go when neither below nor above the selection has room for them clear of the system
 * menu (2.7: an iPad mini in landscape with the keyboard up leaves 230 pt of page, and the menu lay over the buttons'
 * first row): beside the menu, level with the selection. `clear` is how far the buttons keep from the selection for
 * the menu's sake. null when a side has room (the usual rule holds), when the screen isn't wide enough (iPhone, iPad
 * in portrait), or when the selection itself reaches under that place.
 */
export function besideMenu(rect: { left: number; right: number; top: number; bottom: number }, width: number, height: number, view: VisibleBox, clear: number, k = 1): { left: number; top: number } | null {
  // `k`: a point of the screen in the page's pixels (under 1 on a zoomed page); the menu and the gaps are the screen's.
  const gap = 8 * k
  const menu = MENU_WIDTH * k
  if (rect.bottom + clear + height <= view.bottom - 12 * k || rect.top - clear - height >= view.top + gap) return null
  const center = (rect.left + rect.right) / 2
  const menuLeft = Math.max(view.left + gap, Math.min(view.right - gap - menu, center - menu / 2))
  const menuRight = menuLeft + menu
  const top = Math.max(view.top + gap, Math.min(view.bottom - height - 12 * k, rect.top - gap))
  const right = menuRight + gap
  if (right + width <= view.right - gap && rect.right <= right - gap) return { left: right, top }
  const left = menuLeft - gap - width
  if (left >= view.left + gap && rect.left >= left + width + gap) return { left, top }
  return null
}

/**
 * A point of the screen in the page's pixels: 1 on a page as it opened, 1 / zoom on a zoomed one (2.7: Safari zooms
 * the page when a field with small text takes the focus, and our selection buttons, magnified with it, ran past the
 * right edge on iPhone). The buttons are drawn at this scale, so they keep their size on the glass.
 */
export function glassScale(zoom: number | undefined): number {
  return zoom && zoom > 1.02 ? 1 / zoom : 1
}
