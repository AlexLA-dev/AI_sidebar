// The page translated in place (2.7): what's on screen first, the rest as it scrolls into view; blocks the page adds
// later (a feed, comments) as they come; a block the site rendered back in its own language gets the translation again.
// What the page shows later while it's translated (build 107, the owner: «Возникающие попапы после перевода похоже
// не переводятся»): a dialog, a cart drawer or a menu added to the page, one that was there hidden and shows itself
// (its hidden or aria-hidden attribute taken off, a <details> or <dialog> opened), and what web components draw in
// their open shadow roots.
// Translations are kept for the page's address and language: "Original" and translating again, or the same page
// opened again, take them from there without asking the server (and without counting).
//
// Build 109 (the owner's test of 108: «динамически раскрывающаяся и обновляющаяся страница не допереводится», «Но
// долго»). What comes later is translated sooner and the pill says it's working on it:
//  - the state says `busy` while something the reader can see waits for its translation;
//  - what the page shows later goes before what was waiting, in a lane of its own;
//  - what's on the page but not shown yet (a closed menu, a list behind «More», a drawer off the screen) is translated
//    ahead while nothing else waits: what would open nearest the screen first, AHEAD_PASS at a place, AHEAD_CHARS a
//    page, so it's there when it opens;
//  - short words (a menu's, a button's) are kept for the whole site: its next page, and a pop-up that says the same,
//    need no request;
//  - tooltips: a wordless control's label with the page, any other when the pointer or the focus comes to it;
//  - the same words in two places are asked once.
//
// Build 110 (the owner's test of 109: a shop's search hint jumped between the site's words and ours several times a
// second). A translated part the site writes its own words into is read again inside that very change, before the
// next frame, and what's kept goes straight back: the reader never sees the original in between. A part the site
// answers every time (an observer of its own, an animation) is left to the site after a few rounds, for good.
// A system list's rows are translated (blocks.ts); the frames of a page (a chat window, an embedded form) by a small
// script of their own (frame.ts), which this engine runs in too.

import { urlKey } from "../../shared/conversation"
import { TRANSLATE_LIMITS, type TranslateAsk, type TranslateError, type TranslateReply } from "../../shared/translate"
import { applyBlock, blockCurrent, blockIntact, collectBlocks, controlBlock, insideSkipped, optionOf, restore, scanRoot, tipBlocks, WORD_ATTRS, type Applied, type Block } from "./blocks"

export type EngineState =
  // The page as it is (never translated, or put back with "Original").
  | { at: "off" }
  // Translating, nothing shown yet.
  | { at: "working" }
  // Translated (more may be on its way as the person scrolls). `busy`: something the reader can see is being
  // translated right now (the rest of the page, a pop-up, an opened menu).
  | { at: "on"; busy?: true }
  // The free answers (or the week's) are used up: nothing new is translated. `controls`: the day's free translations
  // of controls are (the page can still be translated as a page, one answer).
  | { at: "limit"; controls?: true }
  | { at: "error"; code: TranslateError }

interface Item {
  id: string
  block: Block
  status: "wait" | "queued" | "sent" | "done" | "skip"
  tries: number
  applied: Applied | null
  // The page showed it after its first reading (a pop-up, an opened view): it goes first.
  late: boolean
  // Not shown where it is (no box, or cut off by what holds it, or off to the side): may be translated ahead.
  hidden: boolean
  // Being translated ahead, unseen: the pill doesn't say it's working for it.
  ahead: boolean
}

/** The background's side of a request: replies come to `on` until "done" or "error"; the function cancels it. */
export type Ask = (ask: Omit<TranslateAsk, "type" | "req">, on: (reply: TranslateReply) => void) => () => void

export interface TranslationCache {
  load(url: string, to: string): Promise<Map<string, string>>
  save(url: string, to: string, entries: Map<string, string>): void
  // The site's short words (menus, buttons), kept for all its pages.
  loadSite?(site: string, to: string): Promise<Map<string, string>>
  saveSite?(site: string, to: string, entries: Map<string, string>): void
}

export interface EngineDeps {
  doc: Document
  url: () => string
  // The address the server counts the page by, where it isn't the document's own: a frame is part of the page that
  // holds it (one answer for both).
  counted?: () => string
  // The site the page belongs to (its host), for the words kept site-wide; none: nothing is kept that way.
  site?: () => string
  ask: Ask
  cache: TranslationCache
  // The page counted as an answer just now (for the usage line).
  charged?: () => void
  // The page's frames hear what it's translated into, and when it's back as it was (frames.ts).
  frames?: (state: { on: boolean; to: string; only: "controls" | null }) => void
  // The page's own observers unless given (tests hand in WebKit's records themselves).
  observers?: { mutation?: typeof MutationObserver; intersection?: typeof IntersectionObserver | null }
}

