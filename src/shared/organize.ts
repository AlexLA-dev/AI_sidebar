// Organizing the chats (2.5, Pro, by consent): suggesting a better chat for a page block (or a new one) and
// the user's own tags for an answer or a note. The device keeps a vector (embedding) per message; the server
// (/api/v2/organize) only turns texts into vectors and checks tag candidates, and keeps nothing. The same
// rules are in the app (ContextFlow/Shared (App)/Organize.swift); tests/organize-parity.test.mts checks both
// give the same suggestions. Thresholds come from /api/v2/status, so they can be tuned without a release.

import { entryKey, entryTimes, stripCitations, textKey, type Entry } from "./conversation.ts"
import { activity, namedByUser, pageBlocks, type PageBlock, type Thread } from "./threads.ts"

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
  // A new chat: the block fits its own chat less than this, and at least `splitMin` blocks stay in it.
  splitT: number
  splitMin: number
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
export const DEFAULT_ORGANIZE: OrganizeConfig = {
  moveT: 0.55,
  moveD: 0.1,
  moveT1: 0.65,
  siteT: 0.35,
  topicT: 0.4,
  splitT: 0.25,
  splitMin: 2,
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

// A question needs this much text (or a page) to be judged; a note this much.
const MIN_QUESTION = 15
const MIN_NOTE = 40
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
  else if (e.role === "user") text = (e.label ? plain(e.label) : plain(e.content).slice(0, 600)) + title
  else text = plain(e.content).slice(0, 800)
  return text.slice(0, MAX_EMBED_CHARS)
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

export function scoredBlocks(entries: Entry[], vectorOf: VectorOf): ScoredBlock[] {
  const times = entryTimes(entries)
  return pageBlocks(entries).map((b) => {
    const list = entries.slice(b.start, b.end + 1)
    let signal = 0
    for (const e of list) if (e.role === "user") signal += plain(e.label ?? e.content).length + (e.page?.title ? MIN_QUESTION : 0)
    const notesOnly = list.every((e) => e.note)
    const vectors = list.map((e) => vectorOf(e)).filter((v): v is Float32Array => Boolean(v))
    return {
      ...b,
      v: mean(vectors),
      weak: signal < (notesOnly ? MIN_NOTE : MIN_QUESTION),
      t: times[b.start],
      host: hostOf(b.url),
      settled: list.some((e) => e.from),
      dismissed: list.some((e) => e.dismissed?.move)
    }
  })
}

// ------------------------------------------------------------ moves

export interface MoveSuggestion {
  // The messages to move (a block, or several in a row), shown under the last one.
  start: number
  end: number
  // The chat to move them to; null: a new chat.
  to: string | null
  // Why: the same page is in that chat, the same site, the same topic, or none fits (a new chat).
  why: "page" | "site" | "topic" | "apart"
  score: number
  current: number
}

const RANK = { page: 0, site: 1, topic: 2, apart: 3 } as const

/** True while move suggestions stay on in this chat: fewer than `rollback` refused since the last one taken. */
export function movesAllowed(chat: Thread, all: Thread[], cfg: OrganizeConfig): boolean {
  let taken = -Infinity
  for (const t of all) for (const e of t.m) if (e.from?.chat === chat.id) taken = Math.max(taken, e.from.at)
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
 */
export function suggestMove(chat: Thread, chats: Thread[], vectorOf: VectorOf, cfg: OrganizeConfig): MoveSuggestion | null {
  if (chat.kind === "history" || chat.deleted) return null
  const blocks = scoredBlocks(chat.m, vectorOf)
  if (!blocks.length || !movesAllowed(chat, chats, cfg)) return null
  const others = chats
    .filter((t) => t.id !== chat.id && !t.deleted && t.kind !== "history" && t.m.length > 0)
    .map((t) => ({ thread: t, blocks: scoredBlocks(t.m, vectorOf) }))
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
    if (together) groups[groups.length - 1] = { ...last, end: s.end, index: s.index, score: Math.max(last.score, s.score), current: Math.min(last.current, s.current) }
    else groups.push(s)
  }
  // A new chat for the chat's blocks but not everything: something stays.
  const best = groups
    .filter((g) => g.to !== null || blocks.filter((b) => b.end < g.start || b.start > g.end).length >= cfg.splitMin)
    .sort((a, b) => RANK[a.why] - RANK[b.why] || (b.score - b.current) - (a.score - a.current) || b.end - a.end)[0]
  if (!best) return null
  const { index: _index, ...suggestion } = best
  return suggestion
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
  // Below, the block has to say enough.
  if (!b.v || b.weak) return null
  // The fit to its own chat: its blocks outside the window, else all its other blocks.
  const outside = blocks.filter((x, j) => j < blocks.length - cfg.window && j !== i && x.v)
  const base = (outside.length ? outside : rest.filter((x) => x.v)).map((x) => ({ v: x.v! }))
  const current = topMean(b.v, base, 2)
  // The same site: one other chat is about it (half its blocks or more, two at least), this one isn't.
  if (b.host && !rest.some((x) => x.host === b.host)) {
    const about = others.filter((o) => {
      const on = o.blocks.filter((x) => x.host === b.host).length
      return on >= 2 && on * 2 >= o.blocks.length
    })
    if (about.length === 1 && goesTo(b, rest, chat, about[0], cfg)) {
      const vs = about[0].blocks.filter((x) => x.v).map((x) => ({ v: x.v! }))
      const score = topMean(b.v, vs, 2)
      if (vs.length && score >= cfg.siteT && score >= current) return { to: about[0].thread.id, why: "site", score, current }
    }
  }
  // A chat it fits but that isn't mostly about it (a mix) gets nothing; it still keeps it from a new chat.
  let fits = false
  let best: { to: string; score: number } | null = null
  for (const o of others) {
    const vs = o.blocks.filter((x) => x.v).map((x) => ({ v: x.v! }))
    if (!vs.length) continue
    const score = topMean(b.v, vs, 2)
    if (score < (vs.length >= 2 ? cfg.moveT : cfg.moveT1)) continue
    fits = true
    if (!goesTo(b, rest, chat, o, cfg)) continue
    if (!best || score > best.score) best = { to: o.thread.id, score }
  }
  if (best && best.score - current >= cfg.moveD) return { to: best.to, why: "topic", score: best.score, current }
  if (!fits && base.length && current < cfg.splitT) return { to: null, why: "apart", score: 0, current }
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

/** What a name check was about: the name, the chat's pages and how many questions (up to 3). The same: no new check. */
export function nameCheckKey(thread: Thread, title = thread.title ?? ""): string {
  const asks = Math.min(3, thread.m.filter((e) => e.role === "user").length)
  return textKey(JSON.stringify([title, pageBlocks(thread.m).map((b) => entryKey(thread.m[b.start])), asks]))
}
