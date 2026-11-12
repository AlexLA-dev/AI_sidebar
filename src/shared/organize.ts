// Organizing the chats (2.5, Pro, by consent): suggesting a better chat for a page block (or a new one) and
// the user's own tags for an answer or a note. The device keeps a vector (embedding) per message; the server
// (/api/v2/organize) only turns texts into vectors and checks tag candidates, and keeps nothing. The same
// rules are in the app (ContextFlow/Shared (App)/Organize.swift); tests/organize-parity.test.mts checks both
// give the same suggestions. Thresholds come from /api/v2/status, so they can be tuned without a release.

import { entryKey, entryTimes, stripCitations, textKey, type Entry } from "./conversation.ts"
import { activity, namedByUser, pageBlocks, threadName, type OrgState, type PageBlock, type Thread } from "./threads.ts"

/** What decides a suggestion (chat-organize-2.5.md §2); the server sends its own values in /status. */
export interface OrganizeConfig {
  // Move: the block's fit to the other chat (mean of the two best block similarities), the margin over
  // its fit to its own chat, and the fit needed when the other chat has a single block.
  moveT: number
  moveD: number
  moveT1: number
  // Same site: the fit to the one other chat about that site.
  siteT: number
  // Two blocks this alike are on one topic: what "a chat is mostly about this" counts (2.6: moves only make chats
  // more about one thing).
  topicT: number
  // The match shown with a move ("88% match", 2.6 (93)): a block's fit to a chat on a scale people read, 0% at what
  // unrelated chats share (`matchLo`) and 100% at how alike a chat's own messages get (`matchHi`); a move by topic or
  // site is suggested from `minMatch` % only.
  matchLo: number
  matchHi: number
  minMatch: number
  // A new chat: the block fits its own chat less than this, and at least `splitMin` questions or notes stay in it (2.6
  // (95): not blocks — a chat of two pages on two topics never got a new chat).
  splitT: number
  splitMin: number
  // 2.6 (94): the end of a block off its chat's topic (`tailMove`): an exchange's fit to the rest of the chat below
  // `tailQA` by its question and answers (on one page every question carries the page's title, so this alone tells
  // little) and below `tailA` by its answers; two such exchanges whose answers are `tailAlike` go together.
  tailQA: number
  tailA: number
  tailAlike: number
  // 2.6 (96): the block's last exchange is also off when its answer fits the rest of the chat less than `tailRelCap` and
  // no better than it fits the person's other chats on average, plus `tailRelD` (three other chats at least). One
  // person's unrelated chats look alike in their language, so the fixed tailQA/tailA rarely fire there, and a question
  // asked on a chat's page carries that page's title. Such an end only ever gets a new chat. `tailRelCap` 0: off.
  tailRelCap: number
  tailRelD: number
  // 2.6 (95): two chats on a shared page merge when their answers fit each other this well both ways (`mergeFit`).
  mergeA: number
  // 2.6 (100), the owner: whole chats on one topic merge without a shared page too, from this match (by questions and
  // answers, the % shown) and the answers' `mergeTopicA` (never below `mergeA`). 0: only chats on a shared page merge.
  mergeTopic: number
  mergeTopicA: number
  // How many of the chat's last blocks get move suggestions, and of its last answers and notes tag suggestions.
  window: number
  tagWindow: number
  // Tags: the fit to the tag's examples, the margin over messages without it, how alike its examples are,
  // and the judge's confidence; at most `maxTags` per message (one: the best, so the chat stays uncluttered).
  tagT: number
  tagD: number
  // 2.6 (98): a tag on one or two messages so far (just made, or new to these chats): the fit it needs, to its
  // examples alone (no margin over the messages without it: those are the ones it should be offered on).
  tagT1: number
  // The review's S8: a tag's examples must be alike by this much more than two of the person's messages are on average.
  tagCohD: number
  coherence: number
  judge: number
  maxTags: number
  // Refused this many times in a row without one taken: no more such suggestions (in that chat; for that tag).
  rollback: number
  // "Everything in one chat?" (free, on the device): this many sites in the last 5 blocks, or this many
  // blocks. Once per chat at most, never again after ✕, and at least `messHours` apart.
  messSites: number
  messBlocks: number
  messHours: number
}

// Calibrated on a deploy preview (tools/organize/calibrate.mts, 37 chats in en/ru/ko, text-embedding-3-small:256):
// moves 95% right, 1 suggestion in 33 coherent chats; tags 100% right, none of the "later"-like ones.
// 2.6 (96): measured again on 14 people's libraries, one person per shipped language (en, ru, uk, de, fr, es, it,
// pt-BR, ja, ko, zh-Hans, zh-Hant, vi, ar; 98 chats of 7 kinds each, organize-26/b96 outside the repo), by script
// group (Latin, Cyrillic, CJK, Arabic) and with every library holding all 98 chats. Only moveD changed.
export const DEFAULT_ORGANIZE: OrganizeConfig = {
  moveT: 0.55,
  // 2.6 (96): 0.08, not 0.1. An off-topic end of a page block fit its chat by 0.08–0.1 more than the rest of its chat
  // in two of the 14 libraries (Cyrillic and CJK); at 0.08 those two move, and nothing else changes on that set, the
  // 42-chat set (b95) or the 2.5 sample. At 0.05 coherent chats start getting moves as they grow.
  moveD: 0.08,
  moveT1: 0.65,
  siteT: 0.35,
  topicT: 0.4,
  // Calibrated on the 2.5 sample (organize-26/calib93.mjs): unrelated chats' median fit 0.17, a chat's own messages'
  // 95th percentile 0.66. moveT (0.55) is 78% on it; every move by topic there was right and 80% or more, the moves by
  // site it left out were wrong and about 57%.
  matchLo: 0.17,
  matchHi: 0.66,
  minMatch: 75,
  // 2.6 (95), on lib95 and the 2.5 sample (b95/calib-blocks.mjs): a coherent chat's own blocks fit the rest from 0.38 (1
  // of 59 below 0.35, an INP page in a React chat), blocks of other chats below 0.35 in 93% (same language) and 98%.
  // 2.6 (96), the 14 libraries: own blocks from 0.49 in every script group; the same person's other chats' blocks
  // below 0.35 in 44–67% by group (CJK 51%), other people's in 89–96%. 0.3 and 0.4 change no move there.
  splitT: 0.35,
  splitMin: 2,
  // Calibrated on the 2.5 sample with every question of a chat asked on its first page (b94/calib-apart3.mjs): 1 of
  // 99 of the chats' own exchanges off by both, 41% of unrelated exchanges in the same language and 68% in another
  // (the rest mostly near topics); the question+answer fit alone, at splitT, caught 4% in the same language.
  // 2.6 (95), checked again on the whole set (b95/tailgrid95.sh: lib95 as written and with another chat's question asked
  // on each chat's last page, the 2.5 sample both ways): tailQA 0.35 loses 15–25% of the new chats found, 0.45 or 0.5
  // adds needless ones in 1–2 of 33 coherent chats; tailA 0.26 or more pulls a chat's own question along with an
  // unrelated one (26 of 1,056); tailAlike 0.2–0.4 changes nothing. 0.4, 0.22 and 0.3 stay.
  tailQA: 0.4,
  tailA: 0.22,
  tailAlike: 0.3,
  // The point chosen from organize-96-report's trade-off: lib96's "new chat" for an unrelated question 15 → 43 % (lib95
  // 64 → 75 %, the 2.5 sample 69 %), at one more "new chat" for a chat's own generic follow-up in each set and no move
  // to a wrong chat. ORGANIZE_THRESHOLDS can change it, or turn it off with tailRelCap 0.
  tailRelCap: 0.35,
  tailRelD: 0,
  // lib95 and the 2.5 sample (b95/merge-neg.mjs): different topics asked on the same pages 0.51 at most (two plant-care
  // chats), 99% below 0.40; the same topic again 0.45 at least (median 0.56), the lib's merge pairs 0.49–0.72.
  // 2.6 (96), the 14 libraries: the same topic from 75 % at 0.54 (5th percentile of 180); one person's neighbouring topics
  // asked on each other's pages up to 0.53, mostly in Latin and CJK scripts (23 of 135 from 0.45). 0.48 would drop 14 of
  // those but 4 real merges of the 2.5 sample (English and Russian, 0.45–0.47): it stays.
  mergeA: 0.45,
  // 2.6 (100), the owner's 80 (organize-26/b100/topicmerge.mjs: lib96 and three more people, the 2.5 sample without his
  // chats, lib95). Each chat with two pages or more cut where they differ, 98: joined 61 → 80 (75 % 81, 85 % 79, 90 % 75).
  // Chats on different topics merged, one person's neighbouring topics first: 24 pairs (14 neighbouring, 2 a mix and the
  // chat its part is about, 8 others; 75 % 30, 85 % 16, 90 % 12). Of the chats' suggestions as they are, one move gives
  // way to a merge. The answers decide nothing more: their cut at 0.6 drops as many pairs as 90 % does, and more joins.
  mergeTopic: 80,
  mergeTopicA: 0.45,
  window: 3,
  tagWindow: 5,
  tagT: 0.3,
  tagD: 0,
  // 2.6 (98), lib96 (organize-26/b96/tag96.mjs: one person's chat gets its topic's tag on one answer, every other
  // message of the library a target): 0.5 offers it on 63% of the chat's other messages (80% on its page), 26% of a
  // near topic's and 2% of the rest, before the judge. The margin over messages without the tag cut that to 30%.
  // The review's S6 (organize-26/b98r/tag98r.mjs, lib96 and a second Russian, Korean and Italian person): 21–89% of the
  // same topic by person. Mostly the person: Russian 35% and 56%, Italian 89% and 76%. Korean is low for both (30%,
  // 21%): its vectors tell topics apart less (same topic against others 0.15–0.19 against about 0.3; not the texts'
  // length). A cut of its own would be fitted on two people (0.38 and 0.44, 17% and 3% wrong), so it stays 0.5.
  tagT1: 0.5,
  // The review's S8 (organize-26/b98r/coh.mjs): a person's messages are alike by 0.23–0.39 on average by language
  // (lib96), so the flat 0.2 let two unrelated answers with one tag ("later") count as a topic in most languages (73 of
  // 98 such pairs). 0.05 over the person's average keeps all 98 pairs of answers on one topic and 23 of the 98 pairs.
  tagCohD: 0.05,
  coherence: 0.2,
  judge: 0.7,
  maxTags: 1,
  rollback: 3,
  messSites: 3,
  messBlocks: 6,
  messHours: 72
}

