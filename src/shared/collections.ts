// Подборки (2.7, plan section 2): everything found for one task (a trip, a purchase, a course) in one place. Answers and
// notes become cards, sorted into sections (the AI makes them in Pro; the user drags cards and adds, renames, reorders
// and deletes sections); «Сравнить» puts a table card next to picked cards and «Сводка» says what it all comes to (Pro).
// Pure helpers shared by the panel, the background and tests; the app has the same in Swift (ChatMirror.swift
// `CollectionRecord`). Design note: ~/ContextFlow-work/collections-27/design.md.
//
// A collection is one record, like a chat (record name COLLECTION_PREFIX + uuid, the chats' zone, record type and
// fields: no CloudKit schema change; older versions skip it, it has no "m"). It lives in a space (`sp`). Every section
// and card has its own time and is merged newest-wins, deletions kept, so two devices adding cards at once keep both.

import { stripCitations, entryKey, type Entry } from "./conversation.ts"
import { unaccent } from "./fold.ts"
import { FIRST_SPACE, hasSpaces, resolveSpace, type SpaceList } from "./spaces.ts"

export const COLLECTION_PREFIX = "cf-col-"

/** Free: one collection of up to ten cards (the owner: «важно конвертить в подписку тех, кто пользуется»); Pro: no limit. */
export const FREE_COLLECTIONS = 1
export const FREE_CARDS = 10

export const MAX_COLLECTION_NAME = 60
export const MAX_SECTION_NAME = 40
// A card's gist: one or two lines.
export const MAX_GIST = 160
// What a card keeps of its answer (for «Сравнить» and «Сводка»).
export const MAX_CARD_TEXT = 2_000
// Cards and sections one collection keeps at most (a record stays well under CloudKit's 1 MB).
export const MAX_CARDS = 200
export const MAX_SECTIONS = 20

export type CardKind = "answer" | "note" | "compare"

export interface Card {
  id: string
  sec: string
  o: number
  u: number
  d?: true
  k: CardKind
  // The gist: one or two lines.
  t: string
  // The answer's text (cut), for comparing and summing up.
  x?: string
  src?: { url: string; title: string }
  // When it was written (ms).
  at: number
  tags?: string[]
  // «Открыть чат»: the chat and the message.
  chat?: string
  msg?: string
  // A comparison: its table, and the cards it compares.
  tbl?: { h: string[]; r: string[][]; note?: string }
  of?: string[]
}

export interface Section {
  id: string
  n: string
  o: number
  u: number
  d?: true
  // Made by the AI's layout (the user's own sections have none).
  ai?: true
}

export interface Collection {
  id: string
  n: string
  sp?: string
  o?: number
  // The name, space, order and deletion change together: newest by `mu`.
  mu: number
  d?: true
  sum?: { t: string; u: number }
  s: Section[]
  c: Card[]
}

/** As this device keeps one (`cf:collections`): `u`, the record's last change, decides which copy is newer. */
export interface StoredCollection {
  u: number
  rec: Collection
}

export type StoredCollections = Record<string, StoredCollection>

export function isCollectionId(id: string): boolean {
  return id.startsWith(COLLECTION_PREFIX)
}

function clean(text: unknown, max: number): string {
  if (typeof text !== "string") return ""
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 80 ? value : null
}