const VISIBLE_MARGIN = "300px 0px 900px 0px"
// What the page changes that may bring new words: nodes, text, an element showing itself, and the attributes whose
// words are translated (a tooltip the site rewrites).
const SHOWS = ["hidden", "aria-hidden", "open"]
const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...SHOWS, ...WORD_ATTRS] }
const MAX_INFLIGHT = 2
// The site wrote its own words back where their translation was, and the translation went in again: how often that
// is followed, counted for the words themselves (a site draws them in a new element each time). A re-render now and
// then, or a few times a second, is followed (nothing shows of it). More than BACK_BURST times within BACK_BURST_MS
// (the site answers each of our writes with its own: the two would go on forever) or BACK_MAX within BACK_WINDOW (an
// animation redrawing the words) and those words are left to the site. Rows a long list takes out and puts back as
// it's scrolled come back once each: far from either.
export const BACK_BURST = 6
const BACK_BURST_MS = 120
export const BACK_MAX = 60
const BACK_WINDOW = 5_000
// Reading a changed part again at once may take this long (ms) within a second; past it changes wait SCAN_DELAY, as
// what's new on the page always does.
const NOW_BUDGET = 24
// Times in a row (each within CHURN_GAP of the one before) a part of the page may change its words after they were
// translated before it's left as it is: a clock, a live score (each change would be another request). A heading the
// site rewrites for each view it opens changes now and then, not in a row, and is translated every time.
const MAX_CHURN = 3
const CHURN_GAP = 10_000
// What isn't shown yet is translated ahead in blocks of at most this many characters: this many at one place of the
// page (what would open by the screen: a real shop's header menus took a whole page's allowance before its filter
// list, further down, got any), this many a page.
export const AHEAD_BLOCK = 300
export const AHEAD_PASS = 4_000
export const AHEAD_CHARS = 12_000
// Less when only the controls are translated: that's free within a day's allowance (TRANSLATE_LIMITS, the server's
// caps), which closed menus mustn't use up.
export const AHEAD_CONTROLS_PASS = 1_000
export const AHEAD_CONTROLS_CHARS = 2_000
// The page scrolled this far (px) since the last time: another place.
const AHEAD_STEP = 300
/** A row of a list, a table or a menu. */
const ROWS = "li,tr,dd,dt,option,[role=listitem],[role=option],[role=menuitem],[role=row]"
// A tooltip is asked for this long after the pointer came (several passed over go in one request; the browser shows
// its own tooltip later than that).
const TIP_DELAY = 200
// The state stays `busy` this long after the last piece came, so it doesn't flicker between two requests.
const BUSY_TAIL = 450
// How soon a changed part of the page is read again, and a request leaves once something waits.
const SCAN_DELAY = 40
const FLUSH_DELAY = 30

export class PageTranslator {
  private deps: EngineDeps
  private to = ""
  private from: string | null = null
  // Only the page's controls (buttons, menus, labels) are translated: its words are in the reader's language.
  private only: "controls" | null = null
  private now: EngineState = { at: "off" }
  private listeners = new Set<(s: EngineState) => void>()
  private items = new Map<string, Item>()
  private owner = new WeakMap<Node, Item>()
  private byParent = new Map<Element, Set<Item>>()
  private cache = new Map<string, string>()
  // The site's short words, for all its pages (cache.loadSite); `siteDirty`: new ones to keep.
  private siteWords = new Map<string, string>()
  private siteDirty = false
  // Blocks not written yet, by their text: the same words in two places are asked once.
  private byText = new Map<string, Set<Item>>()
  private sentTexts = new Map<string, number>()
  private aheadChars = 0
  // Where the page stood (its scroll) the last time something was translated ahead.
  private aheadAt: number | null = null
  private aheadInflight = 0
  private first = true
  private busy = false
  private busyTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  private inflight = 0
  private asked = false
  private answered = false
  private capped = false
  private active = false
  private page = ""
  private cancels = new Set<() => void>()
  private io: IntersectionObserver | null = null
  private mo: MutationObserver | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private urlTimer: ReturnType<typeof setInterval> | null = null
  private dirty = new Set<Element>()
  // An attribute's block per element and attribute (a placeholder, a tooltip): read again, it isn't another block.
  private attrItems = new WeakMap<Element, Map<string, Item>>()
  private shadows = new WeakSet<ShadowRoot>()
  private shadowRoots: ShadowRoot[] = []
  private churn = new WeakMap<Element, { n: number; at: number }>()
  // When the site wrote each translated text back lately; the texts left to the site; the translated texts the site
  // has just undone (read again at once: what's kept for them goes back before the next frame).
  private pushed = new Map<string, number[]>()
  private left = new Set<string>()
  private undone = new Set<string>()
  private nowSpent = { at: 0, ms: 0 }
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  state(): EngineState {
    return this.now
  }

