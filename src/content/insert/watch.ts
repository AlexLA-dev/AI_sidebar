// Follows the field the user types in, on the page and in same-origin iframes (TinyMCE, CKEditor 4:
// WebKit sends no focusin up when the focus goes into a frame, so the frames are watched themselves),
// and where things go on screen: the caret, the field, the visible part of the page.
//
// Fields in open shadow roots (LinkedIn, Reddit, Salesforce): a focus event reaches the document with the
// root's host as its target, so the field is the element inside that has the focus; and when the focus moves
// inside one root, the document hears nothing at all, so each root met on the way is listened to as well.

import { activeIn, editableAt, focusedTarget, fromOwnUi, hasFocus, readField, updateCaret, isControl, type Field } from "./field"
import { shadowRootsOf } from "./shadow"

export interface WatchHandlers {
  focus(field: Field): void
  // The focus left the field (and didn't come to another one).
  blur(): void
  // Typing in the field: "/phrase" is looked for after it (not while an IME is composing).
  input(field: Field, composing: boolean): void
  // Every key, before the page's editor sees it (window, capture): the list's own keys.
  keydown(e: KeyboardEvent): void
  copy(e: ClipboardEvent, doc: Document, phase: "capture" | "bubble"): void
}

/** Starts watching; returns the function that stops it. */
export function watchFields(h: WatchHandlers): () => void {
  const stops: Array<() => void> = []
  const watched = new WeakSet<Document | ShadowRoot>()
  // A focus event heard both by the document and by a root on its way counts once.
  const heard = new WeakSet<Event>()
  let field: Field | null = null
  let blurTimer: ReturnType<typeof setTimeout> | undefined

  const onFocus = (e: Event) => {
    if (heard.has(e)) return
    heard.add(e)
    if (fromOwnUi(e)) return
    const target = focusedTarget(e)
    for (const root of target ? shadowRootsOf(target) : []) trackRoot(root)
    const el = editableAt(target)
    if (!el) return
    clearTimeout(blurTimer)
    field = readField(el)
    h.focus(field)
  }
  const onBlur = (e: Event) => {
    if (heard.has(e)) return
    heard.add(e)
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      if (field && !fieldHasFocus(field)) h.blur()
    }, 120)
  }

  /** A shadow root: the focus moving inside it, and the iframes in it. */
  const trackRoot = (root: ShadowRoot) => {
    if (watched.has(root)) return
    watched.add(root)
    root.addEventListener("focusin", onFocus, true)
    root.addEventListener("focusout", onBlur, true)
    root.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
    const added = new MutationObserver(framesAdded)
    added.observe(root, { childList: true, subtree: true })
    stops.push(() => {
      root.removeEventListener("focusin", onFocus, true)
      root.removeEventListener("focusout", onBlur, true)
      added.disconnect()
    })
  }

  const track = (doc: Document) => {
    if (watched.has(doc)) return
    watched.add(doc)
    const win = doc.defaultView
    const onMove = () => {
      if (field && field.el.ownerDocument === doc) field = updateCaret(field)
    }
    const onInput = (e: Event) => {
      // Typing in another field than the one followed (its focus wasn't heard): that one from now on.
      const typed = fromOwnUi(e) ? null : editableAt(focusedTarget(e))
      if (typed && typed !== field?.el) {
        clearTimeout(blurTimer)
        field = readField(typed)
        h.focus(field)
      }
      if (!field || field.el.ownerDocument !== doc) return
      field = updateCaret(field)
      h.input(field, (e as InputEvent).isComposing === true)
    }
    const onCompositionEnd = () => {
      if (!field || field.el.ownerDocument !== doc) return
      field = updateCaret(field)
      h.input(field, false)
    }
    const onKey = (e: KeyboardEvent) => h.keydown(e)
    const onCopyCapture = (e: Event) => h.copy(e as ClipboardEvent, doc, "capture")
    const onCopyBubble = (e: Event) => h.copy(e as ClipboardEvent, doc, "bubble")
    doc.addEventListener("focusin", onFocus, true)
    doc.addEventListener("focusout", onBlur, true)
    for (const type of ["keyup", "selectionchange", "mouseup", "touchend"]) doc.addEventListener(type, onMove, true)
    doc.addEventListener("input", onInput, true)
    doc.addEventListener("compositionend", onCompositionEnd, true)
    win?.addEventListener("keydown", onKey, true)
    doc.addEventListener("copy", onCopyCapture, true)
    win?.addEventListener("copy", onCopyBubble)
    stops.push(() => {
      doc.removeEventListener("focusin", onFocus, true)
      doc.removeEventListener("focusout", onBlur, true)
      for (const type of ["keyup", "selectionchange", "mouseup", "touchend"]) doc.removeEventListener(type, onMove, true)
      doc.removeEventListener("input", onInput, true)
      doc.removeEventListener("compositionend", onCompositionEnd, true)
      win?.removeEventListener("keydown", onKey, true)
      doc.removeEventListener("copy", onCopyCapture, true)
      win?.removeEventListener("copy", onCopyBubble)
    })
  }

  const watchFrame = (frame: HTMLIFrameElement) => {
    const attach = () => {
      try {
        const inner = frame.contentDocument
        if (inner) track(inner)
      } catch {
        // another origin: out of reach
      }
    }
    attach()
    frame.addEventListener("load", attach)
  }

  function framesAdded(records: MutationRecord[]): void {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        const el = n as Element
        if (el.tagName === "IFRAME") watchFrame(el as HTMLIFrameElement)
        else if (el.querySelectorAll) el.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
      }
    }
  }

  track(document)
  document.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
  const frames = new MutationObserver(framesAdded)
  frames.observe(document.documentElement, { childList: true, subtree: true })

  // A field already focused when the panel started (the page autofocuses its editor).
  const active = deepActive()
  for (const root of active ? shadowRootsOf(active) : []) trackRoot(root)
  const el = editableAt(active)
  if (el) {
    field = readField(el)
    h.focus(field)
  }

  return () => {
    frames.disconnect()
    clearTimeout(blurTimer)
    for (const stop of stops) stop()
  }
}

