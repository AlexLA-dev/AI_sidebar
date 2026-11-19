// «Подходящий чат при открытии панели» (2.7, plan section 4): the ✦ circle or Safari's toolbar button opens the panel
// on the chat that fits this page, in whichever space it is (spaces.ts; 107, the owner: a page's chat in another space
// opened nothing until he switched there by hand), the space the panel is in first at each step, a site's bound space
// alone ("Open this site here" wins):
//   1. a chat with this page;
//   2. else a chat on the page's topic at 85 % or more, as chat merging asks (OrganizeConfig.mergeTopic): in Free by
//      the words of the page's title on this device; in Pro with organizing on, by meaning (the background, under the
//      organizing consent: the title goes to our server for its vector and isn't kept);
//   3. a chat on this site only when it's about that site alone (on amazon.com or youtube.com topics differ) and about
//      this page too, at SITE_MATCH or more: one product's docs continue their chat, an unrelated article on the same
//      news site or another product in the same shop doesn't (the director on #172);
//   4. else a new chat, with this page's quick actions.
// A thin line over it says «Продолжаю «…» · Новый чат»: one tap if it guessed wrong. A chat in another space takes the
// panel there: the line names that space and has «← <the space it was in>» instead (a new chat back there).

import { urlKey } from "./conversation.ts"
import { boundSpace, currentSpace, hasSpaces, siteKey, spaceOfChat, type SpaceList } from "./spaces.ts"
import { activity, liveThreads, threadName, threadPages, type ActiveThread, type Thread, type Threads } from "./threads.ts"
import { topicWords } from "./words.ts"

// The words a title is about (words.ts): this module's callers and tests take them from here.
export { topicWords }

/** Why the panel opened on a chat: its page, its topic (by words, or by meaning), its site; "new": none fitted. */
export type MatchWhy = "page" | "topic" | "meaning" | "site" | "new"

export interface ChatMatch {
  // The chat to open (null: a new one).
  chat: string | null
  space: string
  // The panel went into the site's bound space (spaces.ts pageChatPlace).
  bound: boolean
  // 107: the chat is in another space than the panel was in, and the panel went there: the space it was in (the line's
  // way back). Not for a bound site's switch.
  from?: string
  why: MatchWhy
  // A topic's match, %.
  match?: number
}

/** The same threshold as merging chats on one topic (OrganizeConfig.mergeTopic, the owner's 85). */
export const MATCH_TOPIC = 85

/** Rule 3: a same-site chat continues only from this much in common with the page, % (below the topic's 85). */
export const SITE_MATCH = 60

// A title's own words only: what a site adds after a separator goes: "… – Booking.com", "… | YouTube", and the ones
// written without spaces: «東京の天気｜tenki.jp», "Errors|Paystack", «…_新浪科技» (an underscore only next to Chinese,
// Japanese or Korean: a Latin one is a file's or a code's name, "read_file").
const DENSE = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30FC"
const SEPARATOR = new RegExp(`\\s*[|｜]\\s*|\\s+[-–—·•:]\\s+|(?<=[${DENSE}])\\s*_\\s*|\\s*_\\s*(?=[${DENSE}])`, "u")

/**
 * A page title without its site's name: the last part after a separator goes ("… – Booking.com", "Errors | Paystack API
 * Reference"). The longest part was kept before (#172 review): a long site name then stood for the page, and every page
 * of that site matched by topic.
 */
export function titleTopic(title: string): string {
  const parts = title.split(SEPARATOR).map((x) => x.trim()).filter(Boolean)
  return (parts.length > 1 ? parts.slice(0, -1) : parts).join(" ")
}

/** What a chat is about in words: its name, its pages' titles and its questions (not the answers: too many words). */
function chatWords(chat: Thread): Set<string> {
  const texts = [threadName(chat), ...threadPages(chat.m).map((p) => titleTopic(p.title)), ...chat.m.filter((e) => e.role === "user").map((e) => e.content)]
  const out = new Set<string>()
  for (const text of texts) for (const w of topicWords(text)) out.add(w)
  return out
}

