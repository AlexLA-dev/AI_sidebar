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
 * The notification for a message's reminder: the chat's name and the start of the answer or note. A note made
 * on a page (a selection's Note) says that page's title instead, so it's clear what to go back to. A page
 * reminder (the bell by a selection: "Remind me to come back", `remind.page`) also opens that page; any other
 * opens the chat at the message.
 */
export function reminderNotice(entry: Entry, chatTitle: string): { title: string; body: string; url?: string } {
  const page = entry.note && entry.page ? entry.page.title || entry.page.url : ""
  const url = entry.remind?.page && entry.page && /^https?:\/\//.test(entry.page.url) ? entry.page.url : ""
  return { title: page || chatTitle || "ContextFlow", body: reminderText(entry.content), ...(url ? { url } : {}) }
}