/** A collection as read back from storage, iCloud or the app, or null if it isn't one. Parts that don't make sense go. */
export function cleanCollection(raw: unknown, recordId?: string): Collection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  // iCloud's and the app's copy says kind "collection"; the one kept on this device (StoredCollection.rec) doesn't.
  if ((o.kind !== undefined && o.kind !== "collection") || !Array.isArray(o.s) || !Array.isArray(o.c)) return null
  const cid = id(o.id) ?? recordId ?? null
  const mu = num(o.mu)
  if (!cid || mu === undefined) return null
  const sections: Section[] = []
  const seen = new Set<string>()
  for (const x of o.s) {
    if (!x || typeof x !== "object") continue
    const r = x as Record<string, unknown>
    const sid = id(r.id)
    const u = num(r.u)
    if (!sid || u === undefined || seen.has(sid)) continue
    seen.add(sid)
    if (r.d === true) {
      sections.push({ id: sid, n: "", o: 0, u, d: true })
      continue
    }
    sections.push({ id: sid, n: clean(r.n, MAX_SECTION_NAME), o: num(r.o) ?? 0, u, ...(r.ai === true ? { ai: true as const } : {}) })
  }
  const cards: Card[] = []
  const known = new Set<string>()
  for (const x of o.c) {
    if (!x || typeof x !== "object") continue
    const r = x as Record<string, unknown>
    const kid = id(r.id)
    const u = num(r.u)
    if (!kid || u === undefined || known.has(kid)) continue
    known.add(kid)
    if (r.d === true) {
      cards.push({ id: kid, sec: "", o: 0, u, d: true, k: "answer", t: "", at: 0 })
      continue
    }
    const k: CardKind = r.k === "note" || r.k === "compare" ? r.k : "answer"
    const src = r.src as Record<string, unknown> | undefined
    const url = typeof src?.url === "string" && /^https?:\/\//i.test(src.url) ? src.url.slice(0, 2_000) : ""
    const tbl = r.tbl as Record<string, unknown> | undefined
    const h = Array.isArray(tbl?.h) ? tbl!.h.map((c) => clean(c, 60)).slice(0, 6) : []
    const rows = Array.isArray(tbl?.r) ? (tbl!.r as unknown[]).filter(Array.isArray).map((row) => (row as unknown[]).map((c) => clean(c, 80)).slice(0, h.length)).slice(0, 10) : []
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => t.slice(0, 40)).slice(0, 10) : []
    const of = Array.isArray(r.of) ? r.of.filter((t): t is string => typeof t === "string").slice(0, 10) : []
    cards.push({
      id: kid, sec: id(r.sec) ?? "", o: num(r.o) ?? 0, u, k,
      t: clean(r.t, 400), at: num(r.at) ?? u,
      ...(typeof r.x === "string" && r.x ? { x: r.x.slice(0, MAX_CARD_TEXT) } : {}),
      ...(url ? { src: { url, title: clean(src?.title, 200) } } : {}),
      ...(tags.length ? { tags } : {}),
      ...(id(r.chat) ? { chat: r.chat as string } : {}),
      ...(id(r.msg) ? { msg: r.msg as string } : {}),
      ...(h.length >= 2 ? { tbl: { h, r: rows, ...(typeof tbl?.note === "string" && tbl.note ? { note: clean(tbl.note, 200) } : {}) } } : {}),
      ...(of.length ? { of } : {})
    })
  }
  const sumRaw = o.sum as Record<string, unknown> | undefined
  const sumU = num(sumRaw?.u)
  return {
    id: cid,
    n: clean(o.n, MAX_COLLECTION_NAME),
    ...(typeof o.sp === "string" && o.sp ? { sp: o.sp } : {}),
    ...(num(o.o) !== undefined ? { o: num(o.o) } : {}),
    mu,
    ...(o.d === true ? { d: true as const } : {}),
    ...(sumU !== undefined && typeof sumRaw?.t === "string" ? { sum: { t: sumRaw.t.slice(0, 1_000), u: sumU } } : {}),
    s: sections,
    c: cards
  }
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, sortedKeys(v)]))
  return value
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The record in one form whatever order it was built in: for iCloud and the app, and to tell copies apart. */
export function collectionForCloud(rec: Collection): string {
  return JSON.stringify(sortedKeys({ ...rec, v: 1, kind: "collection", s: [...rec.s].sort(byId), c: [...rec.c].sort(byId) }))
}

export function collectionFromCloud(data: string, recordId?: string): Collection | null {
  try {
    return cleanCollection(JSON.parse(data), recordId)
  } catch {
    return null
  }
}

export function sameCollection(a: Collection, b: Collection): boolean {
  return collectionForCloud(a) === collectionForCloud(b)
}

/** Newest of two copies of one item; the same time on both, the one that sorts first as JSON (every device the same). */
function newest<T extends { u: number }>(x: T | undefined, y: T | undefined): T | undefined {
  if (!x) return y
  if (!y) return x
  if (x.u !== y.u) return x.u > y.u ? x : y
  return JSON.stringify(sortedKeys(x)) <= JSON.stringify(sortedKeys(y)) ? x : y
}

/**
 * Two copies of a collection as one: each section and card as its newest copy says (a deletion too: never brought back
 * by an older copy); the name, space, order and deletion by `mu`; the summary by its own time.
 */
