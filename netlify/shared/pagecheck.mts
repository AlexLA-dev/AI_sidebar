// "Find similar" (2.6, Ultra): our server opens each page an answer may link to and checks it before the
// answer is written. Redirects are followed by hand (each hop checked), then the page's status, a "not found"
// page served with 200 (soft-404), a bot wall, an archived copy, whether the page is about the item it was
// picked for, and what the page states for machines: price, stock, dates, language, length.
// Prices and stock are read with page watch's parser (src/shared/watch/extract.ts), so both read shops alike.
// Nothing is stored: the page is read once and forgotten.

import { MONEY_SIGN, currencyOf, currencyOfSign } from "./money.mts"
import { AGO, GONE as GONE_WORDS, ITEM_PAGE, PRICE_PER_MONTH, HELPFUL, MARK_WORDS, NAME_EXTRAS, NAME_STOP, OTHER_ITEMS, PRICE_CART, PRICE_LABEL, PRICE_MONTHLY, PRICE_NOT_NOW, PRICE_SAVING, RATING_OF_5, REVIEW_COUNT, REVIEWS_HEAD as REVIEWS_HEAD_WORDS, SHIPPING, SHOP_WORDS, STARS, UNITS, VERIFIED, foldedPhrases, foldedWords, pattern } from "./lexicon.mts"
import { SIMPLIFIED, TRADITIONAL } from "../../src/shared/share.ts"
import { isOutOfStock } from "../../src/shared/watch/detect.ts"
import { hasDate } from "../../src/shared/watch/detect.ts"
import { pageText, parseNumber, structured } from "../../src/shared/watch/extract.ts"
import { appStoreLink, appStorePricing, pricingLinks, type AppPricing } from "./apppricing.mts"

export type PageStatus = "ok" | "dead" | "soft404" | "blocked" | "archived" | "error" | "unsafe"

export interface PagePrice {
  amount: number
  currency: string
}

export interface PageLink {
  url: string
  text: string
}

export interface CheckedPage {
  // The address as given, and where it led.
  url: string
  finalUrl: string
  status: PageStatus
  http: number
  hops: number
  // Why it isn't "ok" (or a note on an ok page: "thin", "unavailable", "expired").
  reason: string
  title: string
  // JSON-LD name / og:title / first h1: the item the page is about.
  name: string
  description: string
  siteName: string
  // schema.org types seen in the page's JSON-LD (Product, Recipe, NewsArticle, …) and og:type.
  types: string[]
  // <html lang> (or og:locale): the site's language for this request; some sites follow the browser's language.
  lang: string
  // The content's own language when the page states it (JSON-LD inLanguage).
  inLanguage?: string
  price?: PagePrice
  priceRaw?: string
  // Where the price was read: JSON-LD offers or product meta tags (page watch reads it from the same place).
  priceFrom?: "ld" | "meta" | "text"
  stock?: "in" | "out" | "unknown"
  stockRaw?: string
  // ISO dates: when it was published and last changed; a job post's or offer's end.
  published?: string
  modified?: string
  validThrough?: string
  // Seconds: a video's length, a recipe's total time.
  duration?: number
  // Apps (build 91): what it costs as this page shows it (an App Store page's price and in-app purchases); else where
  // to look next: the App Store page the app's site links to, the site's pricing page.
  pricing?: AppPricing
  // Build 93: the item's rating as the page states it for machines (JSON-LD AggregateRating); build 94: else its
  // microdata, a reviews widget's own attributes (Judge.me, Loox, Stamped…) or "4.3 out of 5 · 1,204 reviews" in the
  // product's header — always read by our code, never by a model.
  rating?: PageRating
  // Build 94: the page's own reviews (the text after its "Customer reviews" heading), for what reviewers say.
  reviewsText?: string
  // Build 94: a Shopify shop (its catalog, /products.json, lists the brand's other models).
  shopify?: true
  storeLink?: string
  pricingLinks?: string[]
  // Build 91: the page's links (address and words) and its versions in other languages, for one or two pages more
  // when this one doesn't show the person's condition (dig.mts).
  links?: PageLink[]
  alternates?: Array<{ lang: string; url: string }>
  // The page's main text, folded, cut to the requested length.
  text: string
  ms: number
}

export interface CheckOptions {
  timeoutMs?: number
  maxBytes?: number
  // Characters of main text kept (for the writer and the name check).
  textChars?: number
  // The person's language (kept for the caller's records; pages are always asked for in English).
  lang?: string
  signal?: AbortSignal
  // For tests: a fetch to use instead of the global one.
  fetcher?: typeof fetch
}

const MAX_HOPS = 6
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15"

// ------------------------------------------------------------ addresses

/** Only public http(s) addresses: no local names, private or link-local IP literals, odd ports. */
export function safeUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  if (u.username || u.password) return null
  if (u.port && u.port !== "80" && u.port !== "443") return null
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/.test(host) || host === "localhost") return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null
  }
  if (host.includes(":")) return null // IPv6 literals: never needed for a public page
  return u
}

/** An address without what doesn't change the page: the fragment, tracking parameters, a trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ""
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|msclkid$|mc_|ref$|ref_$|srsltid$|_ga$|yclid$)/i.test(k)) u.searchParams.delete(k)
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "")
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "")
    return u.toString().replace(/^http:/, "https:")
  } catch {
    return raw
  }
}

export const ARCHIVE_HOSTS = /(^|\.)(web\.archive\.org|archive\.org|archive\.ph|archive\.today|archive\.is|archive\.li|archive\.md|webcache\.googleusercontent\.com|cachedview\.nl)$/i

// ------------------------------------------------------------ reading HTML

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&")

const fold = (s: string) => s.replace(/\s+/g, " ").trim()

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    const p = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const a = new RegExp(`<meta[^>]+(?:property|name|itemprop|http-equiv)=["']${p}["'][^>]*content=["']([^"']*)`, "i").exec(html)
    const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop|http-equiv)=["']${p}["']`, "i").exec(html)
    const v = (a ?? b)?.[1]
    if (v && v.trim()) return fold(unescapeHtml(v))
  }
  return ""
}

export function tagText(html: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html)
  return m ? fold(unescapeHtml(m[1].replace(/<[^>]+>/g, " "))) : ""
}

/** The page's main text: <main> or <article> when there is one, without navigation, headers and footers. */
export function mainText(html: string): string {
  let body = html.replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1]
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) body = main
  body = body.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  return pageText(body)
}

