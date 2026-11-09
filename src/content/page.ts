import { Readability } from "@mozilla/readability"

import { urlKey } from "../shared/conversation"
import { MAX_PAGE_CHARS } from "../shared/prompt"
import type { Platform } from "../shared/types"
import { shadowSelection } from "./selectionShadow"
import { unfoldCollapsed } from "./unfold"

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
  return urlKey(location.href)
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
// Its place on the page (2.6 (92)): the panel rings the text it's about, also after iOS has let go of the selection.
let lastRange: Range | null = null
const SELECTION_TTL_MS = 30_000
// A long-press on iPhone selects a single word, so one word is already a selection worth using.
export const MIN_SELECTION_WORDS = 1

function countWords(text: string): number {
  // CJK text has no spaces: count characters / 2 as a rough word count.
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0
  return text.split(/\s+/).filter(Boolean).length + Math.round(cjk / 2)
}

/**
 * Current page selection (outside our own UI), or null: in the page, or inside a site's open shadow root (LinkedIn's
 * messages, selectionShadow.ts), where the document doesn't see it.
 */
export function readSelection(): SelectionInfo | null {
  const inner = shadowSelection(HOST_TAG)
  if (inner) return selectionInfo(inner.toString(), () => inner.getBoundingClientRect())
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const anchor = sel.anchorNode
  const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement
  if (anchorEl?.closest(HOST_TAG)) return null
  return selectionInfo(sel.toString(), () => sel.getRangeAt(0).getBoundingClientRect())
}

function selectionInfo(raw: string, box: () => DOMRect): SelectionInfo | null {
  const text = raw.replace(/\s+\n/g, "\n").trim()
  if (text.length < 2) return null
  let rect: DOMRect | null = null
  try {
    rect = box()
  } catch {
    rect = null
  }
  return { text: text.slice(0, 20_000), words: countWords(text), rect, at: Date.now() }
}

/** Remembers the latest selection: on iPhone tapping our button clears it. */
export function trackSelection(): SelectionInfo | null {
  const current = readSelection()
  if (current && current.words >= MIN_SELECTION_WORDS) {
    lastSelection = current
    try {
      lastRange = document.getSelection()?.getRangeAt(0).cloneRange() ?? lastRange
    } catch {
      // No range to keep.
    }
  }
  return current
}

/** Where the selection the panel is about is on the page: the live one, or the one last remembered. */
export function selectionRange(): Range | null {
  const live = document.getSelection()
  if (live && live.rangeCount > 0 && !live.isCollapsed) {
    const range = live.getRangeAt(0)
    const at = range.commonAncestorContainer
    const el = at instanceof Element ? at : at.parentElement
    if (!el?.closest(HOST_TAG)) return range.cloneRange()
  }
  return lastRange
}

/**
 * Puts the selection the panel was about back on the page when the page has none: the panel's field took it (iPhone
 * drops a page selection once something else gets focus, and so does a click into the field on a Mac). False when
 * there's nothing to put back or the page already has its own selection.
 */
export function restoreSelection(): boolean {
  const live = document.getSelection()
  if (!live || !lastRange || readSelection()) return false
  if (lastRange.collapsed || !lastRange.startContainer.isConnected || !lastRange.endContainer.isConnected) return false
  try {
    live.removeAllRanges()
    live.addRange(lastRange.cloneRange())
    return true
  } catch {
    return false
  }
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
  lastRange = null
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
  unfoldCollapsed(clone)
  clone.querySelectorAll(
    `script,style,noscript,template,svg,canvas,iframe,nav,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],${HOST_TAG}`
  ).forEach((el) => el.remove())
  return clone.innerText || clone.textContent || ""
}

/** The tab is in Private Browsing (an incognito window). */
export function privateBrowsing(): boolean {
  try {
    return chrome.extension?.inIncognitoContext === true
  } catch {
    return false
  }
}

/**
 * Readable text of the page (Readability for articles, cleaned body text otherwise), with its folded sections
 * unfolded (see unfold.ts), up to `max` characters: a question reads all of it (readTab).
 * Read fresh every time: pages load more content after the first look (feeds, SPAs, live updates).
 */
export function extractPage(max = MAX_PAGE_CHARS): { title: string; text: string } {
  let title = document.title
  let text = ""
  try {
    const doc = document.cloneNode(true) as Document
    doc.querySelectorAll(HOST_TAG).forEach((el) => el.remove())
    unfoldCollapsed(doc)
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
  return { title: title.slice(0, 300), text: text.slice(0, max) }
}
