// «Подходящий чат при открытии панели» (2.7, plan section 4): the ✦ circle or Safari's toolbar button opens the panel
// on the chat that fits this page, inside the space it's in (spaces.ts):
//   1. a chat with this page;
//   2. else a chat on the page's topic at 85 % or more, as chat merging asks (OrganizeConfig.mergeTopic): in Free by
//      the words of the page's title on this device; in Pro with organizing on, by meaning (the background, under the
//      organizing consent: the title goes to our server for its vector and isn't kept);
//   3. a chat on this site only when it's about that site alone (on amazon.com or youtube.com topics differ) and about
//      this page too, at SITE_MATCH or more: one product's docs continue their chat, an unrelated article on the same
//      news site or another product in the same shop doesn't (the director on #172);
//   4. else a new chat, with this page's quick actions.
// A thin line over it says «Продолжаю «…» · Новый чат»: one tap if it guessed wrong.

import { urlKey } from "./conversation.ts"
import { unaccent } from "./fold.ts"
import { boundSpace, currentSpace, hasSpaces, siteKey, spaceOfChat, type SpaceList } from "./spaces.ts"
import { activity, chatForPage, liveThreads, threadName, threadPages, type ActiveThread, type Thread, type Threads } from "./threads.ts"

/** Why the panel opened on a chat: its page, its topic (by words, or by meaning), its site; "new": none fitted. */
export type MatchWhy = "page" | "topic" | "meaning" | "site" | "new"

export interface ChatMatch {
  // The chat to open (null: a new one).
  chat: string | null
  space: string
  // The panel went into the site's bound space (spaces.ts pageChatPlace).
  bound: boolean
  why: MatchWhy
  // A topic's match, %.
  match?: number
}

/** The same threshold as merging chats on one topic (OrganizeConfig.mergeTopic, the owner's 85). */
export const MATCH_TOPIC = 85

/** Rule 3: a same-site chat continues only from this much in common with the page, % (below the topic's 85). */
export const SITE_MATCH = 60

// A title's own words only: what a site adds after a separator ("… – Booking.com", "… | YouTube") goes.
const SEPARATOR = /\s+[-–—|·•:]\s+/
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * A page title without its site's name: the last part after a separator goes ("… – Booking.com", "Errors | Paystack API
 * Reference"). The longest part was kept before (#172 review): a long site name then stood for the page, and every page
 * of that site matched by topic.
 */
export function titleTopic(title: string): string {
  const parts = title.split(SEPARATOR).map((x) => x.trim()).filter(Boolean)
  return (parts.length > 1 ? parts.slice(0, -1) : parts).join(" ")
}

/**
 * The words a text is about, folded (case and accents off): letters and digits in runs of 3 or more, no bare numbers;
 * Chinese, Japanese and Korean by pairs of characters (they don't put spaces between words).
 */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const run of unaccent(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (DENSE.test(run)) {
      const chars = [...run]
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
      continue
    }
    if (run.length >= 3 && !/^\d+$/.test(run)) out.add(run)
  }
  return out
}

/** What a chat is about in words: its name, its pages' titles and its questions (not the answers: too many words). */
function chatWords(chat: Thread): Set<string> {
  const texts = [threadName(chat), ...threadPages(chat.m).map((p) => titleTopic(p.title)), ...chat.m.filter((e) => e.role === "user").map((e) => e.content)]
  const out = new Set<string>()
  for (const text of texts) for (const w of topicWords(text)) out.add(w)
  return out
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
  for (const w of words) if (has.has(w)) found++
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
  if (![...own].some((w) => has.has(w))) return 0
  let found = 0
  for (const w of words) if (has.has(w)) found++
  return Math.round((found / words.size) * 100)
}

/** The background's answer by meaning (Pro with organizing on): each chat at SITE_MATCH or more, and the topic's threshold. */
export interface MeaningMatches {
  matches: Array<{ chat: string; match: number }>
  topic: number
}

/** The chats one page may open on: live, about pages (not "Ask your chats"), in `space` when there are spaces. */
export function matchable(threads: Threads, list: SpaceList, space: string, on: boolean): Thread[] {
  const spaced = on && hasSpaces(list)
  return liveThreads(threads).filter((t) => t.kind !== "history" && t.m.length > 0 && (!spaced || spaceOfChat(list, t) === space))
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
  const bound = spaced ? boundSpace(list, siteKey(href)) : null
  const space = bound ?? here
  const switched = space !== here
  const chats = matchable(threads, list, space, on)
  const ids = new Set(chats.map((t) => t.id))
  // 1. This page.
  const page = chatForPage(threads, href, (t) => ids.has(t.id))
  const site = siteKey(href)
  // chatForPage gives a site's chat too: here only one with this very page counts (rule 3 below for the site).
  if (page && chats.find((t) => t.id === page)!.m.some((e) => e.page && urlKey(e.page.url) === urlKey(href))) return { chat: page, space, bound: switched, why: "page" }
  // 2. The topic: by meaning when the background was asked (Pro with organizing on: its answer, at the merge threshold,
  // or null for none); else (Free, or no answer in time) by the title's words.
  const sensed = meaning?.matches.find((m) => ids.has(m.chat) && m.match >= meaning.topic)
  if (sensed) return { chat: sensed.chat, space, bound: switched, why: "meaning", match: sensed.match }
  let best: { chat: Thread; match: number } | null = null
  for (const chat of meaning === undefined ? chats : []) {
    const match = wordMatch(title, chat)
    if (match >= MATCH_TOPIC && (!best || match > best.match || (match === best.match && activity(chat) > activity(best.chat)))) best = { chat, match }
  }
  if (best) return { chat: best.chat.id, space, bound: switched, why: "topic", match: best.match }
  // 3. The site, when the chat is about it alone and about this page too, by words or by meaning (the best such chat;
  // the latest of equals).
  let near: { chat: Thread; match: number } | null = null
  for (const chat of chats) {
    if (!aboutSiteAlone(chat, site)) continue
    const match = Math.max(siteMatch(title, href, chat), meaning?.matches.find((m) => m.chat === chat.id)?.match ?? 0)
    if (match >= SITE_MATCH && (!near || match > near.match || (match === near.match && activity(chat) > activity(near.chat)))) near = { chat, match }
  }
  if (near) return { chat: near.chat.id, space, bound: switched, why: "site", match: near.match }
  // 4. A new chat (the one open stays when it's new and empty: nothing to start again).
  return { chat: shown ? null : active.id, space, bound: switched, why: "new" }
}

