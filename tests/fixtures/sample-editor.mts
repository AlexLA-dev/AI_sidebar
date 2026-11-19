// A sample rich-text field for Check's tests (110): what a browser's editing does with spaces, plus what pages like
// Gmail do on top of it, each behaviour a switch. Recorded on the real Gmail (the owner's Chrome, 2026-11-19, the
// structure only) and from the owner's iPad (109):
//   G1  the first line is a bare text node in the field, the next lines are <div>s, a blank line <div><br></div>,
//       Shift+Return a <br> inside the line                                         type("\n"), type("\r")
//   G2  a typed double space is kept as "⍽␠", a triple one "⍽␠⍽", a space at the end of a line as "⍽" (the browser
//       keeps runs and line ends visible with no-break spaces)                                type()
//   G3  text put in by insertText keeps its characters as given (a ⍽ stays, "␠␠" stays)        execCommand
//   G4  a plain space put over a no-break one where the browser needs one (a line's end, beside another space) is
//       turned straight back                                                                   spaces: "browser"
//   G10 (the owner's iPad) a plain space put over a ⍽ in the middle of a line is turned back too: the editor keeps
//       its own spaces                                                                         keepSpaces
//   G5  changes land in the same text node (Chrome); editors that draw their text again (React and the like) put new
//       nodes in after every input                                                             rebuild
//   G6  the page takes a paste itself: cancels the browser's, puts the text in, a line break as <br>     ownPaste
//   G8  a draft opened again is drawn anew: wrapped in <div dir="ltr">, the ⍽ kept, a "\n" text node after it  reopened()
//   G9  a reply box starts with a hint that can't be edited (words in a contenteditable=false span)   hint
//   G7/G8 a field minimised stays in the page; one closed is taken out of it                   remove()
//   —   an editor that owns its text: takes keys only, anything else is put back                refuse
// Not Gmail only: the switches make the class (Outlook, Notion, Slack, LinkedIn keep spaces the same way; React
// editors redraw; many take pastes themselves).
//
// The engine (linkedom has no Range.setStart, Selection or execCommand): a Range and a Selection good for one field,
// execCommand insertText / delete on text nodes, beforeinput and input, a paste event.

export const NB = " "

export interface Behaviours {
  // What happens to spaces around a change: "browser" (G2/G4, the default), "asTyped" (white-space: pre-wrap fields).
  spaces?: "browser" | "asTyped"
  keepSpaces?: boolean
  rebuild?: boolean
  ownPaste?: boolean
  // The page handles typing itself and lets only pastes in from a script (editors that cancel beforeinput).
  typingRefused?: boolean
  refuse?: boolean
  hint?: string
}

type Point = { node: Node; offset: number }

class SampleRange {
  startContainer!: Node
  startOffset = 0
  endContainer!: Node
  endOffset = 0
  constructor(node: Node) {
    this.startContainer = this.endContainer = node
  }
  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset
  }
  get commonAncestorContainer(): Node {
    return this.startContainer.parentNode ?? this.startContainer
  }
  setStart(node: Node, offset: number): void {
    this.startContainer = node
    this.startOffset = offset
  }
  setEnd(node: Node, offset: number): void {
    this.endContainer = node
    this.endOffset = offset
  }
  collapse(toStart = false): void {
    if (toStart) this.setEnd(this.startContainer, this.startOffset)
    else this.setStart(this.endContainer, this.endOffset)
  }
  selectNodeContents(node: Node): void {
    this.setStart(node, 0)
    this.setEnd(node, node.nodeType === 3 ? (node as Text).data.length : node.childNodes.length)
  }
  cloneRange(): SampleRange {
    const r = new SampleRange(this.startContainer)
    r.setStart(this.startContainer, this.startOffset)
    r.setEnd(this.endContainer, this.endOffset)
    return r
  }
  toString(): string {
    return this.startContainer === this.endContainer && this.startContainer.nodeType === 3 ? (this.startContainer as Text).data.slice(this.startOffset, this.endOffset) : ""
  }
  getClientRects(): DOMRect[] {
    return []
  }
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number } {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
}

