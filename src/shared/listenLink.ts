// Listen's way to the app and back on iPhone and iPad, without waiting for the extension's native side (2.7, the owner
// on TestFlight 107: Listen asked about notifications that were on, opened the app, and the app said «This text is no
// longer here. Tap Listen in Safari again.», round and round).
//
// The text used to reach the app only through a native message (the App Group), sent as the link was followed, and
// whether notifications are on came the same way. Safari hands the extension's native messages over one by one, so
// behind a long one (the chats' sync with iCloud after a reinstall, a note's picture) the text arrived after Safari had
// been put to sleep by the app opening, and the answer about notifications timed out and was read as «off».
//
// Now the link itself carries the text (when it fits a link), and the app sends the person back with a mark in the
// page's address (`#cf-listen=<id>`, as `#cf-chat` does), so neither way waits on a native message.

/** What Listen reads (useListen's ListenWhat). */
export interface ListenLinkItem {
  text: string
  what: "answer" | "page"
  lang: string
  title: string
  url: string
}

/** A link longer than this goes without the text (the app then waits for the native message, as before). */
export const LISTEN_LINK_MAX = 96_000
const TEXT_MAX = 24_000

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** UTF-8 bytes as base64url without padding (a third shorter in a link than percent-encoding Cyrillic or CJK). */
export function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += B64[c & 63]
  }
  return out
}

/**
 * The link Listen follows in its tap: `contextflow://listen?id=…` (the app plays it) or
 * `contextflow://notifications?listen=…` (the app asks about notifications first). With the text and what it is, so the
 * app has it whether or not the native message got there: `w` (a: an answer, p: a page), `l` the language, `n` the
 * title, `u` the page, `t` the text (base64url of its UTF-8).
 */
export function listenLink(to: "listen" | "notifications", id: string, item: ListenLinkItem, max = LISTEN_LINK_MAX): string {
  const head = to === "listen" ? `contextflow://listen?id=${encodeURIComponent(id)}` : `contextflow://notifications?listen=${encodeURIComponent(id)}`
  const about = `&w=${item.what === "page" ? "p" : "a"}&l=${encodeURIComponent(item.lang.slice(0, 16))}&n=${encodeURIComponent(item.title.slice(0, 200))}`
    + (/^https?:\/\//.test(item.url) ? `&u=${encodeURIComponent(item.url.slice(0, 2000))}` : "")
  const link = `${head}${about}&t=${base64Url(item.text.slice(0, TEXT_MAX))}`
  return link.length <= max ? link : `${head}${about}`
}

const ID = "[0-9A-Fa-f-]{8,64}"
const MARK = new RegExp(`(^#|&)cf-listen=(${ID})(?=&|$)`)

/**
 * The text the app sent the person back to Safari for, from the page's address fragment (`#cf-listen=<id>`:
 * notifications were just turned on there, the panel plays it). Returns its id and the fragment without the mark (the
 * page's own fragment, if any, stays); null when the address has none.
 */
export function listenMark(hash: string): { id: string; rest: string } | null {
  const found = MARK.exec(hash)
  if (!found) return null
  const rest = hash.replace(MARK, (_m, lead: string) => (lead === "#" ? "#" : "")).replace(/^#&/, "#")
  return { id: found[2].toLowerCase(), rest: rest === "#" ? "" : rest }
}

/** What an answer about notifications says: on, off, or nothing (no answer in time, or one that isn't known). */
export function notifyAnswer(status: string | null | undefined): boolean | null {
  if (status === "authorized" || status === "provisional" || status === "ephemeral") return true
  if (status === "denied" || status === "notDetermined") return false
  return null
}
