// "Find similar" (2.6, Ultra): our server opens each page an answer may link to and checks it before the
// answer is written. Redirects are followed by hand (each hop checked), then the page's status, a "not found"
// page served with 200 (soft-404), a bot wall, an archived copy, whether the page is about the item it was
// picked for, and what the page states for machines: price, stock, dates, language, length.
// Prices and stock are read with page watch's parser (src/shared/watch/extract.ts), so both read shops alike.
// Nothing is stored: the page is read once and forgotten.

import { isOutOfStock } from "../../src/shared/watch/detect.ts"
import { pageText, parseNumber, structured } from "../../src/shared/watch/extract.ts"

export type PageStatus = "ok" | "dead" | "soft404" | "blocked" | "archived" | "error" | "unsafe"

export interface PagePrice {
  amount: number
  currency: string
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
  lang: string
  price?: PagePrice
  priceRaw?: string
  stock?: "in" | "out" | "unknown"
  stockRaw?: string
  // ISO dates: when it was published and last changed; a job post's or offer's end.
  published?: string
  modified?: string
  validThrough?: string
  // Seconds: a video's length, a recipe's total time.
  duration?: number
  // The page's main text, folded, cut to the requested length.
  text: string
  ms: number
}

export interface CheckOptions {
  timeoutMs?: number
  maxBytes?: number
  // Characters of main text kept (for the writer and the name check).
  textChars?: number
  // The user's language, sent as Accept-Language.
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

const ARCHIVE_HOSTS = /(^|\.)(web\.archive\.org|archive\.org|archive\.ph|archive\.today|archive\.is|archive\.li|archive\.md|webcache\.googleusercontent\.com|cachedview\.nl)$/i

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

function tagText(html: string, tag: string): string {
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

interface LdFacts {
  types: Set<string>
  name?: string
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
  }
  for (const [k, v] of Object.entries(o)) if (k !== "@context" && v && typeof v === "object") ldWalk(v, out, depth + 1)
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

/** A price as "34.50 EUR" (page watch's form) → number and currency; a bare number keeps an empty currency. */
export function readPrice(raw: string | undefined, html = ""): PagePrice | undefined {
  if (!raw) return undefined
  const amount = parseNumber(raw)
  if (amount === null) return undefined
  let currency = /\b([A-Z]{3})\b/.exec(raw)?.[1] ?? ""
  if (!currency) currency = meta(html, "product:price:currency", "og:price:currency", "priceCurrency").toUpperCase().slice(0, 3)
  if (!currency) {
    const sym = /([$€£¥₽₴₹₩]|R\$|zł|kr)/.exec(raw)?.[1]
    currency = sym ? ({ $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₽": "RUB", "₴": "UAH", "₹": "INR", "₩": "KRW", R$: "BRL", zł: "PLN", kr: "SEK" } as Record<string, string>)[sym] ?? "" : ""
  }
  return { amount, currency }
}

// ------------------------------------------------------------ verdicts on a page

// "Not found" in the title or the main heading, in the languages the app speaks.
const NOT_FOUND = new RegExp([
  "\\b404\\b", "not found", "page not found", "page (?:does not|doesn'?t) exist", "no longer (?:available|exists)", "page (?:is )?unavailable",
  "we can'?t find", "couldn'?t find (?:that|this|the) page", "nothing (?:was )?found", "page you (?:requested|were looking for)",
  "страница не найдена", "не найдено", "ошибка 404", "сторінку не знайдено", "сторінка не знайдена",
  "seite nicht gefunden", "nicht gefunden", "page introuvable", "page non trouvée", "página no encontrada", "no se encuentra",
  "pagina non trovata", "página não encontrada", "não encontrada", "nie znaleziono", "sayfa bulunamadı",
  "ページが見つかりません", "找不到", "页面不存在", "페이지를 찾을 수 없", "không tìm thấy", "الصفحة غير موجودة", "لم يتم العثور"
].join("|"), "i")

// A product or listing that is gone though its page still answers (not a dead link: a gone item).
const GONE = /(no longer available|this item is (?:no longer|not) available|product (?:is )?(?:discontinued|unavailable)|listing (?:has )?ended|this listing (?:was|has been) (?:removed|ended)|job (?:is )?no longer (?:available|accepting)|(?:this )?(?:position|job) has been filled|вакансия (?:в архиве|закрыта)|товар (?:снят с продажи|больше не продается)|nicht mehr verfügbar)/i

const BOT_WALL = /(cf-chl-|challenge-platform|just a moment\.\.\.|attention required! \| cloudflare|px-captcha|captcha-delivery|datadome|<title>\s*access denied|pardon our interruption|are you a (?:robot|human)|robot or human\?|request unsuccessful\. incapsula|enable javascript and cookies to continue|verify you are human|unusual traffic from your computer|automated access|sorry, we just need to make sure you'?re not a robot)/i

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
      res = await doFetch(current.toString(), {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": opts.lang ? `${opts.lang},en;q=0.7` : "en-US,en;q=0.9"
        }
      })
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
    // A name that doesn't resolve or a refused connection: the site is gone.
    const gone = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|certificate|CERT_|SSL/i.test(msg)
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
  const published = isoDate(ld.published ?? meta(html, "article:published_time", "datePublished", "date", "pubdate", "publish-date", "dc.date"))
  const modified = isoDate(ld.modified ?? meta(html, "article:modified_time", "og:updated_time", "dateModified", "last-modified"))
  const validThrough = isoDate(ld.validThrough)
  const duration = isoSeconds(ld.duration ?? meta(html, "duration", "video:duration")) ?? (Number(meta(html, "video:duration")) || null)
  const lang = (/<html[^>]*\slang=["']?([\w-]+)/i.exec(html)?.[1] ?? meta(html, "og:locale", "content-language") ?? (res.headers.get("content-language") ?? "")).replace("_", "-")

  let status: PageStatus = notFound ? "soft404" : "ok"
  let reason = notFound ?? ""
  if (status === "ok") {
    if (validThrough && Date.parse(validThrough) < Date.now()) reason = "expired"
    else if (GONE.test(`${title} ${heading} ${text.slice(0, 3_000)}`)) reason = "unavailable"
    else if (text.length < 200) reason = "thin"
  }
  const page: CheckedPage = {
    ...base,
    status,
    reason,
    title,
    name,
    description: meta(html, "og:description", "description", "twitter:description").slice(0, 400),
    siteName: meta(html, "og:site_name", "application-name"),
    types: [...ld.types, ...(ogType ? [`og:${ogType}`] : [])].slice(0, 12),
    lang,
    text: text.slice(0, opts.textChars ?? 6_000),
    ms: Date.now() - started
  }
  const price = readPrice(priceRaw, html)
  if (price) {
    page.price = price
    page.priceRaw = priceRaw
  }
  if (stockRaw) {
    page.stockRaw = stockRaw
    page.stock = isOutOfStock(stockRaw) ? "out" : /InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreOrder|PreSale|BackOrder/i.test(stockRaw) ? "in" : "unknown"
  }
  if (published) page.published = published
  if (modified) page.modified = modified
  if (validThrough) page.validThrough = validThrough
  if (duration) page.duration = duration
  return page
}

// ------------------------------------------------------------ is it the item?

const STOP = new Set(("the a an and or of for with by in on to at from vs best top new official site app apps free online buy shop review reviews " +
  "и в на с по для от до из или о об для это как").split(" "))

/** Words of a name for matching: lower case, accents folded, letters and digits only. */
export function nameTokens(s: string): string[] {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
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