/** Puts the engine into a linkedom document: ranges, the selection, focus, execCommand, animation frames. */
export function installEngine(window: any, document: any): void {
  let range: SampleRange | null = null
  let active: any = null
  document.createRange = () => new SampleRange(document.body)
  const selection = {
    get rangeCount() {
      return range ? 1 : 0
    },
    getRangeAt: () => range,
    addRange: (r: SampleRange) => void (range = r.cloneRange()),
    removeAllRanges: () => void (range = null),
    collapse: (node: Node, offset: number) => {
      range = new SampleRange(node)
      range.setStart(node, offset)
      range.setEnd(node, offset)
    },
    get anchorNode() {
      return range?.startContainer ?? null
    },
    get isCollapsed() {
      return range?.collapsed ?? true
    },
    toString: () => range?.toString() ?? ""
  }
  document.getSelection = () => selection
  window.getSelection = () => selection
  Object.defineProperty(document, "activeElement", { get: () => active ?? document.body, configurable: true })
  document.hasFocus = () => true
  window.HTMLElement.prototype.focus = function () {
    if (this.isConnected) active = this
  }
  window.HTMLElement.prototype.blur = function () {
    if (active === this) active = null
  }
  window.requestAnimationFrame = (f: (t: number) => void) => setTimeout(() => f(Date.now()), 0)
  window.DataTransfer ??= class {
    private d = new Map<string, string>()
    setData(type: string, value: string) {
      this.d.set(type, value)
    }
    getData(type: string) {
      return this.d.get(type) ?? ""
    }
  }
  window.ClipboardEvent ??= class extends window.Event {
    clipboardData: unknown
    constructor(type: string, init: { clipboardData?: unknown; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, init)
      this.clipboardData = init.clipboardData
    }
  }
  window.InputEvent ??= class extends window.Event {
    inputType: string
    data: string | null
    constructor(type: string, init: { inputType?: string; data?: string | null; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, init)
      this.inputType = init.inputType ?? ""
      this.data = init.data ?? null
    }
  }
  // insertText / delete over the selection, as a browser does, in the editor that has the focus.
  document.execCommand = (command: string, _ui: boolean, value?: string): boolean => {
    const editor = SampleEditor.of(active)
    if (!editor || !range) return false
    if (command === "insertText") return editor.replaceSelection(range, value ?? "", "insertText")
    if (command === "delete" || command === "forwardDelete") return editor.replaceSelection(range, "", "deleteContentBackward")
    return false
  }
}

const isSpace = (c: string | undefined) => c === " " || c === NB

export class SampleEditor {
  static all = new Map<Element, SampleEditor>()
  static of(el: Element | null): SampleEditor | null {
    for (let n: Node | null = el; n; n = n.parentNode) {
      const e = SampleEditor.all.get(n as Element)
      if (e) return e
    }
    return null
  }

  readonly el: HTMLElement
  private ownChange = false
  private kept = ""
  /** Every input the page heard, and every paste it took itself. */
  readonly log: string[] = []

  readonly document: any
  readonly is: Behaviours

  constructor(document: any, is: Behaviours = {}) {
    this.document = document
    this.is = is
    this.el = document.createElement("div")
    this.el.setAttribute("contenteditable", "true")
    this.el.setAttribute("role", "textbox")
    this.el.setAttribute("aria-label", "Message Body")
    document.body.appendChild(this.el)
    SampleEditor.all.set(this.el, this)
    this.el.innerHTML = is.hint ? `<span contenteditable="false"><span>${is.hint}</span></span><br>` : "<br>"
    this.kept = this.el.innerHTML
    this.el.addEventListener("input", () => this.afterInput())
    this.el.addEventListener("paste", (e: any) => this.paste(e))
  }

  // ------------------------------------------------------------ what a person does

  /** Clicks into the field: the caret at the end of its text. */
  focus(): void {
    this.el.focus()
    this.caretAtEnd()
  }

  /** Types, key by key: spaces as the browser keeps them (G2), "\n" a new line (G1), "\r" Shift+Return. */
  type(text: string): void {
    for (const ch of text) {
      if (ch === "\n") this.newLine()
      else if (ch === "\r") this.softBreak()
      else {
        this.ownChange = true
        this.replaceSelection(this.selection(), ch, "insertText", true)
        this.ownChange = false
      }
    }
  }

  /** The draft closed and opened again (G8): drawn anew from its HTML, wrapped, a "\n" after it. */
  reopened(): SampleEditor {
    const html = this.el.innerHTML
    this.remove()
    const again = new SampleEditor(this.document, { ...this.is, hint: undefined })
    again.el.innerHTML = `<div dir="ltr">${html}</div>\n`
    again.kept = again.el.innerHTML
    return again
  }

