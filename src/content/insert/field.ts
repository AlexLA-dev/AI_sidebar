// The field being typed in on the page, and putting text into it at the caret so that the page's own
// editor takes it as typing: ProseMirror, Quill, Lexical, Draft.js, TinyMCE and React fields keep their
// own copy of the text and ignore a plain DOM change. When nothing works, the caller copies the text
// and asks to paste it by hand.
//
// Elements may come from a same-origin iframe (TinyMCE, CKEditor 4), so nothing here uses instanceof.

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
  const sel = el.ownerDocument.getSelection()
  const range = sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : null
  return { el, control: false, start: 0, end: 0, range }
}

/** The field has the focus (in an iframe, the iframe has it too). */
export function hasFocus(el: FieldElement): boolean {
  const doc = el.ownerDocument
  return doc.hasFocus() && (doc.activeElement === el || el.contains(doc.activeElement))
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
  if (sel && field.range) {
    sel.removeAllRanges()
    sel.addRange(field.range)
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
  const target = (doc.getSelection()?.anchorNode?.parentElement ?? field.el) as HTMLElement
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
