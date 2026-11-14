// What a copy or a cut on the page put on the clipboard (⌘C, ⌘X, "Copy" and "Cut" in the iPhone's edit menu),
// for the Copied list — or null when it must never be kept: a password or card field, a form with one,
// Private Browsing (checked by the caller), a site the user excluded.
// The owner on 2.7: cut text never reached Copied (only `copy` was listened to).

import { activeIn, fromOwnUi, isControl, sensitiveField, sensitiveForm } from "./field"

/** Longest fragment kept; longer copies are cut (the list shows the start, the insert has it all). */
export const MAX_COPIED = 20_000

/**
 * The element the copy came from: the focused field (inside an open shadow root too: the document's
 * activeElement is its host), or where the page selection starts.
 */
function copySource(doc: Document): Element | null {
  const active = activeIn(doc)
  if (active && isControl(active)) return active
  const node = doc.getSelection()?.anchorNode ?? null
  return node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : active
}

/**
 * The text a copy or cut event put on the clipboard. Read after the page's own handlers (window, bubbling):
 * a page that sets its own text (a "copy code" button, Google Docs, an editor's own cut) is taken at its word.
 */
export function copiedText(e: ClipboardEvent, doc: Document = document): string | null {
  if (fromOwnUi(e)) return null
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

export type ClipboardPhase = "capture" | "bubble"

/**
 * Keeps what copies and cuts on the page put on the clipboard. Each event comes twice (watch.ts): at capture
 * on the document, while the selection is still whole, and at bubble on the window, after the page's own
 * handlers. What capture saw is kept when the page stops the event before it bubbles up, and for a cut also
 * when nothing is left to read at bubble: an editor that cuts by itself (ProseMirror, Lexical) has removed
 * the text by then, and one that puts only HTML on the clipboard leaves no plain text either.
 */
export function clipboardKeeper(keep: (text: string) => void): (e: ClipboardEvent, doc: Document, phase: ClipboardPhase) => void {
  let seen: { e: ClipboardEvent; early: string | null; done: boolean } | null = null
  return (e, doc, phase) => {
    if (phase === "capture") {
      const state = { e, early: copiedText(e, doc), done: false }
      seen = state
      setTimeout(() => {
        if (!state.done && state.early) keep(state.early)
      }, 0)
      return
    }
    const state = seen?.e === e ? seen : null
    if (state) state.done = true
    const text = copiedText(e, doc) ?? (e.type === "cut" ? state?.early ?? null : null)
    if (text) keep(text)
  }
}
