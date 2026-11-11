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
  // How many of the chat's last blocks get move suggestions, and of its last answers and notes tag suggestions.
  window: number
  tagWindow: number
  // Tags: the fit to the tag's examples, the margin over messages without it, how alike its examples are,
  // and the judge's confidence; at most `maxTags` per message (one: the best, so the chat stays uncluttered).
  tagT: number
  tagD: number
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
  window: 3,
  tagWindow: 5,
  tagT: 0.3,
  tagD: 0,
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
  let merge: { to: string; from?: string; score: number; match: number } | null = null
  for (const o of others) {
    const out = mergeFit({ thread: chat, blocks }, o, cfg)
    if (out && (!merge || out.score > merge.score)) merge = { to: o.thread.id, ...out }
    const into = mergeFit(o, { thread: chat, blocks }, cfg)
    if (into && (!merge || into.score > merge.score)) merge = { to: chat.id, from: o.thread.id, ...into }
  }
  if (merge?.from) {
    const last = chat.m.length - 1
    return { start: last, end: last, to: chat.id, from: merge.from, why: "merge", score: merge.score, current: 0, match: merge.match }
  }
  if (merge) return { start: 0, end: chat.m.length - 1, to: merge.to, why: "merge", score: merge.score, current: 0, match: merge.match }
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
 */
function mergeFit(from: { thread: Thread; blocks: ScoredBlock[] }, to: { thread: Thread; blocks: ScoredBlock[] }, cfg: OrganizeConfig): { score: number; match: number } | null {
  // The cheap checks first: every pair of chats is checked when the list counts.
  if (!from.blocks.some((b) => b.url && to.blocks.some((x) => x.url === b.url))) return null
  if (to.thread.m.every((e) => e.note)) return null
  if (from.blocks.some((b) => b.settled || b.dismissed) || (from.thread.org?.mx ?? []).includes(to.thread.id) || !newer(to.thread, from.thread)) return null
  const mine = from.blocks.filter((b) => b.v)
  const theirs = to.blocks.filter((b) => b.v)
  if (!mine.length || !theirs.length) return null
  // Both ways: one chat on a topic and a pile that has it too aren't one chat.
  const fit = (a: ScoredBlock[], b: ScoredBlock[], by: "v" | "a") => a.reduce((s, x) => s + topMean(x[by]!, b.map((y) => ({ v: y[by]! })), 2), 0) / a.length
  // 2.6 (95): decided by the answers. On shared pages the questions' vectors are mostly the page's title: a monitor
  // chat asked on an espresso machine's page fit that chat 100 % by questions and answers, 0.2 by answers.
  if (Math.min(fit(mine, theirs, "a"), fit(theirs, mine, "a")) < cfg.mergeA) return null
  const score = Math.min(fit(mine, theirs, "v"), fit(theirs, mine, "v"))
  const match = matchPercent(score, cfg)
  return match >= cfg.minMatch ? { score, match } : null
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
 * Tags to check for message `index` of `chat` (best first, at most 3): only tags the user put on at least two
 * other messages (their messages count fully, blocks of chats with that tag a little less), whose examples are
 * alike, that fit the message, and fit it better than the closest messages without the tag. Tags it (or its
 * chat) has, refused here, or refused too often are left out. The judge decides among them.
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
  const out: TagCandidate[] = []
  for (const [key, tag] of tags) {
    if (skip.has(key)) continue
    const examples: Array<{ v: Float32Array; w: number; text: string }> = []
    const tagged = new Set<string>()
    for (const t of live) {
      const chatTagged = (t.tags ?? []).some((x) => x.toLowerCase() === key)
      if (chatTagged) tagged.add(t.id)
      t.m.forEach((x, j) => {
        if (!x.tags?.some((y) => y.toLowerCase() === key) || inOwn(t, j)) return
        const xv = vectorOf(x)
        if (xv) examples.push({ v: xv, w: 1, text: exampleText(t.m, j) })
      })
      if (chatTagged && t.id !== chat.id) {
        for (const b of scoredBlocks(t.m, vectorOf)) if (b.v && !b.weak) examples.push({ v: b.v, w: 0.9, text: exampleText(t.m, b.end) })
      }
    }
    if (examples.length < 2) continue
    const list = examples.slice(0, 30)
    let s = 0
    let n = 0
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { s += dot(list[a].v, list[b].v); n++ }
    const coherence = n ? s / n : 0
    if (coherence < cfg.coherence) continue
    const pos = topMean(v, examples, 3)
    if (pos < cfg.tagT) continue
    const negatives: Array<{ v: Float32Array }> = []
    for (const t of live) {
      if (tagged.has(t.id)) continue
      t.m.forEach((x, j) => {
        if (!isTaggable(x) || inOwn(t, j) || x.tags?.some((y) => y.toLowerCase() === key)) return
        const xv = vectorOf(x)
        if (xv) negatives.push({ v: xv })
      })
    }
    const neg = topMean(v, negatives, 3)
    if (pos - neg < cfg.tagD) continue
    const ranked = [...examples].sort((a, b) => dot(v, b.v) * b.w - dot(v, a.v) * a.w)
    out.push({ tag, pos, neg, coherence, examples: ranked.slice(0, 4).map((x) => x.text) })
  }
  return out.sort((a, b) => (b.pos - b.neg) - (a.pos - a.neg) || a.tag.localeCompare(b.tag)).slice(0, 3)
}

/** The messages that get tag suggestions now: the chat's last `tagWindow` answers and notes. */
export function tagTargets(chat: Thread, cfg: OrganizeConfig): number[] {
  const out: number[] = []
  for (let i = chat.m.length - 1; i >= 0 && out.length < cfg.tagWindow; i--) if (isTaggable(chat.m[i])) out.unshift(i)
  return out
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

/** The name the chat's record suggests while it's open: not turned down, not its name already, not one the user typed. */
export function openName(thread: Thread): string | undefined {
  const nm = thread.org?.nm
  if (!nm?.t || !wantsNameCheck(thread) || nm.t.toLowerCase() === threadName(thread).toLowerCase()) return undefined
  // 2.6 (95): first what moves, then the name (a chat on two topics got names of both, and renames came and went).
  if (moveOpen(thread)) return undefined
  if ((nm.no ?? []).some((x) => x.toLowerCase() === nm.t!.toLowerCase())) return undefined
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
    ...(move ? { mv: { s: move.start, e: move.end, to: move.to, why: move.why, ...(move.match !== undefined ? { mt: move.match } : {}), ...(move.from ? { fr: move.from } : {}) } } : {}),
    ...(tags.length ? { tg: tags.map((t) => [t.key, t.tag] as [string, string]) } : {}),
    ...(nm ? { nm } : {}),
    ...(thread.org?.mx?.length ? { mx: thread.org.mx } : {})
  }
}

/** The name check after asking: what it was about, the name it suggests (unless that one was turned down), and the names turned down. */
export function nameStateAfter(previous: OrgState["nm"], key: string, answer: { fits: boolean; title: string }, current: string): NonNullable<OrgState["nm"]> {
  const no = previous?.no ?? []
  const refused = no.some((x) => x.toLowerCase() === answer.title.toLowerCase())
  // The same name in other capitals is no new one (2.6 (94)).
  const suggest = !answer.fits && answer.title && answer.title.toLowerCase() !== current.toLowerCase() && !refused
  return { k: key, ...(suggest ? { t: answer.title } : {}), ...(no.length ? { no } : {}) }
}

/** Whether two states say the same (then the chat isn't written again). */
export function sameOrgState(a: OrgState | undefined, b: OrgState | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
