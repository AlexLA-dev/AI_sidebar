// Our scrolling against the page's touch handlers (2.6, the owner on an iPhone: on google.com neither the panel's
// chat nor Settings scrolled; on other sites they did). Touches in our closed root still bubble out to the page:
// past the host to <html>, the document and the window. A site that listens there with a non-passive touchmove and
// calls preventDefault (Google does, for its own gestures) cancels the browser's scrolling of our lists too.
//
// So, in our root: (1) touch events stop at the root on their way out, so the page's listeners on the way up
// (<html>, the document, the window, in the bubbling phase) never see them; (2) a touch the page cancelled before
// it reached us (a listener in the capturing phase, on the window or the document) still moves the list under the
// finger: we scroll it ourselves by the finger's travel, and let it glide a little after the finger lifts. Whether
// the page cancelled it is read as the event enters our root (capturing), before our own handlers run: a swipe of
// ours that cancels its touch (a chat row, the send button) is left alone.
//
// 2.7.1 (the owner on build 121, iPad with a Magic Keyboard: «когда я свайпаю так над областью чата — листается
// страница»): the page no longer scrolls under the panel. (3) A wheel (a trackpad's two fingers, a mouse) over the
// panel or one of our sheets is cancelled when nothing there under the pointer can scroll that way: a part that
// doesn't scroll (the header, the question field, a chat too short to scroll), or a list already at its top or bottom
// edge. (4) A finger that starts on a part of the panel with nothing to scroll under it doesn't drag the page either.
// The page's own scrolling elsewhere, our floating circle and the pop-ups over the page are left alone, as are the
// panel's drag (pointer events) and two-finger pinches.

const AXIS_SLOP = 6
// The glide after the finger lifts: velocity in px per ms, decaying each frame.
const GLIDE_DECAY = 0.95
const GLIDE_MIN = 0.02

function scrollable(el: Element, axis: "x" | "y"): boolean {
  return canScroll(boxOf(el), axis, 0)
}

/** What a scroll needs to know of an element: its overflow and how far it's scrolled. */
export interface ScrollBox {
  overflowX: string
  overflowY: string
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
}

function boxOf(el: Element): ScrollBox {
  const style = getComputedStyle(el)
  return {
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth
  }
}

/**
 * Whether `box` scrolls along `axis` at all (`delta` 0), or still has room the way of `delta` (px, + is down or to
 * the end). Right to left, scrollLeft runs from 0 to minus the room, so either sign is read by its size.
 */
export function canScroll(box: ScrollBox, axis: "x" | "y", delta: number): boolean {
  const overflow = axis === "y" ? box.overflowY : box.overflowX
  if (overflow !== "auto" && overflow !== "scroll") return false
  const room = axis === "y" ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth
  if (room <= 1) return false
  if (delta === 0) return true
  const at = Math.abs(axis === "y" ? box.scrollTop : box.scrollLeft)
  return delta < 0 ? at > 0.5 : at < room - 0.5
}

/**
 * A wheel over our elements (`chain`: from the one under the pointer up to our root): cancelled when none of them
 * can take it, so it doesn't go on to the page. The way is the bigger of the two deltas.
 */
export function wheelStops(chain: ScrollBox[], deltaX: number, deltaY: number): boolean {
  if (deltaX === 0 && deltaY === 0) return false
  const axis = Math.abs(deltaY) >= Math.abs(deltaX) ? "y" : "x"
  const delta = axis === "y" ? deltaY : deltaX
  return !chain.some((box) => canScroll(box, axis, delta))
}

/** A finger starting there (`chain` as for the wheel): held from dragging the page when nothing under it scrolls. */
export function touchStops(chain: ScrollBox[]): boolean {
  return !chain.some((box) => canScroll(box, "y", 0) || canScroll(box, "x", 0))
}

// The parts of our root that the page shouldn't scroll under: the panel and our sheets (on it or over the page).
const CONTAINED = ".cf-panel, .cf-sheet-back"
// Fields keep their own drags (a range's thumb, selecting text in a field).
const OWN_DRAG = "input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])"

function chainFrom(start: EventTarget | null): ScrollBox[] | null {
  const el = start instanceof Element ? start : null
  if (!el?.closest(CONTAINED)) return null
  const chain: ScrollBox[] = []
  for (let at: Element | null = el; at; at = at.parentElement) chain.push(boxOf(at))
  return chain
}

/** The nearest list from where the touch began that scrolls along `axis`, up to our root (its listener sees the
 * touch's own element: nothing in our root is hidden from it). */