export interface PageRating {
  value: number
  best: number
  count?: number
}

interface LdFacts {
  types: Set<string>
  name?: string
  rating?: PageRating
  published?: string
  modified?: string
  validThrough?: string
  duration?: string
  lang?: string
}

function ldWalk(node: unknown, out: LdFacts, depth = 0) {
  if (depth > 8) return
  if (Array.isArray(node)) {
    for (const n of node) ldWalk(n, out, depth + 1)
    return
  }
  if (!node || typeof node !== "object") return
  const o = node as Record<string, unknown>
  const types = (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((t): t is string => typeof t === "string")
  for (const t of types) out.types.add(t)
  const main = types.some((t) => !/^(WebSite|WebPage|BreadcrumbList|ListItem|Organization|Person|ImageObject|SearchAction|Offer|AggregateOffer|AggregateRating|Rating|Review|Brand|PostalAddress|SiteNavigationElement|ReadAction|EntryPoint|PropertyValue|QuantitativeValue|MonetaryAmount|PriceSpecification|UnitPriceSpecification|ItemList|CollectionPage|FAQPage|Question|Answer|HowToStep|NutritionInformation|Place|GeoCoordinates|ContactPoint|OpeningHoursSpecification)$/.test(t))
  if (main) {
    const name = [o.name, o.headline, o.title].find((v) => typeof v === "string" && v.trim())
    if (name && !out.name) out.name = fold(unescapeHtml(String(name)))
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
    out.published ??= str(o.datePublished) ?? str(o.uploadDate) ?? str(o.datePosted) ?? str(o.dateCreated) ?? str(o.releaseDate)
    out.modified ??= str(o.dateModified)
    out.validThrough ??= str(o.validThrough) ?? str(o.expires)
    out.duration ??= str(o.duration) ?? str(o.totalTime) ?? str(o.timeRequired)
    out.lang ??= str(o.inLanguage)
    // Build 93: the item's own rating (its reviews, as the page states them for machines).
    out.rating ??= ratingOf(o.aggregateRating)
  }
  if (types.includes("AggregateRating")) out.rating ??= ratingOf(o)
  for (const [k, v] of Object.entries(o)) if (k !== "@context" && v && typeof v === "object") ldWalk(v, out, depth + 1)
}

/** A schema.org AggregateRating as a rating (null: not one, or out of its own scale). */
function ratingOf(node: unknown): PageRating | undefined {
  if (!node || typeof node !== "object") return undefined
  const o = node as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN)
  const value = num(o.ratingValue)
  const best = Number.isFinite(num(o.bestRating)) && num(o.bestRating) > 0 ? num(o.bestRating) : 5
  const count = num(o.reviewCount ?? o.ratingCount)
  if (!Number.isFinite(value) || value <= 0 || value > best) return undefined
  return { value: Math.round(value * 10) / 10, best, ...(Number.isFinite(count) && count > 0 ? { count: Math.round(count) } : {}) }
}

const ratingNumber = (v: string | undefined) => (v === undefined ? NaN : Number(v.trim().replace(",", ".")))
const countNumber = (v: string | undefined) => (v === undefined ? NaN : Number(v.replace(/[^\d]/g, "")))

function scaled(value: number, best: number, count: number): PageRating | undefined {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(best) || best <= 0 || value > best) return undefined
  return { value: Math.round(value * 10) / 10, best, ...(Number.isFinite(count) && count > 0 ? { count: Math.round(count) } : {}) }
}

/**
 * Build 94: the item's rating in the page's markup when its JSON-LD has none — microdata (itemprop ratingValue), else
 * the first reviews widget that states both its average and how many (Judge.me's data-average-rating and
 * data-number-of-reviews, Loox's data-rating and data-raters, Stamped's, Yotpo's): a star display without a count
 * isn't a rating summary. The product's own widget comes before related products' in the page.
 */
export function markupRating(html: string): PageRating | undefined {
  const prop = (name: string): string | undefined => {
    const m = new RegExp(`<[^>]*\\bitemprop=["']${name}["'][^>]*>([^<]{0,24})`, "i").exec(html)
    if (!m) return undefined
    const tag = m[0].slice(0, m[0].indexOf(">") + 1)
    return /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1] ?? m[1]
  }
  const value = ratingNumber(prop("ratingValue"))
  if (Number.isFinite(value)) {
    const best = ratingNumber(prop("bestRating"))
    const found = scaled(value, Number.isFinite(best) && best > 0 ? best : 5, countNumber(prop("reviewCount") ?? prop("ratingCount")))
    if (found) return found
  }
  for (const m of html.matchAll(/<(?:div|span|a|p|section)\b[^>]*\bdata-(?:average-rating|rating|average-score|score|reviews-average)=["']?(\d(?:[.,]\d+)?)["']?[^>]*>/gi)) {
    const count = /\bdata-(?:number-of-reviews|raters|count|reviews|reviews-count|total-reviews|rating-count|reviews-total)=["']?(\d[\d,.]*)/i.exec(m[0])?.[1]
    if (!count) continue
    const found = scaled(ratingNumber(m[1]), 5, countNumber(count))
    if (found?.count) return found
  }
  return undefined
}


/**
 * A rating with its count in the product's header (the start of the main text), read by our code, in any of the app's
 * languages ("4.3 out of 5 · 1,204 reviews", "4,3 von 5 · 1.204 Bewertungen", "5つ星のうち4.3 · 1,204件の評価"): the average on
 * a 5 scale with how many next to it; marketing's "5 out of 5" without a count isn't taken.
 */
export function textRating(text: string): PageRating | undefined {
  const head = text.slice(0, 1_500)
  const m = RATING_OF_5.exec(head)
  if (!m) return undefined
  const value = m.slice(1).find((g) => g !== undefined)
  // Around the average, without it ("4.3 of 5 rating from 1,204 ratings": the count is 1,204, not the 5).
  const near = `${head.slice(Math.max(0, m.index - 80), m.index)} | ${head.slice(m.index + m[0].length, m.index + m[0].length + 100)}`
  const c = REVIEW_COUNT.exec(near)
  const count = c?.[1] ?? c?.[2]
  if (!value || !count) return undefined
  const found = scaled(ratingNumber(value), 5, countNumber(count))
  return found?.count ? found : undefined
}

const REVIEWS_HEAD = pattern(REVIEWS_HEAD_WORDS, "giu")
// What reviews themselves look like, in any of the app's languages: a reviewer marked verified, "helpful", a date, a star
// rating, "… ago".
const REVIEW_MARKS: Array<{ test: (s: string) => boolean }> = [pattern(VERIFIED), pattern(HELPFUL), { test: hasDate }, STARS, pattern(AGO)]

/**
 * The page's own reviews — the text after a reviews heading, wherever the theme puts it (often after <main>) — for what
 * reviewers say: a shop's own reviews are often richer than any review site. Only a part that reads like reviews (two of: a
 * verified reviewer, "helpful", dates, stars, "… ago"): a header's "1,204 reviews" or a marketing block isn't one.
 */
export function reviewsSection(html: string): string | undefined {
  const text = pageText(html.replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, " "))
  const tail = text.slice(400)
  for (const m of tail.matchAll(REVIEWS_HEAD)) {
    const out = tail.slice(m.index, m.index + 3_500).trim()
    // Dense scripts (Chinese, Japanese, Korean) say as much in a third of the characters.
    const size = out.length + (out.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) * 2
    if (size > 300 && REVIEW_MARKS.filter((re) => re.test(out)).length >= 2) return out
  }
  return undefined
}

function ldFacts(html: string): LdFacts {
  const out: LdFacts = { types: new Set() }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim()
    try {
      ldWalk(JSON.parse(raw), out)
    } catch {
      try { ldWalk(JSON.parse(unescapeHtml(raw)), out) } catch { /* not JSON */ }
    }
  }
  return out
}

