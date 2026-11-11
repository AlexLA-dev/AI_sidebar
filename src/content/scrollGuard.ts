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

const AXIS_SLOP = 6
// The glide after the finger lifts: velocity in px per ms, decaying each frame.
const GLIDE_DECAY = 0.95
const GLIDE_MIN = 0.02

function scrollable(el: Element, axis: "x" | "y"): boolean {
  const style = getComputedStyle(el)
  const overflow = axis === "y" ? style.overflowY : style.overflowX
  if (overflow !== "auto" && overflow !== "scroll") return false
  return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1
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

  const start = (e: TouchEvent) => {
    e.stopPropagation()
    const p = e.touches[0]
    from = e.target
    last = p ? { x: p.clientX, y: p.clientY, t: e.timeStamp } : null
    axis = null
    scroller = null
    velocity = 0
  }

  const move = (e: TouchEvent) => {
    e.stopPropagation()
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
  }

  const opts = { passive: true }
  const early = { passive: true, capture: true }
  root.addEventListener("touchstart", entering as EventListener, early)
  root.addEventListener("touchmove", entering as EventListener, early)
  root.addEventListener("touchstart", start as EventListener, opts)
  root.addEventListener("touchmove", move as EventListener, opts)
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
  }
}