  subscribe(fn: (s: EngineState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(state: EngineState): void {
    if (JSON.stringify(state) === JSON.stringify(this.now)) return
    this.now = state
    for (const fn of this.listeners) fn(state)
  }

  /** Translates the page into `to` (a target code, src/shared/translate.ts targetCode); `only` "controls": just its
   *  buttons, menus, labels and the like (the ones there and the ones that show later). */
  async start(to: string, from: string | null, only: "controls" | null = null): Promise<void> {
    if (this.active) return
    this.clear()
    if (this.to !== to) this.cache.clear()
    this.to = to
    this.from = from
    this.only = only
    this.active = true
    this.capped = false
    this.first = true
    this.aheadChars = 0
    this.set({ at: "working" })
    this.aheadAt = null
    this.page = urlKey(this.deps.url())
    const site = this.deps.site?.() ?? ""
    try {
      const [kept, words] = await Promise.all([
        this.deps.cache.load(this.page, to),
        site && this.deps.cache.loadSite ? this.deps.cache.loadSite(site, to).catch(() => new Map<string, string>()) : new Map<string, string>()
      ])
      for (const [k, v] of kept) this.cache.set(k, v)
      this.siteWords = words
    } catch {
      // no kept translations
    }
    if (!this.active) return
    this.deps.frames?.({ on: true, to, only })
    this.watch()
    this.add(collectBlocks(this.deps.doc.body, this.watchShadow))
    this.first = false
    // With an IntersectionObserver its first report starts the requests (what's on screen); without one, now.
    if (!this.io) this.flushSoon(0)
  }

  /** "Original": the page as it was. What was translated is kept for translating again. */
  original(): void {
    const was = this.now.at !== "off"
    this.stop()
    this.clear()
    this.set({ at: "off" })
    if (was) this.deps.frames?.({ on: false, to: this.to, only: this.only })
  }

  /** No more requests or watching; what's shown stays. */
  private stop(): void {
    this.active = false
    this.unwatch()
    for (const cancel of this.cancels) cancel()
    this.cancels.clear()
    this.inflight = 0
    this.aheadInflight = 0
    this.sentTexts.clear()
    if (this.busyTimer) clearTimeout(this.busyTimer)
    this.busyTimer = null
    this.busy = false
  }

  /** Every translated block back as it was, and nothing tracked. */
  private clear(): void {
    this.writing(() => {
      for (const item of this.items.values()) if (item.applied) restore(item.applied)
    })
    this.items.clear()
    this.undone.clear()
    this.byParent.clear()
    this.byText.clear()
    this.owner = new WeakMap()
    this.attrItems = new WeakMap()
  }

  // ---------------------------------------------------------------- what the pill says

  /** Something the reader can see is waiting for its translation, or on its way. */
  private waiting(): boolean {
    for (const item of this.items.values()) if ((item.status === "queued" || item.status === "sent") && !item.ahead) return true
    return false
  }

  /** The state "on", with `busy` as it is now (kept a moment after the last piece, so it doesn't flicker). */
  private pulse(): void {
    if (!this.active || (this.now.at !== "on" && this.now.at !== "working")) return
    const waiting = this.waiting()
    if (waiting) {
      if (this.busyTimer) clearTimeout(this.busyTimer)
      this.busyTimer = null
      this.busy = true
    } else if (this.busy && !this.busyTimer) {
      this.busyTimer = setTimeout(() => {
        this.busyTimer = null
        this.busy = this.waiting()
        if (this.now.at === "on") this.setOn()
      }, BUSY_TAIL)
    }
    if (this.now.at === "on") this.setOn()
  }

  private setOn(): void {
    this.set(this.busy ? { at: "on", busy: true } : { at: "on" })
  }

  // ---------------------------------------------------------------- blocks

  /** `now`: asked for at once, whether or not it's on screen (a tooltip the pointer came to). */
  private add(blocks: Block[], now = false): void {
    for (const block of blocks) {
      if (this.only === "controls" && !controlBlock(block)) continue
      // Words left to the site; or the site's own words back where ours just were: ours again while that's followed.
      if (this.left.has(block.text) || (this.undone.has(block.text) && this.kept(block.text) !== undefined && !this.pushedBack(block.text))) continue
      if (block.attr) {
        const known = this.attrItems.get(block.parent)?.get(block.attr)
        if (known && this.items.has(known.id)) continue
      }
      const item: Item = { id: `b${++this.seq}`, block, status: "wait", tries: 0, applied: null, late: !this.first, hidden: false, ahead: false }
      this.items.set(item.id, item)
      if (block.attr) {
        let attrs = this.attrItems.get(block.parent)
        if (!attrs) this.attrItems.set(block.parent, (attrs = new Map()))
        attrs.set(block.attr, item)
      }
      for (const node of block.nodes) this.owner.set(node, item)
      const known = this.kept(block.text)
      if (known !== undefined) {
        this.apply(item, known)
        continue
      }
      let same = this.byText.get(block.text)
      if (!same) this.byText.set(block.text, (same = new Set()))
      same.add(item)
      const at = block.seen ?? block.parent
      let set = this.byParent.get(at)
      if (!set) {
        set = new Set()
        this.byParent.set(at, set)
        this.io?.observe(at)
      }
      set.add(item)
      // Without an IntersectionObserver (tests, very old browsers) everything counts as on screen.
      if (!this.io || now) item.status = "queued"
    }
  }

  /** What's kept for these words: the page's, else the site's (short ones). */
  private kept(text: string): string | undefined {
    return this.cache.get(text) ?? this.siteWords.get(text)
  }

  /** No longer among the blocks waiting to be written. */
  private settled(item: Item): void {
    const same = this.byText.get(item.block.text)
    if (same) {
      same.delete(item)
      if (!same.size) this.byText.delete(item.block.text)
    }
    const at = item.block.seen ?? item.block.parent
    const set = this.byParent.get(at)
    if (set) {
      set.delete(item)
      if (!set.size) {
        this.byParent.delete(at)
        this.io?.unobserve(at)
      }
    }
  }

  private forget(item: Item): void {
    if (item.applied) this.undone.add(item.block.text)
    if (item.applied) this.writing(() => restore(item.applied!))
    item.applied = null
    this.items.delete(item.id)
    if (item.block.attr) {
      const attrs = this.attrItems.get(item.block.parent)
      if (attrs?.get(item.block.attr) === item) attrs.delete(item.block.attr)
    }
    this.settled(item)
  }

  private apply(item: Item, translation: string): void {
    if (!this.active) return
    // Changed since it was sent (or rebuilt): read again as it is now, never written over.
    if (!blockCurrent(item.block)) {
      this.forget(item)
      this.markDirty(item.block.parent)
      return
    }
    let applied: Applied | null = null
    this.writing(() => {
      applied = applyBlock(item.block, translation, this.to)
    })
    if (!applied) {
      item.status = "skip"
      this.settled(item)
      return
    }
    const done = applied as Applied
    item.applied = done
    item.status = "done"
    for (const t of done.texts) this.owner.set(t.node, item)
    for (const t of done.added) this.owner.set(t, item)
    this.settled(item)
    if (this.now.at !== "on" && this.now.at !== "limit") this.setOn()
  }

  /** The words came (or were kept): written into every other place that says the same and waits. */
  private spread(text: string, translation: string): void {
    for (const item of [...(this.byText.get(text) ?? [])]) {
      if (item.status === "wait" || item.status === "queued") this.apply(item, translation)
    }
  }

  // ---------------------------------------------------------------- the server

  private flushSoon(delay = FLUSH_DELAY): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, delay)
  }

