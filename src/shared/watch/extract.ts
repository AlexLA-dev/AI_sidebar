// Page watch (2.5): reading a watched value from a page. The same code reads a page the background fetched
// (HTML text) and the live page the person has open (its HTML), so a value found once is found the same way
// again: JSON-LD Product/Offer, then meta tags and microdata, then the text around the selection.

import { firstValue, lastValue, type WatchWhat } from "./detect.ts"
import type { Watch, WatchSource } from "./types.ts"

export interface PageRead {
  html: string
  // The page's text: tags out, whitespace folded (see pageText).
  text: string
}

export interface Structured {
  ldPrice?: string
  ldStock?: string
  metaPrice?: string
  metaStock?: string
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&")

/** A page's text for reading values: scripts, styles and tags out, whitespace folded to single spaces. */
export function pageText(html: string): string {
  return unescapeHtml(
    html.replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim()
}

export function readPage(html: string): PageRead {
  return { html, text: pageText(html) }
}

// Price kinds that aren't the price to pay now: a struck-through, list or recommended price (schema.org priceType).
const NOT_NOW = /Strikethrough|ListPrice|MSRP|SRP|InvoicePrice|MinimumAdvertised|WasPrice/i

/** A price given (a number or a string; 0 is a price too: an app free to download). */
function usable(v: unknown): v is string | number {
  return v !== undefined && v !== null && v !== "" && (typeof v === "number" || typeof v === "string")
}

/**
 * An offer's price to pay now: its own price (or an aggregate's lowest), else its price specification — one object
 * or a list (WooCommerce, IKEA), skipping struck-through, list and recommended prices and prices per unit.
 */
function offerPrice(o: Record<string, unknown>): { price: string | number; currency: unknown } | null {
  const own = usable(o.price) ? o.price : usable(o.lowPrice) ? o.lowPrice : undefined
  if (own !== undefined) return { price: own, currency: o.priceCurrency }
  const specs = (Array.isArray(o.priceSpecification) ? o.priceSpecification : [o.priceSpecification])
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
  for (const spec of specs) {
    if (NOT_NOW.test(String(spec.priceType ?? ""))) continue
    if (spec.referenceQuantity && typeof spec.referenceQuantity === "object") continue
    const price = usable(spec.price) ? spec.price : usable(spec.minPrice) ? spec.minPrice : undefined
    if (price !== undefined) return { price, currency: spec.priceCurrency ?? o.priceCurrency }
  }
  return null
}

function walk(node: unknown, found: Structured, key = "") {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, found, key)
    return
  }
  if (!node || typeof node !== "object") return
  const o = node as Record<string, unknown>
  const types = (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]) as unknown[]
  // An offer: typed as one, or an untyped object under "offers" or with a price and its currency (some shops omit
  // the type).
  const offer = types.some((t) => t === "Offer" || t === "AggregateOffer") ||
    (o["@type"] === undefined && (key === "offers" || ("priceCurrency" in o && ("price" in o || "priceSpecification" in o || "lowPrice" in o))))
  if (offer) {
    const p = offerPrice(o)
    if (p && !found.ldPrice) found.ldPrice = `${p.price}${p.currency ? ` ${p.currency}` : ""}`
    if (o.availability && !found.ldStock) found.ldStock = String(o.availability).split("/").pop()
  }
  for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") walk(v, found, k)
}

function metaContent(html: string, prop: string): string | undefined {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const a = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${p}["'][^>]*content=["']([^"']+)`, "i").exec(html)
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${p}["']`, "i").exec(html)
  return (a ?? b)?.[1]
}

