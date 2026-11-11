// Reminders on an answer or a note (2.5): what the notification says. A local notification on the device
// that set it (the extension's native handler, or the app); the chat keeps only the mark (`remind`).
// Pure helpers shared by the panel and tests; the app has the same in MessageReminders.swift.

import { citedNote, stripCitations, withNoteWords, type Entry } from "./conversation.ts"

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
 * The notification for a message's reminder: the chat's name and the start of the answer or note. A note made
 * on a page (a selection's Note) says that page's title instead, so it's clear what to go back to. A page
 * reminder ("Come back later", `remind.page`) also opens that page; any other opens the chat at the message.
 * `asked`: the body's wording around the text ("You asked to be reminded: …", 2.5; the bell is about time, the eye's
 * "Changed: …" is watching's). 2.6 (97): a note on a selection with the person's own words says those words, not the
 * quote (the chat shows the quote); one without says the quote, as before.
 */
export function reminderNotice(entry: Entry, chatTitle: string, asked = (text: string) => text): { title: string; body: string; url?: string } {
  const page = entry.note && entry.page ? entry.page.title || entry.page.url : ""
  const url = entry.remind?.page && entry.page && /^https?:\/\//.test(entry.page.url) ? entry.page.url : ""
  const text = citedNote(entry)?.note || entry.content
  return { title: page || chatTitle || "ContextFlow", body: asked(reminderText(text)), ...(url ? { url } : {}) }
}

/**
 * The person's own words on a reminder made with Remind on a selection or a page (2.6 (97)), as its window shows them
 * to change: a cited note's words after its quote; a page's note its text, unless that's the page's name (what a page
 * reminder without words says). Undefined for any other reminder (an answer's, a note typed in the chat, a note on a
 * selection made before: its quote and words are one text).
 */
export function remindWords(entry: Entry): string | undefined {
  if (!entry.note || !entry.remind?.page) return undefined
  const cited = citedNote(entry)
  if (cited) return cited.note
  if (entry.quote) return undefined
  const named = [entry.page?.title, entry.page?.url].filter(Boolean)
  return named.includes(entry.content.trim()) ? "" : entry.content
}

/** The reminder with the person's new words (remindWords); a page's without words says the page's name, as before. */
export function withRemindWords(entry: Entry, words: string | undefined): Entry {
  if (words === undefined || remindWords(entry) === undefined) return entry
  if (citedNote(entry)) return withNoteWords(entry, words)
  return { ...entry, content: words.trim() || entry.page?.title || entry.page?.url || entry.content }
}
