// One running conversation that follows the user across pages (until "New chat").
// Pure helpers shared by the content script and tests.

import type { MediaKind } from "./attachments.ts"
import type { ChatTurn, Grounding } from "./types.ts"

/** The page a question was asked on: normalized URL, title and a fingerprint of its text. */
export interface PageRef {
  url: string
  title: string
  hash?: string
}

/**
 * What a question was asked with besides the page's own text: a video's transcript or captions, or a
 * PDF (on the page, linked from it, or open in the tab). `ok: false` — it couldn't be read and the
 * answer used what the page shows; `reason` "none" means there is nothing to read (no captions,
 * a scanned PDF), anything else that reading it failed.
 */
export interface SourceNote {
  kind: "video" | "pdf"
  ok: boolean
  name: string
  // Video length ("18:40") or PDF pages ("12").
  detail?: string
  reason?: "none" | "failed"
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
  // A note made from a page selection: its text starts with the selected text in quotes.
  quote?: boolean
  // User turns: videos and PDFs read along with the page (shown under the question).
  sources?: SourceNote[]
  // User turns: the page had a video or PDFs that weren't read (not Pro); the answer gets a line about it.
  skipped?: MediaKind[]
  // Answers and notes: the user's tags (a chat's own tags are on the thread).
  tags?: string[]
}

const MAX_HISTORY = 12
// "Whole chat": every message (notes too) up to this many characters, newest kept first.
export const WHOLE_CHAT_CHARS = 48_000

// A note made from a selection keeps at most this much of the selected text.
export const MAX_NOTE_QUOTE = 3_000

/**
 * A note made from a page selection (the Note button by the selection): the selected text in quotes
 * (`quoted`: in the language's quotes), then the user's comment, if any. The page goes with it, so
 * the chat shows where it came from. No AI: it doesn't use an answer.
 */
export function selectionNote(selected: string, comment: string, page: PageRef, quoted = (text: string) => `“${text}”`): Entry {
  let text = selected.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  if (text.length > MAX_NOTE_QUOTE) text = text.slice(0, MAX_NOTE_QUOTE).trimEnd() + "…"
  const quote = quoted(text)
  const note = comment.trim()
  return { role: "user", content: note ? `${quote}\n\n${note}` : quote, note: true, quote: true, page }
}

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
