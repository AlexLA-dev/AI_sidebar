// How much of a page is in which language (2.7, build 107, the owner: «поп-ап о переводе возникает, когда 99% страницы
// и так на нужном языке, а скажем 1% нет»). The pill used to judge the page by its first headings and list items,
// which on many pages are the site's menus. Now each visible block of words is weighed by its letters and put down
// to a language: by its script (Cyrillic, Greek, Arabic, Hebrew, Thai, Chinese, Japanese, Korean) or, for Latin
// letters, by function words (a long block alone, short ones pooled). The main content (the page's <main> or largest
// <article>, without its menus) is weighed apart from the site's frame: the pill offers itself only when the main
// content is in another language; a smaller share is said at the ✦ circle (A2).

import { baseLanguage, languageGuess } from "../translateTarget"

export interface Shares {
  // Letters per language (base codes; "?" when unsure), and their sum.
  langs: Map<string, number>
  letters: number
}

export interface PageShares {
  main: Shares
  page: Shares
}

/** A block's letters only when they're this many: shorter ones (a menu item, a button) are judged together. */
const LONG_BLOCK = 40

const BLOCKS = new Set([
  "P", "LI", "TD", "TH", "DD", "DT", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "FIGCAPTION", "CAPTION", "LABEL",
  "BUTTON", "A", "SUMMARY", "LEGEND", "OPTION", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE",
  "FORM", "UL", "OL", "DL", "TABLE", "TR", "TBODY", "THEAD", "DETAILS", "DIALOG", "FIGURE", "SPAN"
])
const NEVER = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA", "SVG", "MATH", "CONTEXTFLOW-ROOT", "IFRAME", "SELECT"])
/** The site's frame inside or around the main content: menus, bars, side columns, dialogs and banners over the page
 *  (a cookie notice), and the site's own header and footer (frame()). */
const FRAME = "nav,aside,menu,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=menu],[role=menubar],[role=toolbar],[role=tablist],[role=search],[role=dialog],[role=alertdialog],[aria-modal=true]"

/** The site's frame: FRAME, or the site's own header or footer (not an article's, which holds its title or author). */
function frame(el: Element): boolean {
  if (el.matches(FRAME)) return true
  if (el.tagName !== "HEADER" && el.tagName !== "FOOTER") return false
  return !el.parentElement?.closest("article,main,[role=main]")
}

const empty = (): Shares => ({ langs: new Map(), letters: 0 })
const add = (s: Shares, lang: string, n: number) => {
  if (!n) return
  s.langs.set(lang, (s.langs.get(lang) ?? 0) + n)
  s.letters += n
}

/** The page's main content: its main element, else its largest article, else the body. */
export function mainContent(doc: Document): Element {
  const main = doc.querySelector("main,[role=main]")
  if (main && (main.textContent ?? "").trim().length > 200) return main
  let best: Element | null = null
  let size = 0
  for (const a of Array.from(doc.querySelectorAll("article"))) {
    const n = (a.textContent ?? "").length
    if (n > size) {
      best = a
      size = n
    }
  }
  return best && size > 400 ? best : doc.body
}

/** Shown on the page: not display:none or visibility:hidden anywhere up the tree, and with some size. */
function visible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
  if (typeof check === "function") return check.call(el, { visibilityProperty: true })
  const rects = (el as HTMLElement).getClientRects
  // Older Safari: no boxes means not shown. A DOM without layout (tests): taken as shown.
  return typeof rects === "function" ? rects.call(el).length > 0 : true
}

const LETTER = /\p{L}/gu
/** Letters by script of a text: Latin ones, and the rest put down to their language at once. */
function scripts(text: string): { latin: number; other: Map<string, number> } {
  const other = new Map<string, number>()
  let latin = 0
  let kana = 0
  let han = 0
  for (const ch of text.match(LETTER) ?? []) {
    if (/\p{Script=Latin}/u.test(ch)) latin++
    else if (/[぀-ヿ]/.test(ch)) kana++
    else if (/\p{Script=Han}/u.test(ch)) han++
    else if (/\p{Script=Hangul}/u.test(ch)) other.set("ko", (other.get("ko") ?? 0) + 1)
    else if (/\p{Script=Cyrillic}/u.test(ch)) other.set("cyr", (other.get("cyr") ?? 0) + 1)
    else if (/\p{Script=Arabic}/u.test(ch)) other.set("ar", (other.get("ar") ?? 0) + 1)
    else if (/\p{Script=Greek}/u.test(ch)) other.set("el", (other.get("el") ?? 0) + 1)
    else if (/\p{Script=Hebrew}/u.test(ch)) other.set("he", (other.get("he") ?? 0) + 1)
    else if (/\p{Script=Thai}/u.test(ch)) other.set("th", (other.get("th") ?? 0) + 1)
    else other.set("?", (other.get("?") ?? 0) + 1)
  }
  // Japanese writes with kanji and kana; Chinese with hanzi alone.
  if (kana + han) other.set(kana > 0 && kana >= (kana + han) * 0.1 ? "ja" : "zh", kana + han)
  return { latin, other }
}