export function mergeCollections(a: Collection, b: Collection): Collection {
  const meta = a.mu !== b.mu ? (a.mu > b.mu ? a : b) : (JSON.stringify(sortedKeys({ n: a.n, sp: a.sp, o: a.o, d: a.d })) <= JSON.stringify(sortedKeys({ n: b.n, sp: b.sp, o: b.o, d: b.d })) ? a : b)
  const merge = <T extends { id: string; u: number }>(x: T[], y: T[]) => {
    const ids = new Set([...x.map((i) => i.id), ...y.map((i) => i.id)])
    return [...ids].sort().map((i) => newest(x.find((v) => v.id === i), y.find((v) => v.id === i))!)
  }
  const sum = newest(a.sum, b.sum)
  return {
    id: a.id, n: meta.n,
    ...(meta.sp ? { sp: meta.sp } : {}),
    ...(meta.o !== undefined ? { o: meta.o } : {}),
    mu: meta.mu,
    ...(meta.d ? { d: true as const } : {}),
    ...(sum ? { sum } : {}),
    s: merge(a.s, b.s),
    c: merge(a.c, b.c)
  }
}

/**
 * Another copy taken in (iCloud's, the app's), merged with this device's (spaces.ts takeSpaces, the same way): null when
 * it says nothing new here; its own time when it has everything (the time never goes back); else newer than both.
 */
export function takeCollection(stored: StoredCollection | undefined, theirs: { id: string; updatedAt: number; data: string }): StoredCollection | null {
  const rec = collectionFromCloud(theirs.data, theirs.id)
  if (!rec) return null
  if (!stored) return { u: theirs.updatedAt, rec }
  const merged = mergeCollections(stored.rec, rec)
  if (sameCollection(merged, stored.rec) && stored.u >= theirs.updatedAt) return null
  if (sameCollection(merged, rec)) return { u: Math.max(theirs.updatedAt, stored.u), rec: merged }
  return { u: Math.max(stored.u, theirs.updatedAt) + 1, rec: merged }
}

/** The collections newer here than what iCloud or the app has (`theirs`: the time of each copy there). */
export function collectionChanges(stored: StoredCollections, theirs: Record<string, number>): Array<{ id: string; updatedAt: number; data: string }> {
  return Object.entries(stored)
    .filter(([cid, s]) => s.u > (theirs[cid] ?? 0))
    .map(([cid, s]) => ({ id: cid, updatedAt: s.u, data: collectionForCloud(s.rec) }))
}

/** A changed collection as stored: newer than the copy it replaces. */
export function changedCollection(stored: StoredCollection | undefined, rec: Collection, now = Date.now()): StoredCollection {
  return { u: Math.max(now, (stored?.u ?? 0) + 1), rec }
}

// ------------------------------------------------------------ views

/** The collections there are (not deleted): in `space` when Spaces is on with spaces, else all; by order, then newest. */
export function liveCollections(all: Collection[], list: SpaceList, space: string, on: boolean): Collection[] {
  const spaced = on && hasSpaces(list)
  return all
    .filter((c) => !c.d && (!spaced || resolveSpace(list, c.sp) === space))
    .sort((a, b) => (a.o ?? 0) - (b.o ?? 0) || b.mu - a.mu || byId(a, b))
}

export function liveSections(rec: Collection): Section[] {
  return rec.s.filter((s) => !s.d).sort((a, b) => a.o - b.o || byId(a, b))
}

export function liveCards(rec: Collection): Card[] {
  return rec.c.filter((c) => !c.d)
}

/** A section's cards in their order; cards whose section is gone are in the first section. */
export function cardsIn(rec: Collection, sectionId: string): Card[] {
  const sections = liveSections(rec)
  const live = new Set(sections.map((s) => s.id))
  const home = (c: Card) => (live.has(c.sec) ? c.sec : sections[0]?.id)
  return liveCards(rec).filter((c) => home(c) === sectionId).sort((a, b) => a.o - b.o || b.at - a.at || byId(a, b))
}

/** Cards that count against Free's ten (a comparison is made from cards already there). */
export function countedCards(rec: Collection): number {
  return liveCards(rec).filter((c) => c.k !== "compare").length
}

export function canAddCollection(all: Collection[], pro: boolean): boolean {
  return pro || all.filter((c) => !c.d).length < FREE_COLLECTIONS
}

export function canAddCard(rec: Collection, pro: boolean): boolean {
  return countedCards(rec) < (pro ? MAX_CARDS : FREE_CARDS)
}

// ------------------------------------------------------------ edits (each returns the collection as changed at `now`)

