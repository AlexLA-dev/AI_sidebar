// The page as an outline for the model (2.8, round 139, the director's «eyes» part 1a): one walk in reading order of
// what shows, the page's words and its controls together, a line per block of the page.
// - A control sits where it is, as «[#12 button "See availability"]», in its card's or its row's line: so «See
//   availability» is read in its hotel's line and «Apply changes» under the dates it applies.
// - The screen in full; overlays first. The rest of the page is in parts (§n) by its headings (or a screen's height
//   when it has none), each one line with what it holds; read_page(n) opens a part, and an opened part stays open
//   (a read adds, never replaces).
// - The site's own menus (the links of a header, a footer or a nav outside the page's main part) fold to one line,
//   keeping a link whose words are the request's.
// - What it never carries: a field's value (the map's state says filled or empty), an editor's text, our own panel;
//   a personal field's value that the page writes back elsewhere is masked.
// - This is what the model reads. The guards don't: they read the map's `text` (today's selection) and its controls,
//   so words that a long outline brings in (a details form saying «your booking number will be e-mailed») never make
//   the device think a booking is confirmed.

import type { MapItem } from "../../shared/agent/types"
import { isOwnHost } from "../insert/field"
import { DENSE, weightedLength } from "../../shared/agent/length"
import { styleOf } from "./style"

export const OUTLINE_MAX = 9000
const LINE_MAX = 400
const OPEN_MAX = 4
const SUMMARY_TOKENS = 2
// The parts' own lines take at most this much; past it, the rest go ten parts to a line.
const SUMMARY_MAX = 2500

/** A text cut to a weighted length, at a character. */
function clipWeighted(s: string, max: number): string {
  if (weightedLength(s) <= max) return s
  let n = 0
  let i = 0
  for (const ch of s) {
    n += DENSE.test(ch) ? 3 : ch.length
    if (n > max - 1) break
    i += ch.length
  }
  return `${s.slice(0, i)}…`
}

const SKIP = /^(script|style|noscript|template|svg|select|textarea|option|optgroup|head|meta|link|iframe|frame|object|embed|canvas|video|audio|picture|source|track|map|area)$/
const BLOCKY = "div, p, li, tr, td, th, dt, dd, section, article, header, footer, main, aside, nav, form, fieldset, legend, details, summary, ul, ol, dl, table, caption, figure, figcaption, blockquote, pre, label, h1, h2, h3, h4, h5, h6, [role=row], [role=listitem], [role=dialog], [role=heading], [role=group], [role=region]"
const HEADING = /^h[1-4]$/
const MESSAGE = "[role=alert], [role=status], [aria-live=assertive], .error, .errors, .invalid-feedback, .field-error, .form-error"
const MAIN = "main, [role=main], article"
const SITE_REGION = "header, footer, nav, [role=banner], [role=navigation], [role=contentinfo]"

interface Block {
  text: string
  top: number
  bottom: number
  heading?: string
  menu?: { links: string[]; kept: string[] }
  ids: string[]
}

export interface OutlineInput {
  doc: Document
  // The map's controls by their element (only these get a token, so every number the model sees is in the map).
  items: Map<Element, MapItem>
  overlays: Element[]
  height: number
  open?: number[]
  // The request's words (the device's), so a site menu keeps a link that is the request's.
  words?: string[]
}

