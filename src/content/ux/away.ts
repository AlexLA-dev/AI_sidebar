// "A tap elsewhere" for the panel's menus and swipes, with the panel's shadow root open or closed (2.5: closed in
// release builds). A listener on the document sees an event from inside a closed root with a path that ends at the
// host, so taps inside the panel are told apart by a listener on the shadow root itself, and taps on the page by
// the one on the document. Checking the document's path alone closed a menu on the tap that chose its item, and
// that tap went through to whatever was under the menu.

/** Calls `away` on a pointerdown that `inside` doesn't claim (it gets the event's full path); returns the cleanup. */
export function onTapAway(el: Element, inside: (path: EventTarget[]) => boolean, away: () => void): () => void {
  const root = el.getRootNode()
  const host = root instanceof ShadowRoot ? root.host : null
  const onRoot = (e: Event) => {
    if (!inside(e.composedPath())) away()
  }
  const onDocument = (e: Event) => {
    const path = e.composedPath()
    // From inside the panel: the shadow root's listener has decided.
    if (host && path.includes(host)) return
    if (!inside(path)) away()
  }
  if (host) root.addEventListener("pointerdown", onRoot, true)
  document.addEventListener("pointerdown", onDocument, true)
  return () => {
    if (host) root.removeEventListener("pointerdown", onRoot, true)
    document.removeEventListener("pointerdown", onDocument, true)
  }
}

/** Whether a path goes through an element with this class (a menu's own "…" toggles it). */
export const throughClass = (path: EventTarget[], cls: string): boolean => path.some((el) => (el as Element).classList?.contains(cls))
