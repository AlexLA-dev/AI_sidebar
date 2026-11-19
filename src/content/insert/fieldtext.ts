// The text of a field as «Проверить» и «Переписать» work on it (2.7), and putting a change back where it belongs.
// - An input or a textarea: its value. An editor (contenteditable): its text, block by block, each text node's place
//   in it remembered, so a change at characters [from, to) is made on those very nodes: a fix of one word leaves the
//   rest of the editor (links, bold, mentions) as it is.
// - A signature and quoted mail (Gmail, Outlook, Thunderbird, any <blockquote>) are in the text but never worked on:
//   the part with the caret is, between them. A selection in the field, when there is one, is what's worked on.
// - Changes go in as typing (execCommand insertText) or a paste, as quick insert's do, so the page's editor takes them
//   as the person's own and its own undo works; they're checked by reading the field again.
// No imports but field.ts and the shared writing helpers, so the tests load it as it is.

import { diffWords, trimmedSpan, type Edit } from "../../shared/writing"
import { dispatchPaste, isControl, restoreCaret, settle, type Field, type FieldElement } from "./field"

export interface Span {
  node: Text
  start: number
}

export interface FieldText {
  // The field's whole text: an editor's blocks and line breaks as "\n".
  text: string
  // An editor's text nodes and where each starts in `text` (none for an input or a textarea).
  spans: Span[]
  // Signatures and quoted mail: in the text, never worked on.
  skips: Array<{ from: number; to: number }>
  // What can't be edited inside an editor (a mention chip, an embed): a fix never touches it.
  frozen: Array<{ from: number; to: number }>
}

const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|OL|P|PRE|SECTION|TABLE|TBODY|TR|UL)$/
const NEVER = /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT|SVG|IMG|VIDEO|AUDIO|IFRAME|OBJECT|CANVAS)$/
// Gmail's signature and quote, Outlook's reply header and signature, Thunderbird's, and anything named so.
const SKIP_NAME = /gmail_signature|gmail_quote|gmail_extra|moz-signature|moz-cite-prefix|divRplyFwdMsg|appendonsend|(^|[\s_-])signature($|[\s_-])|(^|[\s_-])(quote|quoted)($|[\s_-])/i

function skipped(el: Element): boolean {
  if (el.tagName.toUpperCase() === "BLOCKQUOTE") return true
  if (el.getAttribute("data-smartmail") === "gmail_signature") return true
  return SKIP_NAME.test(`${el.id ?? ""} ${el.getAttribute("class") ?? ""}`)
}

function hidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true
  try {
    return (el.ownerDocument.defaultView?.getComputedStyle(el).display ?? "") === "none"
  } catch {
    return false
  }
}

/** The field's text, and where each piece of it is. */
export function readText(el: FieldElement): FieldText {
  if (isControl(el)) return { text: (el as HTMLInputElement).value, spans: [], skips: [], frozen: [] }
  const out: FieldText = { text: "", spans: [], skips: [], frozen: [] }
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const data = (child as Text).data
        if (!data) continue
        out.spans.push({ node: child as Text, start: out.text.length })
        out.text += data
        continue
      }
      if (child.nodeType !== 1) continue
      const e = child as Element
      const tag = e.tagName.toUpperCase()
      if (tag === "BR") {
        out.text += "\n"
        continue
      }
      if (NEVER.test(tag) || hidden(e)) continue
      const block = BLOCK.test(tag)
      if (block && out.text && !out.text.endsWith("\n")) out.text += "\n"
      const from = out.text.length
      walk(e)
      if (skipped(e)) out.skips.push({ from, to: out.text.length })
      else if (e.getAttribute("contenteditable") === "false") out.frozen.push({ from, to: out.text.length })
      if (block && out.text && !out.text.endsWith("\n")) out.text += "\n"
    }
  }
  walk(el)
  return out
}

/** Where a point of the DOM (a node and an offset, as a Range has them) is in the field's text. */
export function offsetOf(ft: FieldText, node: Node, offset: number): number | null {
  if (node.nodeType === 3) {
    const span = ft.spans.find((s) => s.node === node)
    return span ? span.start + Math.min(offset, span.node.data.length) : null
  }
  // An element and a child index: the first text at or after that child.
  const child = node.childNodes[offset] ?? null
  for (const s of ft.spans) {
    if (!child) {
      if (node.contains(s.node)) continue
      // after the element's last child: the first text after the element
      const pos = node.compareDocumentPosition(s.node)
      if (pos & 4 /* FOLLOWING */) return s.start
      continue
    }
    if (child === s.node || child.contains(s.node)) return s.start
    if (child.compareDocumentPosition(s.node) & 4) return s.start
  }
  // Nothing after it: the end of the text.
  const last = ft.spans[ft.spans.length - 1]
  return last ? last.start + last.node.data.length : 0
}