function later(u: number | undefined, now: number): number {
  return Math.max(now, (u ?? 0) + 1)
}

export function newCollection(cid: string, name: string, space: string | undefined, now = Date.now(), first?: { id: string; name: string }): Collection {
  return {
    id: cid, n: clean(name, MAX_COLLECTION_NAME), mu: now,
    ...(space && space !== FIRST_SPACE ? { sp: space } : {}),
    s: first ? [{ id: first.id, n: clean(first.name, MAX_SECTION_NAME), o: 0, u: now }] : [],
    c: []
  }
}

export function renameCollection(rec: Collection, name: string, now = Date.now()): Collection {
  const n = clean(name, MAX_COLLECTION_NAME)
  return n && n !== rec.n ? { ...rec, n, mu: later(rec.mu, now) } : rec
}

export function deleteCollection(rec: Collection, now = Date.now()): Collection {
  return rec.d ? rec : { ...rec, d: true, mu: later(rec.mu, now) }
}

export function moveCollectionToSpace(rec: Collection, space: string, now = Date.now()): Collection {
  const next: Collection = { ...rec, mu: later(rec.mu, now) }
  if (space === FIRST_SPACE) delete next.sp
  else next.sp = space
  return next
}

export function addSection(rec: Collection, sid: string, name: string, now = Date.now(), ai = false): Collection {
  if (liveSections(rec).length >= MAX_SECTIONS) return rec
  const o = Math.max(-1, ...liveSections(rec).map((s) => s.o)) + 1
  return { ...rec, s: [...rec.s.filter((s) => s.id !== sid), { id: sid, n: clean(name, MAX_SECTION_NAME), o, u: now, ...(ai ? { ai: true as const } : {}) }] }
}

export function renameSection(rec: Collection, sid: string, name: string, now = Date.now()): Collection {
  const n = clean(name, MAX_SECTION_NAME)
  // Renamed by the user, a section is theirs: the AI's layout keeps it.
  return { ...rec, s: rec.s.map((s) => (s.id === sid && !s.d && n ? { id: s.id, n, o: s.o, u: later(s.u, now) } : s)) }
}

/** A section moved to `index` among the live ones (left and right in the columns). */
export function moveSection(rec: Collection, sid: string, index: number, now = Date.now()): Collection {
  const order = liveSections(rec).filter((s) => s.id !== sid)
  const moving = rec.s.find((s) => s.id === sid && !s.d)
  if (!moving) return rec
  order.splice(Math.max(0, Math.min(index, order.length)), 0, moving)
  const at = new Map(order.map((s, i) => [s.id, i]))
  return { ...rec, s: rec.s.map((s) => (at.has(s.id) && at.get(s.id) !== s.o ? { ...s, o: at.get(s.id)!, u: later(s.u, now) } : s)) }
}

/** A section deleted: its cards go to the first other section (the last section with cards can't be deleted). */
export function deleteSection(rec: Collection, sid: string, now = Date.now()): Collection {
  const sections = liveSections(rec)
  const other = sections.find((s) => s.id !== sid)
  const has = cardsIn(rec, sid).length > 0
  if (!sections.some((s) => s.id === sid) || (has && !other)) return rec
  const moved = cardsIn(rec, sid).map((c) => c.id)
  let next: Collection = { ...rec, s: rec.s.map((s) => (s.id === sid ? { id: s.id, n: "", o: 0, u: later(s.u, now), d: true as const } : s)) }
  for (const cid of moved) next = moveCard(next, cid, other!.id, Number.MAX_SAFE_INTEGER, now)
  return next
}

export function addCard(rec: Collection, card: Omit<Card, "o" | "u">, now = Date.now()): Collection {
  const o = Math.max(-1, ...cardsIn(rec, card.sec).map((c) => c.o)) + 1
  return { ...rec, c: [...rec.c.filter((c) => c.id !== card.id), { ...card, o, u: now }] }
}

/** A card moved into `sid` at `index` (dragged within or between sections). */
export function moveCard(rec: Collection, cid: string, sid: string, index: number, now = Date.now()): Collection {
  const card = rec.c.find((c) => c.id === cid && !c.d)
  if (!card || !liveSections(rec).some((s) => s.id === sid)) return rec
  const order = cardsIn(rec, sid).filter((c) => c.id !== cid)
  order.splice(Math.max(0, Math.min(index, order.length)), 0, card)
  const at = new Map(order.map((c, i) => [c.id, i]))
  return {
    ...rec,
    c: rec.c.map((c) => {
      if (!at.has(c.id)) return c
      const o = at.get(c.id)!
      return c.id === cid ? { ...c, sec: sid, o, u: later(c.u, now) } : c.o !== o ? { ...c, o, u: later(c.u, now) } : c
    })
  }
}

