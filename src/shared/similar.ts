// "Find similar" (2.6, Ultra): what the panel, the background worker and the server share. The panel asks only
// engine A (ours, every link opened and checked on our server); engine B (Google) stays off the panel's path.

import { isUltra, type Plan } from "./plan.ts"
import type { Usage } from "./types.ts"
import { isOutOfStock } from "./watch/detect.ts"
import { parseNumber, type Structured } from "./watch/extract.ts"

export type Met = "yes" | "no" | "unknown" | "n/a"

/** One alternative, as the server checked it. */
export interface SimilarItem {
  name: string
  why: string
  fit: string
  // The person's condition as the item's page shows it: "yes" checked, "unknown" not confirmed, "n/a" none asked.
  met: Met
  url: string
  host: string
  title: string
  // The item's own page, or a list or review page that names it.
  source: "item" | "list"
  // Opened by our server just now (false: the site doesn't let servers in; only the search result is known).
  checked: boolean
  // What the page states for machines, read when it was checked: "169.99 USD", in or out of stock, "2026-03-01".
  price?: string
  stock?: "in" | "out"
  date?: string
  // Where the price is on the page, for "Watch price" (page watch reads it from the same place).
  watch?: { source: "ld-price" | "meta-price"; value: string }
  // Apps (build 91): what it costs, read on its App Store page or its pricing page (`url`): free, a subscription from a
  // price, a one-time purchase, or in-app purchases from a price; `freeStart`: free to download, or a free plan.
  pricing?: SimilarPricing
  // Build 91: the page that settled the condition when it isn't the item's own (its price page, a rates page…).
  proof?: string
  // Build 93: how close it is (the share of the subject's traits it has too, 0–100) and how it differs most; under
  // CLOSE_SIMILARITY the panel shows it apart, as less similar, when there are fewer than 3 close ones.
  similarity?: number
  differs?: string
  // Build 93: an App Store app not sold in their country's store.
  regionLocked?: true
  // Build 93: what its reviewers say — the rating its pages state, a summary its pages bear out, where it was read.
  reviews?: { rating?: { value: number; best: number; count?: number }; summary?: string; sources: string[] }
}

/** At or above it an item is close; below, "less similar" (shown apart when fewer than 3 are close). */
export const CLOSE_SIMILARITY = 70

/** The items as the panel shows them: the close ones, and the less similar ones when fewer than 3 are close. */
export function closeAndLess(items: SimilarItem[]): { close: SimilarItem[]; less: SimilarItem[] } {
  const close = items.filter((i) => i.similarity === undefined || i.similarity >= CLOSE_SIMILARITY)
  const less = items.filter((i) => i.similarity !== undefined && i.similarity < CLOSE_SIMILARITY)
  // Enough close ones: the weaker ones aren't needed. None close at all: the best of them lead the list.
  if (close.length >= 3) return { close, less: [] }
  if (!close.length) return { close: less.slice(0, 1), less: less.slice(1, 4) }
  return { close, less: less.slice(0, 3) }
}

export interface SimilarPricing {
  model: "free" | "subscription" | "one_time" | "in_app"
  // "11.99 USD"
  from?: string
  period?: "week" | "month" | "year"
  freeStart?: boolean
  url: string
}

/** A finished answer, kept with the chat's answer turn. */
export interface SimilarAnswer {
  intro: string
  items: SimilarItem[]
  note: string
  // The kind of condition the server understood (none, cheaper, in_stock, …).
  condition: string
  // The person's own words for it ("" for none), and when the pages were checked (ms).
  asked: string
  at: number
}

export type SimilarStep = "plan" | "search" | "check" | "write"

/** What the background passes to the panel while an answer comes. */
export type SimilarStreamEvent =
  | { type: "progress"; step: SimilarStep; pages?: number }
  | { type: "item"; item: SimilarItem }
  | { type: "result"; answer: Omit<SimilarAnswer, "asked" | "at"> }
  | { type: "done" }
  // LIMIT_REACHED: the week's searches are used (`usage`: how many, and when they come back).
  | { type: "error"; code: string; plan?: Plan; usage?: Usage | null }

/** The request the panel makes: the page as it is now, and the condition in the person's words. */
export interface SimilarPayload {
  page: { title: string; url: string; text: string; facts: SimilarFacts }
  condition: string
  // 2.6 (build 90): from a selection, what was selected: alternatives to what it describes, the page as context.
  selection?: string
  // Build 93: where to look (anywhere, or near them) and their country (two letters).
  region?: "world" | "local"
  country?: string
}

/** The longest selection sent as Find similar's subject. */
export const SIMILAR_SELECTION_MAX = 1000

export interface SimilarFacts {
  price?: number
  currency?: string
  stock?: "in" | "out"
  published?: string
  lang?: string
}

/** Who may find similar things: Ultra (2.6). One seam for the panel and the server. */
export function similarAllowed(plan: Plan | string | null | undefined): boolean {
  return isUltra(plan as Plan | null | undefined)
}

/** The condition chips, in the panel's order; "language" means the person's own. */
export const SIMILAR_CHIPS = ["cheaper", "in_stock", "newer", "free", "language", "shorter"] as const
export type SimilarChip = (typeof SIMILAR_CHIPS)[number]

