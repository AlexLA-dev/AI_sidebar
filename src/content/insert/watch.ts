// Follows the field the user types in, on the page and in same-origin iframes (TinyMCE, CKEditor 4:
// WebKit sends no focusin up when the focus goes into a frame, so the frames are watched themselves),
// and where things go on screen: the caret, the field, the visible part of the page.
//
// Fields in open shadow roots (LinkedIn, Reddit, Salesforce): a focus event reaches the document with the
// root's host as its target, so the field is the element inside that has the focus; and when the focus moves
// inside one root, the document hears nothing at all, so each root met on the way is listened to as well.
//
// Sites that switch sections without loading a page (the owner on 2.5 (78), LinkedIn: feed → Start post → back to
// the messages, and the button was gone until a refresh) draw new hosts and roots, and drop the old ones with the
// focus in them (WebKit sends no blur then). So the roots are found again on every press and focus (the event's
// path names each open root it crosses, whether met before or not), a root whose host left the page is let go,
// the field followed is let go when it leaves the page, and a field that has the focus though no focus was heard
// for it (it got it before its root was known) is taken up at the next caret move.

import { listenAround } from "../around"
import { activeIn, editableAt, focusedTarget, fromOwnUi, hasFocus, isOwnHost, readField, updateCaret, isControl, type Field } from "./field"
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
  const docs = new WeakSet<Document>()
  // The open roots listened to, each with what stops listening to it.
  const roots = new Map<ShadowRoot, () => void>()
  // A focus event heard both by the document and by a root on its way counts once.
  const heard = new WeakSet<Event>()
  let field: Field | null = null
  // Whether the handlers were told of `field` (focus) and not since that it went (blur).
  let told = false
  let blurTimer: ReturnType<typeof setTimeout> | undefined
  let pruneTimer: ReturnType<typeof setTimeout> | undefined

  const tell = (f: Field) => {
    clearTimeout(blurTimer)
    // Its roots are listened to (the focus moving on inside them, and the field leaving them).
    for (const root of shadowRootsOf(f.el)) trackRoot(root)
    field = f
    told = true
    h.focus(f)
  }
  const untell = () => {
    told = false
    h.blur()
  }

  /** The field followed left the page with the focus in it (WebKit sends no blur then): no field now. */
  const dropGone = () => {
    if (!field || field.el.isConnected) return
    field = null
    clearTimeout(blurTimer)
    if (told) untell()
  }

  /** The focused field when its focus wasn't heard (it got it before its root was known): followed from now. */
  const takeFocused = () => {
    const el = editableAt(deepActive())
    if (!el || (el === field?.el && told) || !hasFocus(el)) return
    tell(readField(el))
  }

  const onFocus = (e: Event) => {
    if (heard.has(e)) return
    heard.add(e)
    if (fromOwnUi(e)) return
    const target = focusedTarget(e)
    for (const root of target ? shadowRootsOf(target) : []) trackRoot(root)
    const el = editableAt(target)
    if (!el) return
    tell(readField(el))
  }
  const onBlur = (e: Event) => {
    if (heard.has(e)) return
    heard.add(e)
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      if (field && !fieldHasFocus(field)) untell()
    }, 120)
  }

  /** The open roots an event went through (its path): each is listened to, met before or not. */
  const trackPath = (path: EventTarget[]) => {
    for (const node of path) {
      const n = node as Partial<ShadowRoot>
      if (n.nodeType === 11 && n.host) trackRoot(node as ShadowRoot)
    }
  }

  /** A shadow root: the focus moving inside it, and the iframes in it. Not our own panel's (open in test builds). */
  const trackRoot = (root: ShadowRoot) => {
    if (roots.has(root) || isOwnHost(root.host)) return
    root.addEventListener("focusin", onFocus, true)
    root.addEventListener("focusout", onBlur, true)
    root.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
    const added = new MutationObserver(changed)
    added.observe(root, { childList: true, subtree: true })
    roots.set(root, () => {
      root.removeEventListener("focusin", onFocus, true)
      root.removeEventListener("focusout", onBlur, true)
      added.disconnect()
    })
  }

  /** Roots whose host left the page are let go (a site drawing its section anew makes new ones). */
  const prune = () => {
    for (const [root, stop] of roots) {
      if (root.host.isConnected) continue
      stop()
      roots.delete(root)
    }
  }

  const track = (doc: Document) => {
    if (docs.has(doc)) return
    docs.add(doc)
    const win = doc.defaultView
    const onMove = () => {
      dropGone()
      takeFocused()
      if (field && field.el.ownerDocument === doc) field = updateCaret(field)
    }
    const onInput = (e: Event) => {
      // Typing in another field than the one followed (its focus wasn't heard): that one from now on.
      const typed = fromOwnUi(e) ? null : editableAt(focusedTarget(e))
      if (typed && (typed !== field?.el || !told)) tell(readField(typed))
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
    // A press or a focus names in its path every open root it crosses: listened to before the focus is handled.
    stops.push(listenAround(doc, "pointerdown", (_, path) => trackPath(path), doc))
    stops.push(listenAround(doc, "focusin", (_, path) => trackPath(path), doc))
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

  /** The page or a root changed: new iframes are watched, the field and the roots that left are let go. */
  function changed(records: MutationRecord[]): void {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        const el = n as Element
        if (el.tagName === "IFRAME") watchFrame(el as HTMLIFrameElement)
        else if (el.querySelectorAll) el.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
      }
    }
    if (!records.some((r) => r.removedNodes.length)) return
    dropGone()
    clearTimeout(pruneTimer)
    pruneTimer = setTimeout(prune, 300)
  }

  track(document)
  document.querySelectorAll("iframe").forEach((f) => watchFrame(f as HTMLIFrameElement))
  const frames = new MutationObserver(changed)
  frames.observe(document.documentElement, { childList: true, subtree: true })

  // A field already focused when the panel started (the page autofocuses its editor).
  const active = deepActive()
  for (const root of active ? shadowRootsOf(active) : []) trackRoot(root)
  const el = editableAt(active)
  if (el) tell(readField(el))

  return () => {
    frames.disconnect()
    clearTimeout(blurTimer)
    clearTimeout(pruneTimer)
    for (const stop of stops) stop()
    for (const stop of roots.values()) stop()
    roots.clear()
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

type Box4 = { left: number; top: number; right: number; bottom: number }

/**
 * Where the field's text is (viewport rects, the field's own document): each line's text, the pictures and
 * widgets in an editor, and the caret. The button inside a field keeps off them.
 */
export function fieldText(field: Field): Box4[] {
  const el = field.el
  const out: Box4[] = []
  const add = (r: DOMRect) => {
    if (r.width || r.height) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }
  if (isControl(el)) {
    for (const r of controlTextRects(el as HTMLTextAreaElement)) add(r)
  } else {
    const doc = el.ownerDocument
    const range = doc.createRange()
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let n = 0
    for (let node = walker.nextNode(); node && n < 4000; node = walker.nextNode(), n++) {
      if (node.nodeType === 3) {
        if (!node.textContent?.trim()) continue
        range.selectNodeContents(node)
        for (const r of Array.from(range.getClientRects())) add(r)
      } else if ((node as Element).matches("img,video,canvas,svg,iframe,[contenteditable=false]")) {
        add((node as Element).getBoundingClientRect())
      }
    }
  }
  if (hasFocus(el)) add(caretRect(field))
  return out
}

/** The text of an input or textarea, line by line: a hidden copy of the field, measured, put over the field. */
function controlTextRects(el: HTMLInputElement | HTMLTextAreaElement): DOMRect[] {
  if (!el.value.trim()) return []
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
  const text = doc.createTextNode(el.value)
  mirror.appendChild(text)
  doc.body.appendChild(mirror)
  const range = doc.createRange()
  range.selectNodeContents(text)
  const m = mirror.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const rects = Array.from(range.getClientRects()).map((t) => new DOMRect(r.left + t.left - m.left - el.scrollLeft, r.top + t.top - m.top - el.scrollTop, t.width, t.height))
  mirror.remove()
  return rects
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