/** ISO 8601 duration (PT1H5M30S, P0DT45M) in seconds; null when it isn't one. */
export function isoSeconds(value: string | undefined): number | null {
  if (!value) return null
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim())
  if (!m || !m.slice(1).some(Boolean)) return null
  const [d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0))
  return Math.round(d * 86400 + h * 3600 + mi * 60 + s)
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

export function readPrice(raw: string | undefined, html = "", url = ""): PagePrice | undefined {
  if (!raw) return undefined
  const amount = parseNumber(raw)
  if (amount === null) return undefined
  let currency = /\b([A-Z]{3})\b/.exec(raw)?.[1] ?? ""
  if (!currency) currency = meta(html, "product:price:currency", "og:price:currency", "priceCurrency").toUpperCase().slice(0, 3)
  if (!currency) {
    // A sign by the number (every shipped language's, money.mts); one several currencies share, by the domain.
    const sym = new RegExp(`(${MONEY_SIGN})`, "iu").exec(raw)?.[1]
    currency = sym ? currencyOfSign(sym, url ? domainCurrency(url) : "") : ""
  }
  return { amount, currency }
}

// ------------------------------------------------------------ a price in the item's text (2.6)

const CODES = "EUR|USD|GBP|CHF|JPY|CNY|RMB|KRW|TWD|HKD|VND|SAR|AED|RUB|UAH|BRL|MXN|INR|CAD|AUD|SEK|NOK|DKK|PLN|CZK|TRY|ILS|THB|KZT|SGD|NZD"
// A number as a price writes it: thousands grouped by one kind of separator only ("$1,299 256 GB" is 1,299 and a size,
// not 1.299256), Indian grouping ("₹1,23,456"), cents after a dot or a comma; or plain digits.
const GROUPED = String.raw`(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+|\d{1,3}(?:[   ]\d{3})+|\d{1,3}(?:'\d{3})+)`
const NUM = String.raw`${GROUPED}(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
// A price as a page writes it: a sign or code before or after the number, or a number ending in ".-" (no sign).
const TEXT_PRICE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(${MONEY_SIGN}|${CODES}|Fr\.)\s?(${NUM})|(${NUM})\s?(${MONEY_SIGN}|${CODES})(?![\p{L}])|(${NUM})[.,][-–](?![\p{N}]))`, "gu")
const BARE_LABELLED = new RegExp(String.raw`(?:${pattern(PRICE_LABEL).source})\s?:?\s?(${GROUPED}(?:[.,]\d{1,2})?|\d+[.,]\d{2})(?![\p{L}\p{N}])`, "giu")
const NOT_NOW_RE = pattern(PRICE_NOT_NOW)
const SAVING_RE = pattern(PRICE_SAVING)
const MONTHLY_RE = pattern(PRICE_MONTHLY)
const PER_MONTH_RE = pattern(PRICE_PER_MONTH)
const CART_RE = pattern(PRICE_CART)
const SHIP_RE = pattern(SHIPPING)
const OTHERS_RE = pattern(OTHER_ITEMS)
const ITEM_PAGE_RE = pattern(ITEM_PAGE)
// Elements a page uses for a struck-through, was or compare-at price.
const STRUCK_TAG = /<(del|s|strike)\b[^>]*>[\s\S]*?<\/\1>/gi
const STRUCK_CLASS = /<(\w+)\b[^>]*(?:class|id)=["'][^"']*(?:(?:old|was|compare|strike|regular|list|original|crossed|before|rrp|msrp|uvp)[-_]?price|price[-_]?(?:old|was|compare|regular|before|list|original|strike)|line-through|strikethrough)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi
const STRUCK_STYLE = /<(\w+)\b[^>]*style=["'][^"']*line-through[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi
// Text a person doesn't see: hidden by its class, the hidden attribute or display:none.
const HIDDEN = /<(\w+)\b[^>]*(?:class=["'](?:[^"']*\s)?(?:hidden|d-none|sr-only|visually-hidden|is-hidden|u-hidden)(?:\s[^"']*)?["']|\shidden(?=[\s>])|style=["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1>/gi
// Entities a shop's HTML writes prices with ("&euro; 84,95", "&#36; 459.99", "&#163;399"): numeric ones and the usual
// named ones, decoded for reading a price.
const ENTITY: Record<string, string> = {
  euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤", dollar: "$", nbsp: " ", ndash: "–", mdash: "—", minus: "−", times: "×",
  hellip: "…", rsaquo: "›", lsaquo: "‹", raquo: "»", laquo: "«", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "”", amp: "&", lt: "<", gt: ">",
  quot: '"', apos: "'", copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•", thinsp: " ", ensp: " ", emsp: " "
}
const decode = (s: string) => s.replace(/&(?:#(\d{1,6})|#x([\da-f]{1,6})|([a-z]{2,8}));/gi, (all, dec: string, hex: string, name: string) => {
  const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : -1
  if (code >= 0) return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " "
  return ENTITY[name.toLowerCase()] ?? " "
})
// A size or a quantity right before a price ("250 g – 590 ₽", "500 ml: $12", "5kg ¥3,980"): the units in every
// shipped language (lexicon.mts), and clothes' sizes.
const SIZE_UNITS = [...new Set(Object.values(UNITS).flat())].sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
const SIZE_BEFORE = new RegExp(String.raw`(?:\d+(?:[.,]\d+)?\s?(?:${SIZE_UNITS}|")|(?<![\p{L}])(?:xs|s|m|l|xl|xxl)(?![\p{L}]))\s*[:\-–]?\s*$`, "iu")

/**
 * The item's price from its text, when the page states none for machines (2.6): the first clean price after the
 * item's heading, before any section of other items. Skipped: struck-through, was, list and recommended prices,
 * savings, shipping, per-month and part payments, cart totals and order minimums, zero. A number with no sign only as
 * "378.-" or after a price label, in the shop's country's money. Only on a shop's item page: a buy button, a
 * quantity, a size guide or the tax included after the heading, or the page typed a product (not a pricing, tuition or article page, nor the App Store, read by its own
 * reader). A heading that isn't the item's name, or a run of sized prices (an options list), gives none: when unsure,
 * no price rather than a wrong one.
 */
export function textPrice(html: string, url: string, names: string[], product = false): PagePrice | undefined {
  if (/^https?:\/\/apps\.apple\.com\//i.test(url)) return undefined
  // Commented-out HTML isn't on the page (an old shop's price left in a comment).
  const live = html.replace(/<!--[\s\S]*?-->/g, " ")
  // The first heading that is the item's: most of its words in the page's name or title (a "Shopping cart" or a
  // brand's banner heading isn't).
  // Most words of the shorter of the two shared: a long heading with the item's accessories still names it.
  const nameSets = names.map((n) => nameTokens(decode(n))).filter((t) => t.length)
  const h1 = [...live.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].find((m) => {
    const own = nameTokens(decode(pageText(m[1])))
    return own.length > 0 && nameSets.some((n) => own.filter((w) => n.includes(w)).length >= Math.ceil(Math.min(own.length, n.length) / 2))
  })
  if (!h1 || h1.index === undefined) return undefined
  const after = live.slice(h1.index + h1[0].length, h1.index + h1[0].length + 80_000)
    .replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(STRUCK_TAG, " ").replace(STRUCK_CLASS, " ").replace(STRUCK_STYLE, " ").replace(HIDDEN, " ")
  let text = decode(pageText(after)).replace(/\s+/g, " ")
  if (!product && !ITEM_PAGE_RE.test(text.slice(0, 6_000))) return undefined
  const stop = text.search(OTHERS_RE)
  if (stop >= 0) text = text.slice(0, stop)
  text = text.slice(0, 2_000)
  const local = domainCurrency(url)
  const found: Array<{ at: number; end: number; amount: number; currency: string }> = []
  for (const m of text.matchAll(TEXT_PRICE)) {
    const raw = m[2] ?? m[3] ?? m[5]
    const sign = m[1] ?? m[4] ?? ""
    const amount = parseNumber(raw)
    if (amount === null) continue
    const code = sign.toUpperCase()
    const currency = !sign ? local : code === "RMB" ? "CNY" : code === "FR." ? "CHF" : new RegExp(`^(?:${CODES})$`).test(code) ? code : currencyOfSign(sign, local)
    if (!currency) continue
    found.push({ at: m.index!, end: m.index! + m[0].length, amount, currency })
  }
  for (const m of text.matchAll(BARE_LABELLED)) {
    const amount = parseNumber(m[1])
    if (amount !== null && amount > 0 && local && !found.some((f) => f.at <= m.index! + m[0].length && f.end >= m.index!)) found.push({ at: m.index! + m[0].length - m[1].length, end: m.index! + m[0].length, amount, currency: local })
  }
  found.sort((a, b) => a.at - b.at)
  const clean = found.filter((f, i) => {
    // A zero (an empty cart's "€0,00") is no price, but a boundary: its words don't reach the next.
    if (f.amount <= 0) return false
    // The words since the price before it: a word by one price doesn't reach the next ("You save $20 — $79").
    const before = text.slice(Math.max(0, f.at - 28, i > 0 ? found[i - 1].end : 0), f.at)
    const after = text.slice(f.end, f.end + 18)
    if (NOT_NOW_RE.test(before.slice(-14)) || SAVING_RE.test(before) || MONTHLY_RE.test(before.slice(-16)) || PER_MONTH_RE.test(after.slice(0, 10))) return false
    // Shipping and cart words right by the price ("Versand: 4,95 €", "Free delivery over €50"), not a sentence away.
    if (CART_RE.test(before.slice(-16)) || SHIP_RE.test(before.slice(-16)) || SHIP_RE.test(after.slice(0, 12))) return false
    if (/^\s?(?:%|off\b)/i.test(after)) return false
    return true
  })
  let first = clean[0]
  if (!first) return undefined
  // Two prices side by side ("1.290,00 € 899,00 €"): an old price and the one to pay; the lower is the one to pay.
  const next = clean[1]
  if (next && next.at - first.end <= 4 && next.currency === first.currency && next.amount < first.amount) first = next
  // Prices of sizes or options one after another: which one is theirs isn't told.
  const sized = (f: { at: number }) => SIZE_BEFORE.test(text.slice(Math.max(0, f.at - 14), f.at))
  if (sized(first) && clean.slice(1).some((f) => f.at - first.at < 160 && f.amount !== first.amount && sized(f))) return undefined
  return { amount: first.amount, currency: first.currency }
}

/** The money of a country's own domain (".pt" → EUR, ".co.uk" → GBP, ".co.jp" → JPY); "" for .com and the like. */
export function domainCurrency(url: string): string {
  let host = ""
  try { host = new URL(url).hostname.toLowerCase() } catch { return "" }
  const tld = host.split(".").pop() ?? ""
  if (tld.length !== 2) return ""
  return currencyOf(tld === "uk" ? "GB" : tld.toUpperCase())
}

// ------------------------------------------------------------ verdicts on a page

// "Not found" in the title or the main heading, in the languages the app speaks.
export const NOT_FOUND = new RegExp([
  "\\b404\\b", "not found", "page not found", "page (?:does not|doesn'?t) exist", "no longer (?:available|exists)", "page (?:is )?unavailable",
  "we can'?t find", "couldn'?t find (?:that|this|the) page", "nothing (?:was )?found", "page you (?:requested|were looking for)",
  "страница не найдена", "не найдено", "ошибка 404", "сторінку не знайдено", "сторінка не знайдена",
  "seite nicht gefunden", "nicht gefunden", "page introuvable", "page non trouvée", "página no encontrada", "no se encuentra",
  "pagina non trovata", "página não encontrada", "não encontrada", "nie znaleziono", "sayfa bulunamadı",
  "ページが見つかりません", "找不到", "页面不存在", "페이지를 찾을 수 없", "không tìm thấy", "الصفحة غير موجودة", "لم يتم العثور"
].join("|"), "i")

// A product or listing that is gone though its page still answers (not a dead link: a gone item).
// "No longer sold", a listing or a deal that has ended, in any of the app's languages.
const GONE = pattern(GONE_WORDS)

export const BOT_WALL = /(cf-chl-|challenge-platform|just a moment\.\.\.|attention required! \| cloudflare|px-captcha|captcha-delivery|datadome|<title>\s*access denied|pardon our interruption|are you a (?:robot|human)|robot or human\?|request unsuccessful\. incapsula|enable javascript and cookies to continue|verify you are human|unusual traffic from your computer|automated access|sorry, we just need to make sure you'?re not a robot|<title>\s*client challenge|ddos-guard|checking your browser|please wait while we verify)/i

/** Why a page that answered 200 is really a "not found" page, or null. */
export function softNotFound(original: string, finalUrl: string, title: string, heading: string, text: string): string | null {
  let from: URL, to: URL
  try {
    from = new URL(original)
    to = new URL(finalUrl)
  } catch {
    return null
  }
  const depth = (u: URL) => u.pathname.split("/").filter(Boolean).length
  const rootish = (u: URL) => depth(u) === 0 || (depth(u) === 1 && /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(u.pathname.split("/").filter(Boolean)[0]))
  // A deep address that lands on the site's home page: the page it named is gone.
  if (depth(from) >= 1 && !rootish(from) && rootish(to) && !to.search) return "redirected to the home page"
  if (/(^|[/._-])(404|not[-_]?found|page[-_]?not[-_]?found|error)([/._-]|$)/i.test(to.pathname) && !/(404|not[-_]?found|error)/i.test(from.pathname)) return "redirected to an error page"
  // An error parameter on another page (a board, a list); on the same page it's about cookies or a login, not the item.
  if (/[?&](error|err|notfound|not_found|404|gone)=/i.test(to.search) && !/[?&](error|err|notfound|not_found|404|gone)=/i.test(from.search) && to.pathname.replace(/\/$/, "") !== from.pathname.replace(/\/$/, "")) return "redirected to an error page"
  // A redirect that drops the item's own id or slug (a closed job post sent to the board, a product to a
  // category): the item is gone. A successor that keeps some of its words is left to the name check.
  const spec = decodeURIComponent(from.pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase()
  if (spec && (/\d{4,}/.test(spec) || spec.split(/[-_]/).length >= 3) && !decodeURIComponent(to.pathname + to.search).toLowerCase().includes(spec)) {
    const words = (x: string) => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w))
    const left = new Set(words(decodeURIComponent(to.pathname + " " + to.search)))
    if (!words(spec).some((w) => left.has(w))) return "redirected away from the item"
  }
  if (NOT_FOUND.test(title) || NOT_FOUND.test(heading)) return "the page says it was not found"
  const t = text.slice(0, 600)
  if (text.length < 1200 && NOT_FOUND.test(t)) return "the page says it was not found"
  return null
}

/** A bot wall or challenge page: the page may exist, we just can't read it from a server. */
export function isBotWall(status: number, html: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 999 || status === 503 || status === 405) return true
  return BOT_WALL.test(html.slice(0, 60_000))
}

// ------------------------------------------------------------ fetching

/**
 * One hop with node's own HTTP client, for sites whose response headers are larger than fetch accepts
 * (YouTube's are): same request, redirects still left to the caller.
 */
async function hopByHttps(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const { request } = await import(url.startsWith("https:") ? "node:https" : "node:http")
  const { Readable } = await import("node:stream")
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: "GET", headers, signal, maxHeaderSize: 512 * 1024 }, (res: import("node:http").IncomingMessage) => {
      const h = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v))
      const status = res.statusCode ?? 0
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
      try {
        resolve(new Response(body, { status: status >= 200 && status <= 599 ? status : 502, headers: h }))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
    req.end()
  })
}

