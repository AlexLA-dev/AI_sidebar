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