function scrollerFrom(start: EventTarget | null, axis: "x" | "y"): HTMLElement | null {
  for (let el = start instanceof Element ? start : null; el; el = el.parentElement) {
    if (el instanceof HTMLElement && scrollable(el, axis)) return el
  }
  return null
}

export function guardScroll(root: ShadowRoot): () => void {
  let from: EventTarget | null = null
  let last: { x: number; y: number; t: number } | null = null
  let axis: "x" | "y" | null = null
  let scroller: HTMLElement | null = null
  let velocity = 0
  let glide = 0
  // The page cancelled this touch's scrolling: from then on the list follows the finger by our hand.
  let pageCancelled = false

  const stopGlide = () => {
    if (glide) cancelAnimationFrame(glide)
    glide = 0
  }

  // Entering our root: only the page's capturing listeners have run so far.
  const entering = (e: TouchEvent) => {
    if (e.type === "touchstart") {
      stopGlide()
      pageCancelled = e.defaultPrevented
    } else if (e.defaultPrevented) pageCancelled = true
  }

  // (4) This touch began where nothing scrolls, in the panel: its moves don't reach the page's scrolling.
  let holdPage = false

  const start = (e: TouchEvent) => {
    e.stopPropagation()
    const chain = e.touches.length === 1 && !(e.target instanceof Element && e.target.closest(OWN_DRAG)) ? chainFrom(e.target) : null
    holdPage = chain !== null && touchStops(chain)
    const p = e.touches[0]
    from = e.target
    last = p ? { x: p.clientX, y: p.clientY, t: e.timeStamp } : null
    axis = null
    scroller = null
    velocity = 0
  }

  const move = (e: TouchEvent) => {
    e.stopPropagation()
    if (holdPage && e.touches.length === 1 && e.cancelable) e.preventDefault()
    const p = e.touches[0]
    if (!p || !last || e.touches.length > 1) return
    const dx = p.clientX - last.x
    const dy = p.clientY - last.y
    if (!axis) {
      if (Math.abs(dx) < AXIS_SLOP && Math.abs(dy) < AXIS_SLOP) return
      axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x"
      scroller = scrollerFrom(from, axis)
    }
    if (pageCancelled && scroller) {
      const d = axis === "y" ? dy : dx
      if (axis === "y") scroller.scrollTop -= d
      else scroller.scrollLeft -= d
      const dt = Math.max(1, e.timeStamp - last.t)
      velocity = 0.8 * (d / dt) + 0.2 * velocity
    }
    last = { x: p.clientX, y: p.clientY, t: e.timeStamp }
  }

  const end = (e: TouchEvent) => {
    e.stopPropagation()
    const el = scroller
    const along = axis
    if (pageCancelled && el && along && Math.abs(velocity) > GLIDE_MIN) {
      let v = velocity
      let at = performance.now()
      const step = (now: number) => {
        const dt = now - at
        at = now
        if (along === "y") el.scrollTop -= v * dt
        else el.scrollLeft -= v * dt
        v *= Math.pow(GLIDE_DECAY, dt / 16)
        glide = Math.abs(v) > GLIDE_MIN ? requestAnimationFrame(step) : 0
      }
      glide = requestAnimationFrame(step)
    }
    last = null
    scroller = null
    pageCancelled = false
    holdPage = false
  }

  // (3) Wheels: a pinch (ctrlKey: the page's zoom) and one a control of ours already took are let be.
  const wheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || !e.cancelable) return
    const chain = chainFrom(e.target)
    if (chain && wheelStops(chain, e.deltaX, e.deltaY)) e.preventDefault()
  }

  const opts = { passive: true }
  const early = { passive: true, capture: true }
  root.addEventListener("touchstart", entering as EventListener, early)
  root.addEventListener("touchmove", entering as EventListener, early)
  root.addEventListener("touchstart", start as EventListener, opts)
  // Not passive: it may hold the page (4).
  root.addEventListener("touchmove", move as EventListener, { passive: false })
  root.addEventListener("wheel", wheel as EventListener, { passive: false })
  root.addEventListener("touchend", end as EventListener, opts)
  root.addEventListener("touchcancel", end as EventListener, opts)
  return () => {
    stopGlide()
    root.removeEventListener("touchstart", entering as EventListener, true)
    root.removeEventListener("touchmove", entering as EventListener, true)
    root.removeEventListener("touchstart", start as EventListener)
    root.removeEventListener("touchmove", move as EventListener)
    root.removeEventListener("touchend", end as EventListener)
    root.removeEventListener("touchcancel", end as EventListener)
    root.removeEventListener("wheel", wheel as EventListener)
  }
}
