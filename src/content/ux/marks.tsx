// Highlights in the panel: drawn by the Markdown renderer as <mark>, picked from a selection in an
// answer, copied as bold. Offsets count the answer's shown text: its text nodes in order, without the
// buttons in it (a code block's copy button).

import { cloneElement, isValidElement, type ComponentChildren, type VNode } from "preact"

import { markPieces, placeMarks, type Mark } from "../../shared/marks"

type Child = ComponentChildren

/** The shown text of `children` (what the DOM's text nodes will hold, buttons left out). */
export function shownText(children: Child): string {
  if (children === null || children === undefined || typeof children === "boolean") return ""
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(shownText).join("")
  if (isValidElement(children)) {
    if (children.type === "button") return ""
    return shownText((children.props as { children?: Child }).children)
  }
  return ""
}

/** `children` with the parts at `marks` wrapped in <mark class="cf-mark" data-mark=i>. */
export function withMarks(children: Child, marks: Mark[] | undefined): Child {
  const placed = placeMarks(marks, shownText(children))
  if (!placed.length) return children
  let at = 0
  const walk = (node: Child): Child => {
    if (node === null || node === undefined || typeof node === "boolean") return node
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node)
      const from = at
      at += text.length
      const parts: Child[] = []
      let cut = 0
      for (const { i, s, e, first, last } of markPieces(placed, from, at)) {
        if (s > cut) parts.push(text.slice(cut, s))
        const edges = `${first ? " cf-mark-first" : ""}${last ? " cf-mark-last" : ""}`
        parts.push(<mark class={`cf-mark${edges}`} data-mark={i} key={`m${from}-${i}`}>{text.slice(s, e)}</mark>)
        cut = e
      }
      if (!parts.length) return text
      if (cut < text.length) parts.push(text.slice(cut))
      return parts
    }
    if (Array.isArray(node)) return node.map(walk)
    if (isValidElement(node)) {
      if (node.type === "button") return node
      const kids = (node.props as { children?: Child }).children
      if (kids === undefined) return node
      return cloneElement(node as VNode, undefined, walk(kids))
    }
    return node
  }
  return walk(children)
}

/** The text nodes of `box` that count (not inside a button). */
function textNodes(box: Element): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest("button") && box.contains(n.parentElement.closest("button"))) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** Where a range boundary falls in `box`'s shown text. */
function offsetOf(box: Element, nodes: Text[], container: Node, offset: number): number {
  let at = 0
  if (container.nodeType === Node.TEXT_NODE) {
    for (const n of nodes) {
      if (n === container) return at + offset
      at += n.data.length
    }
    return -1
  }
  // An element boundary: the text before its `offset`-th child.
  const child = container.childNodes[offset] ?? null
  for (const n of nodes) {
    if (child && (child === n || child.contains(n) || (child.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))) return at
    if (!child && !container.contains(n) && (container.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) return at
    at += n.data.length
  }
  return at
}

/** A selection in `box` as offsets in its shown text, with that text (null: outside, or nothing). */
export function selectionIn(box: Element, range: Range): { s: number; e: number; text: string } | null {
  if (!box.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== box) return null
  const nodes = textNodes(box)
  const text = nodes.map((n) => n.data).join("")
  let s = offsetOf(box, nodes, range.startContainer, range.startOffset)
  let e = offsetOf(box, nodes, range.endContainer, range.endOffset)
  if (s < 0 || e < 0) return null
  // Not the spaces around it.
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  return e > s ? { s, e, text } : null
}

/**
 * The selection inside the panel's shadow root as a live range. Safari reports a selection in a shadow
 * root on the host; `getComposedRanges` (Safari 17+) gives the real one.
 */
export function panelRange(root: ShadowRoot): Range | null {
  const sel = document.getSelection() as (Selection & { getComposedRanges?: (...args: unknown[]) => StaticRange[] }) | null
  if (!sel || !sel.rangeCount) return null
  let found: StaticRange | Range | null = null
  if (typeof sel.getComposedRanges === "function") {
    try {
      found = sel.getComposedRanges({ shadowRoots: [root] })[0] ?? null
    } catch {
      try {
        found = sel.getComposedRanges(root)[0] ?? null
      } catch {
        found = null
      }
    }
  }
  if (!found) {
    const r = sel.getRangeAt(0)
    found = root.contains(r.startContainer) ? r : null
  }
  if (!found || found.collapsed || !root.contains(found.startContainer)) return null
  if (found instanceof Range) return found
  const live = document.createRange()
  live.setStart(found.startContainer, found.startOffset)
  live.setEnd(found.endContainer, found.endOffset)
  return live
}

/** The rendered answer as HTML for the clipboard: highlights as <strong>, no buttons. */
export function richHtml(box: Element): string {
  const clone = box.cloneNode(true) as Element
  clone.querySelectorAll("button").forEach((b) => b.remove())
  clone.querySelectorAll("mark.cf-mark").forEach((m) => {
    const strong = document.createElement("strong")
    strong.textContent = m.textContent
    m.replaceWith(strong)
  })
  clone.querySelectorAll("[class]").forEach((el) => el.removeAttribute("class"))
  return clone.innerHTML
}

/** Copies `html` and its plain text together: apps that take rich text get the bold. */
export async function copyRich(html: string, plain: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no rich clipboard")
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([`<meta charset="utf-8">${html}`], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" })
      })
    ])
    return true
  } catch {
    return false
  }
}
