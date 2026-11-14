// The page translated in place (2.7): what's on screen first, the rest as it scrolls into view; blocks the page adds
// later (a feed, comments) as they come; a block the site rendered back in its own language gets the translation again.
// Translations are kept for the page's address and language: "Original" and translating again, or the same page
// opened again, take them from there without asking the server (and without counting).

import { urlKey } from "../../shared/conversation"
import { TRANSLATE_LIMITS, type TranslateAsk, type TranslateError, type TranslateReply } from "../../shared/translate"
import { applyBlock, blockCurrent, blockIntact, collectBlocks, insideSkipped, restore, scanRoot, type Applied, type Block } from "./blocks"

export type EngineState =
  // The page as it is (never translated, or put back with "Original").
  | { at: "off" }
  // Translating, nothing shown yet.
  | { at: "working" }
  // Translated (more may be on its way as the person scrolls).
  | { at: "on" }
  // The free answers (or the week's) are used up: nothing new is translated.
  | { at: "limit" }
  | { at: "error"; code: TranslateError }

interface Item {
  id: string
  block: Block
  status: "wait" | "queued" | "sent" | "done" | "skip"
  tries: number
  applied: Applied | null
  // Times the site put its own words back and they were translated again (a site fighting it is left alone).
  again: number
}

/** The background's side of a request: replies come to `on` until "done" or "error"; the function cancels it. */
export type Ask = (ask: Omit<TranslateAsk, "type" | "req">, on: (reply: TranslateReply) => void) => () => void

export interface TranslationCache {
  load(url: string, to: string): Promise<Map<string, string>>
  save(url: string, to: string, entries: Map<string, string>): void
}

export interface EngineDeps {
  doc: Document
  url: () => string
  ask: Ask
  cache: TranslationCache
  // The page counted as an answer just now (for the usage line).
  charged?: () => void
  // The page's own observers unless given (tests hand in WebKit's records themselves).
  observers?: { mutation?: typeof MutationObserver; intersection?: typeof IntersectionObserver | null }
}

const VISIBLE_MARGIN = "300px 0px 900px 0px"
const MAX_INFLIGHT = 2
const MAX_AGAIN = 4
// Times a part of the page may change its words after they were translated before it's left as it is (a clock, a
// live score): each change would be another request.
const MAX_CHURN = 3

export class PageTranslator {
  private deps: EngineDeps
  private to = ""
  private from: string | null = null
  private now: EngineState = { at: "off" }
  private listeners = new Set<(s: EngineState) => void>()
  private items = new Map<string, Item>()
  private owner = new WeakMap<Node, Item>()
  private byParent = new Map<Element, Set<Item>>()
  private cache = new Map<string, string>()
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
  private churn = new WeakMap<Element, number>()
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

  /** Translates the page into `to` (a target code, src/shared/translate.ts targetCode). */
  async start(to: string, from: string | null): Promise<void> {
    if (this.active) return
    this.clear()
    if (this.to !== to) this.cache.clear()
    this.to = to
    this.from = from
    this.active = true
    this.capped = false
    this.set({ at: "working" })
    this.page = urlKey(this.deps.url())
    try {
      for (const [k, v] of await this.deps.cache.load(this.page, to)) this.cache.set(k, v)
    } catch {
      // no kept translations
    }
    if (!this.active) return
    this.watch()
    this.add(collectBlocks(this.deps.doc.body))
    // With an IntersectionObserver its first report starts the requests (what's on screen); without one, now.
    if (!this.io) this.flushSoon(0)
  }

  /** "Original": the page as it was. What was translated is kept for translating again. */
  original(): void {
    this.stop()
    this.clear()
    this.set({ at: "off" })
  }

  /** No more requests or watching; what's shown stays. */
  private stop(): void {
    this.active = false
    this.unwatch()
    for (const cancel of this.cancels) cancel()
    this.cancels.clear()
    this.inflight = 0
  }

  /** Every translated block back as it was, and nothing tracked. */
  private clear(): void {
    this.writing(() => {
      for (const item of this.items.values()) if (item.applied) restore(item.applied)
    })
    this.items.clear()
    this.byParent.clear()
    this.owner = new WeakMap()
  }

