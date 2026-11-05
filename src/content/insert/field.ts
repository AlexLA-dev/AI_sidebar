// The field being typed in on the page, and putting text into it at the caret so that the page's own
// editor takes it as typing: ProseMirror, Quill, Lexical, Draft.js, TinyMCE and React fields keep their
// own copy of the text and ignore a plain DOM change. When nothing works, the caller copies the text
// and asks to paste it by hand.
//
// Elements may come from a same-origin iframe (TinyMCE, CKEditor 4), so nothing here uses instanceof.
//
// Fields may sit inside open shadow roots (LinkedIn's #interop-outlet, Reddit's components, Salesforce): the
// document sees only their host, as its activeElement, as a focus event's target, and as where its selection
// is (Chrome and WebKit move it out to the host). The field, its focus and its caret are looked for inside.

import { HOST_TAG } from "../page"
import { shadowRootOf, shadowRootsOf } from "./shadow"

/** input types that hold plain text a template can go into. */
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel"])

export type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement

export interface Field {
  el: FieldElement
  /** input or textarea: has a value and selectionStart; otherwise a contenteditable root. */
  control: boolean
  /** The caret when the field was last typed in: value offsets in a control, a Range in an editor. */
  start: number
  end: number
  range: Range | null
}

function tag(el: Element): string {
  return el.tagName.toUpperCase()
}

export function isControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return tag(el) === "TEXTAREA" || tag(el) === "INPUT"
}

// ------------------------------------------------------------ shadow roots

/** Our own panel's host: its shadow root is closed in the builds people get, open in test builds. */
export function isOwnHost(node: unknown): boolean {
  return typeof (node as Element | null)?.tagName === "string" && (node as Element).tagName.toLowerCase() === HOST_TAG
}

/** The focused element of `doc`, inside open shadow roots too (the document's activeElement is their host). */
export function activeIn(doc: Document | ShadowRoot): Element | null {
  let el = doc.activeElement
  for (let n = 0; el && !isOwnHost(el) && el.shadowRoot?.activeElement && n < 32; n++) el = el.shadowRoot.activeElement
  return el
}

/**
 * The element a focus or input event is about. Coming out of an open shadow root its target is the root's
 * host: the element inside that has the focus. (Not the event's path: from the page, a closed root such as
 * ours shows only its host; presses and keys read paths through around.ts.)
 */
export function focusedTarget(e: Event): Element | null {
  const target = e.target as Element | null
  if (!target || typeof target.tagName !== "string") return null
  if (isOwnHost(target) || !target.shadowRoot) return target
  return activeIn(target.shadowRoot) ?? target
}

/** The event comes from our own panel (from the page its target is the panel's host). */
export function fromOwnUi(e: Event): boolean {
  const target = e.target as Element | null
  return Boolean(target?.closest?.(HOST_TAG))
}

type ComposedSelection = Selection & {
  getComposedRanges?: (...args: unknown[]) => StaticRange[]
}

/**
 * The selection inside `el` when `el` is in a shadow root: the root's own (Chrome), else the composed ranges
 * (Safari 17 and later, Chrome 137 and later; Safari 17 took the roots as arguments, the standard takes them
 * in a dictionary), else the document's when a browser leaves it inside (Firefox).
 */