  /** The window closed, or the conversation left (G8, G9): the field is taken out of the page. */
  remove(): void {
    this.el.remove()
    SampleEditor.all.delete(this.el)
  }

  /** The text with its spaces named: ⍽ a no-break one. */
  shown(): string {
    return this.el.textContent!.replace(/ /g, "⍽")
  }

  // ------------------------------------------------------------ the engine

  private selection(): SampleRange {
    return (this.document.getSelection().getRangeAt(0) as SampleRange) ?? this.caretAtEnd()
  }

  private caretAtEnd(): SampleRange {
    const texts = this.texts()
    const last = texts[texts.length - 1]
    const r = new SampleRange(this.el)
    if (last) r.setStart(last, last.data.length)
    else {
      // An empty line: before the <br> that holds it open (after a hint, G9).
      const block = this.lastBlock()
      const n = block.childNodes.length
      r.setStart(block, n && (block.lastChild as Element).tagName === "BR" ? n - 1 : n)
    }
    r.collapse(true)
    this.document.getSelection().removeAllRanges()
    this.document.getSelection().addRange(r)
    return r
  }

  private texts(): Text[] {
    const out: Text[] = []
    const walk = (n: Node) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3) out.push(c as Text)
        else if ((c as Element).getAttribute?.("contenteditable") !== "false") walk(c)
      }
    }
    walk(this.el)
    return out
  }

  private lastBlock(): Element {
    const divs = Array.from(this.el.children).filter((c: any) => c.tagName === "DIV" || c.tagName === "P")
    return (divs[divs.length - 1] as Element) ?? this.el
  }

  /** A point inside a text node: an element's point is moved into the text next to it (or a new one). */
  private textPoint(node: Node, offset: number): { node: Text; offset: number } {
    if (node.nodeType === 3) return { node: node as Text, offset }
    const child = node.childNodes[offset] ?? null
    if (child?.nodeType === 3) return { node: child as Text, offset: 0 }
    const before = offset > 0 ? node.childNodes[offset - 1] : null
    if (before?.nodeType === 3) return { node: before as Text, offset: (before as Text).data.length }
    const t = this.document.createTextNode("")
    // Where a <br> holds an empty line open, the text takes its place.
    if (child && (child as Element).tagName === "BR" && node.childNodes.length === 1) node.replaceChild(t, child)
    else node.insertBefore(t, child)
    return { node: t, offset: 0 }
  }

  /** Puts `text` in place of the selection; the beforeinput may be cancelled; spaces are kept as the browser does. */
  replaceSelection(r: SampleRange, text: string, inputType: string, typing = false): boolean {
    if (!this.el.isConnected) return false
    const before = new this.document.defaultView.InputEvent("beforeinput", { inputType, data: text, bubbles: true, cancelable: true })
    if (this.is.typingRefused && !typing && inputType !== "insertFromPaste") before.preventDefault()
    this.el.dispatchEvent(before)
    if (before.defaultPrevented) return true
    const a = this.textPoint(r.startContainer, r.startOffset)
    const b = r.collapsed ? a : this.textPoint(r.endContainer, r.endOffset)
    // Across nodes: what's between goes, the end node keeps what follows the range.
    if (a.node !== b.node) {
      const tail = b.node.data.slice(b.offset)
      let n: Node | null = a.node.nextSibling
      while (n && n !== b.node) {
        const next: Node | null = n.nextSibling
        n.parentNode!.removeChild(n)
        n = next
      }
      b.node.remove()
      a.node.data = a.node.data.slice(0, a.offset) + text + tail
    } else {
      a.node.data = a.node.data.slice(0, a.offset) + text + a.node.data.slice(b.offset)
    }
    const end = a.offset + text.length
    if (this.is.spaces !== "asTyped") {
      // Which runs the browser writes again (as seen on Gmail in Chrome): beside a typed key; for text put in by a
      // script, only a space at the text's own edges, or where a deletion joined two spaces. "teh" → "the" leaves the
      // "⍽" after it as it was.
      const edges: number[] = []
      if (typing) edges.push(a.offset, end)
      else {
        if (!text || isSpace(text[0])) edges.push(a.offset)
        if (text && isSpace(text[text.length - 1])) edges.push(end - 1)
      }
      this.keepVisible(a.node, edges)
    }
    this.document.getSelection().collapse(a.node, Math.min(end, a.node.data.length))
    this.el.dispatchEvent(new this.document.defaultView.InputEvent("input", { inputType, data: text, bubbles: true }))
    return true
  }

  /**
   * G2/G4: the runs of spaces at the change's two edges are written as the browser needs them to show: a lone space
   * inside a line plain, a run "⍽␠⍽…", a space at a line's end "⍽". Typed text is wholly such an edge.
   */
  private keepVisible(node: Text, edges: number[]): void {
    const d = node.data
    const atEnd = (i: number) => i >= d.length && !(node.nextSibling && node.nextSibling.nodeType === 3)
    const atStart = (i: number) => i <= 0 && !(node.previousSibling && node.previousSibling.nodeType === 3)
    const runAround = (i: number): [number, number] | null => {
      let s = i
      let e = i
      while (s > 0 && isSpace(d[s - 1])) s--
      while (e < d.length && isSpace(d[e])) e++
      return e > s ? [s, e] : null
    }
    const runs = new Map<number, [number, number]>()
    for (const i of edges) {
      const run = runAround(i)
      if (run) runs.set(run[0], run)
    }
    let out = d
    for (const [s, e] of runs.values()) {
      const len = e - s
      let run = ""
      for (let k = 0; k < len; k++) run += len === 1 ? " " : k % 2 === 0 ? NB : " "
      if (atEnd(e)) run = run.slice(0, -1) + NB
      if (atStart(s)) run = NB + run.slice(1)
      out = out.slice(0, s) + run + out.slice(e)
    }
    if (out !== d) node.data = out
  }

  private newLine(): void {
    const div = this.document.createElement("div")
    div.innerHTML = "<br>"
    this.el.appendChild(div)
    const r = new SampleRange(div)
    r.setStart(div, 0)
    r.collapse(true)
    this.document.getSelection().removeAllRanges()
    this.document.getSelection().addRange(r)
    this.kept = this.el.innerHTML
  }

  private softBreak(): void {
    const block = this.lastBlock()
    block.appendChild(this.document.createElement("br"))
    const t = this.document.createTextNode("")
    block.appendChild(t)
    this.document.getSelection().collapse(t, 0)
    this.kept = this.el.innerHTML
  }

  /** G6: the page takes the paste itself, a line break as a <br>. */
  private paste(e: any): void {
    if (!this.is.ownPaste) return
    e.preventDefault()
    const text: string = e.clipboardData?.getData("text/plain") ?? ""
    this.log.push("paste")
    const r = this.selection()
    const lines = text.split("\n")
    this.replaceSelection(r, lines[0], "insertFromPaste")
    for (const line of lines.slice(1)) {
      const at = this.document.getSelection().getRangeAt(0) as SampleRange
      const node = at.startContainer as Text
      const rest = node.data.slice(at.startOffset)
      node.data = node.data.slice(0, at.startOffset)
      const br = this.document.createElement("br")
      const t = this.document.createTextNode(line + rest)
      node.after(br, t)
      this.document.getSelection().collapse(t, line.length)
    }
  }

  /** What the page does after an input: keep its spaces (G10), take it back (refuse), draw it again (G5). */
  private afterInput(): void {
    this.log.push("input")
    if (this.is.refuse && !this.ownChange) {
      this.el.innerHTML = this.kept
      return
    }
    if (this.is.keepSpaces && !this.ownChange) {
      // Where the field had a no-break space before, it has one again.
      const was = this.keptText()
      for (const t of this.texts()) {
        const start = this.offsetOf(t)
        let d = t.data
        for (let i = 0; i < d.length; i++) if (d[i] === " " && was[start + i] === NB && this.el.textContent!.length === was.length) d = d.slice(0, i) + NB + d.slice(i + 1)
        if (d !== t.data) t.data = d
      }
    }
    if (this.is.rebuild) {
      for (const t of this.texts()) t.replaceWith(this.document.createTextNode(t.data))
      this.caretAtEnd()
    }
    this.kept = this.el.innerHTML
  }

  private keptText(): string {
    const probe = this.document.createElement("div")
    probe.innerHTML = this.kept
    return probe.textContent ?? ""
  }

  private offsetOf(node: Text): number {
    let at = 0
    for (const t of this.texts()) {
      if (t === node) return at
      at += t.data.length
    }
    return at
  }
}