const overflow = (err: unknown) => /HEADERS_OVERFLOW|Headers Overflow/i.test(`${(err as { code?: string })?.code ?? ""} ${(err as Error)?.message ?? ""} ${((err as Error)?.cause as { code?: string; message?: string })?.code ?? ""} ${((err as Error)?.cause as Error)?.message ?? ""}`)

async function readBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  const all = new Uint8Array(Math.min(size, maxBytes))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.length - at))
    all.set(part, at)
    at += part.byteLength
    if (at >= all.length) break
  }
  const type = res.headers.get("content-type") ?? ""
  let charset = /charset=([\w-]+)/i.exec(type)?.[1]
  if (!charset) {
    const head = new TextDecoder("latin1").decode(all.subarray(0, 4096))
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder((charset ?? "utf-8").toLowerCase()).decode(all)
  } catch {
    return new TextDecoder("utf-8").decode(all)
  }
}

function empty(url: string, status: PageStatus, reason: string, extra: Partial<CheckedPage> = {}): CheckedPage {
  return { url, finalUrl: url, status, http: 0, hops: 0, reason, title: "", name: "", description: "", siteName: "", types: [], lang: "", text: "", ms: 0, ...extra }
}

/** Opens a page the way a person's browser would and says what it is. Never throws. */
export async function checkPage(url: string, opts: CheckOptions = {}): Promise<CheckedPage> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 7_000
  const maxBytes = opts.maxBytes ?? 1_500_000
  const doFetch = opts.fetcher ?? fetch
  const first = safeUrl(url)
  if (!first) return { ...empty(url, "unsafe", "not a public web address"), ms: Date.now() - started }
  if (ARCHIVE_HOSTS.test(first.hostname)) return { ...empty(url, "archived", "an archived copy, not the page itself"), ms: Date.now() - started }

  const timer = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timer, opts.signal]) : timer
  let current = first
  let res: Response | null = null
  let hops = 0
  try {
    for (; hops <= MAX_HOPS; hops++) {
      const headers = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        // English, whatever the person's language: a page in another language then means it (languageCheck).
        "Accept-Language": "en-US,en;q=0.9"
      }
      try {
        res = await doFetch(current.toString(), { redirect: "manual", signal, headers })
      } catch (err) {
        if (!overflow(err) || opts.fetcher) throw err
        res = await hopByHttps(current.toString(), headers, signal)
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
      if (!location) break
      res.body?.cancel().catch(() => undefined)
      let next: URL | null
      try {
        next = safeUrl(new URL(location, current).toString())
      } catch {
        next = null
      }
      if (!next) return { ...empty(url, "unsafe", "redirects to a non-public address", { finalUrl: location, hops: hops + 1, http: res.status }), ms: Date.now() - started }
      if (ARCHIVE_HOSTS.test(next.hostname)) return { ...empty(url, "archived", "redirects to an archived copy", { finalUrl: next.toString(), hops: hops + 1 }), ms: Date.now() - started }
      current = next
    }
  } catch (err) {
    const timedOut = timer.aborted
    const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
    // A name that doesn't resolve, a refused connection, a bad certificate: the site is gone. (A refused TLS
    // handshake is a server turning us away, not a dead site.)
    const gone = /ENOTFOUND|getaddrinfo|ECONNREFUSED|certificate|CERT_/i.test(msg)
    return { ...empty(url, gone ? "dead" : "error", timedOut ? "took too long to open" : msg.slice(0, 120), { finalUrl: current.toString(), hops }), ms: Date.now() - started }
  }
  if (!res) return { ...empty(url, "error", "no answer"), ms: Date.now() - started }
  const finalUrl = current.toString()
  if (hops > MAX_HOPS) return { ...empty(url, "dead", "too many redirects", { finalUrl, hops }), ms: Date.now() - started }

  const type = (res.headers.get("content-type") ?? "").toLowerCase()
  const isHtml = !type || type.includes("html") || type.includes("xml")
  const html = isHtml ? await readBody(res, maxBytes).catch(() => "") : (res.body?.cancel().catch(() => undefined), "")
  const base = { url, finalUrl, http: res.status, hops }

  if (res.status === 404 || res.status === 410 || res.status === 451) return { ...empty(url, "dead", `HTTP ${res.status}`, base), ms: Date.now() - started }
  if (isBotWall(res.status, html)) return { ...empty(url, "blocked", `the site doesn't let servers in (HTTP ${res.status})`, base), ms: Date.now() - started }
  if (res.status >= 400) return { ...empty(url, res.status >= 500 ? "error" : "dead", `HTTP ${res.status}`, base), ms: Date.now() - started }
  if (res.status >= 300) return { ...empty(url, "dead", `HTTP ${res.status} without a target`, base), ms: Date.now() - started }

  // A PDF (a paper) or another file: it opens; its name is checked against the search result only.
  if (!isHtml) {
    const file = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? "")
    return { ...empty(url, "ok", type.includes("pdf") ? "pdf" : "file", base), title: file, name: file, types: type.includes("pdf") ? ["PDF"] : [], ms: Date.now() - started }
  }

  return { ...describePage(html, url, finalUrl, res.status, hops, opts.textChars ?? 6_000, res.headers.get("content-language") ?? ""), ms: Date.now() - started }
}