/**
 * What's worked on: the selection in the field, when there is one; else the part of the text with the caret (or the
 * longest), between signatures and quotes. Its white space at both ends is left out.
 */
export function workRange(field: Field, ft: FieldText, wholePart = false): { from: number; to: number; selected: boolean } {
  const caret = caretOf(field, ft)
  if (!wholePart) {
    if (field.control && field.end > field.start) return trimmed(ft.text, field.start, field.end, true)
    if (!field.control && field.range && !field.range.collapsed) {
      const a = offsetOf(ft, field.range.startContainer, field.range.startOffset)
      const b = offsetOf(ft, field.range.endContainer, field.range.endOffset)
      if (a !== null && b !== null && b > a) return trimmed(ft.text, a, b, true)
    }
  }
  // The parts between what's skipped.
  const parts: Array<{ from: number; to: number }> = []
  let at = 0
  for (const s of [...ft.skips].sort((x, y) => x.from - y.from)) {
    if (s.from > at) parts.push({ from: at, to: s.from })
    at = Math.max(at, s.to)
  }
  if (at < ft.text.length || !parts.length) parts.push({ from: at, to: ft.text.length })
  const withText = parts.filter((p) => ft.text.slice(p.from, p.to).trim())
  const part = (caret !== null ? withText.find((p) => caret! >= p.from && caret! <= p.to) : undefined)
    ?? withText.sort((x, y) => (y.to - y.from) - (x.to - x.from))[0]
    ?? { from: 0, to: 0 }
  return trimmed(ft.text, part.from, part.to, false)
}

/** Where the caret (the selection's start) is in the field's text, when it's known. */
export function caretOf(field: Field, ft: FieldText): number | null {
  if (field.control) return field.start
  return field.range ? offsetOf(ft, field.range.startContainer, field.range.startOffset) : null
}

function trimmed(text: string, from: number, to: number, selected: boolean): { from: number; to: number; selected: boolean } {
  const span = trimmedSpan(text.slice(from, to))
  return { from: from + span.from, to: from + span.to, selected }
}

/** A Range over the characters [from, to) of an editor's text (null when they aren't in its text nodes). */
export function domRange(el: FieldElement, ft: FieldText, from: number, to: number): Range | null {
  const doc = el.ownerDocument
  // The start: in the text node that holds it (at a node's end, the next node's start: the change goes with what follows).
  const startSpan = ft.spans.find((s) => from >= s.start && from < s.start + s.node.data.length)
    ?? ft.spans.find((s) => from === s.start + s.node.data.length)
  // The end: in the text node it ends in (at a node's start, the previous node's end).
  const endSpan = [...ft.spans].reverse().find((s) => to > s.start && to <= s.start + s.node.data.length)
    ?? ft.spans.find((s) => to === s.start)
  if (!startSpan || !endSpan) return null
  const range = doc.createRange()
  range.setStart(startSpan.node, from - startSpan.start)
  range.setEnd(endSpan.node, to - endSpan.start)
  return range
}

/** The change [from, to) touches something an editor won't let be changed, or crosses a block: not made one by one. */
export function editBlocked(ft: FieldText, from: number, to: number): boolean {
  if (ft.frozen.some((f) => from < f.to && to > f.from)) return true
  if (!ft.spans.length) return false
  return ft.text.slice(from, to).includes("\n")
}

/** Text as compared after a change: editors keep spaces as no-break ones and blank lines their own way. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[ ​]/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim()
  return norm(a) === norm(b)
}

/**
 * Puts `text` in place of the characters [from, to) of the field's text, as typing or a paste, and reads it back.
 * True once the field shows it.
 */
