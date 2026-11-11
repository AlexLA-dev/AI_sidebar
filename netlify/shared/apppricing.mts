// What an app costs, as its pages state it: whether there are subscriptions, a one-time price or nothing to pay. Two
// places, read without a model, so nothing is guessed:
// - an App Store page: its price (JSON-LD) and its "In-App Purchases" list (each purchase's name and price);
// - an app's pricing page on its own site: the plans' prices with their period, and whether there's a free plan.
// Either gives: free (nothing to buy), a subscription from a price, a one-time purchase, or in-app purchases from a
// price, with the page it came from.

import { FREE, MONTH, ONE_TIME as ONE_TIME_WORDS, PRICING_LINK, SUBSCRIPTION as SUBSCRIPTION_WORDS, WEEK, YEAR, pattern } from "./lexicon.mts"
import { parseNumber } from "../../src/shared/watch/extract.ts"

export interface PricePoint {
  amount: number
  currency: string
}

export type PayModel = "free" | "subscription" | "one_time" | "in_app"
export type Period = "week" | "month" | "year"

export interface AppPricing {
  model: PayModel
  // The cheapest way to pay (a subscription's per `period`); none for "free".
  from?: PricePoint
  period?: Period
  // A free way in besides: free to download (the store), or a free plan (a pricing page).
  freeStart?: boolean
  // The options read, as the page names them ("Plus Monthly 11.99 USD"), for the writer.
  options: string[]
  // Where it was read.
  url: string
  via: "app_store" | "pricing_page"
}

const SYMBOLS: Record<string, string> = {
  $: "USD", "US$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "円": "JPY", "元": "CNY", "₽": "RUB", "руб": "RUB", "₴": "UAH", "грн": "UAH",
  "₹": "INR", "₩": "KRW", "원": "KRW", R$: "BRL", "zł": "PLN", "₺": "TRY", "₪": "ILS", "₫": "VND", "đ": "VND", "vnđ": "VND"
}

// What a subscription, its period and a one-time purchase are called, in any of the app's languages (lexicon.mts).
// "3 months" is a pack, not a monthly price: only a plain period, or one of 1, counts.
const SUBSCRIPTION = new RegExp(`${pattern(SUBSCRIPTION_WORDS).source}|${pattern(WEEK).source}|${pattern(MONTH).source}|${pattern(YEAR).source}|\\b(?:quarter(?:ly)?|1\\s*(?:mo|months?|yrs?|years?|weeks?|wks?))\\b`, "iu")
const ONE_TIME = pattern(ONE_TIME_WORDS)

// Words for how often a price is paid; the one nearest the price counts ("$10 per seat/month billed annually": monthly).
const PERIODS = new RegExp(`(?<week>${pattern(WEEK).source})|(?<year>${pattern(YEAR).source})|(?<month>${pattern(MONTH).source})`, "giu")

// A free plan, and a link that names an app's prices ("Pricing", "Тарифы", "料金プラン"): the app's languages.
const FREE_PLAN = pattern(FREE)
const PRICING_LABEL = new RegExp(`^(?:${pattern(PRICING_LINK).source})$`, "iu")

function periodsIn(text: string): Period[] {
  return [...text.matchAll(PERIODS)].map((m) => (m.groups?.week ? "week" : m.groups?.year ? "year" : "month"))
}

/** The period a name or a price's surroundings state: the first one said. */
function periodOf(text: string): Period | null {
  return periodsIn(text)[0] ?? null
}

/** A shown price ("$11.99", "299,00 ₽", "€4,99", "USD 5") as an amount and currency (`fallback`: the page's). */
export function pricePoint(shown: string, fallback = ""): PricePoint | null {
  const amount = parseNumber(shown)
  if (amount === null) return null
  const code = /\b([A-Z]{3})\b/.exec(shown)?.[1]
  const sym = /(US\$|R\$|zł|руб|грн|vnđ|[$€£¥円元₽₴₹₩원₺₪₫đ])/i.exec(shown)?.[1]?.toLowerCase().replace(/^(us|r)\$$/, (m) => m.toUpperCase())
  // A plain "$" in another storefront is that storefront's dollar (CAD, AUD…): the page's currency wins.
  const currency = code ?? (sym && sym !== "$" ? SYMBOLS[sym] : "") ?? ""
  return { amount, currency: currency || fallback || (sym === "$" ? "USD" : "") }
}