/** What an opened HTML page is: its status verdict (ok or soft-404) and what it states for machines. */
export function describePage(html: string, url: string, finalUrl: string, http: number, hops: number, textChars = 6_000, contentLanguage = ""): CheckedPage {
  const title = tagText(html, "title")
  const heading = tagText(html, "h1")
  const ld = ldFacts(html)
  const ogType = meta(html, "og:type")
  const text = mainText(html)
  const notFound = softNotFound(url, finalUrl, title, heading, text)
  const st = structured(html)
  const priceRaw = st.ldPrice ?? st.metaPrice
  const stockRaw = st.ldStock ?? st.metaStock
  const name = ld.name || meta(html, "og:title", "twitter:title") || heading || title
  const published = isoDate(ld.published ?? meta(html, "article:published_time", "datePublished", "citation_date", "citation_publication_date", "date", "pubdate", "publish-date", "dc.date"))
  const modified = isoDate(ld.modified ?? meta(html, "article:modified_time", "og:updated_time", "dateModified", "last-modified"))
  const validThrough = isoDate(ld.validThrough)
  const duration = isoSeconds(ld.duration ?? meta(html, "duration", "video:duration")) ?? (Number(meta(html, "video:duration")) || null)
  const lang = (/<html[^>]*\slang=["']?([\w-]+)/i.exec(html)?.[1] || meta(html, "og:locale", "content-language") || contentLanguage).replace("_", "-")

  const status: PageStatus = notFound ? "soft404" : "ok"
  let reason = notFound ?? ""
  if (status === "ok") {
    if (validThrough && Date.parse(validThrough) < Date.now()) reason = "expired"
    else if (GONE.test(`${title} ${heading} ${text.slice(0, 3_000)}`)) reason = "unavailable"
    else if (text.length < 200) reason = "thin"
  }
  const page: CheckedPage = {
    url,
    finalUrl,
    http,
    hops,
    status,
    reason,
    title,
    name,
    description: meta(html, "og:description", "description", "twitter:description").slice(0, 400),
    siteName: meta(html, "og:site_name", "application-name"),
    types: [...ld.types, ...(ogType ? [`og:${ogType}`] : [])].slice(0, 12),
    lang,
    text: text.slice(0, textChars),
    ms: 0
  }
  const price = readPrice(priceRaw, html, finalUrl)
  // A price without a currency on a country's own domain (a .jp shop's "12800") is in that country's money.
  if (price && !price.currency) price.currency = domainCurrency(finalUrl)
  if (price) {
    page.price = price
    page.priceRaw = priceRaw
    page.priceFrom = st.ldPrice ? "ld" : "meta"
  } else if (status === "ok") {
    // None stated for machines: the first clean price after the item's heading (2.6).
    const fromText = textPrice(html, finalUrl, [ld.name ?? "", title, meta(html, "og:title", "twitter:title")], [...ld.types].some((t) => /^(?:Product|ProductGroup|IndividualProduct|ProductModel)$/.test(t)) || ogType === "product")
    if (fromText) {
      page.price = fromText
      page.priceFrom = "text"
    }
  }
  if (stockRaw) {
    page.stockRaw = stockRaw
    page.stock = isOutOfStock(stockRaw) ? "out" : /InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreOrder|PreSale|BackOrder/i.test(stockRaw) ? "in" : "unknown"
  }
  if (published) page.published = published
  if (modified) page.modified = modified
  if (validThrough) page.validThrough = validThrough
  if (duration) page.duration = duration
  if (ld.lang) page.inLanguage = String(ld.lang).slice(0, 12)
  const rating = ld.rating ?? markupRating(html) ?? textRating(text)
  if (rating) page.rating = rating
  if (status === "ok") {
    const reviews = reviewsSection(html)
    if (reviews) page.reviewsText = reviews
    if (/cdn\.shopify\.com|Shopify\.shop\s*=|window\.Shopify\b/.test(html)) page.shopify = true
    const links = pageLinks(html, finalUrl)
    if (links.length) page.links = links
    const alternates = hreflangs(html, finalUrl)
    if (alternates.length) page.alternates = alternates
    const pricing = appStorePricing(html, finalUrl, page.price)
    if (pricing) page.pricing = pricing
    else {
      const store = appStoreLink(html)
      if (store) page.storeLink = store
      const links = pricingLinks(html, finalUrl)
      if (links.length) page.pricingLinks = links
    }
  }
  return page
}

// Links that never lead to an item's facts: accounts, carts, legal pages, social networks.
const NOT_FACTS = /\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|basket|checkout|privacy|terms|cookies?|legal|careers-login)(\/|$|\?)|^(mailto|tel|javascript):/i
const SOCIAL = /(^|\.)(facebook|twitter|x|instagram|pinterest|youtube|linkedin|tiktok|reddit|threads|t)\.(com|me|net)$/i

/** The page's links worth following: http(s), not the page itself, not accounts or social networks; at most 150. */
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  let base: URL
  try {
    base = new URL(pageUrl)
  } catch {
    return []
  }
  const seen = new Set<string>([normalizeUrl(pageUrl)])
  const out: PageLink[] = []
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    if (NOT_FACTS.test(m[1])) continue
    let url: URL
    try {
      url = new URL(m[1].replace(/&amp;/g, "&"), base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol) || SOCIAL.test(url.hostname) || NOT_FACTS.test(url.pathname)) continue
    url.hash = ""
    const key = normalizeUrl(url.toString())
    if (seen.has(key)) continue
    seen.add(key)
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)
    out.push({ url: url.toString(), text })
    if (out.length >= 150) break
  }
  return out
}

