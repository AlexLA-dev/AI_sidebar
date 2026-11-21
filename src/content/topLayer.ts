// Our host over a site's window that shows over everything (2.5 (81), the owner on an iPad: LinkedIn's "Start post"
// window over the dimmed feed had no button by its field, and after such windows the button and the selection
// bubble seemed gone until a reload).
//
// A modal <dialog> (showModal) and an open popover are drawn in the browser's top layer, above any z-index: our host,
// fixed at the end of <html> with the highest z-index, stays under it (the ✦ shows dimmed under the backdrop). A modal
// dialog also makes everything outside it inert: what we draw there can neither be seen nor pressed. So while the
// person works in such a window (a press or the focus in it), our host moves into it, as its last child: drawn with
// it, above its backdrop, and not inert. It goes back to <html> when the window closes, when it leaves the page (with
// our host in it), when the site's code takes our host out, and when the person is back on the page. And a site that
// marks our host inert, as it hides the page behind its own window, gets that undone: our host is never the site's
// to hide.

import { listenAround } from "./around"

function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    // a browser without :popover-open
    return false
  }
}

/** A window in the top layer: a modal dialog or an open popover (a full-screen element too). */
export function inTopLayer(el: Element): boolean {
  return matches(el, ":modal") || matches(el, ":popover-open")
}

export function keepOverTopLayer(host: HTMLElement): () => void {
  let parked: HTMLElement | null = null
  let watch: MutationObserver | null = null
  let closed: (() => void) | null = null

  const home = () => {
    watch?.disconnect()
    watch = null
    if (parked && closed) {
      parked.removeEventListener("close", closed)
      parked.removeEventListener("toggle", closed)
    }
    parked = null
    closed = null
    host.style.removeProperty("translate")
    if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host)
  }

  const park = (spot: HTMLElement) => {
    if (parked === spot && host.parentNode === spot) return
    home()
    parked = spot
    spot.appendChild(host)
    // A window with a transform holds its fixed boxes: our host is put back at the corner of the screen.
    const r = host.getBoundingClientRect()
    if (Math.abs(r.left) > 0.5 || Math.abs(r.top) > 0.5) host.style.setProperty("translate", `${-r.left}px ${-r.top}px`)
    closed = () => {
      if (!inTopLayer(spot)) home()
    }
    spot.addEventListener("close", closed)
    spot.addEventListener("toggle", closed)
    // Closed with no event of its own (the open attribute taken away), taken off the page with our host in it, or our
    // host taken out of it by the site's code.
    watch = new MutationObserver(() => {
      if (!spot.isConnected || host.parentNode !== spot || !inTopLayer(spot)) home()
    })
    watch.observe(spot, { attributes: true, attributeFilter: ["open"], childList: true })
    const root = spot.getRootNode()
    watch.observe(root instanceof ShadowRoot ? root : document.documentElement, { childList: true, subtree: true })
  }

  // Where the person is: inside a top-layer window, our host goes there; back on the page, it comes home.
  const follow = (_: Event, path: EventTarget[]) => {
    // Our own buttons (the path stops at our host when its root is closed) change nothing.
    if (path.includes(host)) return
    const spot = path.find((n) => (n as Node).nodeType === 1 && inTopLayer(n as Element)) as HTMLElement | undefined
    if (spot) park(spot)
    else if (parked) home()
  }

  // Never inert: a site hiding the page behind its window marks the other children of <html> and <body> so.
  const unhide = () => {
    if (host.hasAttribute("inert")) host.removeAttribute("inert")
  }
  const marks = new MutationObserver(unhide)
  marks.observe(host, { attributes: true, attributeFilter: ["inert"] })
  unhide()

  const stops = [
    listenAround(document, "pointerdown", follow),
    listenAround(document, "focusin", follow)
  ]
  return () => {
    for (const stop of stops) stop()
    marks.disconnect()
    home()
  }
}