/**
 * The option a person reads "from" off: the cheapest monthly one when there's one ("from $11.99/month", as stores and
 * pricing pages put it), else the cheapest yearly, else the cheapest weekly.
 */
function fromOption<T extends { price: PricePoint; period: Period }>(options: T[]): T {
  for (const period of ["month", "year", "week"] as const) {
    const of = options.filter((o) => o.period === period)
    if (of.length) return of.reduce((a, b) => (b.price.amount < a.price.amount ? b : a))
  }
  return options[0]
}

const fmt = (p: PricePoint) => `${Number.isInteger(p.amount) ? p.amount : p.amount.toFixed(2)}${p.currency ? ` ${p.currency}` : ""}`

const unescapeJson = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

const isAppStore = (url: string) => {
  try {
    return new URL(url).hostname === "apps.apple.com"
  } catch {
    return false
  }
}

// "In-App Purchases" in the App Store's storefront languages, and its "No".
const IAP_TITLES = /^(in-app purchases|встроенные покупки|покупки в програмі|вбудовані покупки|in[-‑ ]app[-‑ ]käufe|achats intégrés|compras dentro de la app|compras en la app|compras dentro do app|compras no app|acquisti in[-‑ ]app|app内課金|app 内购买项目|app內購買項目|app 內購買項目|앱 내 구입|mua in-app|mua hàng trong ứng dụng|عمليات شراء داخل التطبيق|zakupy w aplikacji|in-app aankopen|uygulama içi satın alımlar|nákupy v aplikaci)$/i
const NO = /^(no|нет|ні|nein|non|não|nao|いいえ|아니요|否|không|لا|nie|nee|hayır|ne)$/i

/**
 * An App Store page's pricing: its price (`price`, from the page's JSON-LD) and its "In-App Purchases" list. Null when
 * the page isn't an App Store app page or its information section can't be found (nothing is assumed then).
 */
export function appStorePricing(html: string, url: string, price: PricePoint | undefined): AppPricing | null {
  if (!isAppStore(url) || !price) return null
  // The information section's facts (provider, size, languages, in-app purchases…), in the storefront's language.
  const notes = [...html.matchAll(/"\$kind":"Annotation","title":"((?:[^"\\]|\\.)*)","summary":"((?:[^"\\]|\\.)*)"/g)]
  const iap = notes.find((n) => IAP_TITLES.test(unescapeJson(n[1])))
  // The information section is there and lists no in-app purchases: there are none.
  const none = () => (price.amount > 0 ? { model: "one_time" as const, from: price, options: [], url, via: "app_store" as const } : { model: "free" as const, options: [], url, via: "app_store" as const })
  if (!iap) return notes.length >= 3 || html.includes('"title":"Information"') ? none() : null
  const at = iap.index ?? 0
  const end = html.indexOf('"$kind":"Annotation"', at + 30)
  const block = html.slice(at, end > at ? end : at + 6_000)
  if (NO.test(unescapeJson(iap[2]).trim())) return none()
  const items: Array<{ name: string; price: PricePoint }> = []
  for (const m of block.matchAll(/"leadingText":"((?:[^"\\]|\\.)*)","trailingText":"((?:[^"\\]|\\.)*)"/g)) {
    const name = unescapeJson(m[1]).trim()
    const p = pricePoint(unescapeJson(m[2]), price.currency)
    if (name && p && p.amount > 0) items.push({ name, price: p })
  }
  const options = items.slice(0, 10).map((i) => `${i.name} ${fmt(i.price)}`)
  // Paid to download: a one-time purchase (with purchases inside, which the options list).
  if (price.amount > 0) return { model: "one_time", from: price, options, url, via: "app_store" }
  if (!items.length) return null
  const subs = items.filter((i) => SUBSCRIPTION.test(i.name) && !ONE_TIME.test(i.name)).map((i) => ({ ...i, period: periodOf(i.name) }))
  const periodic = subs.filter((s): s is typeof s & { period: Period } => s.period !== null)
  if (periodic.length) {
    const best = fromOption(periodic)
    return { model: "subscription", from: best.price, period: best.period, freeStart: true, options, url, via: "app_store" }
  }
  const once = items.filter((i) => ONE_TIME.test(i.name))
  if (once.length && !subs.length) {
    const best = once.reduce((a, b) => (b.price.amount < a.price.amount ? b : a))
    return { model: "one_time", from: best.price, freeStart: true, options, url, via: "app_store" }
  }
  const cheapest = items.reduce((a, b) => (b.price.amount < a.price.amount ? b : a))
  return { model: subs.length ? "subscription" : "in_app", from: cheapest.price, freeStart: true, options, url, via: "app_store" }
}

