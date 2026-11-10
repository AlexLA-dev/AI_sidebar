// A chat's row in the chats list, build 94 (the owner, on TestFlight 93: «на полоске чата хочется видеть глаз и число
// там где установлены наблюдения за изменениями и колокольчик, если напоминалка стоит»): the eye with how many of the
// chat's pages are watched, the bell while one of its reminders is still to ring, and a spinner while its last
// question is being answered (an answer or Find similar). And the chats an "Ask your chats" answer names, as links
// that open them («чтобы при тапе/клике по ним можно было бы сразу перейти на тот чат»).
// Pure, shared by the panel, the server and tests; the app has the same in RowMarks (Later.swift; the tests read both).

import { isQuestion, urlKey, type Entry } from "./conversation.ts"
import { ORPHAN_MS } from "./jobs.ts"

/** Whether a reminder in the chat is still to ring: the bell on its row. */
export function remindsAhead(m: readonly Entry[], now = Date.now()): boolean {
  return m.some((e) => e.remind !== undefined && e.remind.at > now)
}

/** How many of `watched` (the watched pages' addresses) are pages of the chat: the eye's number on its row. */
export function watchesOn(m: readonly Entry[], watched: readonly string[]): number {
  if (!watched.length) return 0
  const pages = new Set<string>()
  for (const e of m) if (e.role === "user" && e.page?.url) pages.add(urlKey(e.page.url))
  return pages.size ? watched.filter((url) => pages.has(urlKey(url))).length : 0
}

/**
 * Whether the chat's last question is still being answered somewhere: no answer after it yet, asked under ORPHAN_MS
 * ago. What a device without the job sees (the app, another device); on the device running it the job says so
 * (runningThreads), however long it takes. The same rule as `interruption`, the other way round.
 */
export function pendingQuestion(m: readonly Entry[], now = Date.now()): boolean {
  const last = m[m.length - 1]
  if (!isQuestion(last)) return false
  const at = last.t ?? last.page?.at
  return at !== undefined && now - at >= -60_000 && now - at < ORPHAN_MS
}

// ------------------------------------------------------------ chat links in "Ask your chats"

/** A link to a chat in an answer: `[its name](chat:<id>)`, as the server asks the model to write it. */
export const CHAT_LINK = /\[([^\]\n]+)\]\(chat:([A-Za-z0-9_-]{1,64})\)/g

// A name shorter than this isn't looked for in an answer's text: "AI" or "Notes" would turn ordinary words into links.
const MIN_NAME = 6

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The answer with the chats it names as links (`[name](chat:<id>)`): the links the model wrote are kept when their
 * chat is among `chats` (else just their name stays), and a chat's name written out in full (in quotes, in bold or
 * plain, any case) becomes a link the first time it appears, for answers written before the server asked for links.
 * Not inside code, inside a link, or inside a longer word. The longest names first, so "Trip to Rome" wins over "Rome".
 */
export function linkChats(text: string, chats: ReadonlyArray<{ id: string; name: string }>): string {
  const known = new Set(chats.map((c) => c.id))
  // The model's own links: kept for a known chat, the name alone for any other.
  let out = text.replace(CHAT_LINK, (_, label: string, id: string) => (known.has(id) ? `[${label}](chat:${id})` : label))
  const linked = new Set<string>()
  out.replace(CHAT_LINK, (_, __, id: string) => {
    linked.add(id)
    return ""
  })
  const names = chats
    .map((c) => ({ id: c.id, name: c.name.replace(/\s+/g, " ").trim() }))
    .filter((c) => c.name.length >= MIN_NAME && !linked.has(c.id))
    .sort((a, b) => b.name.length - a.name.length)
  for (const chat of names) {
    // Code spans, fenced blocks and links are left as they are.
    const parts = out.split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/)
    const word = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped(chat.name).replace(/ /g, "\\s+")})(?![\\p{L}\\p{N}])`, "iu")
    let done = false
    out = parts.map((part, i) => {
      if (done || i % 2 === 1) return part
      const m = word.exec(part)
      if (!m) return part
      done = true
      const start = m.index + m[1].length
      return `${part.slice(0, start)}[${m[2]}](chat:${chat.id})${part.slice(start + m[2].length)}`
    }).join("")
  }
  return out
}
