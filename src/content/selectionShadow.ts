// The page's selection inside the sites' open shadow roots (2.5 (77), the director: LinkedIn draws its messages and
// its new-post window in #interop-outlet's open root, and a selection there gave no bubble: no Ask AI, Google,
// Template, bell or eye). The document reports such a selection at the root's host, if at all, so readSelection
// found nothing. The root is the one the pointer last went down in; quick insert's rangeIn reads the selection
// there (the root's own getSelection in Chrome, getComposedRanges in Safari 17 and later).

import { listenAround } from "./around"
import { rangeIn } from "./insert/field"
import { closestComposed, shadowRootsOf } from "./insert/shadow"

let touched: Element | null = null

/**
 * Remembers where the pointer last went down, inside open roots too (the event's path, through listenAround: a
 * closed root, like the panel's, shows only its host). A long-press on iPhone and a drag on a Mac both start with it.
 */
export function trackPointer(doc: Document = document): () => void {
  return listenAround(doc, "pointerdown", (_, path) => {
    const target = path[0] as Node | undefined
    touched = target && target.nodeType === 1 ? (target as Element) : target?.parentElement ?? null
  }, doc)
}

/**
 * The selection inside the open shadow root the pointer last went down in (and the roots around it), or null:
 * none there, or it's in `host` (the panel, open in test builds).
 */
export function shadowSelection(host: string): Range | null {
  const el = touched
  if (!el?.isConnected || closestComposed(el, host)) return null
  for (const root of shadowRootsOf(el)) {
    for (const child of Array.from(root.children)) {
      const range = rangeIn(child)
      if (range && !range.collapsed && range.toString().trim()) return range
    }
  }
  return null
}