export function deleteCard(rec: Collection, cid: string, now = Date.now()): Collection {
  return { ...rec, c: rec.c.map((c) => (c.id === cid && !c.d ? { id: c.id, sec: "", o: 0, u: later(c.u, now), d: true as const, k: c.k, t: "", at: 0 } : c)) }
}

export function setSummary(rec: Collection, text: string, now = Date.now()): Collection {
  return { ...rec, sum: { t: text.trim().slice(0, 1_000), u: later(rec.sum?.u, now) } }
}

/** «Сравнить»: a table card after the last of the compared cards, in its section. */
export function addComparison(rec: Collection, cid: string, of: string[], table: { h: string[]; r: string[][]; note?: string }, now = Date.now()): Collection {
  const picked = liveCards(rec).filter((c) => of.includes(c.id))
  if (picked.length < 2) return rec
  const sec = picked[picked.length - 1].sec
  const names = picked.map((c) => c.t)
  const added = addCard(rec, { id: cid, sec, k: "compare", t: table.note ?? names.join(" · ").slice(0, MAX_GIST), at: now, tbl: table, of: picked.map((c) => c.id) }, now)
  // Right after the compared cards.
  const last = Math.max(...cardsIn(added, sec).filter((c) => of.includes(c.id)).map((c) => cardsIn(added, sec).indexOf(c)))
  return moveCard(added, cid, sec, last + 1, now)
}

/**
 * The AI's layout: its sections (an existing id, or null for a new one: `newIds` gives it an id) and each card's section
 * by index. The user's own sections are kept; the AI's old ones it didn't keep go when they're left empty.
 */
export function applyLayout(rec: Collection, layout: { sections: Array<{ id: string | null; name: string }>; cards: Array<{ id: string; section: number }> }, newIds: () => string, now = Date.now()): Collection {
  let next = rec
  const ids: string[] = []
  for (const s of layout.sections) {
    if (s.id && liveSections(next).some((x) => x.id === s.id)) ids.push(s.id)
    else {
      const sid = newIds()
      next = addSection(next, sid, s.name, now, true)
      ids.push(sid)
    }
  }
  const counter = new Map<string, number>()
  for (const c of layout.cards) {
    const sid = ids[c.section]
    if (!sid) continue
    const index = counter.get(sid) ?? 0
    counter.set(sid, index + 1)
    next = moveCard(next, c.id, sid, index, now)
  }
  for (const s of liveSections(next)) if (s.ai && !ids.includes(s.id) && cardsIn(next, s.id).length === 0) next = deleteSection(next, s.id, now)
  return next
}

// ------------------------------------------------------------ cards from a chat