/**
 * One word in two forms (109, the owner didn't see a chat in another space continue): «четырёхдневка» and
 * «четырёхдневку», "компании" and "компания", "works" and "work" are one word to a reader; equal words only made a
 * Russian title's topic 0 % against its own chat. The same start of 4 letters or more, at least 60 % of the longer word,
 * and endings of 3 letters at most past it. Chinese, Japanese and Korean pairs of characters are too short for this:
 * equal only.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i >= 4 && i >= 0.6 * Math.max(a.length, b.length) && a.length - i <= 3 && b.length - i <= 3
}

/** `has` holds `word`, or the same word with another ending (sameWord). */
function hasWord(has: Set<string>, word: string): boolean {
  if (has.has(word)) return true
  if (word.length < 4) return false
  for (const w of has) if (sameWord(w, word)) return true
  return false
}

/**
 * How much of the page title's words a chat has, %: 85 or more is a chat on this topic. A title of fewer than two words
 * says too little to judge (0).
 */
export function wordMatch(title: string, chat: Thread): number {
  const words = topicWords(titleTopic(title))
  if (words.size < 2) return 0
  const has = chatWords(chat)
  let found = 0
  for (const w of words) if (hasWord(has, w)) found++
  return Math.round((found / words.size) * 100)
}

/** A chat about one site alone: every page it was on is on `site` (rule 3). */
export function aboutSiteAlone(chat: Thread, site: string): boolean {
  const pages = threadPages(chat.m)
  return Boolean(site) && pages.length > 0 && pages.every((p) => siteKey(p.url) === site)
}

/** The words of an address's first two path parts, a site's sections ("/docs/api/errors" → docs, api). */
function pathWords(href: string): Set<string> {
  try {
    const parts = new URL(href).pathname.split("/").filter(Boolean).slice(0, 2)
    return topicWords(parts.join(" ").replace(/[-_.+]/g, " "))
  } catch {
    return new Set()
  }
}

/**
 * Rule 3: how much a page on a chat's own site has in common with the chat, %: the page's whole title (its site's or
 * product's name included) and its address's first two parts, against the chat's name, questions, and its pages' titles
 * and addresses. Two pages of one product's docs share its name and section ("… | Paystack API Reference",
 * /docs/api/…); two articles of a news site or two products of a shop share the site's name and little else. At least
 * one word in common must come from the page itself (its title's own part or its section), not the site's name alone:
 * a long site name made unrelated articles 62 % alike. 0 for a page of fewer than two words.
 */
export function siteMatch(title: string, href: string, chat: Thread): number {
  const own = new Set([...topicWords(titleTopic(title)), ...pathWords(href)])
  const words = new Set([...own, ...topicWords(title)])
  if (words.size < 2) return 0
  const has = new Set<string>()
  for (const text of [threadName(chat), ...chat.m.filter((e) => e.role === "user").map((e) => e.content)]) for (const w of topicWords(text)) has.add(w)
  for (const p of threadPages(chat.m)) {
    for (const w of topicWords(p.title)) has.add(w)
    for (const w of pathWords(p.url)) has.add(w)
  }
  if (![...own].some((w) => hasWord(has, w))) return 0
  let found = 0
  for (const w of words) if (hasWord(has, w)) found++
  return Math.round((found / words.size) * 100)
}

/** The background's answer by meaning (Pro with organizing on): each chat at SITE_MATCH or more, and the topic's threshold. */
export interface MeaningMatches {
  matches: Array<{ chat: string; match: number }>
  topic: number
}

/**
 * The chats one page may open on: live, about pages (not "Ask your chats"); in `space` when there are spaces and a space
 * is given (a site's bound space), every space's with null (107).
 */
export function matchable(threads: Threads, list: SpaceList, space: string | null, on: boolean): Thread[] {
  const spaced = on && hasSpaces(list) && space !== null
  return liveThreads(threads).filter((t) => t.kind !== "history" && t.m.length > 0 && (!spaced || spaceOfChat(list, t) === space))
}