/** The words of an element that belong to it and not to a block inside it. */
function ownText(el: Element): string {
  let out = ""
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) out += (child as Text).data
    else if (child.nodeType === 1) {
      const c = child as Element
      if (NEVER.has(c.tagName)) continue
      if (!blockLike(c)) out += ` ${ownText(c)} `
    }
  }
  return out
}

const blockLike = (el: Element) => BLOCKS.has(el.tagName) && el.tagName !== "SPAN" && el.tagName !== "A" && el.tagName !== "LABEL"

/**
 * Letters by language in the visible text under `root`, the main content apart from the frame around it. Cyrillic is
 * Russian or Ukrainian by the whole of it; Latin by function words (long blocks each, short ones pooled).
 */
export function pageShares(doc: Document, root: Element = doc.body): PageShares {
  const main = mainContent(doc)
  const out: PageShares = { main: empty(), page: empty() }
  const pools = { main: [] as string[], page: [] as string[] }
  const cyr = { main: [] as string[], page: [] as string[] }
  const walk = (el: Element, inMain: boolean, inFrame: boolean, shown: boolean) => {
    if (NEVER.has(el.tagName)) return
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return
    const here = inMain || el === main
    const framed = inFrame || (here && el !== main && frame(el))
    const isShown = shown && visible(el)
    if (!isShown) return
    if (blockLike(el) || el === root) {
      const text = ownText(el).replace(/\s+/g, " ").trim()
      if (text) {
        const { latin, other } = scripts(text)
        const counted = here && !framed
        for (const [lang, n] of other) {
          if (lang === "cyr") {
            cyr.page.push(text)
            if (counted) cyr.main.push(text)
            continue
          }
          add(out.page, lang, n)
          if (counted) add(out.main, lang, n)
        }
        if (latin >= LONG_BLOCK) {
          const lang = languageGuess(text)?.lang
          const latinLang = lang && !NON_LATIN.has(lang) ? lang : null
          if (latinLang) {
            add(out.page, latinLang, latin)
            if (counted) add(out.main, latinLang, latin)
          } else {
            pools.page.push(text)
            if (counted) pools.main.push(text)
          }
        } else if (latin) {
          pools.page.push(text)
          if (counted) pools.main.push(text)
        }
      }
    }
    for (const child of Array.from(el.children)) walk(child, here, framed, isShown)
  }
  walk(root, root === main, false, true)
  // Short Latin blocks together: one guess for all of them (a menu of «Home», «Products», «Contact»).
  for (const key of ["main", "page"] as const) {
    const text = pools[key].join(". ")
    const letters = text.match(/\p{Script=Latin}/gu)?.length ?? 0
    if (letters) add(out[key], latinGuess(text) ?? "?", letters)
    const cyrText = cyr[key].join(". ")
    const cyrLetters = cyrText.match(/\p{Script=Cyrillic}/gu)?.length ?? 0
    if (cyrLetters) add(out[key], languageGuess(cyrText)?.lang === "uk" ? "uk" : "ru", cyrLetters)
  }
  return out
}

const NON_LATIN = new Set(["ru", "uk", "ar", "he", "el", "th", "ja", "ko", "zh"])

/** A Latin-script guess for pooled short texts: by function words over all of them (the long-text floor is skipped:
 *  menus have few function words). */
function latinGuess(text: string): string | null {
  const g = languageGuess(text.slice(0, 2000))
  return g && !NON_LATIN.has(g.lang) ? g.lang : null
}

/** The share of `s`'s known letters that are in `lang` (base codes compared; unknown letters left out). */
export function shareOf(s: Shares, lang: string): number {
  const base = baseLanguage(lang)
  let known = 0
  let mine = 0
  for (const [l, n] of s.langs) {
    if (l === "?") continue
    known += n
    if (baseLanguage(l) === base) mine += n
  }
  return known ? mine / known : 0
}

/** The language with most letters in `s` other than `except`, and its share of the known letters. */
export function topOther(s: Shares, except: string): { lang: string; share: number } | null {
  const base = baseLanguage(except)
  let known = 0
  let best: string | null = null
  let most = 0
  for (const [l, n] of s.langs) {
    if (l === "?") continue
    known += n
    if (baseLanguage(l) === base) continue
    if (n > most) {
      most = n
      best = l
    }
  }
  return best && known ? { lang: best, share: most / known } : null
}