/** Thresholds as received (the server's, or a stored copy): known numbers only, the rest from the defaults. */
export function organizeConfig(raw: unknown): OrganizeConfig {
  const out = { ...DEFAULT_ORGANIZE }
  if (!raw || typeof raw !== "object") return out
  for (const key of Object.keys(out) as Array<keyof OrganizeConfig>) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000) out[key] = value
  }
  return out
}

// ------------------------------------------------------------ texts and vectors

// A question needs this much text (or a page) to be judged; a note this much. In characters of an alphabet: see `textSize`.
const MIN_QUESTION = 15
const MIN_NOTE = 40
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * How much a text says, in characters of an alphabet (Latin, Cyrillic, Arabic…): dense scripts (Chinese, Japanese,
 * Korean) say as much in about a third of the characters, so each of their characters counts three times.
 */
export function textSize(text: string): number {
  return text.length + (text.match(DENSE)?.length ?? 0) * 2
}
export const MAX_EMBED_CHARS = 1_200

const plain = (text: string) => stripCitations(text).replace(/[*_`#>|]+/g, " ").replace(/\s+/g, " ").trim()

/**
 * What a message is about, as its vector sees it: a question with its page's title (a quick action by its
 * name, not its fixed prompt), the start of an answer, a note with its page's title.
 */
export function embedText(e: Entry): string {
  const title = e.page?.title ? `\n${plain(e.page.title)}` : ""
  let text: string
  if (e.note) text = plain(e.content).slice(0, 1_000) + title
  // 2.6 (95): a Find similar request by what it's about (its selection, its page), not by its condition: "Cheaper" is
  // the same word in every shopping chat, and made blocks about unrelated products look like one topic.
  else if (e.role === "user" && e.similarAsk !== undefined) text = [e.similarSel ? plain(e.similarSel).slice(0, 300) : "", e.page?.title ? plain(e.page.title) : plain(e.label ?? e.content)].filter(Boolean).join("\n")
  else if (e.role === "user") text = (e.label ? plain(e.label) : plain(e.content).slice(0, 600)) + title
  else if (isSimilarList(e.content)) text = similarGist(e.content)
  else text = plain(e.content).slice(0, 800)
  return text.slice(0, MAX_EMBED_CHARS)
}

// A Find similar answer's list (`similarMarkdown`): numbered items that start with a linked name in bold.
const SIMILAR_ITEM = /^\d+\.\s+\*\*\[(.+?)\]\(/

function isSimilarList(text: string): boolean {
  return text.split("\n").filter((l) => SIMILAR_ITEM.test(l.trim())).length >= 2
}

/**
 * 2.6 (95): what a Find similar answer is about: its first line and the names it lists. The rest of each item is the
 * same in every list (the price against the person's one, their country's shops, "Not confirmed"), and made lists of
 * unrelated things alike.
 */
function similarGist(text: string): string {
  const lines = text.split("\n").map((l) => l.trim())
  const first = lines.findIndex((l) => SIMILAR_ITEM.test(l))
  // The line before the list (none: the list only; the note after it is the same in every answer).
  const intro = lines.slice(0, Math.max(0, first)).filter(Boolean).join(" ")
  const names = lines.map((l) => SIMILAR_ITEM.exec(l)?.[1]).filter((x): x is string => Boolean(x))
  return `${plain(intro)}\n${names.map(plain).join("; ")}`.trim()
}

/** The vector space's name ("model:dims"): a vector from another one is never compared. */
export type VectorSpace = string

/** A vector as it travels and is kept: its numbers scaled to −127…127 (int8), base64. */
export function packVector(v: ArrayLike<number>): string {
  let max = 0
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]))
  const bytes = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) bytes[i] = (max ? Math.round((v[i] / max) * 127) : 0) & 0xff
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** A packed vector back, of unit length (null when it isn't one). */
export function unpackVector(packed: string): Float32Array | null {
  let binary: string
  try {
    binary = atob(packed)
  } catch {
    return null
  }
  if (!binary.length) return null
  const v = new Float32Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    const b = binary.charCodeAt(i)
    v[i] = b > 127 ? b - 256 : b
  }
  return unit(v)
}

function unit(v: Float32Array): Float32Array | null {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (!n) return null
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** The mean of the `k` best similarities of `v` to `list`, each times its weight (0 for an empty list). */
function topMean(v: Float32Array, list: Array<{ v: Float32Array; w?: number }>, k: number): number {
  if (!list.length) return 0
  const sims = list.map((x) => dot(v, x.v) * (x.w ?? 1)).sort((a, b) => b - a).slice(0, k)
  return sims.reduce((s, x) => s + x, 0) / sims.length
}

function mean(vectors: Float32Array[]): Float32Array | null {
  if (!vectors.length) return null
  const out = new Float32Array(vectors[0].length)
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i]
  return unit(out)
}

/** The message's vector, if the device has it (by its key and text). */
export type VectorOf = (e: Entry) => Float32Array | null | undefined

// ------------------------------------------------------------ blocks

/** A page block with what the rules need: its vector, whether it says enough, its time and site. */
export interface ScoredBlock extends PageBlock {
  v: Float32Array | null
  // 2.6 (95): its answers' vector (its messages' without answers): what it's about apart from the page's title, which
  // every question on that page carries.
  a: Float32Array | null
  weak: boolean
  t: number | null
  host: string
  // Someone already decided about it: it was moved here, or a move was turned down.
  settled: boolean
  dismissed: boolean
}

export function hostOf(url: string | null): string {
  if (!url) return ""
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

// A chat's scored blocks, kept per message list and vector reader: the chats list's counts score every chat once, not
// once per other chat (2.6 (91): that was the app's hang). Message lists are never changed in place.
const scoredCache = new WeakMap<VectorOf, WeakMap<Entry[], ScoredBlock[]>>()

export function scoredBlocks(entries: Entry[], vectorOf: VectorOf): ScoredBlock[] {
  let byList = scoredCache.get(vectorOf)
  if (!byList) scoredCache.set(vectorOf, (byList = new WeakMap()))
  const hit = byList.get(entries)
  if (hit) return hit
  const out = scoreBlocks(entries, vectorOf)
  byList.set(entries, out)
  return out
}

function scoreBlocks(entries: Entry[], vectorOf: VectorOf): ScoredBlock[] {
  const times = entryTimes(entries)
  return pageBlocks(entries).map((b) => scored(entries, times, b, vectorOf))
}

/** Messages `b.start`…`b.end` scored as a block. */
function scored(entries: Entry[], times: Array<number | null>, b: PageBlock, vectorOf: VectorOf): ScoredBlock {
  const list = entries.slice(b.start, b.end + 1)
  let signal = 0
  for (const e of list) if (e.role === "user") signal += textSize(plain(e.label ?? e.content)) + (e.page?.title ? MIN_QUESTION : 0)
  const notesOnly = list.every((e) => e.note)
  const vectors = list.map((e) => vectorOf(e)).filter((v): v is Float32Array => Boolean(v))
  const answers = list.filter((e) => e.role === "assistant").map((e) => vectorOf(e)).filter((v): v is Float32Array => Boolean(v))
  return {
    ...b,
    v: mean(vectors),
    a: mean(answers.length ? answers : vectors),
    weak: signal < (notesOnly ? MIN_NOTE : MIN_QUESTION),
    t: times[b.start],
    host: hostOf(b.url),
    settled: list.some((e) => e.from),
    dismissed: list.some((e) => e.dismissed?.move)
  }
}

/** 2.6 (94): a block's exchanges — each question or note with the answers after it — scored like blocks, on its page. */
export function exchangesOf(entries: Entry[], b: PageBlock, vectorOf: VectorOf): ScoredBlock[] {
  const ranges: PageBlock[] = []
  for (let i = b.start; i <= b.end; i++) {
    if (entries[i].role === "user" || !ranges.length) ranges.push({ start: i, end: i, url: b.url })
    else ranges[ranges.length - 1].end = i
  }
  const times = entryTimes(entries)
  return ranges.map((x) => scored(entries, times, x, vectorOf))
}

// ------------------------------------------------------------ moves

export interface MoveSuggestion {
  // The messages to move (a block, or several in a row), shown under the last one.
  start: number
  end: number
  // The chat to move them to; null: a new chat.
  to: string | null
  // Why: the whole chat joins a newer one on its topic and pages (2.6 (94)), the same page is in that chat, the same
  // site, the same topic, or none fits (a new chat).
  why: "merge" | "page" | "site" | "topic" | "apart"
  score: number
  current: number
  // How well it fits there, in % (matchPercent), for a merge or a move by topic or by site (a page needs none).
  match?: number
  // 2.6 (95): the other way round, an older chat joins this one whole (`to` is this chat; shown under message `end`).
  // People work in the newer chat: a merge shown only in the older one goes unseen.
  from?: string
  // 2.6 (100): a merge of chats on one topic without a shared page (`mergeTopic`): the suggestion says so.
  topic?: true
}

/** A block's fit to a chat as people read it: 0–100 %, 0 at what unrelated chats share, 100 at a chat's own messages. */
export function matchPercent(score: number, cfg: OrganizeConfig): number {
  const span = cfg.matchHi - cfg.matchLo
  if (!(span > 0)) return 0
  return Math.max(0, Math.min(100, Math.round(((score - cfg.matchLo) / span) * 100)))
}

const RANK = { merge: 0, page: 1, site: 2, topic: 3, apart: 4 } as const

/** True while move suggestions stay on in this chat: fewer than `rollback` refused since the last one taken. */
// When a move out of each chat was last taken, per list of chats (read once for all of them).
const takenCache = new WeakMap<Thread[], Map<string, number>>()

export function movesAllowed(chat: Thread, all: Thread[], cfg: OrganizeConfig): boolean {
  let takenOf = takenCache.get(all)
  if (!takenOf) {
    takenOf = new Map()
    for (const t of all) for (const e of t.m) if (e.from) takenOf.set(e.from.chat, Math.max(takenOf.get(e.from.chat) ?? -Infinity, e.from.at))
    takenCache.set(all, takenOf)
  }
  const taken = takenOf.get(chat.id) ?? -Infinity
  const times = entryTimes(chat.m)
  let refused = 0
  for (const b of pageBlocks(chat.m)) {
    if (!chat.m.slice(b.start, b.end + 1).some((e) => e.dismissed?.move)) continue
    if ((times[b.start] ?? 0) > taken) refused++
  }
  return refused < cfg.rollback
}

/**
 * The one move to suggest in `chat` now (or null): of its last `window` blocks, those nobody decided about yet are
 * checked — first whether the same page is in another chat (no vectors needed; a short note or question will do),
 * then, for those that say enough, the same site, then the topic; a block that fits no chat and not its own goes to
 * a new chat. Blocks in a row with the same place are one suggestion. The strongest reason wins.
 *
 * A move only makes chats more about one thing (2.6): a block leaves its chat when it's off that chat's topic, for a
 * chat mostly about it. A chat of one block (a note on a page, a single question) joins another chat mostly about
 * it; of two such chats, the smaller joins the larger. Two chats never suggest moves into each other.
 *
 * 2.6 (94): first, the whole chat may join a newer chat on its topic and pages (`mergeFit`); last, when no block goes
 * anywhere, the end of a block off the chat's topic (`tailMove`).
 */
export function suggestMove(chat: Thread, chats: Thread[], vectorOf: VectorOf, cfg: OrganizeConfig): MoveSuggestion | null {
  if (chat.kind === "history" || chat.deleted) return null
  const blocks = scoredBlocks(chat.m, vectorOf)
  if (!blocks.length || !movesAllowed(chat, chats, cfg)) return null
  const others = chats
    .filter((t) => t.id !== chat.id && !t.deleted && t.kind !== "history" && t.m.length > 0)
    .map((t) => ({ thread: t, blocks: scoredBlocks(t.m, vectorOf) }))
  let merge: { to: string; from?: string; score: number; match: number; topic?: true } | null = null
  for (const o of others) {
    const out = mergeFit({ thread: chat, blocks }, o, cfg)
    if (out && (!merge || out.score > merge.score)) merge = { to: o.thread.id, ...out }
    const into = mergeFit(o, { thread: chat, blocks }, cfg)
    if (into && (!merge || into.score > merge.score)) merge = { to: chat.id, from: o.thread.id, ...into }
  }
  if (merge?.from) {
    const last = chat.m.length - 1
    return { start: last, end: last, to: chat.id, from: merge.from, why: "merge", score: merge.score, current: 0, match: merge.match, ...(merge.topic ? { topic: true as const } : {}) }
  }
  if (merge) return { start: 0, end: chat.m.length - 1, to: merge.to, why: "merge", score: merge.score, current: 0, match: merge.match, ...(merge.topic ? { topic: true as const } : {}) }
  const first = Math.max(0, blocks.length - cfg.window)
  const found: Array<MoveSuggestion & { index: number }> = []
  for (let i = first; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.settled || b.dismissed) continue
    const rest = blocks.filter((_, j) => j !== i)
    const pick = movePlace(chat, b, i, blocks, rest, others, cfg)
    if (pick) found.push({ ...pick, start: b.start, end: b.end, index: i })
  }
  // Blocks in a row going to the same chat (or, for a new chat, alike) are moved together.
  const groups: Array<MoveSuggestion & { index: number }> = []
  for (const s of found) {
    const last = groups[groups.length - 1]
    const together = last && last.index + 1 === s.index && last.to === s.to && last.why === s.why &&
      (s.to !== null || (blocks[last.index].v && blocks[s.index].v && dot(blocks[last.index].v!, blocks[s.index].v!) >= cfg.moveT))
    if (together) {
      groups[groups.length - 1] = {
        ...last, end: s.end, index: s.index, score: Math.max(last.score, s.score), current: Math.min(last.current, s.current),
        ...(last.match !== undefined || s.match !== undefined ? { match: Math.max(last.match ?? 0, s.match ?? 0) } : {})
      }
    } else groups.push(s)
  }
  // A new chat for part of the chat, not everything: `splitMin` questions or notes stay.
  const best = groups
    .filter((g) => g.to !== null || asksOutside(chat.m, g.start, g.end) >= cfg.splitMin)
    .sort((a, b) => RANK[a.why] - RANK[b.why] || (b.score - b.current) - (a.score - a.current) || b.end - a.end)[0]
  if (!best) return tailMove(chat, blocks, others, vectorOf, cfg)
  const { index, ...suggestion } = best
  // 2.6 (95): a block whose start is on the chat's topic and whose end isn't: only its end goes (a question on another
  // topic asked on a page the chat had one question on took that question along).
  if ((best.why === "apart" || best.why === "topic") && blocks[index].start === best.start) {
    const end = tailMove(chat, blocks, others, vectorOf, cfg, index)
    if (end && end.start > best.start) return end
  }
  return suggestion
}

/**
 * The fit the end of a block needs to go to chat `o` (its `blocks` vectors): `moveT`, or `moveT1` for a chat of a single
 * question or note (2.6 (95): not a single block — several questions on one page are a chat on that topic). A whole
 * block keeps `moveT1` for a chat of one block: with `moveT` there, chats on near topics got moves (lib95: two trips,
 * sleep and coffee).
 */
function enough(o: { thread: Thread }, blocks: number, cfg: OrganizeConfig): number {
  return blocks >= 2 || o.thread.m.filter((e) => e.role === "user").length >= 2 ? cfg.moveT : cfg.moveT1
}

/** How many questions and notes of `entries` are outside `start`…`end`: what stays after a move of them. */
function asksOutside(entries: Entry[], start: number, end: number): number {
  let n = 0
  entries.forEach((e, i) => { if (e.role === "user" && (i < start || i > end)) n++ })
  return n
}

/** When a chat was started: its first message's time (else its last activity). */
function startedAt(t: Thread): number {
  return entryTimes(t.m).find((x): x is number => x !== null) ?? activity(t)
}

/** Of two chats, the newer one: started later, then written in last, then by id. */
function newer(a: Thread, b: Thread): boolean {
  if (startedAt(a) !== startedAt(b)) return startedAt(a) > startedAt(b)
  if (activity(a) !== activity(b)) return activity(a) > activity(b)
  return a.id > b.id
}

/**
 * 2.6 (94): whether chat `from` joins `to` whole (chats on one topic and the same pages become one, the older joining
 * the newer, the messages by time), and how well it fits there: `to` is newer, `from` has
 * a page `to` has too, nothing in `from` was turned down or moved in, `from`'s blocks fit `to` from `minMatch` % on
 * average and `to`'s fit `from` as well (the topic: the pages alone don't say it), and that merge wasn't turned down
 * (`org.mx`). The move puts the messages in by time.
 * 2.6 (95): one shared page is enough (an old and a new chat on a topic usually share one page of a few), and `to` may
 * be one block; a chat of notes only still gets joined the other way (`joins`, 2.6 (91)). The answers must fit too: on a
 * shared page the questions' vectors are mostly the page's title. The match shown is by questions and answers, like
 * every move's, so a merge needs `minMatch` % by them as well.
 * 2.6 (100), the owner: «если тематика, контекст довольно сильно пересекаются (как я до этого писал - 80%+)». Without a
 * shared page the chats merge from `mergeTopic` % (0: never), the other rules as they are; the suggestion says it's the
 * same topic (`topic`).
 */
function mergeFit(from: { thread: Thread; blocks: ScoredBlock[] }, to: { thread: Thread; blocks: ScoredBlock[] }, cfg: OrganizeConfig): { score: number; match: number; topic?: true } | null {
  // The cheap checks first: every pair of chats is checked when the list counts.
  const page = from.blocks.some((b) => b.url && to.blocks.some((x) => x.url === b.url))
  if (!page && !(cfg.mergeTopic > 0)) return null
  if (to.thread.m.every((e) => e.note)) return null
  if (from.blocks.some((b) => b.settled || b.dismissed) || (from.thread.org?.mx ?? []).includes(to.thread.id) || !newer(to.thread, from.thread)) return null
  const mine = from.blocks.filter((b) => b.v)
  const theirs = to.blocks.filter((b) => b.v)
  if (!mine.length || !theirs.length) return null
  // By topic, never a larger chat into a newer chat of one block: that one joins the larger by the move rules (the
  // smaller into the larger), not the other way round.
  if (!page && to.blocks.length < 2 && from.thread.m.length > to.thread.m.length) return null
  // Both ways: one chat on a topic and a pile that has it too aren't one chat.
  const fit = (a: ScoredBlock[], b: ScoredBlock[], by: "v" | "a") => a.reduce((s, x) => s + topMean(x[by]!, b.map((y) => ({ v: y[by]! })), 2), 0) / a.length
  // 2.6 (95): decided by the answers. On shared pages the questions' vectors are mostly the page's title: a monitor
  // chat asked on an espresso machine's page fit that chat 100 % by questions and answers, 0.2 by answers.
  if (Math.min(fit(mine, theirs, "a"), fit(theirs, mine, "a")) < (page ? cfg.mergeA : Math.max(cfg.mergeA, cfg.mergeTopicA))) return null
  const score = Math.min(fit(mine, theirs, "v"), fit(theirs, mine, "v"))
  const match = matchPercent(score, cfg)
  if (!page) return match >= cfg.mergeTopic && match >= cfg.minMatch ? { score, match, topic: true } : null
  return match >= cfg.minMatch ? { score, match } : null
}

/** The engine's version, sent with a scan's numbers (2.6 (98)). */
export const ORGANIZE_ENGINE = 98

/**
 * 2.6 (98): what a scan of a chat compared and why nothing fired — numbers and named reasons only, for the diagnostic
 * event (no text, no names): the chats and the share of messages with vectors; the closest other chat to merge with
 * (its match by questions and answers both ways, its answers' fit ×100, and the first rule it stopped at); the
 * strongest block to move anywhere in the chat (its match, and the first rule it stopped at); what fired; the
 * thresholds' key.
 */
export interface OrganizeScan {
  chats: number
  msgs: number
  vec: number
  mg: number
  mga: number
  mgw: "none" | "page" | "notes" | "settled" | "refused" | "answers" | "match" | "open"
  mv: number
  mvw: "none" | "window" | "weak" | "settled" | "topic" | "fit" | "margin" | "mix" | "open"
  res: "off" | "none" | MoveSuggestion["why"]
  tv: number
}

/** A key of the thresholds in use (0–9972): their names in order, each value to a thousandth. */
export function thresholdsKey(cfg: OrganizeConfig): number {
  let h = 0
  for (const key of (Object.keys(cfg) as Array<keyof OrganizeConfig>).sort()) h = (h * 31 + Math.round(cfg[key] * 1000)) % 9973
  return (h + 9973) % 9973
}

/** The scan's numbers for chat `chat` among `chats`, with `found` the suggestion it gave (or null). */
export function organizeScan(chat: Thread, chats: Thread[], vectorOf: VectorOf, cfg: OrganizeConfig, found: MoveSuggestion | null): OrganizeScan {
  const live = chats.filter((t) => t.id !== chat.id && !t.deleted && t.kind !== "history" && t.m.length > 0)
  const blocks = scoredBlocks(chat.m, vectorOf)
  const others = live.map((t) => ({ thread: t, blocks: scoredBlocks(t.m, vectorOf) }))
  let all = 0
  let have = 0
  for (const t of [chat, ...live]) for (const e of t.m) {
    if (!embedText(e)) continue
    all++
    if (vectorOf(e)) have++
  }
  // The closest chat to merge with: by questions and answers, both ways (the older one joins the newer).
  const here = { thread: chat, blocks }
  const fit = (a: ScoredBlock[], b: ScoredBlock[], by: "v" | "a") => a.reduce((n, x) => n + topMean(x[by]!, b.map((y) => ({ v: y[by]! })), 2), 0) / a.length
  let merge: { qa: number; a: number; why: OrganizeScan["mgw"] } | null = null
  for (const o of others) {
    const [from, to] = newer(o.thread, chat) ? [here, o] : [o, here]
    const mine = from.blocks.filter((b) => b.v)
    const theirs = to.blocks.filter((b) => b.v)
    if (!mine.length || !theirs.length) continue
    const qa = Math.min(fit(mine, theirs, "v"), fit(theirs, mine, "v"))
    if (merge && qa <= merge.qa) continue
    const a = Math.min(fit(mine, theirs, "a"), fit(theirs, mine, "a"))
    // No shared page: "page" unless they're on one topic from `mergeTopic` % (2.6 (100)).
    const page = from.blocks.some((b) => b.url && to.blocks.some((x) => x.url === b.url))
    const why: OrganizeScan["mgw"] = !page && (!(cfg.mergeTopic > 0) || matchPercent(qa, cfg) < cfg.mergeTopic) ? "page"
      : to.thread.m.every((e) => e.note) ? "notes"
      : from.blocks.some((b) => b.settled || b.dismissed) ? "settled"
      : (from.thread.org?.mx ?? []).includes(to.thread.id) ? "refused"
      : a < (page ? cfg.mergeA : Math.max(cfg.mergeA, cfg.mergeTopicA)) ? "answers"
      : matchPercent(qa, cfg) < cfg.minMatch ? "match"
      : "open"
    merge = { qa, a, why }
  }
  // The strongest block to move, anywhere in the chat, and the first rule it stops at.
  const first = Math.max(0, blocks.length - cfg.window)
  let move: { score: number; why: OrganizeScan["mvw"] } | null = null
  blocks.forEach((b, i) => {
    if (!b.v) return
    const rest = blocks.filter((_, j) => j !== i)
    const outside = blocks.filter((x, j) => j < blocks.length - cfg.window && j !== i && x.v)
    const base = (outside.length ? outside : rest.filter((x) => x.v)).map((x) => ({ v: x.v! }))
    const current = topMean(b.v, base, 2)
    for (const o of others) {
      const vs = o.blocks.filter((x) => x.v).map((x) => ({ v: x.v! }))
      if (!vs.length) continue
      const score = topMean(b.v, vs, 2)
      if (move && score <= move.score) continue
      const why: OrganizeScan["mvw"] = i < first ? "window"
        : b.weak ? "weak"
        : b.settled || b.dismissed ? "settled"
        : rest.length > 0 && shareOn(b, rest, cfg).share >= 0.5 ? "topic"
        : score < (vs.length >= 2 ? cfg.moveT : cfg.moveT1) || matchPercent(score, cfg) < cfg.minMatch ? "fit"
        : score - current < cfg.moveD ? "margin"
        : !goesTo(b, rest, chat, o, cfg) ? "mix"
        : "open"
      move = { score, why }
    }
  })
  return {
    chats: live.length,
    msgs: chat.m.length,
    vec: all ? Math.round((have * 100) / all) : 0,
    mg: merge ? matchPercent(merge.qa, cfg) : 0,
    mga: merge ? Math.max(0, Math.round(merge.a * 100)) : 0,
    mgw: merge?.why ?? "none",
    mv: move ? matchPercent((move as { score: number }).score, cfg) : 0,
    mvw: move ? (move as { why: OrganizeScan["mvw"] }).why : "none",
    res: !movesAllowed(chat, chats, cfg) ? "off" : found ? found.why : "none",
    tv: thresholdsKey(cfg)
  }
}

/**
 * 2.6 (94): the end of a block off its chat's topic — an answer about something else asked on the same page, or in the
 * app (no page), which stays in that page's block (a page block was only ever moved whole). Of the chat's last `window` blocks, the latest first: its longest run of last exchanges (`exchangesOf`) that
 * are each off the rest of the chat, whose answers are `tailAlike` among themselves, with `splitMin` questions or notes
 * staying. Off: below `tailQA` by question and answers and below `tailA` by answers, or (2.6 (95)) its answers fit
 * another chat from `minMatch` % by `moveD` more than the closest of the rest (a question carries its page's title, so
 * a question on another topic asked on that page fits the page's chat by its question; lib95: a monitor question on a
 * robot vacuum's page, 0.49 to its chat by question, 0.33 by answer, 0.78 to a monitors chat). They go to a chat mostly about them from `minMatch` %, else to a new chat when no chat fits them
 * (one that fits but is a mix keeps them from a new chat, as for blocks). Measured on the 2.5 sample with an unrelated
 * exchange asked on a chat's last page (b95/real95.mjs): to its own chat in 936 of 1,056 cases where it has one (672
 * with the absolute signals only), a new chat in 730 of 1,056 where it has none, never to a wrong chat; on lib95 (b95/
 * libpage95.mjs) 365 of 439 to their own chat and 280 of 439 to a new one, 2 elsewhere each.
 */
function tailMove(chat: Thread, blocks: ScoredBlock[], others: Array<{ thread: Thread; blocks: ScoredBlock[] }>, vectorOf: VectorOf, cfg: OrganizeConfig, only?: number): MoveSuggestion | null {
  const first = Math.max(0, blocks.length - cfg.window)
  const vectorsOf = (o: { blocks: ScoredBlock[] }) => o.blocks.filter((y) => y.v).map((y) => ({ v: y.v! }))
  // The other chat a vector fits best, from moveT (moveT1 for a chat of one block) and minMatch; null: none.
  const fitsElsewhere = (v: Float32Array): number | null => {
    let best: number | null = null
    for (const o of others) {
      const vs = vectorsOf(o)
      if (!vs.length) continue
      const score = topMean(v, vs, 2)
      if (score >= (enough(o, vs.length, cfg)) && matchPercent(score, cfg) >= cfg.minMatch && (best === null || score > best)) best = score
    }
    return best
  }
  // 2.6 (96): how well an answer fits the person's chats in general: its mean fit to the other chats' answers.
  const usualFit = (a: Float32Array): number | null => {
    if (!(cfg.tailRelCap > 0)) return null
    const fits = others.map((o) => o.blocks.filter((y) => y.a).map((y) => ({ v: y.a! }))).filter((vs) => vs.length).map((vs) => topMean(a, vs, 2))
    return fits.length >= 3 ? fits.reduce((s, x) => s + x, 0) / fits.length : null
  }
  for (let i = blocks.length - 1; i >= first; i--) {
    if (only !== undefined && i !== only) continue
    const b = blocks[i]
    if (b.settled || b.dismissed) continue
    const xs = exchangesOf(chat.m, b, vectorOf)
    if (xs.length < 2) continue
    const answers = xs.map((x) => x.a)
    const besides = blocks.filter((x, j) => j !== i && x.v)
    const outer = besides.map((x) => ({ v: x.v! }))
    const outerA = besides.map((x) => ({ v: x.a! }))
    // Narrowing a block's move (`only`): its first exchange has to be on the rest of the chat's topic.
    if (only !== undefined && (!outer.length || !xs[0].v || (topMean(xs[0].v, outer, 2) < cfg.tailQA && topMean(xs[0].a!, outerA, 2) < cfg.tailA))) continue
    const elsewhere = answers.map((a) => (a ? fitsElsewhere(a) : null))
    // The longest such end; `apartOnly`: its last exchange is off by the person's usual fit alone.
    let from = -1
    let apartOnly = false
    for (let k = 1; k < xs.length && from < 0; k++) {
      const part = xs.slice(k)
      if (part.some((x) => !x.v || x.settled || x.dismissed) || asksOutside(chat.m, part[0].start, part[part.length - 1].end) < cfg.splitMin) continue
      const rest = [...outer, ...xs.slice(0, k).filter((x) => x.v).map((x) => ({ v: x.v! }))]
      const restA = [...outerA, ...answers.slice(0, k).filter((a): a is Float32Array => Boolean(a)).map((v) => ({ v }))]
      if (!rest.length || !restA.length) continue
      const off = (x: ScoredBlock, z: number) => {
        if (topMean(x.v!, rest, 2) < cfg.tailQA && topMean(answers[z]!, restA, 2) < cfg.tailA) return true
        // Against the closest of the rest: in a chat on two related subjects, its own subject's answer alone (top-2 let
        // the other subject halve the fit, and on-topic answers went to a chat on a near topic).
        const there = elsewhere[z]
        return there !== null && there - topMean(answers[z]!, restA, 1) >= cfg.moveD
      }
      // 2.6 (96): the block's last answer, against the person's usual fit (off when tailRelCap is 0).
      const offUsual = (z: number) => {
        if (z !== xs.length - 1) return false
        const own = topMean(answers[z]!, restA, 2)
        const usual = own < cfg.tailRelCap ? usualFit(answers[z]!) : null
        return usual !== null && own - usual < cfg.tailRelD
      }
      let byUsual = false
      const offAll = part.every((x, z) => {
        if (off(x, k + z)) return true
        if (!offUsual(k + z)) return false
        byUsual = true
        return true
      })
      if (!offAll) continue
      if (part.some((_, a) => part.some((_, z) => z > a && dot(answers[k + a]!, answers[k + z]!) < cfg.tailAlike))) continue
      from = k
      apartOnly = byUsual
    }
    if (from < 0 || xs.slice(from).every((x) => x.weak)) continue
    const part = xs.slice(from)
    const head = xs.slice(0, from)
    const x: ScoredBlock = { ...b, start: part[0].start, end: part[part.length - 1].end, v: mean(part.map((y) => y.v!)), a: mean(answers.slice(from).map((y) => y!)), weak: false, t: part[0].t, settled: false, dismissed: false }
    const current = topMean(x.v!, [...outer, ...head.filter((y) => y.v).map((y) => ({ v: y.v! }))], 2)
    const currentA = topMean(x.a!, [...outerA, ...answers.slice(0, from).filter((y): y is Float32Array => Boolean(y)).map((v) => ({ v }))], 1)
    // The chat as it would stay, for "a chat of one block would rather join this one" (its own end left out of that).
    const staying = {
      thread: { ...chat, m: chat.m.filter((_, j) => j < x.start || j > x.end) },
      blocks: blocks.map((y, j) => (j === i ? { ...y, end: head[head.length - 1].end, v: mean(head.filter((h) => h.v).map((h) => h.v!)), a: mean(answers.slice(0, from).filter((h): h is Float32Array => Boolean(h))) } : y))
    }
    let fits = false
    let best: { to: string; score: number; margin: number } | null = null
    for (const o of others) {
      const vs = vectorsOf(o)
      if (!vs.length) continue
      const score = topMean(x.v!, vs, 2)
      // Better there than here by its questions and answers, or by its answers (the question has this page's title).
      const margin = Math.max(score - current, topMean(x.a!, vs, 2) - currentA)
      if (score < (enough(o, vs.length, cfg)) || matchPercent(score, cfg) < cfg.minMatch) continue
      fits = true
      if (shareOn(x, o.blocks, cfg).share <= 0.5 || (o.blocks.length === 1 && joins(o.blocks[0], o.thread, staying, cfg))) continue
      if (!best || score > best.score) best = { to: o.thread.id, score, margin }
    }
    if (best && best.margin >= cfg.moveD && !apartOnly) return { start: x.start, end: x.end, to: best.to, why: "topic", score: best.score, current, match: matchPercent(best.score, cfg) }
    if (!fits) return { start: x.start, end: x.end, to: null, why: "apart", score: 0, current }
  }
  return null
}

/**
 * Whether block `x` is on block `b`'s subject: the same page, or a topic this alike; without the vectors to tell, the
 * same site (with them, a site isn't a subject: one video site holds every topic).
 */
function onSubject(b: ScoredBlock, x: ScoredBlock, cfg: OrganizeConfig): boolean {
  if (b.url && x.url === b.url) return true
  if (b.v && x.v) return dot(b.v, x.v) >= cfg.topicT
  return Boolean(b.host && x.host === b.host)
}

/** How many of `list` are on `b`'s subject, and their share of it (0 for an empty list). */
function shareOn(b: ScoredBlock, list: ScoredBlock[], cfg: OrganizeConfig): { on: number; share: number } {
  const on = list.filter((x) => onSubject(b, x, cfg)).length
  return { on, share: list.length ? on / list.length : 0 }
}

/** Of two chats, the one the other joins: more messages, then written in last, then by id. */
function larger(a: Thread, b: Thread): boolean {
  if (a.m.length !== b.m.length) return a.m.length > b.m.length
  if (activity(a) !== activity(b)) return activity(a) > activity(b)
  return a.id < b.id
}

/** Whether a chat's blocks are on more than one topic: one of them is off the rest (less than half of them on it). */
function isMix(blocks: ScoredBlock[], cfg: OrganizeConfig): boolean {
  return blocks.length > 1 && blocks.some((x, i) => shareOn(x, blocks.filter((_, j) => j !== i), cfg).share < 0.5)
}

/**
 * Whether a chat of one block `b` joins `to`: `to` is on one topic and mostly about `b`'s (more than half its blocks),
 * and has more on it or, with one such block each, is the larger chat. Never into a mix, and of two chats one way.
 */
function joins(b: ScoredBlock, from: Thread, to: { thread: Thread; blocks: ScoredBlock[] }, cfg: OrganizeConfig): boolean {
  // `to` joins this one whole (2.6 (94)): not the other way too.
  if (mergeFit(to, { thread: from, blocks: [b] }, cfg)) return false
  // Most of `to` is on `b`'s site (its pages, whatever each one is about): that site's chat (2.6 (91)).
  const onSite = b.host ? to.blocks.filter((x) => x.host === b.host).length : 0
  if (onSite * 2 > to.blocks.length) return onSite > 1 || larger(to.thread, from)
  if (isMix(to.blocks, cfg)) return false
  const there = shareOn(b, to.blocks, cfg)
  return there.share > 0.5 && (there.on > 1 || larger(to.thread, from))
}

/**
 * Whether block `b` of chat `from` (with its other blocks `rest`) goes to `to`. A block that is the whole chat joins
 * (`joins`). A block of a chat goes when it's off that chat's topic (less than half of `rest` is on it), to a chat that
 * has its page or is mostly about it (more than half its blocks), unless that chat is one block that would rather
 * join this one.
 */
function goesTo(b: ScoredBlock, rest: ScoredBlock[], from: Thread, to: { thread: Thread; blocks: ScoredBlock[] }, cfg: OrganizeConfig, samePage = false): boolean {
  if (!rest.length) return joins(b, from, to, cfg)
  if (shareOn(b, rest, cfg).share >= 0.5) return false
  if (!samePage && shareOn(b, to.blocks, cfg).share <= 0.5) return false
  return !(to.blocks.length === 1 && joins(to.blocks[0], to.thread, { thread: from, blocks: [...rest, b] }, cfg))
}

function movePlace(
  chat: Thread,
  b: ScoredBlock,
  i: number,
  blocks: ScoredBlock[],
  rest: ScoredBlock[],
  others: Array<{ thread: Thread; blocks: ScoredBlock[] }>,
  cfg: OrganizeConfig
): Omit<MoveSuggestion, "start" | "end"> | null {
  // The same page, already in another chat and not elsewhere in this one.
  if (b.url && !rest.some((x) => x.url === b.url)) {
    const there = others
      .filter((o) => o.blocks.some((x) => x.url === b.url) && goesTo(b, rest, chat, o, cfg, true))
      .sort((a, z) => activity(z.thread) - activity(a.thread))[0]
    if (there) return { to: there.thread.id, why: "page", score: 1, current: 0 }
  }
  // A chat of one block on a site (a note, a question) joins the chat with the most of that site, when more than half
  // of it is that site and the block isn't about something else entirely there (2.6 (91): a note's chat joins the
  // chat with the questions about that site). A short note says too little to be judged by its words: its site will do.
  // 2.6 (93): that chat may be one page's questions too (one block), when it has more messages than this one.
  const onHost = b.host && !rest.some((x) => x.host === b.host) ? others.map((o) => ({ o, on: o.blocks.filter((x) => x.host === b.host).length })) : []
  const sites = onHost.filter(({ o, on }) => on >= 2 && on * 2 >= o.blocks.length)
  if (!rest.length) {
    const home = onHost
      .filter(({ o, on }) => on * 2 > o.blocks.length && (on >= 2 || o.thread.m.length > chat.m.length) && !mergeFit(o, { thread: chat, blocks }, cfg))
      .sort((a, z) => z.on - a.on || (larger(a.o.thread, z.o.thread) ? -1 : 1))[0]
    const vs = home ? home.o.blocks.filter((x) => x.v).map((x) => ({ v: x.v! })) : []
    // 2.6 (95): questions that say enough join a site's chat on their topic only (rtings.com and amazon.com hold every
    // topic: a monitor review joined the headphones chat). A note keeps 2.6 (91)'s rule: its site's chat.
    const notes = chat.m.every((e) => e.note)
    const fit = b.v && vs.length ? topMean(b.v, vs, 2) : null
    if (home && (fit === null || (fit >= cfg.siteT && (notes || b.weak || matchPercent(fit, cfg) >= cfg.minMatch)))) return { to: home.o.thread.id, why: "site", score: 1, current: 0 }
  }
  // Below, the block has to say enough.
  if (!b.v || b.weak) return null
  // The fit to its own chat: its blocks outside the window, else all its other blocks.
  const outside = blocks.filter((x, j) => j < blocks.length - cfg.window && j !== i && x.v)
  const base = (outside.length ? outside : rest.filter((x) => x.v)).map((x) => ({ v: x.v! }))
  const current = topMean(b.v, base, 2)
  // The same site: one other chat is about it (half its blocks or more, two at least), this one isn't.
  if (sites.length) {
    const about = sites.map(({ o }) => o)
    if (about.length === 1 && goesTo(b, rest, chat, about[0], cfg)) {
      const vs = about[0].blocks.filter((x) => x.v).map((x) => ({ v: x.v! }))
      const score = topMean(b.v, vs, 2)
      const match = matchPercent(score, cfg)
      if (vs.length && score >= cfg.siteT && score >= current && match >= cfg.minMatch) return { to: about[0].thread.id, why: "site", score, current, match }
    }
  }
  // A chat it fits but that isn't mostly about it (a mix) gets nothing; it still keeps it from a new chat.
  let fits = false
  let best: { to: string; score: number } | null = null
  for (const o of others) {
    const vs = o.blocks.filter((x) => x.v).map((x) => ({ v: x.v! }))
    if (!vs.length) continue
    const score = topMean(b.v, vs, 2)
    if (score < (vs.length >= 2 ? cfg.moveT : cfg.moveT1) || matchPercent(score, cfg) < cfg.minMatch) continue
    fits = true
    if (!goesTo(b, rest, chat, o, cfg)) continue
    if (!best || score > best.score) best = { to: o.thread.id, score }
  }
  if (best && best.score - current >= cfg.moveD) return { to: best.to, why: "topic", score: best.score, current, match: matchPercent(best.score, cfg) }
  // 2.6 (95): and off the chat's topic, like a move (a block whose page is elsewhere in the chat is that chat's).
  if (!fits && base.length && current < cfg.splitT && shareOn(b, rest, cfg).share < 0.5) return { to: null, why: "apart", score: 0, current }
  return null
}

// ------------------------------------------------------------ tags

export interface TagCandidate {
  tag: string
  pos: number
  neg: number
  coherence: number
  // A few of the user's messages with this tag, for the judge.
  examples: string[]
}

/** Answers and notes: the messages tags go on. */
export const isTaggable = (e: Entry) => e.role === "assistant" || Boolean(e.note)

/** Tags refused on `rollback` messages since one was last taken: not suggested any more. */
export function refusedTags(chats: Thread[], cfg: OrganizeConfig): Set<string> {
  const taken = new Map<string, number>()
  const refused = new Map<string, number[]>()
  for (const t of chats) {
    const times = entryTimes(t.m)
    t.m.forEach((e, i) => {
      for (const tag of e.accepted?.tags ?? []) taken.set(tag.toLowerCase(), Math.max(taken.get(tag.toLowerCase()) ?? -Infinity, times[i] ?? 0))
      for (const tag of e.dismissed?.tags ?? []) refused.set(tag.toLowerCase(), [...(refused.get(tag.toLowerCase()) ?? []), times[i] ?? 0])
    })
  }
  const out = new Set<string>()
  for (const [tag, at] of refused) {
    const since = taken.get(tag) ?? -Infinity
    if (at.filter((x) => x > since).length >= cfg.rollback) out.add(tag)
  }
  return out
}

/** A message as a tag's example (its question first): what the judge reads. */
function exampleText(entries: Entry[], i: number): string {
  const e = entries[i]
  let q = ""
  for (let j = i - 1; j >= 0 && !e.note; j--) {
    if (entries[j].role === "user" && !entries[j].note) {
      q = `${plain(entries[j].label ?? entries[j].content).slice(0, 120)} → `
      break
    }
  }
  return `${q}${plain(e.content).slice(0, 300)}${e.page?.title ? ` (${plain(e.page.title)})` : ""}`
}

/** The text the judge gets for the message itself. */
export function judgeText(entries: Entry[], i: number): string {
  return exampleText(entries, i).slice(0, 1_500)
}

/**
 * How alike two of the person's answers and notes are on average (their vectors' mean dot over every pair, from the
 * sum of the vectors: no pairs walked); 0 with fewer than two.
 */
function libraryMean(live: Thread[], vectorOf: VectorOf): number {
  let sum: number[] | null = null
  let self = 0
  let n = 0
  for (const t of live) for (const x of t.m) {
    if (!isTaggable(x)) continue
    const v = vectorOf(x)
    if (!v) continue
    sum ??= new Array<number>(v.length).fill(0)
    for (let i = 0; i < v.length; i++) {
      sum[i] += v[i]
      self += v[i] * v[i]
    }
    n++
  }
  if (!sum || n < 2) return 0
  let all = 0
  for (const x of sum) all += x * x
  return (all - self) / (n * (n - 1))
}

/**
 * Tags to check for message `index` of `chat` (best first, at most 3): the user's tags on other messages (their
 * messages count fully, blocks of chats with that tag a little less) that fit the message. A tag with three examples
 * or more: its examples alike, and it fits better than the closest messages without it. 2.6 (98): a tag on one or two
 * messages (just made), or on this page's only: from `tagT1` to them, wherever they are, its two or more alike. Best
 * first by how far each clears its rule's bar. Tags it (or its chat) has, refused here, or refused too often are left
 * out. The judge decides among them.
 */
export function tagCandidates(chat: Thread, index: number, chats: Thread[], vectorOf: VectorOf, cfg: OrganizeConfig): TagCandidate[] {
  const e = chat.m[index]
  const v = e && isTaggable(e) ? vectorOf(e) : null
  if (!v || chat.kind === "history") return []
  const own = pageBlocks(chat.m).find((b) => b.start <= index && index <= b.end)
  const inOwn = (t: Thread, j: number) => t.id === chat.id && own !== undefined && own.start <= j && j <= own.end
  const skip = new Set([...(e.tags ?? []), ...(chat.tags ?? []), ...(e.dismissed?.tags ?? [])].map((t) => t.toLowerCase()))
  for (const tag of refusedTags(chats, cfg)) skip.add(tag)
  const live = chats.filter((t) => !t.deleted && t.kind !== "history")
  const tags = new Map<string, string>()
  for (const t of live) for (const tag of [...(t.tags ?? []), ...t.m.flatMap((x) => x.tags ?? [])]) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag)
  const out: Array<{ c: TagCandidate; margin: number }> = []
  let usual: number | undefined
  for (const [key, tag] of tags) {
    if (skip.has(key)) continue
    const examples: Array<{ v: Float32Array; w: number; text: string; own: boolean }> = []
    const tagged = new Set<string>()
    for (const t of live) {
      const chatTagged = (t.tags ?? []).some((x) => x.toLowerCase() === key)
      if (chatTagged) tagged.add(t.id)
      t.m.forEach((x, j) => {
        if (!x.tags?.some((y) => y.toLowerCase() === key) || (t.id === chat.id && j === index)) return
        const xv = vectorOf(x)
        if (xv) examples.push({ v: xv, w: 1, text: exampleText(t.m, j), own: inOwn(t, j) })
      })
      if (chatTagged && t.id !== chat.id) {
        for (const b of scoredBlocks(t.m, vectorOf)) if (b.v && !b.weak) examples.push({ v: b.v, w: 0.9, text: exampleText(t.m, b.end), own: false })
      }
    }
    // 2.6 (98): a tag on one or two messages is a new one: it fits from tagT1, by its examples alone.
    let fresh = examples.length < 3
    if (!fresh) {
      // An established tag: its examples outside this message's own page (one there says little about the topic). The
      // review's S7: one put on this page's messages only (fewer than 2 elsewhere) is judged as a new one, by all of
      // them, so it isn't dropped here at its third example.
      const outside = examples.filter((x) => !x.own)
      if (outside.length >= 2) {
        examples.length = 0
        examples.push(...outside)
      } else fresh = true
    }
    const list = examples.slice(0, 30)
    let s = 0
    let n = 0
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { s += dot(list[a].v, list[b].v); n++ }
    const coherence = n ? s / n : 0
    // The review's S8: examples that aren't alike ("later" on two unrelated messages) say no topic, a new tag's two too;
    // alike by more than the person's messages are on average.
    if (n && (coherence < cfg.coherence || coherence - (usual ??= libraryMean(live, vectorOf)) < cfg.tagCohD)) continue
    const pos = topMean(v, examples, 3)
    if (pos < (fresh ? cfg.tagT1 : cfg.tagT)) continue
    const negatives: Array<{ v: Float32Array }> = []
    for (const t of fresh ? [] : live) {
      if (tagged.has(t.id)) continue
      t.m.forEach((x, j) => {
        if (!isTaggable(x) || inOwn(t, j) || x.tags?.some((y) => y.toLowerCase() === key)) return
        const xv = vectorOf(x)
        if (xv) negatives.push({ v: xv })
      })
    }
    const neg = fresh ? 0 : topMean(v, negatives, 3)
    if (!fresh && pos - neg < cfg.tagD) continue
    const ranked = [...examples].sort((a, b) => dot(v, b.v) * b.w - dot(v, a.v) * a.w)
    // The review's S8: ranked by how far each clears its own rule's bar (a new tag's tagT1; an established one's margin
    // over the messages without it), so a just-made tag doesn't outrank every established one.
    out.push({ c: { tag, pos, neg, coherence, examples: ranked.slice(0, 4).map((x) => x.text) }, margin: fresh ? pos - cfg.tagT1 : pos - neg - cfg.tagD })
  }
  return out.sort((a, b) => b.margin - a.margin || a.c.tag.localeCompare(b.c.tag)).slice(0, 3).map((x) => x.c)
}

/**
 * The messages that get tag suggestions now: the chat's last `tagWindow` answers and notes. 2.6 (98): in a chat with
 * the user's tag on a message, its untagged ones too, up to twice that, the latest first (a tag put on one message
 * is offered on the ones like it in this chat at once, not only on the last few). And, the owner's note «Не предлагает
 * такую метку в других чатах, а надо», up to `tagWindow` more: those a tag the user put on messages (in any of `chats`)
 * fits from `tagT1`, the closest first, wherever they are in the chat; so a tag is offered in the other chats as they
 * open, not only on their last messages. Whether it's offered is still tagCandidates' and the judge's.
 */
export function tagTargets(chat: Thread, cfg: OrganizeConfig, chats: Thread[] = [], vectorOf: VectorOf = () => null): number[] {
  const out: number[] = []
  for (let i = chat.m.length - 1; i >= 0 && out.length < cfg.tagWindow; i--) if (isTaggable(chat.m[i])) out.push(i)
  if (chat.m.some((e) => e.tags?.length)) {
    for (let i = chat.m.length - 1; i >= 0 && out.length < cfg.tagWindow * 2; i--) {
      if (isTaggable(chat.m[i]) && !chat.m[i].tags?.length && !out.includes(i)) out.push(i)
    }
  }
  for (const i of nearTagged(chat, chats, vectorOf, cfg).filter((i) => !out.includes(i)).slice(0, cfg.tagWindow)) out.push(i)
  return out.sort((a, b) => a - b)
}

/**
 * The chat's answers and notes that one of the user's tags on messages (in `chats`, this one's included) fits from
 * `tagT1`: the mean of its 3 closest tagged messages, as a new tag's rule (tagCandidates). The closest first, the later
 * of equals first. Tags the message or its chat has, it turned down, or refused too often don't count.
 */
function nearTagged(chat: Thread, chats: Thread[], vectorOf: VectorOf, cfg: OrganizeConfig): number[] {
  if (chat.kind === "history") return []
  const examples = new Map<string, Array<{ v: Float32Array }>>()
  for (const t of chats) {
    if (t.deleted || t.kind === "history") continue
    for (const x of t.m) {
      if (!x.tags?.length) continue
      const xv = vectorOf(x)
      if (!xv) continue
      for (const key of new Set(x.tags.map((tag) => tag.toLowerCase()))) examples.set(key, [...(examples.get(key) ?? []), { v: xv }])
    }
  }
  if (!examples.size) return []
  const refused = refusedTags(chats, cfg)
  const chatTags = (chat.tags ?? []).map((t) => t.toLowerCase())
  const found: Array<{ i: number; fit: number }> = []
  chat.m.forEach((e, i) => {
    if (!isTaggable(e)) return
    const v = vectorOf(e)
    if (!v) return
    const skip = new Set([...chatTags, ...[...(e.tags ?? []), ...(e.dismissed?.tags ?? [])].map((t) => t.toLowerCase())])
    let fit = 0
    for (const [key, list] of examples) if (!skip.has(key) && !refused.has(key)) fit = Math.max(fit, topMean(v, list, 3))
    if (fit >= cfg.tagT1) found.push({ i, fit })
  })
  return found.sort((a, b) => b.fit - a.fit || b.i - a.i).map((x) => x.i)
}

/** The judge's verdicts → the tags to show (confident yes only, at most `maxTags`, in the candidates' order). */
export function judgedTags(candidates: TagCandidate[], verdicts: Array<{ tag: string; fits: boolean; confidence: number }>, cfg: OrganizeConfig): string[] {
  const yes = new Set(verdicts.filter((v) => v.fits && v.confidence >= cfg.judge).map((v) => v.tag.replace(/^#+/, "").toLowerCase()))
  return candidates.filter((c) => yes.has(c.tag.toLowerCase())).map((c) => c.tag).slice(0, cfg.maxTags)
}

// ------------------------------------------------------------ "everything in one chat?" (no AI)

/** The chat looks like a pile (for the card that shows what organizing does): many sites lately, or many blocks. */
export function looksMixed(chat: Thread, cfg: OrganizeConfig): boolean {
  if (chat.kind === "history") return false
  const blocks = pageBlocks(chat.m)
  if (blocks.length >= cfg.messBlocks) return true
  const sites = new Set(blocks.slice(-5).map((b) => hostOf(b.url)).filter(Boolean))
  return sites.size >= cfg.messSites
}

/** The messages whose vectors the device lacks: their keys and texts (to embed), the newest chats first. */
export function missingVectors(chats: Thread[], has: (key: string, text: string) => boolean, max = Infinity): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = []
  const seen = new Set<string>()
  for (const t of [...chats].filter((c) => !c.deleted && c.kind !== "history").sort((a, b) => activity(b) - activity(a))) {
    for (const e of t.m) {
      const text = embedText(e)
      const key = entryKey(e)
      if (!text || seen.has(key) || has(key, text)) continue
      seen.add(key)
      out.push({ key, text })
      if (out.length >= max) return out
    }
  }
  return out
}

// ------------------------------------------------------------ the chat's name by its topic (2.6)

export const MAX_NAME_TEXT = 6_000

/**
 * What the AI reads to name a chat (/api/v2/organize op "name"): page by page, the page's title, the person's
 * questions and notes, and the start of each answer. A long chat keeps its first page and as many of the latest as fit.
 */
export function nameText(entries: Entry[]): string {
  const parts = pageBlocks(entries).map((b) => {
    const list = entries.slice(b.start, b.end + 1)
    const lines: string[] = []
    const title = list.find((e) => e.page?.title)?.page?.title
    if (title) lines.push(`Page: ${plain(title).slice(0, 150)}`)
    for (const e of list) {
      if (e.note) lines.push(`Note: ${plain(e.content).slice(0, 300)}`)
      else if (e.role === "user") lines.push(`Question: ${plain(e.label ?? e.content).slice(0, 300)}`)
      else if (plain(e.content)) lines.push(`Answer: ${plain(e.content).slice(0, 200)}`)
    }
    return lines.join("\n")
  }).filter(Boolean)
  const all = parts.join("\n\n")
  if (all.length <= MAX_NAME_TEXT || parts.length < 2) return all.slice(0, MAX_NAME_TEXT)
  const first = parts[0].slice(0, 1_200)
  const latest: string[] = []
  let size = first.length
  for (let i = parts.length - 1; i > 0; i--) {
    if (size + parts[i].length + 2 > MAX_NAME_TEXT) break
    latest.unshift(parts[i])
    size += parts[i].length + 2
  }
  return [first, ...latest].join("\n\n")
}

/**
 * Whether the chat's name gets checked by itself (as suggestions come): not one the user typed, and the chat has
 * two questions or notes at least (one question names it well enough).
 */
export function wantsNameCheck(thread: Thread): boolean {
  if (thread.kind === "history" || thread.deleted || namedByUser(thread)) return false
  return thread.m.filter((e) => e.role === "user").length >= 2
}

/**
 * What a name check was about: the name, the chat's pages and how many questions (up to 3). The same: no new check.
 * The app works it out the same way (2.6 (93): it's kept with the chat, so no device asks again what another did).
 */
export function nameCheckKey(thread: Thread, title = thread.title ?? ""): string {
  const asks = Math.min(3, thread.m.filter((e) => e.role === "user").length)
  return textKey([title, pageBlocks(thread.m).map((b) => entryKey(thread.m[b.start])).join("\u0001"), String(asks)].join("\u0000"))
}

// ------------------------------------------------------------ organizing's state, kept with the chat (2.6 (93))

/** The key of the chat's last message ("" without one): what OrgState.k is checked against. */
export function lastKey(entries: Entry[]): string {
  return entries.length ? entryKey(entries[entries.length - 1]) : ""
}

// ------------------------------------------------------------ names turned down (2.6 (98), the review's S5)

/**
 * Words that don't tell names apart (articles, prepositions, conjunctions: "the", "für", "và", "في"), by script: the
 * Latin languages' together, Vietnamese's apart (its "da", "do" are words), Cyrillic's, Arabic's, Korean's.
 */
const NAME_STOP = {
  latin: new Set([
    "the", "a", "an", "and", "or", "of", "for", "with", "by", "in", "on", "to", "at", "from", "vs", "my", "your", "our", "about", "how", "what",
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "für", "mit", "von", "vom", "im", "am", "zum", "zur", "oder", "auf", "über", "bei", "zu", "wie", "was",
    "le", "la", "les", "l", "un", "une", "et", "pour", "avec", "de", "d", "du", "en", "ou", "au", "aux", "sur", "dans", "par", "à",
    "el", "los", "las", "una", "y", "para", "con", "del", "al", "por", "sobre",
    "il", "lo", "i", "gli", "e", "per", "di", "della", "dei", "delle", "degli", "alla", "su", "da", "nel", "nella", "dell",
    "o", "os", "as", "um", "uma", "com", "do", "dos", "das", "em", "no", "na", "nos", "nas", "ao"
  ]),
  vi: new Set(["và", "cho", "của", "với", "các", "những", "về", "trong", "là", "một"]),
  cyrillic: new Set(["и", "в", "во", "на", "с", "со", "по", "для", "от", "до", "из", "или", "о", "об", "обо", "про", "к", "ко", "у", "за", "это", "как", "что",
    "і", "й", "та", "з", "із", "зі", "від", "або", "як", "що"]),
  arabic: new Set(["و", "في", "من", "على", "مع", "أو", "عن", "إلى"]),
  hangul: new Set(["및", "위한", "대한"])
}
/** Letters only Vietnamese has (ă, đ, ơ, ư, and those with a tone mark): a name with one is Vietnamese. */
const VI_LETTER = /[ăđơư\u1EA0-\u1EF9]/u
/** Korean particles at a word's end ("교토의" is "교토"), the longer first. */
const KO_PARTICLES = ["에서", "으로", "에게", "까지", "부터", "의", "을", "를", "은", "는", "이", "가", "에", "로", "와", "과", "도", "만"]
/** Arabic's article (with "and", "with", "for" before it) at a word's start ("السيارات" is "سيارات"). */
const AR_ARTICLES = ["وال", "بال", "لل", "ال"]
/** Japanese and Chinese particles between a name's words (の, と, 的): not words of it. */
const DENSE_JOIN = new Set(Array.from("のをにはがとでへもや的和与與及"))
const DENSE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/u
const HAN_CHAR = /\p{Script=Han}/u
/** How much a word counts; a Chinese character half a word, a kana a third (a word is two or three of them). */
const WORD = 6
const HAN = 3
const KANA = 2
/** Only the last turned-down names block near repeats; any of them blocks itself. */
export const NEAR_TURNED_DOWN = 5

/** A unit of a name's content: a word (`alt`: a Korean one without its particle), or a Chinese or Japanese character. */
interface NameUnit { u: string; alt?: string; w: number; char: boolean }

/**
 * A name's content: its words in lower case without the words that don't tell names apart (NAME_STOP; Arabic's
 * article off); Chinese and Japanese, which have no spaces, as their characters without particles.
 */
function nameUnits(name: string): NameUnit[] {
  const text = name.toLowerCase().normalize("NFC")
  const vi = VI_LETTER.test(text)
  const out: NameUnit[] = []
  const word = (raw: string) => {
    let w = raw
    let alt: string | undefined
    let stop = vi ? NAME_STOP.vi : NAME_STOP.latin
    if (/\p{Script=Cyrillic}/u.test(w)) stop = NAME_STOP.cyrillic
    else if (/\p{Script=Arabic}/u.test(w)) {
      stop = NAME_STOP.arabic
      const p = AR_ARTICLES.find((x) => w.startsWith(x) && Array.from(w).length - Array.from(x).length >= 3)
      if (p) w = w.slice(p.length)
    } else if (/\p{Script=Hangul}/u.test(w)) {
      stop = NAME_STOP.hangul
      const p = KO_PARTICLES.find((x) => w.endsWith(x) && Array.from(w).length > Array.from(x).length)
      if (p) alt = w.slice(0, w.length - p.length)
    }
    if (!stop.has(w)) out.push({ u: w, ...(alt ? { alt } : {}), w: WORD, char: false })
  }
  for (const run of text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    let plain = ""
    for (const c of Array.from(run)) {
      if (!DENSE_CHAR.test(c)) {
        plain += c
        continue
      }
      if (plain) word(plain)
      plain = ""
      if (!DENSE_JOIN.has(c)) out.push({ u: c, w: HAN_CHAR.test(c) ? HAN : KANA, char: true })
    }
    if (plain) word(plain)
  }
  return out
}

/**
 * Two words of names alike: the same (a Korean one with or without its particle), or one form of the other
 * ("поездка" / "поездки", "hotel" / "hotels"): a shared start of 4 letters or more that leaves at most 3 of the longer.
 */
function sameWord(a: NameUnit, b: NameUnit): boolean {
  if (a.u === b.u) return true
  if (a.char || b.char) return false
  if (a.alt !== undefined && (a.alt === b.u || a.alt === b.alt)) return true
  if (b.alt !== undefined && b.alt === a.u) return true
  const x = Array.from(a.u)
  const y = Array.from(b.u)
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  return p >= 4 && p >= Math.max(x.length, y.length) - 3
}

/**
 * 2.6 (98): whether two names are the same or nearly (a name turned down came back reworded after the chat changed a
 * little): equal in lower case; or every content word of the smaller one is in the other, in any order and form, and
 * the other adds at most one (none to a one-word name). A word that differs makes another name ("Tips for the
 * garden" / "Tips for the kitchen"), however many words they share.
 */
export function nearName(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true
  const x = nameUnits(a)
  const y = nameUnits(b)
  const weight = (list: NameUnit[]) => list.reduce((s, u) => s + u.w, 0)
  const [small, large] = weight(x) <= weight(y) ? [x, y] : [y, x]
  if (!small.length) return false
  const used = new Set<number>()
  for (const u of small) {
    const j = large.findIndex((v, k) => !used.has(k) && sameWord(u, v))
    if (j < 0) return false
    used.add(j)
  }
  const extra = large.reduce((s, v, k) => s + (used.has(k) ? 0 : v.w), 0)
  return extra <= (weight(small) >= WORD + HAN ? WORD : 0)
}

/** Whether `name` was turned down for the chat (`no`, the oldest first): one of them, or a near repeat of one of the last NEAR_TURNED_DOWN. */
export function turnedDownName(no: string[], name: string): boolean {
  return no.some((x) => x.toLowerCase() === name.toLowerCase()) || no.slice(-NEAR_TURNED_DOWN).some((x) => nearName(x, name))
}

/** The name the chat's record suggests while it's open: not turned down (nor nearly), not its name already, not one the user typed. */
export function openName(thread: Thread): string | undefined {
  const nm = thread.org?.nm
  if (!nm?.t || !wantsNameCheck(thread) || nm.t.toLowerCase() === threadName(thread).toLowerCase()) return undefined
  // 2.6 (95): first what moves, then the name (a chat on two topics got names of both, and renames came and went).
  if (moveOpen(thread)) return undefined
  if (turnedDownName(nm.no ?? [], nm.t)) return undefined
  return nm.t
}

/** The tags the chat's record says the check confirmed, still open: the message is there, without that tag, not turned down. */
export function openTags(thread: Thread): Array<{ index: number; key: string; tag: string }> {
  const out: Array<{ index: number; key: string; tag: string }> = []
  for (const [key, tag] of thread.org?.tg ?? []) {
    const index = thread.m.findIndex((e) => entryKey(e) === key)
    const e = thread.m[index]
    const has = (list?: string[]) => (list ?? []).some((x) => x.toLowerCase() === tag.toLowerCase())
    if (e && !has(e.tags) && !has(e.dismissed?.tags)) out.push({ index, key, tag })
  }
  return out
}

/** The move the chat's record suggests, while the chat is as it was then and the move still stands. */
export function openMove(thread: Thread, chats: Thread[]): OrgState["mv"] {
  const mv = moveOpen(thread)
  if (!mv) return undefined
  // An older chat joining this one (2.6 (95)): while it's there and the merge wasn't turned down.
  if (mv.fr) return chats.some((t) => t.id === mv.fr && !t.deleted && !(t.org?.mx ?? []).includes(thread.id)) ? mv : undefined
  if (mv.to !== null && !chats.some((t) => t.id === mv.to && !t.deleted)) return undefined
  return mv
}

/** The move the chat's record holds, while the chat is as it was then and nobody took or turned it down here. */
function moveOpen(thread: Thread): OrgState["mv"] {
  const org = thread.org
  const mv = org?.mv
  if (!org || !mv || org.n !== thread.m.length || org.k !== lastKey(thread.m)) return undefined
  if (mv.s < 0 || mv.s > mv.e || mv.e >= thread.m.length) return undefined
  if (!mv.fr && thread.m.slice(mv.s, mv.e + 1).some((e) => e.dismissed?.move || e.from)) return undefined
  if (mv.why === "merge" && !mv.fr && mv.to && (org.mx ?? []).includes(mv.to)) return undefined
  return mv
}

/** The state to keep with the chat after a run: the move and tags worked out now, and the name check as it stands. */
export function orgStateFor(thread: Thread, move: MoveSuggestion | null, tags: Array<{ key: string; tag: string }>, nm: OrgState["nm"]): OrgState {
  return {
    n: thread.m.length,
    k: lastKey(thread.m),
    ...(move ? { mv: { s: move.start, e: move.end, to: move.to, why: move.why, ...(move.match !== undefined ? { mt: move.match } : {}), ...(move.from ? { fr: move.from } : {}), ...(move.topic ? { tp: true as const } : {}) } } : {}),
    ...(tags.length ? { tg: tags.map((t) => [t.key, t.tag] as [string, string]) } : {}),
    ...(nm ? { nm } : {}),
    ...(thread.org?.mx?.length ? { mx: thread.org.mx } : {})
  }
}

/**
 * The name check after asking: what it was about, the name it suggests (unless it was turned down, or is a near repeat
 * of one of the last ones turned down: turnedDownName), and the names turned down.
 */
export function nameStateAfter(previous: OrgState["nm"], key: string, answer: { fits: boolean; title: string }, current: string): NonNullable<OrgState["nm"]> {
  const no = previous?.no ?? []
  const refused = turnedDownName(no, answer.title)
  // The same name in other capitals is no new one (2.6 (94)).
  const suggest = !answer.fits && answer.title && answer.title.toLowerCase() !== current.toLowerCase() && !refused
  return { k: key, ...(suggest ? { t: answer.title } : {}), ...(no.length ? { no } : {}) }
}

/** Whether two states say the same (then the chat isn't written again). */
export function sameOrgState(a: OrgState | undefined, b: OrgState | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
