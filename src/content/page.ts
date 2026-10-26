import { Readability } from "@mozilla/readability"

import { MAX_PAGE_CHARS } from "../shared/prompt"
import type { Platform } from "../shared/types"

export const HOST_TAG = "contextflow-root"

export function detectPlatform(target: "safari" | "chrome"): Platform {
  if (target === "chrome") return "chrome"
  const ua = navigator.userAgent
  if (/iPhone|iPod/.test(ua)) return "ios"
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ipados"
  if (/Macintosh/.test(ua)) return "macos"
  return "other"
}

export function isTouch(platform: Platform): boolean {
  return platform === "ios" || platform === "ipados"
}

/** Stable key for "the same page" (ignores hash and tracking parameters). */
export function pageKey(): string {
  try {
    const url = new URL(location.href)
    url.hash = ""
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|mc_|ref$|ref_src)/i.test(p)) url.searchParams.delete(p)
    }
    return url.toString()
  } catch {
    return location.href
  }
}

export function siteName(): string {
  return location.hostname.replace(/^www\./, "")
}

// ------------------------------------------------------------- selection

export interface SelectionInfo {
  text: string
  words: number
  rect: DOMRect | null
  at: number
}

let lastSelection: SelectionInfo | null = null
const SELECTION_TTL_MS = 30_000
// A long-press on iPhone selects a single word, so one word is already a selection worth using.
export const MIN_SELECTION_WORDS = 1

function countWords(text: string): number {
  // CJK text has no spaces: count characters / 2 as a rough word count.
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0
  return text.split(/\s+/).filter(Boolean).length + Math.round(cjk / 2)
}

/** Current page selection (outside our own UI), or null. */
export function readSelection(): SelectionInfo | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const anchor = sel.anchorNode
  const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement
  if (anchorEl?.closest(HOST_TAG)) return null
  const text = sel.toString().replace(/\s+\n/g, "\n").trim()
  if (text.length < 2) return null
  let rect: DOMRect | null = null
  try {
    rect = sel.getRangeAt(0).getBoundingClientRect()
  } catch {
    rect = null
  }
  return { text: text.slice(0, 20_000), words: countWords(text), rect, at: Date.now() }
}

/** Remembers the latest selection: on iPhone tapping our button clears it. */
export function trackSelection(): SelectionInfo | null {
  const current = readSelection()
  if (current && current.words >= MIN_SELECTION_WORDS) lastSelection = current
  return current
}

export function recentSelection(): SelectionInfo | null {
  const live = readSelection()
  if (live && live.words >= MIN_SELECTION_WORDS) return live
  if (lastSelection && Date.now() - lastSelection.at < SELECTION_TTL_MS) return lastSelection
  return null
}

/** Uses `selection` as the context of the next answer (e.g. the one our selection button captured). */
export function rememberSelection(selection: SelectionInfo): void {
  lastSelection = { ...selection, at: Date.now() }
}

export function forgetSelection(): void {
  lastSelection = null
}

// ------------------------------------------------------------ page text

function cleanText(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

function fallbackText(): string {
  const clone = document.body?.cloneNode(true) as HTMLElement | undefined
  if (!clone) return ""
  clone.querySelectorAll(
    `script,style,noscript,template,svg,canvas,iframe,nav,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],${HOST_TAG}`
  ).forEach((el) => el.remove())
  return clone.innerText || clone.textContent || ""
}

/**
 * Readable text of the page (Readability for articles, cleaned body text otherwise).
 * Read fresh every time: pages load more content after the first look (feeds, SPAs, live updates).
 */
export function extractPage(): { title: string; text: string } {
  let title = document.title
  let text = ""
  try {
    const doc = document.cloneNode(true) as Document
    doc.querySelectorAll(HOST_TAG).forEach((el) => el.remove())
    const article = new Readability(doc, { charThreshold: 300 }).parse()
    if (article?.textContent && article.textContent.trim().length > 400) {
      text = article.textContent
      title = article.title || title
    }
  } catch {
    // Readability can throw on unusual documents; use the fallback.
  }
  if (!text) text = fallbackText()
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"],meta[property="og:description"]')?.content
  text = cleanText(text)
  if (text.length < 200 && description) text = `${description}\n\n${text}`.trim()
  return { title: title.slice(0, 300), text: text.slice(0, MAX_PAGE_CHARS) }
}