  private flush(): void {
    if (!this.active || this.capped || this.now.at === "limit") return
    // The page's first request alone: it's the one that counts the page (and may meet the limit).
    const lanes = this.answered ? MAX_INFLIGHT : 1
    for (;;) {
      // What the page showed later (a pop-up, an opened menu) goes first, and has a lane to itself when the others
      // are taken: it never waits behind what was scrolled past.
      const queued = [...this.items.values()].filter((i) => i.status === "queued" && !this.sentTexts.has(i.block.text))
      const late = queued.filter((i) => i.late && !i.ahead)
      const spare = this.answered && this.inflight >= lanes && this.inflight < lanes + 1 && late.length > 0
      if (this.inflight >= lanes && !spare) break
      // One request at a time for what's translated ahead: the other lane stays free for what shows.
      const order = spare ? late : [...late, ...queued.filter((i) => !i.late && !i.ahead), ...(this.aheadInflight ? [] : queued.filter((i) => i.ahead))]
      const first = !this.asked
      // Controls alone go in requests the server takes as such (short ones, free).
      const max = this.only === "controls" ? Math.min(TRANSLATE_LIMITS.controlRequestChars, first ? TRANSLATE_LIMITS.firstChars : TRANSLATE_LIMITS.requestChars) : first ? TRANSLATE_LIMITS.firstChars : TRANSLATE_LIMITS.requestChars
      const batch: Item[] = []
      const texts = new Set<string>()
      let chars = 0
      for (const item of order) {
        // The same words twice: asked once, the other place written when they come (spread).
        if (texts.has(item.block.text)) continue
        if (batch.length && (chars + item.block.text.length > max || batch.length >= TRANSLATE_LIMITS.requestBlocks)) break
        // What's shown and what's translated ahead don't share a request (the pill says it's working for the first).
        if (batch.length && item.ahead !== batch[0].ahead) break
        batch.push(item)
        texts.add(item.block.text)
        chars += item.block.text.length
      }
      if (!batch.length) break
      this.send(batch, first)
    }
    const idle = this.inflight === 0 && ![...this.items.values()].some((i) => i.status === "queued")
    if (idle && this.now.at === "working") {
      // Nothing on screen to translate (or all of it came from the kept translations): the rest as it scrolls in.
      this.setOn()
    }
    if (idle && this.answered && this.now.at === "on" && this.ahead()) this.flushSoon()
    this.pulse()
  }

