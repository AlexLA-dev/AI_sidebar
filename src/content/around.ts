// Presses and keys anywhere: on the page and in our own panel. The panel's shadow root is closed in what ships, and
// a listener on the page's document or window never sees inside a closed root: there composedPath() stops at the
// host, so a press on a menu's own item looked like a press outside it (the menu closed and the click fell through
// to the page). So it listens twice: in our root, where the path is whole, and on the page for everything else.

/** Calls `handler` with the event's whole path for every `type` event on the page and in the root `inside` is in. */
export function listenAround<K extends keyof DocumentEventMap>(
  inside: Node,
  type: K,
  handler: (e: DocumentEventMap[K], path: EventTarget[]) => void,
  page: Document | Window = document
): () => void {
  const root = inside.getRootNode()
  const host = root instanceof ShadowRoot ? root.host : null
  const onRoot = (e: Event) => handler(e as DocumentEventMap[K], e.composedPath())
  const onPage = (e: Event) => {
    const path = e.composedPath()
    // From inside our root: its own listener has the whole path.
    if (host && path.includes(host)) return
    handler(e as DocumentEventMap[K], path)
  }
  if (host) root.addEventListener(type, onRoot, true)
  page.addEventListener(type, onPage, true)
  return () => {
    if (host) root.removeEventListener(type, onRoot, true)
    page.removeEventListener(type, onPage, true)
  }
}
