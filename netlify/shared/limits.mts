// Which limits an answer ran into, logged with it so /analytics (cf_limits_report) can show whether any
// of them keeps getting in users' way. Only the flags that are set go into the event.

import { MAX_MEDIA_PAGE_CHARS, MAX_OTHER_PAGE_CHARS, pageLimit, pageText, type PageContext } from "../../src/shared/prompt.ts"

/** What the panel or the app says about the chat a question came from (ContextFlow 2.4 and later). */
export interface ChatSize {
  // Messages in the chat (questions, answers, notes), before any are left out of the request.
  chat_turns?: number
  // Pages the chat has been on.
  chat_pages?: number
  // Chats kept on the device (beyond 50 the oldest are deleted).
  chats?: number
}

/** The client's numbers about its chat (whole numbers up to 100,000; anything else is dropped). */
export function chatSize(raw: unknown): ChatSize {
  if (!raw || typeof raw !== "object") return {}
  const s = raw as Record<string, unknown>
  const out: ChatSize = {}
  for (const [from, to] of [["turns", "chat_turns"], ["pages", "chat_pages"], ["chats", "chats"]] as const) {
    const n = s[from]
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000) out[to] = n
  }
  return out
}

/** Not every chat the client sent fitted into "Ask your chats" or AI search (too many, or too much text). */
export function digestCut(raw: unknown, kept: Array<{ text: string }>, maxChars: number): boolean {
  const sent = Array.isArray(raw) ? raw.length : 0
  return sent > kept.length || kept.reduce((n, c) => n + c.text.length, 0) >= maxChars
}

/** All the text a page carried (its own and its transcript or PDFs). */
function sentChars(page: PageContext): number {
  return page.text.length + (page.attachments ?? []).reduce((n, a) => n + a.heading.length + a.text.length, 0)
}

export interface LimitInput {
  // The page as the client sent it, and as the model got it (with its video or PDFs, or without).
  sent: PageContext | null
  page: PageContext | null
  // Messages the client sent, and those the model got.
  sentMessages: number
  messages: number
  // The chat's other pages the model got.
  others: PageContext[]
  // The model stopped at its length limit.
  answerCut: boolean
}

// Marks events that carry these flags (cf_limits_report reads older ones from their sizes).
export const LIMITS_VERSION = 1

/** The limits this answer ran into. */
export function limitsHit({ sent, page, sentMessages, messages, others, answerCut }: LimitInput): Record<string, true | number> {
  const hits: Record<string, true | number> = { limits_v: LIMITS_VERSION }
  if (sent && page) {
    // With its video or PDFs, cut to the media limit; otherwise cut when the model doesn't get all of it (a 2.3 or
    // 2.4 panel cuts a page at 24 000 characters itself, 2.5 sends it whole; see pageText).
    const cut = page.media && sent.attachments?.length
      ? sentChars(sent) - sent.text.length > MAX_MEDIA_PAGE_CHARS
      : page.kind === "selection" ? page.text.length >= pageLimit(page) : pageText(page).cut
    if (cut) hits.page_cut = true
  }
  if (sentMessages > messages) hits.history_cut = true
  // Saved and cached page texts are cut to this limit before they're sent, so reaching it counts too.
  const othersCut = others.filter((p) => p.text.length >= MAX_OTHER_PAGE_CHARS).length
  if (othersCut) hits.other_pages_cut = othersCut
  if (answerCut) hits.answer_cut = true
  return hits
}
