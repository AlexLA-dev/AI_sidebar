// What kind of page this is, for the page hints (2.7, plan section 6), decided on the device from the page's markup
// (structured data, meta tags, its own fields) and the length of its words. Nothing of the page leaves the device: the
// plan's promise «страница обрабатывается только по запросу» holds until the person taps.

export type PageKind = "product" | "article" | "video" | "form" | "event" | "stay"

const VIDEO = /^https?:\/\/((www|m)\.)?(youtube\.com\/(watch|shorts\/)|youtu\.be\/|vimeo\.com\/\d)/i

/** The schema.org types the page declares in its JSON-LD (with @graph), lowercased. */
export function ldTypes(doc: Document): Set<string> {
  const out = new Set<string>()
  const add = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 6) return
    if (Array.isArray(node)) {
      for (const n of node) add(n, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    const type = rec["@type"]
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === "string") out.add(t.toLowerCase())
    if (rec["@graph"]) add(rec["@graph"], depth + 1)
    if (rec.mainEntity) add(rec.mainEntity, depth + 1)
    if (rec.offers && typeof rec.offers === "object") out.add("offer")
  }
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
    try {
      add(JSON.parse(s.textContent ?? ""), 0)
    } catch {
      // a broken block: the rest still counts
    }
  }
  return out
}

const meta = (doc: Document, name: string) =>
  doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim().toLowerCase() ?? ""

/** One Chinese, Japanese or Korean character says about as much as 2.5 Latin ones (an English text is that much
 *  longer in its translation): an article of 2,000 of them is as long a read as one of 5,000 letters. 2.7, the
 *  director's audit: CJK articles never counted as long. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const DENSE_WEIGHT = 2.5

/** A text's length as a read: its characters, those of Chinese, Japanese and Korean weighted. */
export function readLength(text: string): number {
  const dense = text.match(DENSE)?.length ?? 0
  return Math.round(text.length + dense * (DENSE_WEIGHT - 1))
}

/** The page's own words, roughly: its paragraphs (menus and lists of links aren't prose), as long a read as Latin
 *  letters (readLength). */
export function proseLength(doc: Document, cap = 20_000): number {
  let n = 0
  for (const p of Array.from(doc.querySelectorAll("p"))) {
    if (p.closest("nav,header,footer,aside,form,[role=navigation]")) continue
    n += readLength((p.textContent ?? "").trim())
    if (n >= cap) break
  }
  return n
}

/** A field to write a message in: a big text area or editor, or a form of several text fields (not a search box). */
function writable(doc: Document): boolean {
  for (const el of Array.from(doc.querySelectorAll("textarea, [contenteditable=''], [contenteditable='true']"))) {
    if ((el as HTMLElement).closest?.("contextflow-root")) continue
    // Big enough to write a message in (a site's hidden buffers have no size); without layout (tests) it counts.
    const r = typeof (el as HTMLElement).getBoundingClientRect === "function" ? (el as HTMLElement).getBoundingClientRect() : null
    if (!r || (r.width >= 200 && r.height >= 40)) return true
  }
  for (const form of Array.from(doc.querySelectorAll("form"))) {
    if (form.getAttribute("role") === "search" || form.querySelector("input[type=search]")) continue
    const fields = form.querySelectorAll("input:not([type]), input[type=text], input[type=email], input[type=tel], textarea")
    if (fields.length >= 3) return true
  }
  return false
}

/** The page's kind, or null when it's none the hints have something for. */
export function pageKind(doc: Document, url: string): PageKind | null {
  if (VIDEO.test(url)) return "video"
  const types = ldTypes(doc)
  const has = (...names: string[]) => names.some((n) => types.has(n))
  const og = meta(doc, "og:type")
  if (has("product", "productgroup", "offer", "aggregateoffer") || og === "product" || og === "product.item" || meta(doc, "product:price:amount") ||
      doc.querySelector('[itemtype*="schema.org/Product"], [itemprop="price"]')) return "product"
  if ([...types].some((t) => t.endsWith("event")) || og === "event") return "event"
  if (has("recipe", "hotel", "lodgingbusiness", "lodgingreservation", "flightreservation", "eventreservation", "reservation", "trainreservation")) return "stay"
  if (writable(doc)) return "form"
  const long = proseLength(doc)
  if (long >= 8_000 || (long >= 4_000 && (og === "article" || has("article", "newsarticle", "blogposting") || doc.querySelector("article")))) return "article"
  return null
}