/** A card's gist: the text's first sentences without Markdown or citations, up to MAX_GIST characters. */
export function gistOf(text: string): string {
  const raw = stripCitations(text).replace(/```[\s\S]*?```/g, "\n").split("\n")
  const lines: string[] = []
  raw.forEach((line, i) => {
    // A table is no gist; neither is a title line (a heading, or bold alone) with text after it.
    if (/^\s*\|/.test(line)) return
    if (/^\s{0,3}(#{1,6}\s+\S.*|\*\*[^*]+\*\*:?)\s*$/.test(line) && raw.slice(i + 1).some((x) => x.trim() && !/^\s*\|/.test(x))) return
    const plain = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
      .replace(/[*_`~|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
    // Each line or bullet is a sentence of its own.
    if (plain) lines.push(/[.!?。！？:：…]$/.test(plain) ? plain : `${plain}.`)
  })
  const joined = lines.join(" ")
  const plain = joined || stripCitations(text).replace(/[*_`~|#>-]+/g, " ").replace(/\s+/g, " ").trim()
  if (plain.length <= MAX_GIST) return plain
  // Whole sentences from the start (a decimal point isn't the end of one).
  let out = ""
  for (const s of plain.split(/(?<=[.!?])\s+|(?<=[。！？])/)) {
    if ((out ? `${out} ${s}` : s).length > MAX_GIST) break
    out = out ? `${out} ${s}` : s
  }
  return out.length >= 40 ? out : `${plain.slice(0, MAX_GIST - 1).trimEnd()}…`
}

/** The card an answer or a note becomes: its gist, text, page, tags and the way back to its chat. */
export function cardFrom(entries: Entry[], index: number, chat: string, cid: string, sec: string, now = Date.now()): Omit<Card, "o" | "u"> | null {
  const e = entries[index]
  if (!e || (e.role !== "assistant" && !e.note)) return null
  // An answer's page is its question's; a note has only its own («Ваша заметка» otherwise).
  let page = e.page
  for (let i = index - 1; !page && !e.note && i >= 0; i--) if (entries[i].role === "user") page = entries[i].page
  const text = stripCitations(e.content).slice(0, MAX_CARD_TEXT)
  const tags = e.tags?.filter(Boolean).slice(0, 10) ?? []
  return {
    id: cid, sec, k: e.note ? "note" : "answer", t: gistOf(e.content), x: text, at: e.t ?? now,
    ...(page?.url && /^https?:\/\//i.test(page.url) ? { src: { url: page.url, title: clean(page.title, 200) } } : {}),
    ...(tags.length ? { tags } : {}),
    chat, msg: entryKey(e)
  }
}

// ------------------------------------------------------------ «В подборку» by words (Free, and when the AI can't)

function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of unaccent(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []) if (!/^\d+$/.test(w)) out.add(w)
  return out
}

/**
 * Where a card goes by words, on the device: the collection and section whose name and cards share most of the card's
 * words (its gist and page title). The best section of the best collection; that collection's first section when no
 * section shares any. Null with no collections.
 */
export function suggestPlace(collections: Collection[], card: { t: string; src?: { title: string } }): { collection: string; section: string | null; score: number } | null {
  const mine = words(`${card.t} ${card.src?.title ?? ""}`)
  let best: { collection: string; section: string | null; score: number } | null = null
  for (const rec of collections) {
    if (rec.d) continue
    const sections = liveSections(rec)
    let top: { section: string | null; score: number } = { section: sections[0]?.id ?? null, score: 0 }
    for (const s of sections) {
      const theirs = words([s.n, ...cardsIn(rec, s.id).map((c) => `${c.t} ${c.src?.title ?? ""}`)].join(" "))
      let n = 0
      for (const w of mine) if (theirs.has(w)) n++
      const score = mine.size ? n / mine.size : 0
      if (score > top.score) top = { section: s.id, score }
    }
    const nameHits = [...words(rec.n)].filter((w) => mine.has(w)).length
    const score = top.score + nameHits * 0.1
    if (!best || score > best.score) best = { collection: rec.id, section: top.section, score }
  }
  return best
}

// ------------------------------------------------------------ «В подборку» with the AI (Pro): what it's shown, what it says

/** A page's host without "www.", for a card's source line and the AI's view of it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** What the AI is shown to place a card: the card, and the space's collections with their sections and gists. */
export function placeBody(card: Pick<Card, "t" | "x" | "src">, shown: Collection[], lang: string): Record<string, unknown> {
  return {
    card: { gist: card.t, text: card.x ?? "", title: card.src?.title ?? "", site: card.src ? hostOf(card.src.url) : "" },
    collections: shown.slice(0, 20).map((c) => ({
      id: c.id, name: c.n,
      sections: liveSections(c).map((s) => ({ id: s.id, name: s.n, cards: cardsIn(c, s.id).slice(0, 8).map((x) => x.t) }))
    })),
    lang
  }
}

/** A suggestion in the sheet: an existing section, a new section in a collection, or a new collection. */
export interface Place {
  collection: string | null
  section: string | null
  newSection?: string
  newCollection?: string
  by: "ai" | "words"
}

/** The AI's answer as a place among `shown` (ids it didn't get are dropped), or null. */
export function placeFromAi(body: Record<string, unknown>, shown: Collection[]): Place | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const rec = shown.find((c) => c.id === body.collection)
  if (rec) {
    const sec = liveSections(rec).find((s) => s.id === body.section)
    if (sec) return { collection: rec.id, section: sec.id, by: "ai" }
    const name = str(body.newSection)
    return name ? { collection: rec.id, section: null, newSection: name, by: "ai" } : null
  }
  const named = str(body.newCollection)
  return named ? { collection: null, section: null, newCollection: named, newSection: str(body.newSection), by: "ai" } : null
}
