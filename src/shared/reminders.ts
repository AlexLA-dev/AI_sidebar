// Reminders on an answer or a note (2.5): what the notification says. A local notification on the device
// that set it (the extension's native handler, or the app); the chat keeps only the mark (`remind`).
// Pure helpers shared by the panel and tests; the app has the same in MessageReminders.swift.

import { stripCitations, type Entry } from "./conversation.ts"

const BODY_MAX = 160

/** The text a notification shows for a message: plain words, no Markdown, tables or list signs. */
export function reminderText(content: string, max = BODY_MAX): string {
  const text = stripCitations(content)
    .replace(/```[a-z]*\n?/gi, "")
    // Tables: the divider row goes, cells become words.
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\W)[*_]([^*_\n]+)[*_]/g, "$1$2")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * The notification for a message's reminder. A page reminder (a note made from a selection with "Remind
 * me", `remind.page`) says "Check: <the quote>" under the page's title and opens the page; any other
 * says the chat's name and the start of the answer or note, and opens the chat at it.
 */
export function reminderNotice(entry: Entry, chatTitle: string, checkLabel: (quote: string) => string): { title: string; body: string; url?: string } {
  if (entry.remind?.page && entry.page?.url) {
    const quote = entry.content.split("\n\n")[0].replace(/^[«“"„]|[»”"“]$/g, "")
    return { title: entry.page.title || entry.page.url, body: checkLabel(reminderText(quote, 120)), url: entry.page.url }
  }
  return { title: chatTitle || "ContextFlow", body: reminderText(entry.content) }
}