/** Prices and stock a page states for machines: JSON-LD offers, Open Graph and product meta, microdata. */
export function structured(html: string): Structured {
  const found: Structured = {}
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim()
    try {
      walk(JSON.parse(raw), found)
    } catch {
      try { walk(JSON.parse(unescapeHtml(raw)), found) } catch { /* not JSON */ }
    }
  }
  for (const prop of ["product:price:amount", "og:price:amount", "price"]) {
    const v = metaContent(html, prop)
    if (v && /\d/.test(v)) {
      const cur = metaContent(html, prop.replace("amount", "currency")) ?? metaContent(html, "priceCurrency")
      found.metaPrice = cur && prop !== "price" ? `${v} ${cur}` : v
      break
    }
  }
  if (!found.metaPrice) {
    const m = /itemprop=["']price["'][^>]*content=["']([^"']+)/i.exec(html)
    if (m) found.metaPrice = m[1]
  }
  // Microdata whose price is the element's own text (<span itemprop="price">95.00</span>), with its currency's.
  if (!found.metaPrice) {
    const m = /<(?:span|div|p|b|strong|bdi|data)\b[^>]*itemprop=["']price["'][^>]*>\s*([^<]{1,30}?)\s*</i.exec(html)
    if (m && /\d/.test(m[1])) {
      const cur = /itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/i.exec(html)?.[1]
      found.metaPrice = cur && !/[A-Za-z]{3}/.test(m[1]) ? `${m[1].trim()} ${cur.toUpperCase()}` : m[1].trim()
    }
  }
  for (const prop of ["product:availability", "og:availability", "availability"]) {
    const v = metaContent(html, prop)
    if (v) {
      found.metaStock = v.split("/").pop()
      break
    }
  }
  if (!found.metaStock) {
    const m = /itemprop=["']availability["'][^>]*(?:content|href)=["']([^"']+)/i.exec(html)
    if (m) found.metaStock = m[1].split("/").pop()
  }
  return found
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim()
const CONTEXT = 40

/**
 * Where a selection sits in the page's text: up to 40 characters right before and after it, to find the same
 * spot on the next check. Null when the selection isn't in the text (it was in an image or a field).
 */
export function locate(text: string, selection: string): { before: string; after: string } | null {
  const sel = fold(selection)
  const at = text.indexOf(sel)
  if (at < 0) return null
  // The words around it, cut at a space so a check doesn't depend on half a word.
  let before = text.slice(Math.max(0, at - CONTEXT), at)
  if (at > CONTEXT) before = before.replace(/^\S*\s/, "")
  let after = text.slice(at + sel.length, at + sel.length + CONTEXT)
  if (at + sel.length + CONTEXT < text.length) after = after.replace(/\s\S*$/, "")
  return { before, after }
}

// "Black · Size 42: " → itself, "Size 42: ", "42: " (a tail of two words, then one, but never empty).
function tails(before: string): string[] {
  if (!before.trim()) return []
  const out = [before]
  const words = before.trimEnd().split(" ")
  const end = before.slice(before.trimEnd().length)
  for (const n of [3, 2, 1]) {
    if (words.length > n) out.push(words.slice(-n).join(" ") + end)
  }
  return [...new Set(out)].filter((t) => t.trim().length >= 3)
}

/** The value in the text after `before` (and before `after`, when it's near), as the kind of value it is. */
export function readAround(text: string, what: WatchWhat, before = "", after = ""): string | null {
  const starts: number[] = []
  // The whole run of words before it, then shorter tails of it: the page may have changed a little around it.
  for (const b of tails(before)) {
    for (let i = text.indexOf(b); i >= 0 && starts.length < 5; i = text.indexOf(b, i + 1)) starts.push(i + b.length)
    if (starts.length) break
  }
  if (!starts.length && after.trim()) {
    // Only the words after it survived: read just before them.
    const j = text.indexOf(after)
    const v = j >= 0 ? lastValue(what, text.slice(Math.max(0, j - 80), j)) : null
    return v ? fold(v) : null
  }
  for (const s of starts) {
    const end = after.trim() ? text.indexOf(after, s) : -1
    const window = text.slice(s, end >= s && end - s <= 120 ? end : s + 80)
    const v = firstValue(what, window)
    if (v) return fold(v)
    // A status or a word that isn't in the lists: the words between the two anchors.
    if (end >= s && end - s <= 80 && (what === "status" || what === "date")) return fold(text.slice(s, end)) || null
  }
  return null
}

/** Read a watch's value from a page: from where it was found when the watch was made. */
export function readValue(page: PageRead, w: Pick<Watch, "source" | "what" | "before" | "after">): string | null {
  const s = w.source
  if (s === "ld-price" || s === "ld-stock" || s === "meta-price" || s === "meta-stock") {
    const st = structured(page.html)
    const v = s === "ld-price" ? st.ldPrice : s === "ld-stock" ? st.ldStock : s === "meta-price" ? st.metaPrice : st.metaStock
    if (v) return v
    // The page dropped its markup: fall back to the text around the old spot.
  }
  if (s === "page") return digest(page.text)
  if (w.what === "page") return null
  return readAround(page.text, w.what, w.before, w.after)
}

/** Which source holds a selected value: markup first (steadier than text), else the text around it. */
export function pickSource(page: PageRead, what: WatchWhat, selection: string): WatchSource {
  const st = structured(page.html)
  const num = (v: string | undefined) => (v ? parseNumber(v) : null)
  if (what === "price") {
    const sel = parseNumber(selection)
    if (sel !== null && num(st.ldPrice) === sel) return "ld-price"
    if (sel !== null && num(st.metaPrice) === sel) return "meta-price"
  }
  if (what === "stock") {
    if (st.ldStock) return "ld-stock"
    if (st.metaStock) return "meta-stock"
  }
  return "text"
}

/** A number from a price as shops write it: 1,299.99 · 1.299,99 · 1 299 · 34,500 円. */
export function parseNumber(value: string): number | null {
  const m = /\d[\d   .,']*/.exec(value)
  if (!m) return null
  let s = m[0].replace(/[   ']/g, "").replace(/[.,]$/, "")
  const lastDot = s.lastIndexOf(".")
  const lastComma = s.lastIndexOf(",")
  const dec = Math.max(lastDot, lastComma)
  // A separator with exactly three digits after it and no other kind is a thousands separator (34,500 · 1.299).
  if (dec >= 0 && s.length - dec - 1 === 3 && (lastDot < 0 || lastComma < 0)) s = s.replace(/[.,]/g, "")
  else if (dec >= 0) s = s.slice(0, dec).replace(/[.,]/g, "") + "." + s.slice(dec + 1)
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** A short digest of a page's text, for "page" watches: changes when the words change. */
export function digest(text: string): string {
  let h = 5381
  const s = fold(text)
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}:${s.length}`
}
