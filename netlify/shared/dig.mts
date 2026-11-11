// One or two pages deeper (build 91, for any kind of item): when an item's
// first page doesn't show whether the person's condition holds, the pages it links to that would — a review's link to
// the item's own page, the page in their language, the price, plans, rates, tickets or tuition page, the full recipe,
// the syllabus, the listing on the company's site. Pure helpers: which links, and what a quote from a page proves.
// The engine (similar.mts) opens them, checks them the same strict way, and lets a model point at the words that
// answer it, which must be on the page.

import type { ConditionKind } from "./similar.mts"
import type { CheckedPage, PageLink, PagePrice } from "./pagecheck.mts"
import { nameTokens } from "./pagecheck.mts"
import { pricePoint } from "./apppricing.mts"
import { FREE as FREE_WORDS, HOURS_IN, IN_STOCK, LEADS as LEAD_WORDS, MINUTES_IN, NOT_FREE as NOT_FREE_WORDS, pattern } from "./lexicon.mts"
import { firstPrice, isOutOfStock } from "../../src/shared/watch/detect.ts"

// What a link's words or address say it leads to, for each kind of condition, in any of the app's languages.
const LEADS: Partial<Record<ConditionKind, RegExp>> = Object.fromEntries(Object.entries(LEAD_WORDS).map(([kind, words]) => [kind, pattern(words)]))

/** How much of the item's name a link's words carry (0…1). */
function namedIn(text: string, name: string): number {
  const want = nameTokens(name)
  if (!want.length || !text) return 0
  const have = new Set(nameTokens(text))
  return want.filter((t) => have.has(t)).length / want.length
}

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
const sameSite = (a: string, b: string) => {
  const x = site(a)
  const y = site(b)
  return Boolean(x && y) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`))
}

export interface NextPage {
  url: string
  // Why it was picked: the item's own page (named in a review), the page in their language, or a page on the subject.
  why: "item" | "language" | "topic"
}

/**
 * The one or two pages to open after `page` for the condition `kind` (the item `name`; `lang`: the language wanted):
 * a review's link naming the item, the page's version in that language, then the same site's links whose words or
 * address lead to the condition's facts. Nothing for a condition no page can settle (nearby, none).
 */
export function nextPages(page: CheckedPage, kind: ConditionKind, name: string, list: boolean, lang = ""): NextPage[] {
  if (kind === "none" || kind === "nearby") return []
  const out: NextPage[] = []
  const add = (url: string, why: NextPage["why"]) => {
    if (out.length < 2 && !out.some((o) => o.url === url)) out.push({ url, why })
  }
  if (kind === "language" && lang) {
    const want = lang.toLowerCase().split("-")[0]
    const alt = page.alternates?.find((a) => a.lang.split("-")[0] === want)
    if (alt) add(alt.url, "language")
    return out
  }
  const links = page.links ?? []
  // A review or list names the item: its own page, wherever it is.
  if (list) {
    const named = links
      .map((l) => ({ l, score: namedIn(l.text, name) }))
      .filter((x) => x.score >= 0.6 && x.l.text.length <= 100)
      .sort((a, b) => b.score - a.score)
    for (const x of named) add(x.l.url, "item")
    if (out.length) return out
  }
  const lead = LEADS[kind]
  if (!lead) return out
  const scored = links
    .filter((l) => sameSite(l.url, page.finalUrl))
    .map((l) => {
      let path = ""
      try {
        path = decodeURIComponent(new URL(l.url).pathname)
      } catch {
        path = l.url
      }
      return { l, score: (lead.test(l.text) ? 2 : 0) + (lead.test(path.replace(/[-_/]+/g, " ")) ? 1 : 0) + (namedIn(l.text, name) >= 0.5 ? 0.5 : 0) }
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
  for (const x of scored) add(x.l.url, "topic")
  return out
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

/** Whether `quote` stands on the page (spaces and case aside): a model's words count only when the page has them. */
export function quoteOn(text: string, quote: string): boolean {
  const q = fold(quote).replace(/^["'«“]+|["'»”.…]+$/g, "")
  return q.length >= 6 && fold(text).includes(q)
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"

/** A date a quote states ("2026-03-04", "March 4, 2026", "4 March 2026", "04.03.2026", "2026年3月4日", "2026년 3월 4일"), as ISO. */
function dateIn(quote: string): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(quote)?.[1]
  if (iso) return new Date(`${iso}T00:00:00Z`).toISOString()
  // Year first with its marks (Chinese, Japanese, Korean), or day.month.year as most of Europe writes it.
  const cjk = /(\d{4})\s*[年년.]\s*(\d{1,2})\s*[月월.]\s*(\d{1,2})/.exec(quote)
  const dmy = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(quote)
  const ymd = cjk ? [cjk[1], cjk[2], cjk[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : null
  if (ymd) {
    const t = Date.UTC(Number(ymd[0]), Number(ymd[1]) - 1, Number(ymd[2]))
    return Number.isFinite(t) && Number(ymd[1]) <= 12 && Number(ymd[2]) <= 31 ? new Date(t).toISOString() : undefined
  }
  const words = new RegExp(`\\b(?:(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})|(\\d{1,2})\\s+(${MONTHS})\\.?,?\\s+(\\d{4}))\\b`, "i").exec(quote)
  const raw = words ? (words[1] ? `${words[1]} ${words[2]}, ${words[3]}` : `${words[5]} ${words[4]}, ${words[6]}`) : ""
  const t = raw ? Date.parse(`${raw} UTC`) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** A length a quote states ("1 hr 20 mins", "45 Minuten", "1時間20分", "2 giờ"), in seconds. */
function durationIn(quote: string): number | undefined {
  const h = HOURS_IN.exec(quote)
  const m = MINUTES_IN.exec(quote)
  if (!h && !m) return undefined
  return Math.round((h ? Number(h[1].replace(",", ".")) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0))
}

// Free, "free" that isn't the price (delivery, a trial), and stock a shop can sell now: the app's languages.
const FREE = pattern(FREE_WORDS)
const NOT_FREE = pattern(NOT_FREE_WORDS)
const IN = pattern(IN_STOCK)

/**
 * What a quote from a page proves for the condition `kind`, read by our code (never taken from the model): its price,
 * whether it's free, in stock, its date, its length. Null when it proves nothing of the kind.
 */
export function quoteFacts(kind: ConditionKind, quote: string): Partial<Pick<CheckedPage, "price" | "stock" | "published" | "duration">> | null {
  if (kind === "cheaper") {
    const shown = firstPrice(quote)
    const p = shown ? pricePoint(shown) : null
    return p && p.amount > 0 ? { price: p as PagePrice } : null
  }
  if (kind === "free") {
    const shown = firstPrice(quote)
    const p = shown ? pricePoint(shown) : null
    if (FREE.test(quote) && !NOT_FREE.test(quote) && !(p && p.amount > 0)) return { price: { amount: 0, currency: p?.currency ?? "" } }
    return p && p.amount > 0 ? { price: p as PagePrice } : null
  }
  if (kind === "in_stock") return isOutOfStock(quote) ? { stock: "out" } : IN.test(quote) ? { stock: "in" } : null
  if (kind === "newer") {
    const d = dateIn(quote)
    return d ? { published: d } : null
  }
  if (kind === "shorter") {
    const s = durationIn(quote)
    return s ? { duration: s } : null
  }
  return null
}