/** The focused element, inside a same-origin iframe or an open shadow root if the focus is there. */
export function deepActive(): Element | null {
  let el: Element | null = activeIn(document)
  while (el && el.tagName === "IFRAME") {
    try {
      const inner = (el as HTMLIFrameElement).contentDocument
      if (!inner) break
      el = activeIn(inner)
    } catch {
      break
    }
  }
  return el
}

export function fieldHasFocus(field: Field): boolean {
  return hasFocus(field.el)
}

// ------------------------------------------------------------ where things are

/** The element's rect in the top page's coordinates (an iframe's offset added). */
export function pageRect(el: Element): DOMRect {
  let rect = el.getBoundingClientRect()
  let win = el.ownerDocument.defaultView
  while (win && win !== window && win.frameElement) {
    const frame = win.frameElement as HTMLElement
    const fr = frame.getBoundingClientRect()
    rect = new DOMRect(rect.left + fr.left + frame.clientLeft, rect.top + fr.top + frame.clientTop, rect.width, rect.height)
    win = frame.ownerDocument.defaultView
  }
  return rect
}

/** The caret's rect (top page coordinates), or the field's top-left corner when it can't be told. */
export function caretRect(field: Field): DOMRect {
  const el = field.el
  if (isControl(el)) return controlCaret(el as HTMLInputElement, field.start)
  const range = field.range
  if (range) {
    const rects = range.getClientRects()
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    if (r && (r.width || r.height)) return offsetByFrame(el, new DOMRect(r.left, r.top, Math.max(1, r.width), r.height))
    // A collapsed range on an empty line has no rect: a marker shows where it is.
    const doc = el.ownerDocument
    const mark = doc.createElement("span")
    mark.textContent = "​"
    const probe = range.cloneRange()
    probe.insertNode(mark)
    const mr = mark.getBoundingClientRect()
    mark.remove()
    return offsetByFrame(el, new DOMRect(mr.left, mr.top, 1, mr.height))
  }
  const r = pageRect(el)
  return new DOMRect(r.left + 8, r.top + 4, 1, 20)
}

function offsetByFrame(el: Element, rect: DOMRect): DOMRect {
  const top = pageRect(el.ownerDocument.body ?? el)
  const own = (el.ownerDocument.body ?? el).getBoundingClientRect()
  return new DOMRect(rect.left + top.left - own.left, rect.top + top.top - own.top, rect.width, rect.height)
}

const MIRROR_STYLES = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "textIndent", "tabSize"
] as const

/** Where the caret is in an input or textarea: a hidden copy of the field, measured up to the caret. */
function controlCaret(el: HTMLInputElement | HTMLTextAreaElement, at: number): DOMRect {
  const doc = el.ownerDocument
  const style = doc.defaultView!.getComputedStyle(el)
  const mirror = doc.createElement("div")
  for (const key of MIRROR_STYLES) (mirror.style as unknown as Record<string, string>)[key] = style[key as keyof CSSStyleDeclaration] as string
  const multi = el.tagName.toUpperCase() === "TEXTAREA"
  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.style.whiteSpace = multi ? "pre-wrap" : "pre"
  mirror.style.overflowWrap = multi ? "break-word" : "normal"
  mirror.textContent = el.value.slice(0, at)
  const mark = doc.createElement("span")
  mark.textContent = el.value.slice(at) || "."
  mirror.appendChild(mark)
  doc.body.appendChild(mirror)
  const left = mark.offsetLeft
  const top = mark.offsetTop
  const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.25 || 18
  mirror.remove()
  const r = pageRect(el)
  return new DOMRect(r.left + left - el.scrollLeft, r.top + top - el.scrollTop, 1, lh)
}

/**
 * The visible part of the page, and how to turn a rect into `position: fixed` coordinates. On iPhone and
 * iPad with the keyboard up, rects count from the visible part while fixed elements count from where the
 * page was: they differ by the visual viewport's offset (iOS 26 Safari; see the quick insert tech check).
 */
export function viewport(touch: boolean): { top: number; left: number; width: number; height: number; dx: number; dy: number } {
  const vv = window.visualViewport
  const width = vv?.width ?? window.innerWidth
  const height = vv?.height ?? window.innerHeight
  const dx = touch ? vv?.offsetLeft ?? 0 : 0
  const dy = touch ? vv?.offsetTop ?? 0 : 0
  return { top: dy, left: dx, width, height, dx, dy }
}
