// One running conversation that follows the user across pages (until "New chat").
// Pure helpers shared by the content script and tests.

import type { MediaKind } from "./attachments.ts"
import { markedContent, type Mark } from "./marks.ts"
import type { SimilarAnswer } from "./similar.ts"
import type { ChatTurn, Grounding } from "./types.ts"

/** The page a question was asked on: normalized URL, title and a fingerprint of its text. */
export interface PageRef {
  url: string
  title: string
  hash?: string
  // The page's readable text (Readability, as in Reading mode; never HTML), kept with the chat so the
  // ContextFlow app can answer about it later: on the first question or note on the page, and again
  // when the page has changed. Not from Private Browsing, videos' transcripts or PDFs.
  text?: string
  // When the question or note was written (ms): the chat shows the date by the page's title. Missing
  // before 2.4.
  at?: number
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
  // "Find similar" (2.6): on the question, the condition in the person's words ("" for none); on the answer, the
  // checked list (its text is the same list in Markdown, for copying, sharing and the app).
  similarAsk?: string
  // …and, asked from a selection, what was selected (its subject; asked again with it).
  similarSel?: string
  similar?: SimilarAnswer
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
  // 2.5: a message's id and when it was written (ms). Older messages have neither: their key comes from
  // their content (entryKey) and their time from their page (entryTimes).
  id?: string
  t?: number
  // Moved here from another chat (organizing): which one, and when (ms).
  from?: { chat: string; at: number }
  // Organizing suggestions the user turned down here (moving this message's block; these tags), and the
  // suggested tags they took. Kept on the message, so they reach the other devices with the chat.
  dismissed?: { move?: true; tags?: string[] }
  accepted?: { tags?: string[] }
  // 2.5, answers: what the user highlighted (sent to the model as <mark>, copied as bold).
  marks?: Mark[]
  // 2.5, answers and notes: pinned at the top of the chat (when, ms).
  pinned?: number
  // 2.5, answers and notes: a reminder (ms). The notification rings only on the device that set it (`dev`).
  // `page`: a note made from a selection with "Remind me": the notification opens its page.
  remind?: { at: number; dev?: string; page?: true }
}

/** A new message's id: 12 random letters and digits. */
export function newEntryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")
}

/** A message as it's written: with an id and the time (kept when it has them). */
export function stamped<T extends Entry>(entry: T, now = Date.now()): T {
  return { ...entry, id: entry.id ?? newEntryId(), t: entry.t ?? now }
}

/** FNV-1a (32 bit) of the UTF-16 code units of `text`, from `seed`, as 8 hex digits. */
function fnv(text: string, seed: number): string {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** A 64-bit fingerprint of `text` (two FNV-1a passes), the same in the app (Organize.swift). */
export function textKey(text: string): string {
  return fnv(text, 0x811c9dc5) + fnv(text, 0x050c5d1f)
}

/**
 * A message's stable key, the same on every device and in the app: its id, or for a message written
 * before 2.5 a fingerprint of its role, text and page (with the page's time, which tells apart the same
 * quick action asked twice on one page).
 */
export function entryKey(entry: Entry): string {
  return entry.id ?? `h${textKey(`${entry.role}\u0000${entry.content}\u0000${entry.page?.url ?? ""}\u0000${entry.page?.at ?? ""}`)}`
}

/**
 * When each message was written, to put moved messages in order: its `t`, else its page's time (2.4),
 * else the time of the message before it; null before the first known time (older than any).
 */
export function entryTimes(entries: Entry[]): Array<number | null> {
  let last: number | null = null
  return entries.map((e) => {
    const own = e.t ?? e.page?.at
    if (typeof own === "number" && Number.isFinite(own)) last = own
    return last
  })
}

/** The messages with "Page updated" worked out again for their order (after messages moved in or out). */
export function withPageChanges(entries: Entry[]): Entry[] {
  const seen = new Map<string, string>()
  return entries.map((e) => {
    if (e.role !== "user" || !e.page) return e
    const before = seen.get(e.page.url)
    if (e.page.hash) seen.set(e.page.url, e.page.hash)
    if (e.note) return e
    const changed = before !== undefined && e.page.hash !== undefined && before !== e.page.hash
    if (changed === Boolean(e.pageChanged)) return e
    const next = { ...e }
    if (changed) next.pageChanged = true
    else delete next.pageChanged
    return next
  })
}

const MAX_HISTORY = 12
/** The messages a free answer remembers (build 91: the whole chat is Pro's). */
export const FREE_MEMORY = MAX_HISTORY
// Page texts kept in a chat: each cut to this (the budget the server gives a chat's other pages), for
// its last 10 pages (an answer in the app gets the chat's last page and up to MAX_APP_OTHER_PAGES others).
export const MAX_SAVED_PAGE_CHARS = 8_000
export const MAX_SAVED_PAGES = 10
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
  return stamped({ role: "user", content: note ? `${quote}\n\n${note}` : quote, note: true, quote: true, page }, page.at)
}

