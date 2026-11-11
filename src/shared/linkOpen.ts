// A page opened from a link in a chat opens with the panel on that chat, at the message the link was in (2.6 (98), the
// owner: «Если новая страница открывается по клику/тапу в расширении или приложении - надо чтобы сайдбар открывался там
// сразу и на том чате и месте, где кликнули на страницу»). Find similar's notification did it first (build 95,
// `#cf-similar=<chat>`); now every link does:
// - from the panel, nothing is added to the page's address: the panel notes which chat and message the link was in
//   (LINK_OPEN_KEY), and the page that opens from it takes the note (takesLinkOpen); a tab that already shows the page
//   is told at once;
// - from the app (Safari is another app), the address carries `#cf-chat=<chat>&cf-at=<message>`, which the panel takes
//   out at once (takeChatMark); a page with an address fragment of its own keeps it, and the next panel asked opens it.

import { urlKey, type Entry } from "./conversation.ts"

/** Where the panel notes the link last opened from a chat (chrome.storage.local). */
export const LINK_OPEN_KEY = "cf:linkOpen"

/** A link opened from a chat: its page (by address and by site), the chat, and the message it was in. */
export interface LinkOpen {
  key: string
  host: string
  chat: string
  at?: string
  t: number
}

/** A page's site without "www." ("" for an address that isn't one). */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

/** The note for a link to `href` in `chat` (`at`: its message, messageAt's form); null for an address that isn't a page. */
export function linkOpen(href: string, chat: string, at: string | undefined, now: number): LinkOpen | null {
  if (!/^https?:\/\//i.test(href) || !chat) return null
  return { key: urlKey(href), host: hostOf(href), chat, ...(at ? { at } : {}), t: now }
}

// The page the link named, a while after; the same site a short while after (a link through a redirect).
const SAME_PAGE_MS = 120_000
const SAME_SITE_MS = 30_000

/** Whether the page at `href` is the one a noted link opened (the note is taken once, by the first such page). */
export function takesLinkOpen(note: LinkOpen | null | undefined, href: string, now: number): boolean {
  if (!note || now < note.t) return false
  if (urlKey(href) === note.key) return now - note.t <= SAME_PAGE_MS
  return Boolean(note.host) && hostOf(href) === note.host && now - note.t <= SAME_SITE_MS
}

/** A message's place, as a link carries it: its id, else its index ("i3"). */
export function messageRef(entries: Entry[], index: number): string | undefined {
  const entry = entries[index]
  if (!entry) return undefined
  return entry.id ?? `i${index}`
}

/** The message a link's `at` names, by its id or index; undefined when the chat has no such message. */
export function messageAt(entries: Entry[], at: string | undefined): number | undefined {
  if (!at) return undefined
  const byId = entries.findIndex((e) => e.id === at)
  if (byId >= 0) return byId
  const index = /^i(\d{1,5})$/.exec(at)
  return index && Number(index[1]) < entries.length ? Number(index[1]) : undefined
}

const CHAT = "[A-Za-z0-9_-]{1,80}"
const MARK = new RegExp(`(^#|&)(cf-similar|cf-chat|cf-at)=(${CHAT})(?=&|$)`, "g")

/**
 * The chat (and message) the app asked the panel to open, from the page's address fragment: `#cf-chat=<chat>&cf-at=<at>`
 * (2.6 (98), any link in the app), or `#cf-similar=<chat>` (Find similar's notification, build 95). Returns them and the
 * fragment without them (the page's own fragment, if any, stays); null when the address has none.
 */
export function chatMark(hash: string): { chat: string; at?: string; similar: boolean; rest: string } | null {
  const found: Record<string, string> = {}
  const rest = hash.replace(MARK, (_m, lead: string, name: string, value: string) => {
    found[name] = value
    return lead === "#" ? "#" : ""
  }).replace(/^#&/, "#")
  const chat = found["cf-chat"] ?? found["cf-similar"]
  if (!chat) return null
  return { chat, ...(found["cf-at"] ? { at: found["cf-at"] } : {}), similar: !found["cf-chat"], rest: rest === "#" ? "" : rest }
}