export function rangeIn(el: Element): Range | null {
  const doc = el.ownerDocument
  const sel = doc.getSelection() as ComposedSelection | null
  const inside = (r: AbstractRange | null | undefined): r is AbstractRange => Boolean(r && el.contains(r.startContainer))
  const roots = shadowRootsOf(el)
  if (roots.length) {
    const own = (roots[0] as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
    if (own && own.rangeCount > 0 && inside(own.getRangeAt(0))) return own.getRangeAt(0).cloneRange()
    if (sel?.getComposedRanges) {
      for (const call of [() => sel.getComposedRanges!({ shadowRoots: roots }), () => sel.getComposedRanges!(...roots)]) {
        let found: StaticRange | undefined
        try {
          found = call()[0]
        } catch {
          found = undefined
        }
        if (!inside(found)) continue
        const range = doc.createRange()
        range.setStart(found.startContainer, found.startOffset)
        range.setEnd(found.endContainer, found.endOffset)
        return range
      }
    }
  }
  if (sel && sel.rangeCount > 0 && inside(sel.getRangeAt(0))) return sel.getRangeAt(0).cloneRange()
  return null
}

/** A card number, a security code and the like (autocomplete "cc-…", or named so). */
export function sensitiveField(el: Element): boolean {
  const input = el as HTMLInputElement
  if (tag(el) === "INPUT" && (input.type === "password" || input.type === "hidden")) return true
  const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase()
  if (/\bcc-|\bcurrent-password\b|\bnew-password\b|\bone-time-code\b/.test(auto)) return true
  const name = `${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase()
  return /card.?number|cardnum|\bccnum|\bcvc\b|\bcvv\b|\biban\b|security.?code/.test(name)
}

/** The element's form has a password or card field: nothing from it is kept. A login box elsewhere
 * on the page (most sites have one) doesn't count. */
export function sensitiveForm(el: Element): boolean {
  const form = el.closest("form")
  if (!form) return false
  for (const field of Array.from(form.querySelectorAll("input"))) if (sensitiveField(field)) return true
  return false
}

/**
 * The editable field `node` is in: an input or textarea of plain text, or the root of a contenteditable
 * editor. Null for passwords, card fields, read-only fields and everything else.
 */
export function editableAt(node: EventTarget | null): FieldElement | null {
  const el = node as Element | null
  if (!el || typeof el.tagName !== "string") return null
  if (isControl(el)) {
    if (el.readOnly || el.disabled) return null
    if (tag(el) === "INPUT" && !TEXT_INPUTS.has((el as HTMLInputElement).type)) return null
    return sensitiveField(el) ? null : el
  }
  const html = el as HTMLElement
  if (!html.isContentEditable) return null
  let root = html
  while (root.parentElement?.isContentEditable) root = root.parentElement
  return root
}

/** The field with the caret where it is now. */
export function readField(el: FieldElement): Field {
  if (isControl(el)) {
    let start = el.value.length
    let end = start
    try {
      // email and url inputs have no selection API: the end of the value.
      if (el.selectionStart !== null) {
        start = el.selectionStart
        end = el.selectionEnd ?? start
      }
    } catch {
      // keep the end
    }
    return { el, control: true, start, end, range: null }
  }
  return { el, control: false, start: 0, end: 0, range: rangeIn(el) }
}

/** The field has the focus (in an iframe, the iframe has it too; in a shadow root, its host has it). */
export function hasFocus(el: FieldElement): boolean {
  const doc = el.ownerDocument
  const active = activeIn(doc)
  return doc.hasFocus() && (active === el || el.contains(active))
}

/** The caret is still in the field: keep the latest position. */
export function updateCaret(field: Field): Field {
  return hasFocus(field.el) ? readField(field.el) : field
}

/** Text before the caret, at most `max` characters (what a "/" phrase is looked for in). */
export function textBeforeCaret(field: Field, max = 80): string {
  if (field.control) {
    const el = field.el as HTMLInputElement
    return el.value.slice(Math.max(0, field.start - max), field.start)
  }
  const range = field.range
  if (!range || !range.collapsed) return ""
  const doc = field.el.ownerDocument
  const before = doc.createRange()
  // The block the caret is in: a phrase never spans paragraphs.
  let block: Node = range.startContainer
  while (block !== field.el && block.parentNode && !isBlock(block)) block = block.parentNode
  before.setStart(block, 0)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().slice(-max)
}

function isBlock(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const display = (node as Element).ownerDocument.defaultView?.getComputedStyle(node as Element).display ?? ""
  return display === "block" || display === "list-item" || display === "flex" || display === "table-cell"
}

/** Puts the focus and the caret back in the field (the list took them). */
export function restoreCaret(field: Field): void {
  const el = field.el
  const doc = el.ownerDocument
  if (!hasFocus(el)) {
    // An editor inside an iframe: the iframe's window takes the focus first.
    if (doc !== document) doc.defaultView?.focus()
    el.focus({ preventScroll: true })
  }
  if (field.control) {
    try {
      ;(el as HTMLInputElement).setSelectionRange(field.start, field.end)
    } catch {
      // no selection API (email, url)
    }
    return
  }
  const sel = doc.getSelection()
  const range = field.range
  if (!sel || !range) return
  sel.removeAllRanges()
  try {
    sel.addRange(range)
  } catch {
    // below
  }
  // A field in a shadow root: where a browser won't take the range as it is, the ends are given one by one.
  if (!rangeIn(el) && shadowRootOf(el)) {
    try {
      sel.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset)
    } catch {
      // the focus keeps the browser's own caret
    }
  }
}

/** Selects the `count` characters before the caret (a typed "/phrase"), so the insert replaces them. */
function selectBack(field: Field, count: number): void {
  if (count <= 0) return
  if (field.control) {
    const el = field.el as HTMLInputElement
    try {
      el.setSelectionRange(Math.max(0, field.start - count), field.end)
    } catch {
      // no selection API
    }
    return
  }
  const sel = field.el.ownerDocument.getSelection() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null
  if (!sel?.modify) return
  sel.collapseToEnd()
  for (let i = 0; i < count; i++) sel.modify("extend", "backward", "character")
}

// ------------------------------------------------------------ insert

/** Text without any whitespace: editors turn line breaks into paragraphs and spaces into &nbsp;. */
function squash(text: string): string {
  return text.replace(/[\s ​]+/g, "")
}

function count(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++
  return n
}

function contents(field: Field): string {
  return squash(field.control ? (field.el as HTMLInputElement).value : field.el.textContent ?? "")
}

/** The page's editor got to update its DOM (Draft.js and Lexical re-render after the event). */
function settle(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    win.requestAnimationFrame(() => setTimeout(finish, 30))
    // A tab in the background doesn't run animation frames.
    setTimeout(finish, 250)
  })
}

export type InsertWay = "typing" | "paste" | "value"

/** The ways tried, in order. Multi-line text into an editor goes as a paste first: typed line breaks
 * become whatever each editor makes of them, a pasted text/plain is split into paragraphs by all of them. */
function ways(field: Field, text: string): InsertWay[] {
  if (field.control) return ["typing", "value"]
  return text.includes("\n") ? ["paste", "typing"] : ["typing", "paste"]
}

function dispatchPaste(field: Field, text: string): void {
  const doc = field.el.ownerDocument
  const win = doc.defaultView ?? window
  const data = new win.DataTransfer()
  data.setData("text/plain", text)
  // Where the caret is (inside the field; the document's selection may point at a shadow root's host).
  const at = rangeIn(field.el)?.startContainer ?? null
  const target = ((at && (at.nodeType === 1 ? at : at.parentElement)) ?? field.el) as HTMLElement
  target.dispatchEvent(new win.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }))
}

function setValue(field: Field, text: string): void {
  const el = field.el as HTMLInputElement
  const win = el.ownerDocument.defaultView ?? window
  let start = el.value.length
  let end = start
  try {
    if (el.selectionStart !== null) {
      start = el.selectionStart
      end = el.selectionEnd ?? start
    }
  } catch {
    // no selection API
  }
  el.setRangeText(text, start, end, "end")
  el.dispatchEvent(new win.InputEvent("input", { inputType: "insertFromPaste", data: text, bubbles: true, composed: true }))
}

/**
 * Puts `text` at the field's caret, replacing the `replace` characters before it (a typed "/phrase").
 * Returns how it went in, or null when the field didn't take it (the caller copies it instead).
 */
export async function insertText(field: Field, text: string, replace = 0, only?: InsertWay[]): Promise<InsertWay | null> {
  const doc = field.el.ownerDocument
  const win = doc.defaultView ?? window
  restoreCaret(field)
  const probe = squash(text).slice(0, 40)
  for (const way of only ?? ways(field, text)) {
    if (replace > 0) selectBack(field, replace)
    const before = contents(field)
    const had = count(before, probe)
    try {
      if (way === "typing") doc.execCommand("insertText", false, text)
      else if (way === "paste") dispatchPaste(field, text)
      else setValue(field, text)
    } catch {
      continue
    }
    await settle(win)
    const after = contents(field)
    // Empty text (a template of only blanks) counts once the field changed.
    if (probe ? count(after, probe) > had : after !== before) return way
    // Nothing changed: the next way starts from the same caret.
    if (after === before) {
      restoreCaret(field)
      continue
    }
    // The field changed but the text isn't there (an editor reformatted it): don't add it twice.
    return way
  }
  return null
}

/** Copies text for a paste by hand (the fallback, and the iPhone's own edit menu). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;opacity:0;top:0;left:0"
    document.documentElement.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}