  /** While nothing waits: what the page holds but doesn't show yet (short pieces) is queued, so a menu or a list is in
   *  the reader's language the moment it opens: what would open by the screen, nearest first, once per place the page
   *  is scrolled to, within the page's allowance. True when something was. */
  private ahead(): boolean {
    const controls = this.only === "controls"
    const left = (controls ? AHEAD_CONTROLS_CHARS : AHEAD_CHARS) - this.aheadChars
    if (left <= 0) return false
    const view = this.deps.doc.defaultView
    const at = view?.scrollY ?? 0
    if (this.aheadAt !== null && Math.abs(at - this.aheadAt) < AHEAD_STEP) return false
    const height = view?.innerHeight ?? 0
    // Where a hidden piece would open: the nearest part of the page around it that has a box. How far that is from
    // the screen (0 on it); whether it's the rest of a list the reader has before them (a hidden row whose list
    // shows: the items behind «More»); and how many levels up the box is (a closed menu sits deep under the header).
    const where = new Map<Element, { d: number; up: number; rest: boolean }>()
    const boxed = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect?.()
      return !!r && (r.width > 0 || r.height > 0)
    }
    const place = (el: Element): { d: number; up: number; rest: boolean } => {
      const known = where.get(el)
      if (known) return known
      let found = { d: height > 0 ? Number.POSITIVE_INFINITY : 0, up: 0, rest: false }
      if (height > 0) {
        for (let a: Element | null = el, i = 0; a && i < 14; a = a.parentElement, i++) {
          const r = a.getBoundingClientRect?.()
          if (!r || (r.width === 0 && r.height === 0)) continue
          const row = el.closest?.(ROWS)
          found = { d: r.bottom < 0 ? -r.bottom : r.top > height ? r.top - height : 0, up: i, rest: !!row && !boxed(row) && boxed(row.parentElement) }
          break
        }
      }
      where.set(el, found)
      return found
    }
    const near = [...this.items.values()]
      // (Not a system list's rows: a list that isn't shown is mostly one the site draws its own in place of.)
      .filter((i) => i.status === "wait" && i.hidden && !i.block.seen && i.block.text.length <= AHEAD_BLOCK)
      .map((item) => ({ item, ...place(item.block.parent) }))
      .filter((c) => c.d <= height / 2)
      .sort((a, b) => a.d - b.d || Number(b.rest) - Number(a.rest) || a.up - b.up)
    // The rest of a shown list within the page's allowance; anything else within one place's.
    let budget = Math.min(left, controls ? AHEAD_CONTROLS_PASS : AHEAD_PASS)
    let any = false
    for (const { item, rest } of near) {
      const size = item.block.text.length
      if (this.aheadChars + size > (controls ? AHEAD_CONTROLS_CHARS : AHEAD_CHARS) || (!rest && size > budget)) continue
      if (!rest) budget -= size
      this.aheadChars += size
      item.status = "queued"
      item.ahead = true
      any = true
    }
    if (any) this.aheadAt = at
    return any
  }

  private send(batch: Item[], first: boolean): void {
    this.asked = true
    this.inflight++
    for (const item of batch) {
      item.status = "sent"
      this.sentTexts.set(item.block.text, (this.sentTexts.get(item.block.text) ?? 0) + 1)
    }
    const ids = new Set(batch.map((i) => i.id))
    const quiet = batch.every((i) => i.ahead)
    if (quiet) this.aheadInflight++
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      this.inflight = Math.max(0, this.inflight - 1)
      if (quiet) this.aheadInflight = Math.max(0, this.aheadInflight - 1)
      this.cancels.delete(cancel)
      for (const item of batch) {
        const n = (this.sentTexts.get(item.block.text) ?? 1) - 1
        if (n > 0) this.sentTexts.set(item.block.text, n)
        else this.sentTexts.delete(item.block.text)
      }
    }
    const cancel = this.deps.ask(
      { url: this.deps.counted?.() ?? this.deps.url(), to: this.to, from: this.from, blocks: batch.map((i) => ({ id: i.id, text: i.block.text })), first, ...(this.only === "controls" ? { kind: "controls" as const } : {}) },
      (reply) => {
        if (ended || !this.active) return
        if (reply.type === "items") {
          this.answered = true
          for (const { id, text } of reply.items) {
            const item = this.items.get(id)
            if (!item || !ids.has(id)) continue
            this.keep(item.block, text)
            this.apply(item, text)
            this.spread(item.block.text, text)
          }
          this.saveSoon()
          this.pulse()
        } else if (reply.type === "skip") {
          for (const id of reply.ids) {
            const item = this.items.get(id)
            if (!item || !ids.has(id)) continue
            // Left as it is, in every place that says the same.
            for (const same of [item, ...(this.byText.get(item.block.text) ?? [])]) {
              same.status = "skip"
              this.settled(same)
            }
          }
        } else if (reply.type === "done") {
          this.answered = true
          end()
          if (reply.charged) this.deps.charged?.()
          this.requeue(batch)
          this.flushSoon()
        } else {
          end()
          this.failed(batch, reply.code)
        }
      }
    )
    this.cancels.add(cancel)
  }

  /** A translation kept: for the page, and a control's short words for the whole site. */
  private keep(block: Block, translation: string): void {
    this.cache.set(block.text, translation)
    if (block.text.length > TRANSLATE_LIMITS.controlChars || !this.deps.cache.saveSite) return
    this.siteWords.delete(block.text)
    this.siteWords.set(block.text, translation)
    this.siteDirty = true
  }

  /** Blocks a request didn't reach (time ran out): asked again, twice at most. */
  private requeue(batch: Item[]): void {
    for (const item of batch) {
      if (item.status !== "sent") continue
      item.tries++
      item.status = item.tries < 3 ? "queued" : "skip"
    }
  }

  private failed(batch: Item[], code: TranslateError): void {
    for (const item of batch) if (item.status === "sent") item.status = "queued"
    const shown = [...this.items.values()].some((i) => i.applied)
    if (code === "LIMIT_REACHED" || code === "CONTROLS_CAP") {
      // Nothing more is translated; what came from the kept translations stays.
      this.stop()
      this.set(code === "CONTROLS_CAP" ? { at: "limit", controls: true } : { at: "limit" })
      return
    }
    if (code === "PAGE_CAP") {
      // The page's safety cap: what's translated stays, the rest as it is.
      this.capped = true
      if (shown) this.setOn()
      else this.set({ at: "error", code })
      this.pulse()
      return
    }
    if (!shown || code === "CONSENT" || code === "BAD_REQUEST" || code === "UNAVAILABLE") {
      if (!shown) this.stop()
      this.set({ at: "error", code })
      return
    }
    // Shown already: tried again a little later, a few times.
    for (const item of batch) {
      item.tries++
      if (item.tries >= 3) item.status = "skip"
    }
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.flush()
      }, 4_000)
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 1_500)
  }

  private save(): void {
    this.deps.cache.save(this.page, this.to, this.cache)
    const site = this.deps.site?.() ?? ""
    if (this.siteDirty && site) this.deps.cache.saveSite?.(site, this.to, this.siteWords)
    this.siteDirty = false
  }

  // ---------------------------------------------------------------- the page

  private writing(fn: () => void): void {
    fn()
    // Our own changes aren't the site's.
    this.mo?.takeRecords()
  }

  private watch(): void {
    const win = this.deps.doc.defaultView as (Window & typeof globalThis) | null
    const IO = this.deps.observers?.intersection === undefined ? win?.IntersectionObserver : this.deps.observers.intersection
    if (IO) {
      this.io = new IO((entries) => {
        let any = false
        let late = false
        for (const entry of entries) {
          const items = this.byParent.get(entry.target as Element)
          if (!items) continue
          if (!entry.isIntersecting) {
            const hidden = notShown(entry)
            for (const item of items) item.hidden = hidden
            any ||= hidden
            continue
          }
          for (const item of items) {
            item.hidden = false
            // Shown while it was being translated ahead: the pill says it's working on it.
            item.ahead = false
            if (item.status === "wait") {
              item.status = "queued"
              any = true
              late ||= item.late
            }
          }
        }
        // Every report, the first one too (nothing on screen to translate: the state says so). What the page just
        // showed is asked for at once.
        if (any || this.now.at === "working") this.flushSoon(late ? 0 : FLUSH_DELAY)
      }, { rootMargin: VISIBLE_MARGIN })
    }
    const MO = this.deps.observers?.mutation ?? win?.MutationObserver
    if (MO) {
      this.mo = new MO((records) => this.changed(records))
      this.mo.observe(this.deps.doc.body, OBSERVE)
    }
    // The page scrolled to another place and come to rest: what's hidden near the screen there, ahead.
    win?.addEventListener("scroll", this.scrolled, { passive: true })
    // A tooltip's words when the pointer or the focus comes to what carries it.
    this.deps.doc.addEventListener("pointerover", this.tips, { capture: true, passive: true })
    this.deps.doc.addEventListener("focusin", this.tips, { capture: true, passive: true })
    // An address that changes without a new page (a site that loads its pages itself): a new page from then on.
    this.urlTimer = setInterval(() => {
      const key = urlKey(this.deps.url())
      if (key === this.page) return
      this.save()
      this.page = key
      this.asked = false
      this.answered = false
      this.capped = false
      this.aheadChars = 0
      this.aheadAt = null
      void this.deps.cache.load(key, this.to).then((kept) => {
        for (const [k, v] of kept) this.cache.set(k, v)
      }, () => undefined)
    }, 1_000)
  }

  /** A web component's open shadow root: its changes are watched like the page's. */
  private watchShadow = (shadow: ShadowRoot): void => {
    if (this.shadows.has(shadow) || !this.mo) return
    this.shadows.add(shadow)
    this.mo.observe(shadow, OBSERVE)
    shadow.addEventListener("pointerover", this.tips, { capture: true, passive: true })
    shadow.addEventListener("focusin", this.tips, { capture: true, passive: true })
    this.shadowRoots.push(shadow)
  }

  /** The pointer or the focus on `ev`'s element: its tooltips (and those around it) are asked for now. */
  private tips = (ev: Event): void => {
    if (!this.active || this.capped || this.now.at === "limit") return
    // A finger shows no tooltip: only a mouse or a trackpad's pointer, and the keyboard's focus where there is one.
    if (ev.type === "pointerover" ? (ev as PointerEvent).pointerType === "touch" : this.deps.doc.defaultView?.matchMedia?.("(hover: hover)").matches === false) return
    // On the page it's the element itself; inside a web component, its own root hears it (watchShadow).
    const el = ev.target as Element | null
    if (!el || el.nodeType !== 1 || el.tagName === "CONTEXTFLOW-ROOT") return
    const blocks = tipBlocks(el).filter((b) => !this.attrItems.get(b.parent)?.has(b.attr!))
    if (!blocks.length) return
    this.add(blocks, true)
    this.flushSoon(TIP_DELAY)
  }

  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  private scrolled = (): void => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null
      this.flushSoon()
    }, 400)
  }

  private unwatch(): void {
    this.deps.doc.defaultView?.removeEventListener("scroll", this.scrolled)
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = null
    this.io?.disconnect()
    this.io = null
    this.mo?.disconnect()
    this.mo = null
    for (const target of [this.deps.doc, ...this.shadowRoots.splice(0)]) {
      target.removeEventListener("pointerover", this.tips, { capture: true })
      target.removeEventListener("focusin", this.tips, { capture: true })
    }
    for (const t of [this.flushTimer, this.scanTimer, this.retryTimer, this.saveTimer]) if (t) clearTimeout(t)
    this.flushTimer = this.scanTimer = this.retryTimer = null
    if (this.saveTimer) {
      this.saveTimer = null
      this.save()
    }
    if (this.urlTimer) clearInterval(this.urlTimer)
    this.urlTimer = null
    this.dirty.clear()
    this.shadows = new WeakSet()
  }

  /** The site changed the page: its own words back in a translated block, new blocks, a block rebuilt. */
  private changed(records: MutationRecord[]): void {
    if (!this.active) return
    for (const r of records) {
      // A system list's row rewritten by the site: the label on it (ours) no longer says what the row does.
      const row = r.type === "attributes" ? null : optionOf(r.target)
      if (row) {
        const item = this.attrItems.get(row)?.get("label")
        if (item && this.items.has(item.id)) this.forget(item)
        this.churned(row)
        this.markDirty(row)
        continue
      }
      if (r.type === "characterData") {
        const node = r.target as Text
        const item = this.owner.get(node)
        // Words written into a text node no block owned (an empty label filled in later): read its part again.
        if (!item && node.data.trim() && node.parentElement) {
          this.markDirty(node.parentElement)
          continue
        }
        const rec = item?.applied?.texts.find((t) => t.node === node)
        if (!item || !rec || node.data === rec.now) continue
        if (node.data === rec.was && this.pushedBack(item.block.text)) {
          // The site wrote its own words back (a re-render): ours again, before the next frame.
          this.writing(() => {
            node.data = rec.now
          })
        } else {
          this.forget(item)
          this.churned(item.block.parent)
          this.markDirty(item.block.parent)
        }
        continue
      }
      if (r.type === "attributes") {
        const el = r.target as Element
        if (el.nodeType !== 1 || el.tagName === "CONTEXTFLOW-ROOT") continue
        const name = r.attributeName ?? ""
        if (SHOWS.includes(name)) {
          // Something that was there hidden shows itself (a menu, a dialog, a drawer): read it now.
          if (!el.hasAttribute("hidden")) this.markDirty(el)
          continue
        }
        // An attribute's words changed by the site (a tooltip that says something else now, a hint the site writes
        // again): read again, at once where it was translated.
        const item = this.attrItems.get(el)?.get(name)
        if (item && this.items.has(item.id)) {
          if (item.applied?.attr && el.getAttribute(name) === item.applied.attr.now) continue
          // Written again with the words it had, while they wait for their translation: nothing changed (a field
          // whose hint the site sets over and over).
          if (!item.applied && blockCurrent(item.block)) continue
          this.forget(item)
        }
        this.churned(el)
        // A tooltip already asked for (the pointer was on it) is asked again; a control's label with its part.
        if (item) this.add(tipBlocks(el).filter((b) => b.parent === el && b.attr === name && this.follows(b)), true)
        this.markDirty(el)
        continue
      }
      if (r.type !== "childList") continue
      const target = r.target as Element
      if (target.nodeType !== 1 || target.tagName === "CONTEXTFLOW-ROOT") continue
      // A translated block whose nodes the site replaced: put back what's left and read it again.
      for (const node of [...Array.from(r.removedNodes), ...Array.from(r.addedNodes)]) {
        const item = this.owner.get(node)
        if (item && this.items.has(item.id)) {
          this.forget(item)
          this.markDirty(item.block.parent)
        }
      }
      // Or took out the element around translated words (to draw it again with its own).
      for (const node of Array.from(r.removedNodes)) if (node.nodeType === 1 && this.translatedIn(node as Element)) this.markDirty(target)
      for (const item of [...(this.byParent.get(target) ?? [])]) if (!blockIntact(item.block)) this.forget(item)
      for (const node of Array.from(r.addedNodes)) {
        if (node.nodeType === 3 && !(node as Text).data.trim()) continue
        this.markDirty(node.nodeType === 1 ? (node as Element) : target)
      }
    }
    // Translated words the site has just undone: their part is read again now, inside the site's own change.
    if (this.undone.size) this.rescanNow()
  }

  /** Translated words were inside `el` (which the site took out of the page): they're forgotten. Looks at its first
   *  words only: a long part taken out is read again a moment later, as before. */
  private translatedIn(el: Element): boolean {
    const walker = el.ownerDocument.createTreeWalker(el, 4)
    let found = false
    for (let n = walker.nextNode(), seen = 0; n && seen < 60; n = walker.nextNode(), seen++) {
      const item = this.owner.get(n)
      if (!item?.applied || !this.items.has(item.id)) continue
      this.forget(item)
      found = true
    }
    return found
  }

  /** The site wrote `text` back where its translation was: true while that's still followed (see BACK_BURST), false
   *  once those words are left to the site. */
  private pushedBack(text: string): boolean {
    if (this.left.has(text)) return false
    const now = Date.now()
    if (this.pushed.size > 400) this.pushed.clear()
    const times = (this.pushed.get(text) ?? []).filter((t) => now - t < BACK_WINDOW)
    times.push(now)
    this.pushed.set(text, times)
    if (times.length <= BACK_MAX && times.filter((t) => now - t < BACK_BURST_MS).length <= BACK_BURST) return true
    this.left.add(text)
    return false
  }

  /** What changed is read now rather than SCAN_DELAY later, within NOW_BUDGET a second. */
  private rescanNow(): void {
    const t0 = performance.now()
    if (t0 - this.nowSpent.at > 1_000) this.nowSpent = { at: t0, ms: 0 }
    if (this.nowSpent.ms > NOW_BUDGET) return
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = null
    this.rescan()
    this.nowSpent.ms += performance.now() - t0
  }

  /** A block read again is translated: not where its part was left to the site, and (unless its words are kept:
   *  that costs nothing) not where the words change too often to follow. */
  private follows(block: Block): boolean {
    return !this.left.has(block.text) && (this.kept(block.text) !== undefined || !this.lively(block.parent))
  }

  /** The site changed a translated part's words: counted while the changes come in a row, so one that keeps
   *  changing (a clock) is left alone and one rewritten now and then (a view's heading) isn't. */
  private churned(el: Element): void {
    const now = Date.now()
    const was = this.churn.get(el)
    this.churn.set(el, { n: was && now - was.at < CHURN_GAP ? was.n + 1 : 1, at: now })
  }

  /** Changing too often to follow (until it has kept still for a while). */
  private lively(el: Element): boolean {
    const c = this.churn.get(el)
    return !!c && c.n >= MAX_CHURN && Date.now() - c.at < CHURN_GAP
  }

  private markDirty(el: Element): void {
    // A system list is read from what holds it (the walk leaves the list alone; its rows are read as attributes).
    const list = el.closest?.("select")
    const root = scanRoot(list?.parentElement ?? el)
    if (!root || insideSkipped(root)) return
    this.dirty.add(root)
    if (this.scanTimer) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.rescan()
    }, SCAN_DELAY)
  }

  private rescan(): void {
    if (!this.active) return
    const roots = [...this.dirty].filter((el) => el.isConnected)
    this.dirty.clear()
    // Each part of the page once (a root inside another dirty one is read with it).
    const tops = roots.filter((el) => !roots.some((other) => other !== el && other.contains(el)))
    for (const root of tops) {
      let blocks = collectBlocks(root, this.watchShadow)
      let changed = false
      for (const block of blocks) {
        const owners = new Set(block.nodes.map((n) => this.owner.get(n)).filter((i): i is Item => !!i && this.items.has(i.id)))
        if (!owners.size) continue
        const [only] = owners
        if (owners.size === 1 && blockIntact(only.block) && block.nodes.every((n) => this.owner.get(n) === only)) continue
        for (const item of owners) this.forget(item)
        changed = true
      }
      if (changed) blocks = collectBlocks(root, this.watchShadow)
      this.add(blocks.filter((b) => this.follows(b) && !b.nodes.some((n) => {
        const item = this.owner.get(n)
        return item && this.items.has(item.id)
      })))
    }
    this.undone.clear()
    this.flushSoon()
  }
}

/** A block the observer says isn't on screen: not shown where it is (no box; or within the screen's reach and cut off
 *  by what holds it; or off to the side, as a closed drawer is), rather than further down the page. */
function notShown(entry: IntersectionObserverEntry): boolean {
  const r = entry.boundingClientRect
  if (r.width === 0 && r.height === 0) return true
  const root = entry.rootBounds
  if (!root) return false
  return r.bottom > root.top && r.top < root.bottom
}
