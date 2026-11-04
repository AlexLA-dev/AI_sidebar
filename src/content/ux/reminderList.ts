// The reminders in the panel's "Reminders" list (2.5; 2.5 (75), the owner's notes: a row must say what the reminder
// is about in full, not a title cut at the row's width). Pure, so it's tested without a page.

import { entryKey, isQuestion, type Entry } from "../../shared/conversation.ts"
import { toPlainText } from "../../shared/share.ts"
import { threadTitle, type Threads } from "../../shared/threads.ts"
import type { LaterItem } from "./later.ts"

// An answer's start shown with its reminder; the whole answer is a tap away ("Open").
const ANSWER_START = 280

/** What a reminder on `m[idx]` is about: a note's text; for an answer, the question it answers and its start. */
export function reminderText(m: Entry[], idx: number): { text?: string; question?: string } {
  const entry = m[idx]
  if (!entry) return {}
  if (entry.role === "user") return entry.content.trim() ? { text: entry.content.trim() } : {}
  const before = m[idx - 1]
  const question = idx > 0 && isQuestion(before) ? (before.label ?? before.content).trim() : ""
  const plain = toPlainText(entry.content).replace(/\s+/g, " ").trim()
  const text = plain.length > ANSWER_START ? `${plain.slice(0, ANSWER_START).replace(/\s+\S*$/, "")}…` : plain
  return { ...(text ? { text } : {}), ...(question ? { question } : {}) }
}

/**
 * The reminders still to ring in every chat, the soonest first: each with its chat (or page) as the title, what it's
 * about, and when (`when`: "Tomorrow 9:00"; `elsewhere`: the same, set on another device, where it rings).
 */
export function reminderRows(threads: Threads, dev: string | undefined, now: number, when: (at: number) => string, elsewhere: (label: string) => string): LaterItem[] {
  const out: LaterItem[] = []
  for (const [chat, thread] of Object.entries(threads)) {
    if (thread.deleted) continue
    thread.m.forEach((m, idx) => {
      if (!m.remind || m.remind.at <= now) return
      const page = m.note ? m.page : undefined
      // It rings on the device that set it (`dev`); one without it was set before 2.5's marks.
      const here = !m.remind.dev || m.remind.dev === dev
      out.push({
        id: `remind:${chat}:${entryKey(m)}`,
        kind: "remind",
        title: page ? page.title || page.url : thread.title || threadTitle(thread.m),
        ...(m.remind.page && page ? { url: page.url } : {}),
        status: here ? when(m.remind.at) : elsewhere(when(m.remind.at)),
        sortAt: m.remind.at,
        at: m.remind.at,
        here,
        ...reminderText(thread.m, idx)
      })
    })
  }
  return out.sort((a, b) => a.sortAt - b.sortAt)
}

/** A reminder row's chat and message key ("remind:<chat>:<key>"). */
export function reminderOf(item: LaterItem): { chat: string; key: string } | null {
  if (item.kind !== "remind") return null
  const [, chat, ...key] = item.id.split(":")
  return chat && key.length ? { chat, key: key.join(":") } : null
}

/** `m` with the reminder of the message `key` at `at` (rung on device `dev`, where it was set); a page's stays one. */
export function withReminderAt(m: Entry[], key: string, at: number, dev: string | undefined): Entry[] {
  return m.map((x) => (entryKey(x) === key ? { ...x, remind: { ...(x.remind?.page ? { page: true as const } : {}), at, ...(dev ? { dev } : {}) } } : x))
}