/** The page in other languages: <link rel="alternate" hreflang="…" href="…">. */
export function hreflangs(html: string, pageUrl: string): Array<{ lang: string; url: string }> {
  const out: Array<{ lang: string; url: string }> = []
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\brel=["']?alternate/i.test(tag)) continue
    const lang = /\bhreflang=["']?([\w-]+)/i.exec(tag)?.[1]
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (!lang || !href || lang.toLowerCase() === "x-default") continue
    try {
      out.push({ lang: lang.toLowerCase(), url: new URL(href.replace(/&amp;/g, "&"), pageUrl).toString() })
    } catch {
      // not an address
    }
    if (out.length >= 40) break
  }
  return out
}

const SCRIPTS: Array<[string, RegExp]> = [
  ["cyrl", /\p{Script=Cyrillic}/u], ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ["arab", /\p{Script=Arabic}/u], ["hebr", /\p{Script=Hebrew}/u], ["thai", /\p{Script=Thai}/u], ["grek", /\p{Script=Greek}/u], ["latn", /\p{Script=Latin}/u]
]
const LANG_SCRIPT: Record<string, string> = { ru: "cyrl", uk: "cyrl", be: "cyrl", bg: "cyrl", sr: "cyrl", kk: "cyrl", mk: "cyrl", zh: "cjk", ja: "cjk", ko: "cjk", ar: "arab", fa: "arab", ur: "arab", he: "hebr", th: "thai", el: "grek" }

/** The script most letters of a text are in ("latn", "cyrl", "cjk", …), or "" for too few letters. */
export function scriptOf(text: string): string {
  const counts = new Map<string, number>()
  let letters = 0
  for (const ch of text.slice(0, 3_000)) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    const found = SCRIPTS.find(([, re]) => re.test(ch))
    if (found) counts.set(found[0], (counts.get(found[0]) ?? 0) + 1)
  }
  if (letters < 20) return ""
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]
  return n / letters > 0.5 ? best : ""
}