/** Where a page's chat is looked for: a site's bound space alone ("Open this site here"), else null (every space). */
export function matchScope(list: SpaceList, href: string, on: boolean): string | null {
  return on && hasSpaces(list) ? boundSpace(list, siteKey(href)) : null
}

/**
 * The best of a rule's candidates: one in `home` (the space the panel is in, or the bound one) before another space's;
 * then the higher match; then the latest.
 */
function best<T extends { chat: Thread; match: number }>(found: T[], home: (chat: Thread) => boolean): T | null {
  let top: T | null = null
  for (const f of found) {
    if (!top) {
      top = f
      continue
    }
    const a = home(f.chat)
    const b = home(top.chat)
    if (a !== b ? a : f.match !== top.match ? f.match > top.match : activity(f.chat) > activity(top.chat)) top = f
  }
  return top
}

/**
 * Where the panel opens on a page from the circle or the toolbar button (the rules above). `meaning`: the background's
 * answer by meaning (Pro with organizing on: the chats it scored, or null for none); undefined when it wasn't asked or
 * didn't answer in time (the title's words then). `title`: the page's title.
 */
export function matchChat(
  threads: Threads,
  active: ActiveThread,
  href: string,
  title: string,
  list: SpaceList,
  on: boolean,
  meaning?: MeaningMatches | null
): ChatMatch {
  const shown = threads[active.id] && !threads[active.id].deleted && threads[active.id].trashed === undefined ? threads[active.id] : undefined
  const here = currentSpace(list, shown, active, on)
  const spaced = on && hasSpaces(list)
  const bound = matchScope(list, href, on)
  const home = bound ?? here
  const switched = home !== here
  const spaceOf = (chat: Thread) => (spaced ? spaceOfChat(list, chat) : home)
  const inHome = (chat: Thread) => spaceOf(chat) === home
  const chats = matchable(threads, list, bound, on)
  const ids = new Set(chats.map((t) => t.id))
  // The chat's space: the panel goes there; from another space than the one it was in, the line says so.
  const at = (chat: Thread, why: MatchWhy, match?: number): ChatMatch => {
    const space = spaceOf(chat)
    return { chat: chat.id, space, bound: switched, ...(space !== home ? { from: home } : {}), why, ...(match !== undefined ? { match } : {}) }
  }
  // 1. This page (a chat with this very page; a site's chat is rule 3's).
  const key = urlKey(href)
  const page = best(chats.filter((t) => threadPages(t.m).some((p) => urlKey(p.url) === key)).map((chat) => ({ chat, match: 100 })), inHome)
  if (page) return at(page.chat, "page")
  // 2. The topic: by meaning when the background was asked (Pro with organizing on: its answer, at the merge threshold,
  // or null for none); else (Free, or no answer in time) by the title's words.
  const byId = new Map(chats.map((t) => [t.id, t]))
  const sensed = best((meaning?.matches ?? []).filter((m) => ids.has(m.chat) && m.match >= meaning!.topic).map((m) => ({ chat: byId.get(m.chat)!, match: m.match })), inHome)
  if (sensed) return at(sensed.chat, "meaning", sensed.match)
  const worded = meaning === undefined ? best(chats.map((chat) => ({ chat, match: wordMatch(title, chat) })).filter((f) => f.match >= MATCH_TOPIC), inHome) : null
  if (worded) return at(worded.chat, "topic", worded.match)
  // 3. The site, when the chat is about it alone and about this page too, by words or by meaning.
  const site = siteKey(href)
  const near = best(
    chats.filter((chat) => aboutSiteAlone(chat, site))
      .map((chat) => ({ chat, match: Math.max(siteMatch(title, href, chat), meaning?.matches.find((m) => m.chat === chat.id)?.match ?? 0) }))
      .filter((f) => f.match >= SITE_MATCH),
    inHome
  )
  if (near) return at(near.chat, "site", near.match)
  // 4. A new chat in the space the panel is in (the one open stays when it's new and empty: nothing to start again).
  return { chat: shown ? null : active.id, space: home, bound: switched, why: "new" }
}
