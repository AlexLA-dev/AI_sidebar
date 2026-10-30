// One running conversation that follows the user across pages (until "New chat").
// Pure helpers shared by the content script and tests.

import type { ChatTurn, Grounding } from "./types.ts"

/** The page a question was asked on: normalized URL, title and a fingerprint of its text. */
export interface PageRef {
  url: string
  title: string
  hash?: string
}

export interface Entry extends ChatTurn {
  label?: string
  mode?: "google"
  // Google answers: sources and Search Suggestions shown with the answer.
  grounding?: Grounding
  // User turns: where they were asked, and whether the page had changed since the last question there.
  page?: PageRef
  pageChanged?: boolean
  // A note the user wrote in the chat: kept with it, never sent to the AI as a question.
  note?: boolean
}

const MAX_HISTORY = 12
// "Whole chat": every message (notes too) up to this many characters, newest kept first.
export const WHOLE_CHAT_CHARS = 48_000

/** A question to the AI (a user turn that isn't a note). */
export function isQuestion(entry: Entry | undefined): boolean {
  return entry?.role === "user" && !entry.note
}

/** Stable key for "the same page": no hash, no tracking parameters. */
export function urlKey(href: string): string {
  try {
    const url = new URL(href)
    url.hash = ""
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|mc_|ref$|ref_src)/i.test(p)) url.searchParams.delete(p)
    }
    return url.toString()
  } catch {
    return href
  }
}

/** Short, stable fingerprint of page text (FNV-1a, 32 bit) to notice when a page has new content. */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** Removes numbered source citations ("[2](url)") from an answer. */
export function stripCitations(text: string): string {
  return text.replace(/[ \t]*\[\d{1,2}\]\(https?:[^)\s]+\)/g, "")
}

/** The last page the conversation was on (from the latest user turn), if any. */
export function lastPage(entries: Entry[]): PageRef | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === "user" && entries[i].page) return entries[i].page
  return undefined
}

/** True when the page was asked about before in this conversation and its text has changed since. */
export function pageHasChanged(entries: Entry[], url: string, hash: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const page = entries[i].role === "user" ? entries[i].page : undefined
    if (page?.url === url && page.hash) return page.hash !== hash
  }
  return false
}

/** The messages of a conversation read back from storage or iCloud, or null if it isn't one. */
export function entriesFrom(parsed: unknown): Entry[] | null {
  if (!Array.isArray(parsed)) return null
  const valid = parsed.every((e) =>
    e !== null && typeof e === "object" &&
    ((e as Entry).role === "user" || (e as Entry).role === "assistant") &&
    typeof (e as Entry).content === "string"
  )
  return valid ? (parsed as Entry[]) : null
}

/**
 * Messages for the model: the last turns (without notes), citations stripped, and questions asked on
 * other pages marked with that page so the model knows the current page content isn't what they were about.
 * `wholeChat`: every message that fits WHOLE_CHAT_CHARS, the user's notes marked as notes.
 */
export function historyForModel(entries: Entry[], currentUrl: string, wholeChat = false): ChatTurn[] {
  const turn = ({ role, content, page, note }: Entry): ChatTurn => {
    const text = stripCitations(content)
    const elsewhere = role === "user" && page && page.url !== currentUrl ? `"${page.title || page.url}" — ${page.url}` : ""
    if (note) return { role, content: `[Note the user wrote${elsewhere ? ` on another page: ${elsewhere}` : ""}]\n${text}` }
    return { role, content: elsewhere ? `[Asked on another page: ${elsewhere}]\n${text}` : text }
  }
  if (!wholeChat) return entries.filter((e) => !e.note).slice(-MAX_HISTORY).map(turn)
  const turns: ChatTurn[] = []
  let size = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = turn(entries[i])
    size += t.content.length
    if (size > WHOLE_CHAT_CHARS && turns.length) break
    turns.unshift(t)
  }
  return turns
}

/** Pages of the chat other than `currentUrl`, the most recent first. */
export function otherPages(entries: Entry[], currentUrl: string): PageRef[] {
  const seen = new Set([currentUrl])
  const pages: PageRef[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const page = entries[i].role === "user" ? entries[i].page : undefined
    if (page && !seen.has(page.url)) {
      seen.add(page.url)
      pages.push(page)
    }
  }
  return pages
}