/** An item a model read off a pricing page: the plan's name, its price as shown, and how often it's paid. */
export interface PlanSeen {
  name: string
  price: string
  period: Period | "one_time" | "unknown"
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// The signs a shown price may carry, before or after its number (pricePoint's currencies).
const MONEY_SIGN = "US\\$|R\\$|zł|руб|грн|vnđ|[$€£¥円元₽₴₹₩원₺₪₫đ]"
// Where the next price starts after one, or the previous one ends before it: another plan's words don't count.
const NEXT_PRICE = new RegExp(`(?:${MONEY_SIGN})\\s?\\d|\\d\\s?(?:${MONEY_SIGN})`, "u")
const PREV_PRICE = new RegExp(`(?:${MONEY_SIGN})\\s?\\d[\\d.,]*|\\d\\s?(?:${MONEY_SIGN})`, "u")

/**
 * Where `shown` ("$10", "€9.50", "9,99 €") stands in `text` as a whole price (not part of a longer number), allowing a
 * space between the sign and the number as pages often have; -1 when it isn't there.
 */
export function findPrice(text: string, shown: string): { at: number; end: number } | null {
  const m = new RegExp(`^\\s*(${MONEY_SIGN}|[A-Z]{3})?\\s?(\\d[\\d.,\\s]*\\d|\\d)\\s?(${MONEY_SIGN}|[A-Z]{3})?\\s*$`, "u").exec(shown)
  if (!m || (!m[1] && !m[3])) return null
  const num = m[2].replace(/\s+/g, "").split(/([.,])/).map((part) => (part === "." || part === "," ? `\\s?\\${part}\\s?` : part)).join("")
  const source = m[1] ? `${escape(m[1])}\\s?${num}(?![\\d])` : `(?<![\\d.,])${num}\\s?${escape(m[3]!)}`
  const found = new RegExp(source).exec(text)
  return found ? { at: found.index, end: found.index + found[0].length } : null
}

/**
 * A pricing page's plans as a model read them, kept only where the page bears them out: each price where it stands in
 * the text, its period said next to it (a monthly price by "/mo", "per month"…; a one-time one by "lifetime", "one-time"…),
 * a free plan only when the page says "free". Null when no plan holds up.
 */
export function plansPricing(plans: PlanSeen[], freePlan: boolean, text: string, url: string): AppPricing | null {
  const held: Array<{ name: string; price: PricePoint; period: Period | "one_time"; around: string }> = []
  for (const plan of plans.slice(0, 12)) {
    if (plan.period === "unknown") continue
    const spot = findPrice(text, plan.price)
    const price = spot ? pricePoint(plan.price) : null
    if (!spot || !price || price.amount <= 0) continue
    // Its surroundings up to the next or previous price: another plan's words don't count for this one.
    const after = text.slice(spot.end, spot.end + 40).split(NEXT_PRICE)[0]
    const before = text.slice(Math.max(0, spot.at - 24), spot.at).split(PREV_PRICE).pop() ?? ""
    const said = periodOf(after) ?? periodsIn(before).pop() ?? null
    const ok = plan.period === "one_time" ? ONE_TIME.test(`${before} ${after}`) : said === plan.period
    if (!ok) continue
    held.push({ name: plan.name.slice(0, 60), price, period: plan.period, around: `${plan.name.slice(0, 40)} ${plan.price}${plan.period === "one_time" ? " one-time" : `/${plan.period}`}` })
  }
  const free = freePlan && (FREE_PLAN.test(text) || /[$€£¥₩]\s?0(?![\d.,])/.test(text))
  const options = held.slice(0, 8).map((h) => h.around)
  const periodic = held.filter((h): h is typeof h & { period: Period } => h.period !== "one_time")
  if (periodic.length) {
    const best = fromOption(periodic)
    return { model: "subscription", from: best.price, period: best.period, ...(free ? { freeStart: true } : {}), options, url, via: "pricing_page" }
  }
  if (held.length) {
    const best = held.reduce((a, b) => (b.price.amount < a.price.amount ? b : a))
    return { model: "one_time", from: best.price, ...(free ? { freeStart: true } : {}), options, url, via: "pricing_page" }
  }
  return null
}

/** The App Store page the app's own site links to ("Download on the App Store"), when there's one. */
export function appStoreLink(html: string): string | null {
  const m = /href=["'](https:\/\/apps\.apple\.com\/[a-z]{2}(?:-[a-z]{2,4})?\/app\/[^"'?#]*\/id\d+|https:\/\/apps\.apple\.com\/app\/(?:[^"'?#]*\/)?id\d+)/i.exec(html)
  return m ? m[1] : null
}

/** The site's own links to its pricing page (same site), best first: where to look when the page doesn't say. */
export function pricingLinks(html: string, pageUrl: string): string[] {
  let base: URL
  try {
    base = new URL(pageUrl)
  } catch {
    return []
  }
  const site = base.hostname.replace(/^www\./, "")
  const out: string[] = []
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    let href: URL
    try {
      href = new URL(m[1], base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(href.protocol)) continue
    const host = href.hostname.replace(/^www\./, "")
    if (host !== site && !host.endsWith(`.${site}`) && !site.endsWith(`.${host}`)) continue
    const path = href.pathname.toLowerCase()
    const byPath = /\/(pricing|plans|prices|price|premium|upgrade|tarifs?|tarife|preise|prix|precios|planes|prezzi|piani|precos|planos|ryokin|price-plan)(\/|\.html?)?$/.test(path)
    const byLabel = PRICING_LABEL.test(label.trim())
    if (!byPath && !byLabel) continue
    href.hash = ""
    const link = href.toString()
    if (!out.includes(link) && link !== base.toString()) out.push(link)
    if (out.length >= 3) break
  }
  return out
}

/** The pricing in one line for the writer ("free to download; subscription from 11.99 USD/month"). */
export function pricingLine(p: AppPricing): string {
  const per = p.period ? `/${p.period}` : ""
  const start = p.freeStart ? (p.via === "app_store" ? "free to download; " : "free plan; ") : ""
  const what =
    p.model === "free" ? "free, no in-app purchases"
    : p.model === "subscription" ? `${start}subscription from ${fmt(p.from!)}${per}`
    : p.model === "one_time" ? `${start}one-time purchase ${fmt(p.from!)}`
    : `${start}in-app purchases from ${fmt(p.from!)}`
  const where = p.via === "pricing_page" ? "its pricing page" : p.options.length ? "the App Store's In-App Purchases list" : "the App Store page"
  return `${what} (from ${where}${p.options.length ? `: ${p.options.slice(0, 5).join("; ")}` : ""})`
}