/**
 * The page a question or note was written on, with its text when the chat doesn't have this version
 * of it yet (`text` empty: none, e.g. Private Browsing).
 */
export function pageRef(entries: Entry[], url: string, title: string, text: string, keepText = true, now = Date.now()): PageRef {
  const hash = textFingerprint(text)
  const ref: PageRef = { url, title, hash, at: now }
  const saved = entries.some((e) => e.page?.url === url && e.page.hash === hash && e.page.text)
  if (keepText && text.trim() && !saved) ref.text = text.slice(0, MAX_SAVED_PAGE_CHARS)
  return ref
}

/**
 * When the chat came to a page, by its title: "Nov 1 (2 days ago)", the same day "Nov 3 (3 hours
 * ago)", in `locale`; the year only when it isn't this one.
 */
export function pageWhen(at: number, now: number, locale: string): string {
  const day = new Date(at)
  const today = new Date(now)
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  // Calendar days (round: a day with a clock change is 23 or 25 hours).
  const days = Math.max(0, Math.round((start(today) - start(day)) / 86_400_000))
  const year = day.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}
  const date = day.toLocaleDateString(locale, { day: "numeric", month: "short", ...year })
  return `${date} (${pageAgo(days, Math.max(0, now - at), locale)})`
}

/** "2 days ago"; the same day in hours, minutes or "now" (another device's clock may run a bit ahead). */
function pageAgo(days: number, ms: number, locale: string): string {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  if (days > 0) return relative.format(-days, "day")
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return relative.format(0, "second")
  if (minutes < 60) return relative.format(-minutes, "minute")
  return relative.format(-Math.floor(minutes / 60), "hour")
}

/** The page texts kept in the chat: the latest one of each page, the most recent page first. */
export function savedPages(entries: Entry[]): Array<{ url: string; title: string; text: string }> {
  const out: Array<{ url: string; title: string; text: string }> = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const page = entries[i].page
    if (page?.text && !out.some((p) => p.url === page.url)) out.push({ url: page.url, title: page.title, text: page.text })
  }
  return out
}

/** The chat with only the texts `savedPages` gives for its last `max` pages; older ones are dropped. */
export function trimSavedPages(entries: Entry[], max = MAX_SAVED_PAGES): Entry[] {
  const kept = new Set<number>()
  const urls = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const page = entries[i].page
    if (!page?.text || urls.has(page.url) || urls.size >= max) continue
    urls.add(page.url)
    kept.add(i)
  }
  return entries.map((e, i) => (e.page?.text && !kept.has(i) ? withoutText(e) : e))
}

/** The entry without its page's text. */
export function withoutText(entry: Entry): Entry {
  if (!entry.page?.text) return entry
  const { text: _text, ...page } = entry.page
  return { ...entry, page }
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
  const turn = ({ role, content, page, note, marks }: Entry): ChatTurn => {
    // The user's highlights in an answer go as <mark>…</mark> (the rule is in the system prompt).
    const text = role === "assistant" && marks?.length ? markedContent(stripCitations(content), marks) : stripCitations(content)
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
