// «Подходящий чат при открытии панели» (2.7, plan section 4): the ✦ circle or Safari's toolbar button opens the panel
// on the chat that fits this page, inside the space it's in (spaces.ts):
//   1. a chat with this page;
//   2. else a chat on the page's topic at 85 % or more, as chat merging asks (OrganizeConfig.mergeTopic): in Free by
//      the words of the page's title on this device; in Pro with organizing on, by meaning (the background, under the
//      organizing consent: the title goes to our server for its vector and isn't kept);
//   3. a chat on this site only when it's about that site alone (on amazon.com or youtube.com topics differ);
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

// A title's own words only: what a site adds after a separator ("… – Booking.com", "… | YouTube") goes.
const SEPARATOR = /\s+[-–—|·•:]\s+/
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** A page title without its site's name: the longest part between separators. */
export function titleTopic(title: string): string {
  const parts = title.split(SEPARATOR).map((x) => x.trim()).filter(Boolean)
  return parts.sort((a, b) => b.length - a.length)[0] ?? ""
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

/** The chats one page may open on: live, about pages (not "Ask your chats"), in `space` when there are spaces. */
export function matchable(threads: Threads, list: SpaceList, space: string, on: boolean): Thread[] {
  const spaced = on && hasSpaces(list)
  return liveThreads(threads).filter((t) => t.kind !== "history" && t.m.length > 0 && (!spaced || spaceOfChat(list, t) === space))
}

/**
 * Where the panel opens on a page from the circle or the toolbar button (the rules above). `meaning`: the background's
 * answer by meaning (Pro with organizing on: a chat, or null for none); undefined when it wasn't asked or didn't answer
 * in time (the title's words then). `title`: the page's title.
 */
export function matchChat(
  threads: Threads,
  active: ActiveThread,
  href: string,
  title: string,
  list: SpaceList,
  on: boolean,
  meaning?: { chat: string; match: number } | null
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
  if (meaning && ids.has(meaning.chat)) return { chat: meaning.chat, space, bound: switched, why: "meaning", match: meaning.match }
  let best: { chat: Thread; match: number } | null = null
  for (const chat of meaning === undefined ? chats : []) {
    const match = wordMatch(title, chat)
    if (match >= MATCH_TOPIC && (!best || match > best.match || (match === best.match && activity(chat) > activity(best.chat)))) best = { chat, match }
  }
  if (best) return { chat: best.chat.id, space, bound: switched, why: "topic", match: best.match }
  // 3. The site, when the chat is about it alone (the latest such chat).
  const alone = chats.filter((t) => aboutSiteAlone(t, site)).sort((a, b) => activity(b) - activity(a))[0]
  if (alone) return { chat: alone.id, space, bound: switched, why: "site" }
  // 4. A new chat (the one open stays when it's new and empty: nothing to start again).
  return { chat: shown ? null : active.id, space, bound: switched, why: "new" }
}

