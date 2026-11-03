// What a copy on the page copied (⌘C, "Copy" in the iPhone's edit menu), for the Copied list — or null
// when it must never be kept: a password or card field, a form with one, Private Browsing (checked by
// the caller), a site the user excluded.

import { isControl, sensitiveField, sensitiveForm } from "./field"

/** Longest fragment kept; longer copies are cut (the list shows the start, the insert has it all). */
export const MAX_COPIED = 20_000

/** The element the copy came from: the focused field, or where the page selection starts. */
function copySource(doc: Document): Element | null {
  const active = doc.activeElement
  if (active && isControl(active)) return active
  const node = doc.getSelection()?.anchorNode ?? null
  return node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : active
}

/**
 * The text a copy event put on the clipboard. Read after the page's own handlers (window, bubbling):
 * a page that sets its own text (a "copy code" button, Google Docs) is taken at its word.
 */
export function copiedText(e: ClipboardEvent, doc: Document = document): string | null {
  const source = copySource(doc)
  if (source && (sensitiveField(source) || sensitiveForm(source))) return null
  if (source?.closest("contextflow-root")) return null
  let text = ""
  if (e.defaultPrevented) {
    try {
      text = e.clipboardData?.getData("text/plain") ?? ""
    } catch {
      text = ""
    }
  }
  if (!text && source && isControl(source)) {
    const el = source as HTMLInputElement
    try {
      if (el.selectionStart !== null && el.selectionEnd !== null) text = el.value.slice(el.selectionStart, el.selectionEnd)
    } catch {
      text = ""
    }
  }
  if (!text) text = doc.getSelection()?.toString() ?? ""
  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim()
  if (text.length < 2) return null
  return text.slice(0, MAX_COPIED)
}