// Letters only one of the languages that share a script has.
const UK_LETTERS = /[іїєґ]/giu
const RU_LETTERS = /[ыэъё]/giu
// Vietnamese by the letters only it writes: ơ, ư and the vowels with a tone mark below or a hook (ạ ả ấ … ỹ); not ă
// (Romanian's commonest) nor đ (Croatian, Serbian).
const VI_LETTERS = /[ơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HANGUL = /\p{Script=Hangul}/gu
const HAN = /\p{Script=Han}/gu
const FA_LETTERS = /[پچژگک]/gu
const UR_LETTERS = /[ٹڈڑںے]/gu
// Characters that differ between simplified and traditional Chinese (as src/shared/share.ts tells them apart).
const TRADITIONAL_CHARS = new RegExp(`[${TRADITIONAL}]`, "gu")
const SIMPLIFIED_CHARS = new RegExp(`[${SIMPLIFIED}]`, "gu")
const MARKS = Object.entries(MARK_WORDS).map(([lang, words]) => [lang, new RegExp(`(?<![\\p{L}])(?:${words.join("|")})(?![\\p{L}])`, "giu")] as const)

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0

/** A language as compared here: its base ("pt", "uk"), and "zh-Hans" / "zh-Hant" when the variant is known. */
export function langKey(tag: string | undefined): string {
  const t = (tag ?? "").trim().replace("_", "-").toLowerCase()
  const base = t.split("-")[0]
  if (!/^[a-z]{2,3}$/.test(base)) return ""
  if (base === "zh") return /hant|-tw|-hk|-mo/.test(t) ? "zh-Hant" : /hans|-cn|-sg/.test(t) ? "zh-Hans" : "zh"
  return base
}

const sameLanguage = (a: string, b: string) => a === b || (a.split("-")[0] === b.split("-")[0] && (!a.includes("-") || !b.includes("-")))

const LATIN_LANGS = new Set(["en", "de", "fr", "es", "it", "pt", "vi", "nl", "pl", "tr", "sv", "da", "no", "nb", "fi", "cs", "ro", "hu", "id", "ms"])
function scriptOfLang(key: string): string {
  const base = key.split("-")[0]
  return LANG_SCRIPT[base] ?? (LATIN_LANGS.has(base) ? "latn" : "")
}

/**
 * The language a text is in, from its letters and words: a language ("uk", "ja", "zh-Hant", "de"…) when they tell it,
 * else only its script ("cyrl", "cjk", "arab", "latn"), else "". `short` (a title): fewer signs are enough.
 */
export function textLanguage(text: string, short = false): { lang: string; script: string } {
  const sample = text.slice(0, 3_000)
  const script = scriptOf(short && sample.length >= 4 ? sample.padEnd(20, " ") + sample : sample)
  const need = short ? 2 : 3
  if (script === "cyrl") {
    const uk = count(sample, UK_LETTERS) + 2 * count(sample, MARKS.find(([l]) => l === "uk")![1])
    const ru = count(sample, RU_LETTERS) + 2 * count(sample, MARKS.find(([l]) => l === "ru")![1])
    if (uk >= need - 1 && uk > 2 * ru) return { lang: "uk", script }
    if (ru >= need - 1 && ru > 2 * uk) return { lang: "ru", script }
    return { lang: "", script }
  }
  if (script === "cjk") {
    // By share of the dense characters, not a count: a Taiwanese shop's text with one Japanese product name, or a
    // Japanese one with a Korean brand, stays in its own language. Korean is mostly Hangul; Japanese prose and titles
    // carry kana among their kanji.
    const hangul = count(sample, HANGUL)
    const kana = count(sample, KANA)
    const dense = hangul + kana + count(sample, HAN)
    if (hangul >= need && hangul / dense >= 0.3) return { lang: "ko", script }
    if (kana >= need && kana / dense >= 0.15) return { lang: "ja", script }
    // Han alone: Chinese only in running text (Japanese sentences always carry kana); a title of a few Han
    // characters may be either.
    if (!short && count(sample, HAN) >= 20) {
      const trad = count(sample, TRADITIONAL_CHARS)
      const simp = count(sample, SIMPLIFIED_CHARS)
      return { lang: trad > simp ? "zh-Hant" : simp > trad ? "zh-Hans" : "zh", script }
    }
    return { lang: "", script }
  }
  if (script === "arab") {
    const fa = count(sample, FA_LETTERS)
    const ur = count(sample, UR_LETTERS)
    return { lang: ur > fa && ur >= need ? "ur" : fa >= need ? "fa" : "ar", script }
  }
  if (script === "latn") {
    const lower = sample.toLowerCase()
    const letters = lower.match(/\p{L}/gu)?.length ?? 0
    const vi = count(lower, VI_LETTERS)
    if (vi >= need && vi / Math.max(1, letters) > 0.02) return { lang: "vi", script }
    const scores = MARKS.filter(([l]) => l !== "ru" && l !== "uk").map(([lang, re]) => [lang, count(lower, re)] as const).sort((a, b) => b[1] - a[1])
    const [best, second] = scores
    if (best[1] >= need && best[1] >= 2 * second[1]) return { lang: best[0], script }
    return { lang: "", script }
  }
  const own: Record<string, string> = { hebr: "he", thai: "th", grek: "el" }
  return { lang: own[script] ?? "", script }
}

/**
 * Is the page in this language? The content's own stated language first (JSON-LD inLanguage); else the language its
 * title, then its text, is written in — told apart within a script (Ukrainian from Russian, Japanese, Korean and
 * Chinese from one another, German from English…); a title in another script than the text leads (a page's
 * interface around it may be in English). Only when the text can't tell, the site's stated language. Pages are
 * opened with English as the browser's language, so a site that answers in another language means it.
 */
export function languageCheck(want: string, page: Pick<CheckedPage, "lang" | "inLanguage" | "title" | "text">): "yes" | "no" | "unknown" {
  const w = langKey(want)
  if (!w) return "unknown"
  if (page.inLanguage && langKey(page.inLanguage)) return sameLanguage(langKey(page.inLanguage), w) ? "yes" : "no"
  const title = textLanguage(page.title.length >= 4 ? page.title : "", true)
  const text = textLanguage(page.text.slice(0, 1_500))
  // A title in a script of its own (not Latin) says what the content is; text in another script is the interface.
  const titleLeads = Boolean(title.script) && title.script !== "latn"
  const told = [title, ...(!titleLeads || text.script === title.script ? [text] : [])].find((t) => t.lang)
  if (told) return sameLanguage(told.lang, w) ? "yes" : "no"
  const script = titleLeads ? title.script : text.script || title.script
  if (script && scriptOfLang(w) && script !== scriptOfLang(w)) return "no"
  // The same script, the language not told by the words: the site's own, when it's in that script too.
  const stated = langKey(page.lang)
  if (stated && (!script || scriptOfLang(stated) === script)) return sameLanguage(stated, w) ? "yes" : "no"
  return "unknown"
}

// ------------------------------------------------------------ is it the item?

// Words that don't tell names apart: function words in the app's languages, and a shop title's usual extras.
const STOP = new Set(foldedWords(NAME_STOP, NAME_EXTRAS))
// A title's extras and a shop's words of several words, taken out of a name whole before it's split into words.
const PHRASES = foldedPhrases(NAME_STOP, NAME_EXTRAS, SHOP_WORDS).sort((a, b) => b.length - a.length)
const PHRASE_RE = PHRASES.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${PHRASES.map((p) => p.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+")).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null

/** Words of a name for matching: lower case, accents folded, letters and digits only. */
export function nameTokens(s: string): string[] {
  const folded = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  return (PHRASE_RE ? folded.replace(PHRASE_RE, " ") : folded)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w) && (w.length >= 2 || /\d/.test(w)))
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

/**
 * How much of an item's name a page bears (0–1): the name's words found in its title, name and heading,
 * or failing that in the start of its text. Names in scripts without spaces are matched as a whole.
 */
export function nameScore(name: string, page: Pick<CheckedPage, "title" | "name" | "text">): number {
  const head = `${page.title} ${page.name}`
  const body = page.text.slice(0, 8_000)
  if (CJK.test(name)) {
    const runs = name.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]{2,}/gu) ?? []
    if (!runs.length) return 0
    const found = runs.filter((r) => head.includes(r) || body.includes(r)).length
    return found / runs.length
  }
  const want = [...new Set(nameTokens(name))]
  if (!want.length) return 0
  const inHead = new Set(nameTokens(head))
  const inBody = new Set(nameTokens(body))
  const headHits = want.filter((w) => inHead.has(w)).length
  const bodyHits = want.filter((w) => inHead.has(w) || inBody.has(w)).length
  return Math.max(headHits / want.length, (bodyHits / want.length) * 0.9)
}