/** What the page the person is on states for machines (page watch's reader), as the server takes it. */
export function factsFrom(st: Structured, lang: string): SimilarFacts {
  const facts: SimilarFacts = {}
  const raw = st.ldPrice ?? st.metaPrice
  const amount = raw ? parseNumber(raw) : null
  if (amount !== null) {
    facts.price = amount
    const currency = /\b([A-Z]{3})\b/.exec(raw ?? "")?.[1]
    if (currency) facts.currency = currency
  }
  const stock = st.ldStock ?? st.metaStock
  if (stock) facts.stock = isOutOfStock(stock) ? "out" : "in"
  if (lang) facts.lang = lang.slice(0, 12)
  return facts
}

/**
 * The answer as Markdown: the chat turn's text, for copying, sharing and the app, which show no cards. Links are
 * the checked pages'.
 */
export function similarMarkdown(a: Pick<SimilarAnswer, "intro" | "items" | "note">, words: { inStock: string; outOfStock: string; notConfirmed: string; notOpened: string }): string {
  const lines = a.intro ? [a.intro, ""] : []
  a.items.forEach((it, i) => {
    const facts = [
      it.price,
      it.stock === "in" ? words.inStock : it.stock === "out" ? words.outOfStock : "",
      it.met === "unknown" ? words.notConfirmed : "",
      it.checked ? "" : words.notOpened
    ].filter(Boolean).join(" · ")
    lines.push(`${i + 1}. **[${it.name.replace(/[[\]]/g, "")}](${it.url})** (${it.host}) — ${it.why}${it.fit ? ` ${it.fit}` : ""}${facts ? ` _(${facts})_` : ""}`)
  })
  if (a.note) lines.push("", a.note)
  return lines.join("\n")
}

/** Only well-formed items reach the panel (it renders what the background passes). */
export function cleanItem(raw: unknown): SimilarItem | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
  const url = s(o.url, 2_000)
  if (!/^https?:\/\//i.test(url) || !s(o.name, 1)) return null
  const met = (["yes", "no", "unknown", "n/a"] as const).find((m) => m === o.met) ?? "unknown"
  const w = (o.watch ?? null) as Record<string, unknown> | null
  return {
    name: s(o.name, 160), why: s(o.why, 400), fit: s(o.fit, 300), met, url, host: s(o.host, 120), title: s(o.title, 300),
    source: o.source === "list" ? "list" : "item", checked: o.checked !== false,
    ...(s(o.price, 40) ? { price: s(o.price, 40) } : {}),
    ...(o.stock === "in" || o.stock === "out" ? { stock: o.stock } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(s(o.date, 10)) ? { date: s(o.date, 10) } : {}),
    ...(w && (w.source === "ld-price" || w.source === "meta-price") && s(w.value, 60) ? { watch: { source: w.source, value: s(w.value, 60) } } : {}),
    ...(cleanPricing(o.pricing) ?? {}),
    ...(/^https?:\/\//i.test(s(o.proof, 2_000)) ? { proof: s(o.proof, 2_000) } : {}),
    ...(typeof o.similarity === "number" && o.similarity >= 0 && o.similarity <= 100 ? { similarity: Math.round(o.similarity) } : {}),
    ...(s(o.differs, 200) ? { differs: s(o.differs, 200) } : {}),
    ...(o.regionLocked === true ? { regionLocked: true as const } : {}),
    ...(cleanReviews(o.reviews) ?? {})
  }
}

function cleanReviews(raw: unknown): { reviews: NonNullable<SimilarItem["reviews"]> } | null {
  const r = (raw ?? null) as Record<string, unknown> | null
  if (!r || typeof r !== "object") return null
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).map((u) => u.slice(0, 2_000)).slice(0, 3)
  const g = (r.rating ?? null) as Record<string, unknown> | null
  const rating = g && typeof g.value === "number" && typeof g.best === "number" && g.value > 0 && g.value <= g.best && g.best <= 100
    ? { value: g.value, best: g.best, ...(typeof g.count === "number" && g.count > 0 ? { count: Math.round(g.count) } : {}) }
    : null
  const summary = typeof r.summary === "string" ? r.summary.slice(0, 300) : ""
  if (!sources.length || (!rating && !summary)) return null
  return { reviews: { ...(rating ? { rating } : {}), ...(summary ? { summary } : {}), sources } }
}

function cleanPricing(raw: unknown): { pricing: SimilarPricing } | null {
  const p = (raw ?? null) as Record<string, unknown> | null
  if (!p || typeof p !== "object") return null
  const model = (["free", "subscription", "one_time", "in_app"] as const).find((m) => m === p.model)
  const url = typeof p.url === "string" ? p.url.slice(0, 2_000) : ""
  const from = typeof p.from === "string" ? p.from.slice(0, 40) : ""
  if (!model || !/^https?:\/\//i.test(url) || (model !== "free" && !from)) return null
  const period = (["week", "month", "year"] as const).find((x) => x === p.period)
  return { pricing: { model, url, ...(from ? { from } : {}), ...(period ? { period } : {}), ...(p.freeStart === true ? { freeStart: true } : {}) } }
}