  // ---------------------------------------------------------------- blocks

  private add(blocks: Block[]): void {
    for (const block of blocks) {
      const item: Item = { id: `b${++this.seq}`, block, status: "wait", tries: 0, applied: null, again: 0 }
      this.items.set(item.id, item)
      for (const node of block.nodes) this.owner.set(node, item)
      const known = this.cache.get(block.text)
      if (known !== undefined) {
        this.apply(item, known)
        continue
      }
      let set = this.byParent.get(block.parent)
      if (!set) {
        set = new Set()
        this.byParent.set(block.parent, set)
        this.io?.observe(block.parent)
      }
      set.add(item)
      // Without an IntersectionObserver (tests, very old browsers) everything counts as on screen.
      if (!this.io) item.status = "queued"
    }
  }

  private forget(item: Item): void {
    if (item.applied) this.writing(() => restore(item.applied!))
    item.applied = null
    this.items.delete(item.id)
    const set = this.byParent.get(item.block.parent)
    if (set) {
      set.delete(item)
      if (!set.size) {
        this.byParent.delete(item.block.parent)
        this.io?.unobserve(item.block.parent)
      }
    }
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
      applied = applyBlock(item.block, translation)
    })
    if (!applied) {
      item.status = "skip"
      return
    }
    const done = applied as Applied
    item.applied = done
    item.status = "done"
    for (const t of done.texts) this.owner.set(t.node, item)
    for (const t of done.added) this.owner.set(t, item)
    const set = this.byParent.get(item.block.parent)
    set?.delete(item)
    if (set && !set.size) {
      this.byParent.delete(item.block.parent)
      this.io?.unobserve(item.block.parent)
    }
    if (this.now.at !== "on" && this.now.at !== "limit") this.set({ at: "on" })
  }

  // ---------------------------------------------------------------- the server

  private flushSoon(delay = 60): void {
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
    while (this.inflight < lanes) {
      const first = !this.asked
      const max = first ? TRANSLATE_LIMITS.firstChars : TRANSLATE_LIMITS.requestChars
      const batch: Item[] = []
      let chars = 0
      for (const item of this.items.values()) {
        if (item.status !== "queued") continue
        if (batch.length && (chars + item.block.text.length > max || batch.length >= TRANSLATE_LIMITS.requestBlocks)) break
        batch.push(item)
        chars += item.block.text.length
      }
      if (!batch.length) break
      this.send(batch, first)
    }
    if (this.inflight === 0 && this.now.at === "working" && ![...this.items.values()].some((i) => i.status === "queued")) {
      // Nothing on screen to translate (or all of it came from the kept translations): the rest as it scrolls in.
      this.set({ at: "on" })
    }
  }

  private send(batch: Item[], first: boolean): void {
    this.asked = true
    this.inflight++
    for (const item of batch) item.status = "sent"
    const ids = new Set(batch.map((i) => i.id))
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      this.inflight = Math.max(0, this.inflight - 1)
      this.cancels.delete(cancel)
    }
    const cancel = this.deps.ask(
      { url: this.deps.url(), to: this.to, from: this.from, blocks: batch.map((i) => ({ id: i.id, text: i.block.text })), first },
      (reply) => {
        if (ended || !this.active) return
        if (reply.type === "items") {
          this.answered = true
          for (const { id, text } of reply.items) {
            const item = this.items.get(id)
            if (!item || !ids.has(id)) continue
            this.cache.set(item.block.text, text)
            this.apply(item, text)
          }
          this.saveSoon()
        } else if (reply.type === "skip") {
          for (const id of reply.ids) {
            const item = this.items.get(id)
            if (item && ids.has(id)) item.status = "skip"
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
    if (code === "LIMIT_REACHED") {
      // Nothing more is translated; what came from the kept translations stays.
      this.stop()
      this.set({ at: "limit" })
      return
    }
    if (code === "PAGE_CAP") {
      // The page's safety cap: what's translated stays, the rest as it is.
      this.capped = true
      this.set(shown ? { at: "on" } : { at: "error", code })
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
      this.deps.cache.save(this.page, this.to, this.cache)
    }, 1_500)
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
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          for (const item of this.byParent.get(entry.target as Element) ?? []) {
            if (item.status === "wait") {
              item.status = "queued"
              any = true
            }
          }
        }
        // Every report, the first one too (nothing on screen to translate: the state says so).
        if (any || this.now.at === "working") this.flushSoon()
      }, { rootMargin: VISIBLE_MARGIN })
    }
    const MO = this.deps.observers?.mutation ?? win?.MutationObserver
    if (MO) {
      this.mo = new MO((records) => this.changed(records))
      this.mo.observe(this.deps.doc.body, { childList: true, subtree: true, characterData: true })
    }
    // An address that changes without a new page (a site that loads its pages itself): a new page from then on.
    this.urlTimer = setInterval(() => {
      const key = urlKey(this.deps.url())
      if (key === this.page) return
      this.page = key
      this.asked = false
      this.answered = false
      this.capped = false
      void this.deps.cache.load(key, this.to).then((kept) => {
        for (const [k, v] of kept) this.cache.set(k, v)
      }, () => undefined)
    }, 1_000)
  }

  private unwatch(): void {
    this.io?.disconnect()
    this.io = null
    this.mo?.disconnect()
    this.mo = null
    for (const t of [this.flushTimer, this.scanTimer, this.retryTimer, this.saveTimer]) if (t) clearTimeout(t)
    this.flushTimer = this.scanTimer = this.retryTimer = null
    if (this.saveTimer) {
      this.saveTimer = null
      this.deps.cache.save(this.page, this.to, this.cache)
    }
    if (this.urlTimer) clearInterval(this.urlTimer)
    this.urlTimer = null
    this.dirty.clear()
  }

  /** The site changed the page: its own words back in a translated block, new blocks, a block rebuilt. */
  private changed(records: MutationRecord[]): void {
    if (!this.active) return
    for (const r of records) {
      if (r.type === "characterData") {
        const node = r.target as Text
        const item = this.owner.get(node)
        const rec = item?.applied?.texts.find((t) => t.node === node)
        if (!item || !rec || node.data === rec.now) continue
        if (node.data === rec.was && item.again < MAX_AGAIN) {
          // The site wrote its own words back (a re-render): ours again.
          item.again++
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
      for (const item of [...(this.byParent.get(target) ?? [])]) if (!blockIntact(item.block)) this.forget(item)
      for (const node of Array.from(r.addedNodes)) {
        if (node.nodeType === 3 && !(node as Text).data.trim()) continue
        this.markDirty(node.nodeType === 1 ? (node as Element) : target)
      }
    }
  }

  /** The site changed a translated part's words: counted, so one that keeps changing is left alone. */
  private churned(el: Element): void {
    this.churn.set(el, (this.churn.get(el) ?? 0) + 1)
  }

  private markDirty(el: Element): void {
    const root = scanRoot(el)
    if (!root || insideSkipped(root)) return
    this.dirty.add(root)
    if (this.scanTimer) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.rescan()
    }, 150)
  }

  private rescan(): void {
    if (!this.active) return
    const roots = [...this.dirty].filter((el) => el.isConnected)
    this.dirty.clear()
    // Each part of the page once (a root inside another dirty one is read with it).
    const tops = roots.filter((el) => !roots.some((other) => other !== el && other.contains(el)))
    for (const root of tops) {
      let blocks = collectBlocks(root)
      let changed = false
      for (const block of blocks) {
        const owners = new Set(block.nodes.map((n) => this.owner.get(n)).filter((i): i is Item => !!i && this.items.has(i.id)))
        if (!owners.size) continue
        const [only] = owners
        if (owners.size === 1 && blockIntact(only.block) && block.nodes.every((n) => this.owner.get(n) === only)) continue
        for (const item of owners) this.forget(item)
        changed = true
      }
      if (changed) blocks = collectBlocks(root)
      this.add(blocks.filter((b) => (this.churn.get(b.parent) ?? 0) < MAX_CHURN && !b.nodes.some((n) => {
        const item = this.owner.get(n)
        return item && this.items.has(item.id)
      })))
    }
    this.flushSoon()
  }
}