export interface Outline {
  text: string
  // The page's parts after the screen (§2 …): how many there are.
  sections: number
  // The controls whose numbers the outline shows (the map lists each of them).
  ids: Set<string>
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

/** A control as the outline shows it, in place: its number, role, name (or its hint) and the states that matter. */
export function token(i: MapItem): string {
  // (An editor's name is its text — the person's typing: the outline shows none.)
  const name = i.role === "editor" ? `""` : i.label ? JSON.stringify(clipWeighted(i.label, 60)) : i.hint ? `(${i.hint})` : `""`
  const flags = (i.state ?? []).filter((s) => /^(selected|checked|pressed|current|expanded|disabled|unavailable|filled|empty|invalid|required)$/.test(s))
  const value = i.value && !i.lock && (i.role === "textbox" || i.role === "select" || i.role === "combobox" || i.role === "slider") ? ` =${JSON.stringify(clipWeighted(i.value, 40))}` : ""
  return `[#${i.id} ${i.role} ${name}${value}${flags.length ? ` ${flags.join(",")}` : ""}]`
}

function hidden(el: Element, view: Window | null): boolean {
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert") || el.hasAttribute("hidden")) return true
  const style = view ? styleOf(el) : null
  return !!style && (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden")
}

/** The outline of a page (see the file's head). Cheap on a phone: styles are read only for what's within a screen of the screen. */
export function buildOutline(input: OutlineInput): Outline {
  const { doc, items, overlays, height } = input
  const view = doc.defaultView
  const words = (input.words ?? []).map((w) => w.toLocaleLowerCase()).filter((w) => w.length >= 3)
  const requestWord = (label: string) => {
    const l = label.toLocaleLowerCase()
    return words.some((w) => l.includes(w))
  }
  // Values of personal and secret fields as the page holds them: masked wherever the page writes them back.
  const masks: string[] = []
  for (const [el, i] of items) {
    const v = (el as HTMLInputElement).value
    if (i.lock && typeof v === "string" && v.trim().length >= 3) masks.push(v.trim())
  }
  const mask = (t: string) => masks.reduce((s, m) => s.split(m).join("[a filled detail]"), t)

  const overlaySet = new Set(overlays)

  // ---- one walk: blocks in reading order
  const walk = (root: Element, into: Block[], frameDy = 0) => {
    let line: string[] = []
    let ids: string[] = []
    let block: Element | null = null
    let top = Infinity
    let bottom = -Infinity
    // A card that is one link: everything in it is one line (its words and the controls inside, «Book» with its salon).
    let card: Element | null = null
    const flush = () => {
      const text = squash(line.join(" "))
      if (text && /[\p{L}\p{N}]/u.test(text.replace(/\[#[^\]]*\]/g, "") + (ids.length ? "x" : ""))) {
        const last = into[into.length - 1]
        if (!(last && last.text === text)) into.push({ text: clipWeighted(mask(text), LINE_MAX), top: top === Infinity ? 0 : top, bottom: bottom === -Infinity ? 0 : bottom, ids })
      }
      line = []
      ids = []
      top = Infinity
      bottom = -Infinity
    }
    const put = (piece: string, at: Element, r?: { top: number; bottom: number }, id?: string) => {
      const b = card && card.contains(at) ? card : at.closest(BLOCKY)
      if (b !== block) {
        flush()
        block = b
      }
      line.push(piece)
      if (id) ids.push(id)
      if (r) {
        top = Math.min(top, r.top + frameDy)
        bottom = Math.max(bottom, r.bottom + frameDy)
      }
    }
    // A site's own menu: its links fold into one line.
    const menuOf = (el: Element): Block | null => {
      const links: string[] = []
      const kept: string[] = []
      let t = Infinity
      let b = -Infinity
      for (const [cel, i] of items) {
        if (i.role !== "link" || !el.contains(cel)) continue
        if (i.label) links.push(clipWeighted(i.label, 24))
        if (i.label && requestWord(i.label)) {
          kept.push(token(i))
        }
        const r = cel.getBoundingClientRect()
        t = Math.min(t, r.top + frameDy)
        b = Math.max(b, r.bottom + frameDy)
      }
      if (!links.length) return null
      return { text: "", top: t === Infinity ? 0 : t, bottom: b === -Infinity ? 0 : b, ids: [], menu: { links, kept } }
    }
    const visit = (el: Element, words: boolean, siteRegion: boolean) => {
      const t = el.tagName.toLowerCase()
      if (isOwnHost(el)) return
      if (!overlaySet.has(root) && overlaySet.has(el)) return
      const item = items.get(el)
      const r = el.getBoundingClientRect()
      const far = r.width > 0 && r.height > 0 && (r.top + frameDy > height * 2 || r.bottom + frameDy < -height)
      // (Within a screen of the screen the style decides; beyond it only the attributes do: no style read.)
      if (far ? el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden") : hidden(el, view)) return
      // (An editor's text is the person's typing: never read, whether or not the map lists the editor.)
      if (el.matches("[contenteditable]:not([contenteditable=false])") && !item) return
      if (item) {
        // In a site menu its links are folded into the menu's line (a link with the request's words is kept there).
        if (siteRegion && item.role === "link") return
        const isCardLink = item.role === "link" && el.children.length > 1 && weightedLength(item.label) >= 40
        if (isCardLink && !card) card = el
        put(isCardLink ? token({ ...item, label: clipWeighted(item.label, 24) }) : token(item), el, r, item.id)
        // A field's or an editor's own text is never read (the person's typing); a card that is one link keeps its words.
        const field = /^(textbox|textarea|editor|combobox|select|listbox|slider)$/.test(item.role)
        if (field) return
        const isCard = item.role === "link" && el.children.length > 1 && weightedLength(item.label) >= 40
        if (isCard && card === el) {
          for (const c of Array.from(el.children)) visit(c, words, siteRegion)
          card = null
          flush()
          return
        }
        for (const c of Array.from(el.children)) visit(c, false, siteRegion)
        return
      }
      if (SKIP.test(t)) return
      // The site's menus: a header's, a footer's or an outside nav's links in one line (its fields and buttons stay).
      if (!siteRegion && el.matches(SITE_REGION) && !el.closest(MAIN) && !overlaySet.has(root)) {
        flush()
        const menu = menuOf(el)
        if (menu) into.push(menu)
        for (const c of Array.from(el.children)) visit(c, words, true)
        flush()
        return
      }
      if (HEADING.test(t) || el.getAttribute("role") === "heading") {
        flush()
        const text = mask(squash((el as HTMLElement).innerText ?? el.textContent))
        if (text) into.push({ text: `# ${clipWeighted(text, 160)}`, heading: clipWeighted(text, 80), top: r.top + frameDy, bottom: r.bottom + frameDy, ids: [] })
        // (A heading's own controls — rare — still get their tokens.)
        for (const [cel, i] of items) if (el.contains(cel) && cel !== el) {
          put(token(i), cel, cel.getBoundingClientRect(), i.id)
        }
        flush()
        return
      }
      const message = el.matches(MESSAGE) && !!squash(el.textContent)
      if (message) {
        flush()
        line.push("[message]")
      }
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) {
          if (!words) continue
          const w = squash(n.nodeValue)
          // In a site menu, the words of its links are folded already; other words read.
          if (w && !(siteRegion && el.closest("a"))) put(w, el, r)
        } else if (n.nodeType === 1) visit(n as Element, words, siteRegion)
      }
      const shadow = (el as HTMLElement).shadowRoot
      if (shadow) for (const c of Array.from(shadow.children)) visit(c, words, siteRegion)
      // A same-origin frame's page reads in place.
      if (t === "iframe" || t === "frame") {
        let inner: Document | null = null
        try {
          inner = (el as HTMLIFrameElement).contentDocument
        } catch {
          inner = null
        }
        if (inner?.body) {
          flush()
          walk(inner.body, into, frameDy + r.top)
        }
      }
      if (message) flush()
    }
    visit(root, true, false)
    flush()
  }

  // Short neighbours in one line: a calendar's days, its weekday letters, a row of time slots (each its own block on the
  // page) read as one line, not forty.
  const TOKEN_ONLY = /^\[#[^\]]*\]$/
  const small = (b: Block) => !b.heading && !b.menu && (TOKEN_ONLY.test(b.text) || weightedLength(b.text) <= 8)
  const joined = (list: Block[]) => {
    const out: Block[] = []
    let run = false
    for (const b of list) {
      const prev = out[out.length - 1]
      if (prev && run && small(b) && weightedLength(prev.text) + b.text.length < LINE_MAX) {
        prev.text = `${prev.text} ${b.text}`
        prev.top = Math.min(prev.top, b.top)
        prev.bottom = Math.max(prev.bottom, b.bottom)
        prev.ids = [...prev.ids, ...b.ids]
        continue
      }
      out.push({ ...b })
      run = small(b)
    }
    return out
  }
  const overRaw: Block[] = []
  for (const o of overlays) walk(o, overRaw)
  const overBlocks = joined(overRaw)
  const raw: Block[] = []
  if (doc.body) walk(doc.body, raw)
  const blocks = joined(raw)

  // ---- parts: the screen, then §2… by headings (or a screen's height of the page when no heading comes)
  interface Part { n: number; heading: string; blocks: Block[]; where: "above" | "below" | "screen"; top: number }
  const onScreen = (b: Block) => b.bottom > 0 && b.top < height
  const screen: Block[] = []
  const parts: Part[] = []
  let cur: Part | null = null
  for (const b of blocks) {
    if (onScreen(b) || (b.top === 0 && b.bottom === 0)) {
      screen.push(b)
      cur = null
      continue
    }
    const where = b.top >= height ? "below" : "above"
    // A part: about a screen and a half of the page, or from a heading once the part before has half a screen.
    const span = cur ? b.bottom - cur.top : 0
    if (!cur || cur.where !== where || (b.heading && span >= height / 2) || span > height * 1.5) {
      cur = { n: parts.length + 2, heading: b.heading ?? "", blocks: [], where, top: b.top }
      parts.push(cur)
    }
    cur.blocks.push(b)
  }
  const open = new Set((input.open ?? []).slice(-OPEN_MAX))

  const lineOf = (b: Block) => {
    if (b.menu) return `[the site's menu: ${b.menu.links.slice(0, 6).join(" · ")}${b.menu.links.length > 6 ? ` · … ${b.menu.links.length} links` : ""}]${b.menu.kept.length ? ` ${b.menu.kept.join(" ")}` : ""}`
    return b.text
  }
  const out: string[] = []
  let size = 0
  const add = (s: string, force = false) => {
    if (!force && size + s.length + 1 > OUTLINE_MAX) return false
    out.push(s)
    size += s.length + 1
    return true
  }
  if (overBlocks.length) {
    add("[over the page]")
    for (const b of overBlocks) add(lineOf(b))
    add("[the page under it]")
  }
  for (const b of screen) if (!add(lineOf(b))) break
  // The parts: an opened one in full; the others as one line each (its heading, its first words, a few controls).
  const summary = (p: Part) => {
    const ids = p.blocks.flatMap((b) => b.ids)
    const firstWords = p.heading || clipWeighted(p.blocks.map((b) => b.text.replace(/\[#[^\]]*\]/g, "").trim()).find(Boolean) ?? "", 60)
    const tokens: string[] = []
    for (const b of p.blocks) {
      for (const m of b.text.matchAll(/\[#[^\]]*\]/g)) {
        if (tokens.length >= SUMMARY_TOKENS) break
        tokens.push(m[0])
      }
    }
    return `§${p.n} ${JSON.stringify(firstWords)} (${p.where}; ${ids.length} controls${tokens.length ? `: ${tokens.join(" ")}${ids.length > tokens.length ? " …" : ""}` : ""})`
  }
  const lines: string[] = []
  let summaries = 0
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]
    if (open.has(p.n)) {
      lines.push(`§${p.n} (opened):`)
      for (const b of p.blocks) lines.push(lineOf(b))
      continue
    }
    const one = summary(p)
    if (summaries + one.length <= SUMMARY_MAX) {
      lines.push(one)
      summaries += one.length + 1
      continue
    }
    // (Past the parts' share: ten closed parts to a line, by their first heading; each still opens by its number.)
    const group = [p]
    while (group.length < 10 && k + 1 < parts.length && !open.has(parts[k + 1].n) && parts[k + 1].where === p.where) group.push(parts[++k])
    const controls = group.reduce((n, g) => n + g.blocks.reduce((m, b) => m + b.ids.length, 0), 0)
    const head = group.map((g) => g.heading).find(Boolean) ?? ""
    lines.push(`§${group[0].n}–§${group[group.length - 1].n}${head ? ` ${JSON.stringify(head)}` : ""} (${p.where}; ${controls} controls)`)
  }
  for (const s of lines) if (!add(s)) {
    add(`… ${parts.length} parts in all`, true)
    break
  }
  const finalIds = new Set<string>()
  for (const s of out) for (const m of s.matchAll(/\[#([^\s\]]+)/g)) finalIds.add(m[1])
  return { text: out.join("\n"), sections: parts.length, ids: finalIds }
}