export async function replaceText(el: FieldElement, from: number, to: number, text: string): Promise<boolean> {
  const before = readText(el)
  const expect = before.text.slice(0, from) + text + before.text.slice(to)
  const doc = el.ownerDocument
  const win = doc.defaultView ?? window
  const control = isControl(el)
  const ways: Array<"typing" | "paste" | "value"> = control ? ["typing", "value"] : text.includes("\n") ? ["paste", "typing"] : ["typing", "paste"]
  for (const way of ways) {
    const now = readText(el)
    const field = selectIn(el, now, from, to)
    // An insert with nothing to replace, at the very end of an empty editor: its start.
    if (!field) return false
    try {
      if (way === "typing") typeOver(doc, text)
      else if (way === "paste") dispatchPaste(field, text)
      else {
        const input = el as HTMLInputElement
        input.setRangeText(text, from, to, "end")
        input.dispatchEvent(new win.InputEvent("input", { inputType: "insertReplacementText", data: text, bubbles: true, composed: true }))
      }
    } catch {
      continue
    }
    await settle(win)
    const after = readText(el).text
    // Nothing changed (the editor turned the change back, or it was only in a space's kind): the next way, or no.
    if (after === now.text) {
      if (expect === now.text) return true
      continue
    }
    if (sameText(after, expect)) return true
    // The field changed some other way (an editor that reformats): don't make the change twice. When its words are
    // right, the spaces by the change are put right (109, the owner: extra spaces after a fix).
    if (!sameText(after.replace(/\s+/g, ""), expect.replace(/\s+/g, ""))) return false
    await tidySpaces(el, expect, from, from + text.length)
    return true
  }
  return false
}

/** The field with the characters [from, to) of its text selected (null when an editor's text nodes don't hold them). */
function selectIn(el: FieldElement, ft: FieldText, from: number, to: number): Field | null {
  let field: Field
  if (isControl(el)) field = { el, control: true, start: from, end: to, range: null }
  else {
    const range = domRange(el, ft, from, to)
    if (!range) return null
    field = { el, control: false, start: 0, end: 0, range }
  }
  restoreCaret(field)
  return field
}

/** Types `text` over the selection; with no text, the selection is removed (an empty insertText does nothing in some engines). */
function typeOver(doc: Document, text: string): void {
  if (text) doc.execCommand("insertText", false, text)
  else doc.execCommand("delete", false)
}

/**
 * The spaces around a change made right: where the field's text differs from what was meant only in spaces near
 * [from, to) (one doubled, or one lost), they're typed as meant. A space's kind (a no-break one) is the field's own.
 */
async function tidySpaces(el: FieldElement, expect: string, from: number, to: number): Promise<void> {
  const ft = readText(el)
  const only = (s: string) => /^[^\S\n]*$/.test(s)
  const near = (e: Edit) => e.from >= from - 2 && e.from <= to + 2 + Math.max(0, ft.text.length - expect.length)
  const fixes = diffWords(ft.text, expect).filter((e) => only(ft.text.slice(e.from, e.to)) && only(e.text) && near(e))
  if (!fixes.length) return
  const doc = el.ownerDocument
  for (const e of fixes.reverse()) {
    if (!selectIn(el, readText(el), e.from, e.to)) continue
    try {
      typeOver(doc, e.text)
    } catch {
      // as it is
    }
  }
  await settle(doc.defaultView ?? window)
}

/** The field's text the change left: what was [from, to) is now [from, end) (everything after it is as it was). */
export function changedEnd(before: string, after: string, to: number): number {
  return after.length - (before.length - to)
}

/**
 * Puts `text` at `range` (a caret in an editor), as a paste or typing (Compose's draft, 2.7 (108)). For a caret where the
 * field has no text node of its own (the blank first line of Gmail's empty reply, above the signature): offsets only
 * reach text nodes, and the signature's would take the draft. True once the field holds the new words.
 */
export async function insertAtCaret(el: FieldElement, range: Range, text: string): Promise<boolean> {
  const doc = el.ownerDocument
  const win = doc.defaultView ?? window
  const letters = (s: string) => s.replace(/\s+/g, "").length
  const before = letters(readText(el).text)
  for (const way of text.includes("\n") ? ["paste", "typing"] : ["typing", "paste"]) {
    const now = readText(el).text
    const field: Field = { el, control: false, start: 0, end: 0, range: range.cloneRange() }
    restoreCaret(field)
    try {
      if (way === "typing") doc.execCommand("insertText", false, text)
      else dispatchPaste(field, text)
    } catch {
      continue
    }
    await settle(win)
    const after = readText(el).text
    if (letters(after) - before >= letters(text) * 0.9) return true
    // Something else changed: no second try on top of it.
    if (after !== now) return false
  }
  return false
}

