// Chats as threads: several conversations, each continued from any page, tab or device until the
// user starts a new one. Pure helpers shared by the content script, the background and tests.

import { entriesFrom, entryKey, entryTimes, MAX_SAVED_PAGE_CHARS, stripCitations, withoutText, withPageChanges, type Entry } from "./conversation.ts"
import type { ChatDigest } from "./history.ts"

export interface Thread {
  id: string
  u: number // last change (ms), decides which copy wins between devices
  m: Entry[]
  a?: number // last message (ms): the list order; renaming changes `u` only (missing = `u`)
  title?: string // set by the user; otherwise the first question names the chat
  pin?: number // pinned: its place among the pinned chats at the top of the list (lower first)
  kind?: "history" // "Ask your chats" (Pro): questions about all the other chats, not a page
  tags?: string[] // the user's tags for the chat (answers and notes have their own, on the entry)
  deleted?: boolean // kept until iCloud knows, so the deletion reaches the other devices
}

export type Threads = Record<string, Thread>

/** The thread this device shows, and when it was picked (a newer thread from another device takes over). */
export interface ActiveThread {
  id: string
  at: number
}

/** A thread as iCloud stores it (`data` is the JSON conversation), or its deletion. */
export type CloudChange = { id: string; updatedAt: number; data: string } | { id: string; deleted: true }

export const MAX_THREADS = 50
export const MAX_TITLE = 80
// Per thread: many threads come down in one sync, so they stay well under a CloudKit record's 1 MB
// (room for the messages and the texts of 10 pages).
const CLOUD_MAX_CHARS = 200_000
// Page texts kept on this device across all chats; beyond it the older chats keep theirs only in iCloud.
export const MAX_SAVED_TEXT_CHARS = 2_000_000

export function newThreadId(): string {
  return crypto.randomUUID()
}

/** When the thread last got a message. */
export function activity(thread: Thread): number {
  return thread.a ?? thread.u
}

/** Threads that still exist, the last one written in first. */
export function liveThreads(threads: Threads): Thread[] {
  return Object.values(threads).filter((t) => !t.deleted && t.m.length > 0).sort((a, b) => activity(b) - activity(a))
}

/** The list of chats: pinned ones first in their order, then the others, the last one written in first. */
export function chatList(threads: Threads): Thread[] {
  const live = liveThreads(threads)
  return [...live.filter((t) => t.pin !== undefined).sort((a, b) => a.pin! - b.pin!), ...live.filter((t) => t.pin === undefined)]
}

/** The pin value that puts a chat at `index` among `pinned` (the other pinned chats, in list order). */
export function pinAt(pinned: Thread[], index: number): number {
  const before = pinned[index - 1]?.pin
  const after = pinned[index]?.pin
  if (before === undefined) return after === undefined ? 0 : after - 1
  return after === undefined ? before + 1 : (before + after) / 2
}

/** The pages the chat was on, in the order it first came to them. */
export function threadPages(entries: Entry[]): Array<{ url: string; title: string }> {
  const pages = new Map<string, string>()
  for (const e of entries) if (e.role === "user" && e.page && !pages.has(e.page.url)) pages.set(e.page.url, e.page.title)
  return [...pages].map(([url, title]) => ({ url, title }))
}

/** How many notes the user wrote in the chat. */
export function threadNotes(entries: Entry[]): number {
  return entries.filter((e) => e.note).length
}

/** The chat's name: the user's, or its first question. */
export function threadName(thread: Thread): string {
  return thread.title || threadTitle(thread.m)
}

/** A name the user typed, cleaned up; empty means "name it after the first question again". */
export function cleanTitle(text: string): string {
  return oneLine(text, MAX_TITLE)
}

/** A short name for the list: the first question (or quick action and its page). */
export function threadTitle(entries: Entry[]): string {
  const first = entries.find((e) => e.role === "user")
  if (!first) return ""
  const text = first.label ? (first.page?.title ? `${first.label} · ${first.page.title}` : first.label) : first.content
  return oneLine(text, 80)
}

/** The last answer's first line, for the list. */
export function threadSnippet(entries: Entry[]): string {
  const last = [...entries].reverse().find((e) => e.role === "assistant") ?? entries[entries.length - 1]
  return last ? oneLine(stripCitations(last.content).replace(/[*_`]+/g, "").replace(/[#>|]+/g, " "), 120) : ""
}

/** Host of the last page asked about in the thread. */
export function threadSite(entries: Entry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const url = entries[i].page?.url
    if (url) {
      try {
        return new URL(url).hostname.replace(/^www\./, "")
      } catch {
        return ""
      }
    }
  }
  return ""
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * The thread with new messages as of `now`: its name, pin, tags and kind stay (a deleted thread
 * comes back as a new one). `kind` marks a new "Ask your chats" thread.
 */
export function withMessages(stored: Thread | undefined, id: string, m: Entry[], now: number, kind?: "history"): Thread {
  const keep = stored && !stored.deleted ? stored : undefined
  const keptKind = keep?.kind ?? kind
  return {
    id, u: now, a: now, m,
    ...(keep?.title ? { title: keep.title } : {}),
    ...(keep?.pin !== undefined ? { pin: keep.pin } : {}),
    ...(keep?.tags?.length ? { tags: keep.tags } : {}),
    ...(keptKind ? { kind: keptKind } : {})
  }
}

/**
 * Keeps pinned threads and the newest MAX_THREADS; older ones become deletions so iCloud drops them too.
 * Page texts stay within `maxText` characters on this device, the pinned and latest chats first.
 */
export function prune(threads: Threads, now = Date.now(), maxText = MAX_SAVED_TEXT_CHARS): Threads {
  const list = chatList(threads)
  const keep = new Set(list.slice(0, MAX_THREADS).map((t) => t.id))
  const out: Threads = {}
  for (const t of Object.values(threads)) {
    if (t.deleted || keep.has(t.id) || t.m.length === 0) out[t.id] = t
    else out[t.id] = { id: t.id, u: now, m: [], deleted: true }
  }
  let size = 0
  for (const t of list) {
    if (!keep.has(t.id)) continue
    const text = t.m.reduce((n, e) => n + (e.page?.text?.length ?? 0), 0)
    // Only this device's copy changes (its time stays): iCloud keeps the texts it has.
    if (text && size + text > maxText) out[t.id] = { ...t, m: t.m.map(withoutText) }
    else size += text
  }
  return out
}

/**
 * Local changes iCloud doesn't have yet. `synced` holds, per thread, the time of the copy iCloud
 * has (sent or received); a deletion is only sent for a thread iCloud knows.
 */
export function pendingChanges(threads: Threads, synced: Record<string, number>): CloudChange[] {
  const out: CloudChange[] = []
  for (const t of Object.values(threads)) {
    if (t.deleted) {
      if (t.id in synced) out.push({ id: t.id, deleted: true })
    } else if (t.m.length > 0 && t.u > (synced[t.id] ?? 0)) {
      out.push({ id: t.id, updatedAt: t.u, data: threadForCloud(t) })
    }
  }
  return out
}

/**
 * A thread as iCloud stores it: JSON with its messages and, when set, its name and the time of its
 * last message. If it would not fit, the oldest page texts go first, then the oldest messages.
 */
export function threadForCloud(thread: Thread, maxChars = CLOUD_MAX_CHARS): string {
  const meta = {
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.a !== undefined && thread.a !== thread.u ? { a: thread.a } : {}),
    ...(thread.pin !== undefined ? { pin: thread.pin } : {}),
    ...(thread.kind ? { k: thread.kind } : {}),
    ...(thread.tags?.length ? { tags: thread.tags } : {})
  }
  let m = thread.m
  let data = JSON.stringify({ ...meta, m })
  while (data.length > maxChars && m.length) {
    const oldest = m.findIndex((e) => e.page?.text)
    m = oldest >= 0 ? m.map((e, i) => (i === oldest ? withoutText(e) : e)) : m.slice(1)
    data = JSON.stringify({ ...meta, m })
  }
  return data
}

/** A thread read back from iCloud (2.3 build 56 stored just the messages), or null if it isn't one. */
export function threadFromCloud(data: string): Pick<Thread, "m" | "a" | "title" | "pin" | "kind" | "tags"> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    const m = entriesFrom(parsed)
    return m && { m }
  }
  if (parsed === null || typeof parsed !== "object") return null
  const { m: raw, a, title, pin, k, tags } = parsed as Record<string, unknown>
  const m = entriesFrom(raw)
  if (!m) return null
  return {
    m,
    ...(typeof a === "number" ? { a } : {}),
    ...(typeof title === "string" && title.trim() ? { title: cleanTitle(title) } : {}),
    ...(typeof pin === "number" && Number.isFinite(pin) ? { pin } : {}),
    ...(k === "history" ? { kind: "history" as const } : {}),
    ...(Array.isArray(tags) && cleanTags(tags).length ? { tags: cleanTags(tags) } : {})
  }
}

/** After a sync: what was sent is in iCloud now; deletions iCloud confirmed are forgotten. */
export function markSent(threads: Threads, synced: Record<string, number>, sent: CloudChange[]): { threads: Threads; synced: Record<string, number> } {
  const nextThreads = { ...threads }
  const nextSynced = { ...synced }
  for (const c of sent) {
    if ("deleted" in c) {
      delete nextSynced[c.id]
      if (nextThreads[c.id]?.deleted) delete nextThreads[c.id]
    } else {
      nextSynced[c.id] = c.updatedAt
    }
  }
  // A deletion of a thread iCloud never had needs no message.
  for (const t of Object.values(nextThreads)) if (t.deleted && !(t.id in nextSynced)) delete nextThreads[t.id]
  return { threads: nextThreads, synced: nextSynced }
}

/**
 * Applies what iCloud reports; a local copy changed after the remote one stays (it goes up next). Then
 * the sweep for moved messages (sweepMoved): an older copy of a chat may have brought one back.
 */
export function applyRemote(
  threads: Threads,
  synced: Record<string, number>,
  changed: { id: string; updatedAt: number; data: string }[],
  deleted: string[],
  now = Date.now()
): { threads: Threads; synced: Record<string, number>; changed: boolean } {
  const nextThreads = { ...threads }
  const nextSynced = { ...synced }
  let touched = false
  for (const r of changed) {
    nextSynced[r.id] = Math.max(nextSynced[r.id] ?? 0, r.updatedAt)
    const local = nextThreads[r.id]
    if (local && local.u >= r.updatedAt) continue
    const remote = threadFromCloud(r.data)
    if (!remote) continue
    nextThreads[r.id] = { id: r.id, u: r.updatedAt, ...remote }
    touched = true
  }
  for (const id of deleted) {
    delete nextSynced[id]
    if (nextThreads[id]) {
      delete nextThreads[id]
      touched = true
    }
  }
  if (!touched) return { threads: nextThreads, synced: nextSynced, changed: false }
  return { threads: sweepMoved(nextThreads, nextSynced, now).threads, synced: nextSynced, changed: true }
}

/**
 * The thread to show when the panel opens: the one picked on this device, unless another device
 * continued a different chat after that (so a chat started on the iPhone opens on the Mac).
 */
export function shownThread(threads: Threads, active: ActiveThread): { id: string; m: Entry[] } {
  const current = threads[active.id]
  const own = current && !current.deleted ? current : undefined
  const latest = liveThreads(threads)[0]
  if (latest && latest.id !== active.id && activity(latest) > Math.max(active.at, own ? activity(own) : 0)) return { id: latest.id, m: latest.m }
  return { id: active.id, m: own?.m ?? [] }
}

// ------------------------------------------------------------ the copy the ContextFlow app reads

/**
 * What the app's copy of the chats (App Group, see ChatMirror.swift) lacks: threads changed since
 * `mirrored` (the time of each thread the app has), and deletions of threads it has that are gone here.
 * Unlike iCloud, the app gets every chat, synced or not, at most `maxChars` of data in one go.
 */
export function mirrorChanges(threads: Threads, mirrored: Record<string, number>, maxChars = 900_000): CloudChange[] {
  const out: CloudChange[] = []
  let size = 0
  for (const id of Object.keys(mirrored)) {
    const t = threads[id]
    if (!t || t.deleted || t.m.length === 0) out.push({ id, deleted: true })
  }
  for (const t of liveThreads(threads)) {
    if (t.u <= (mirrored[t.id] ?? 0)) continue
    const data = threadForCloud(t)
    if (size > 0 && size + data.length > maxChars) break
    size += data.length
    out.push({ id: t.id, updatedAt: t.u, data })
  }
  return out
}

/** After the app has `sent`: the time of each thread it now has. */
export function markMirrored(mirrored: Record<string, number>, sent: CloudChange[]): Record<string, number> {
  const next = { ...mirrored }
  for (const c of sent) {
    if ("deleted" in c) delete next[c.id]
    else next[c.id] = c.updatedAt
  }
  return next
}

/**
 * Changes made in the ContextFlow app (renamed, pinned, deleted chats, messages moved): a newer copy
 * replaces this one; a deletion keeps a tombstone for a thread iCloud has, so the other devices hear
 * about it. Unlike applyRemote, iCloud doesn't have these yet: they go up with the next sync. Then the
 * sweep for moved messages, as after iCloud.
 */
export function applyAppChanges(threads: Threads, synced: Record<string, number>, changes: CloudChange[], now = Date.now()): { threads: Threads; changed: boolean } {
  const next = { ...threads }
  let changed = false
  for (const c of changes) {
    const local = next[c.id]
    if ("deleted" in c) {
      if (!local || local.deleted) continue
      if (c.id in synced) next[c.id] = { id: c.id, u: now, m: [], deleted: true }
      else delete next[c.id]
      changed = true
      continue
    }
    if (local && local.u >= c.updatedAt) continue
    const app = threadFromCloud(c.data)
    if (!app) continue
    next[c.id] = { id: c.id, u: c.updatedAt, ...app }
    changed = true
  }
  return { threads: changed ? sweepMoved(next, synced, now).threads : next, changed }
}

// ------------------------------------------------------------ organizing: page blocks and moving them

/**
 * A run of messages on one page (`start`…`end`, inclusive): its questions and answers and the notes
 * written there. A question or note on another page starts the next block; a note without a page is a
 * block of its own; a question without a page (asked in the app about the chat) stays with the block
 * before it.
 */
export interface PageBlock {
  start: number
  end: number
  url: string | null
}

export function pageBlocks(entries: Entry[]): PageBlock[] {
  const blocks: PageBlock[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const url = e.page?.url ?? null
    const current = blocks[blocks.length - 1]
    if (current && !(e.role === "user" && ((e.note && !url) || (url !== null && url !== current.url)))) current.end = i
    else blocks.push({ start: i, end: i, url })
  }
  return blocks
}

/** What a move changed, so "Undo" can put it back. */
export interface MoveUndo {
  source: string
  target: string
  // The moved messages' keys (entryKey).
  keys: string[]
  // Both chats before the move (target null: the move made it) and after it (source null: deleted).
  before: { source: Thread; target: Thread | null }
  after: { source: Thread | null; target: Thread }
}

/** Where messages written at `time` go among `entries`: after the last turn written by then (null: before any time). */
function insertAt(entries: Entry[], time: number | null): number {
  const times = entryTimes(entries)
  let at = 0
  times.forEach((t, i) => {
    if (t === null || (time !== null && t <= time)) at = i + 1
  })
  // Not between a question and its answer.
  while (at < entries.length && entries[at].role === "assistant") at++
  return at
}

/**
 * The block's messages with their page's text on the first of them on each page, when the source keeps
 * that text on another message and neither the block nor the target has it.
 */
function withPageText(block: Entry[], source: Entry[], target: Entry[]): Entry[] {
  const key = (e: Entry) => `${e.page!.url}\u0000${e.page!.hash ?? ""}`
  const has = (list: Entry[], k: string) => list.some((e) => e.page?.text && key(e) === k)
  const done = new Set<string>()
  return block.map((e) => {
    if (e.role !== "user" || !e.page) return e
    const k = key(e)
    if (done.has(k)) return e
    done.add(k)
    if (has(block, k) || has(target, k)) return e
    const text = [...source].reverse().find((x) => x.page?.text && key(x) === k)?.page?.text
    return text ? { ...e, page: { ...e.page, text: text.slice(0, MAX_SAVED_PAGE_CHARS) } } : e
  })
}

/** A chat without messages: gone, as a deletion for iCloud when iCloud has it. */
function emptied(next: Threads, id: string, synced: Record<string, number>, now: number): void {
  if (id in synced) next[id] = { id, u: Math.max(now, (next[id]?.u ?? 0) + 1), m: [], deleted: true }
  else delete next[id]
}

/** The time a changed copy of `thread` gets: now, and always later than the copy it replaces. */
function later(thread: Thread | undefined, now: number): number {
  return Math.max(now, (thread?.u ?? 0) + 1)
}

/**
 * Moves messages `start`…`end` of chat `sourceId` (a page block, or several in a row) to chat
 * `targetId`, or to a new chat when no chat has that id. They go in among the target's messages by when
 * they were written (after the last turn written before them), keep their ids (messages from before
 * 2.5 get theirs now, from their content) and say where they came from (`from`). The block takes its
 * page's text along when the source keeps it on an earlier message. The target's time of last message
 * changes only when the block is newer; the source's becomes that of its last message left. A source
 * left empty is deleted. Null when it can't be moved ("Ask your chats", the same chat, a wrong range).
 */
export function moveEntries(
  threads: Threads,
  synced: Record<string, number>,
  sourceId: string,
  start: number,
  end: number,
  targetId: string,
  now = Date.now()
): { threads: Threads; undo: MoveUndo } | null {
  const source = threads[sourceId]
  const stored = threads[targetId]
  const target = stored && !stored.deleted ? stored : undefined
  if (!source || source.deleted || source.kind === "history" || target?.kind === "history" || sourceId === targetId) return null
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= source.m.length) return null
  const times = entryTimes(source.m)
  const into = target?.m ?? []
  const moved = withPageText(source.m.slice(start, end + 1), source.m, into)
    .map((e) => ({ ...e, id: entryKey(e), from: { chat: sourceId, at: now } }))
  const rest = withPageChanges([...source.m.slice(0, start), ...source.m.slice(end + 1)])
  const at = insertAt(into, times[start])
  const newest = times[end]
  const m = withPageChanges([...into.slice(0, at), ...moved, ...into.slice(at)])
  const nextTarget: Thread = target
    ? { ...target, u: later(stored, now), a: newest !== null && newest > activity(target) ? newest : activity(target), m }
    : { id: targetId, u: later(stored, now), a: newest ?? activity(source), m }
  const next: Threads = { ...threads, [targetId]: nextTarget }
  if (rest.length) next[sourceId] = { ...source, u: later(source, now), a: entryTimes(rest).at(-1) ?? activity(source), m: rest }
  else emptied(next, sourceId, synced, now)
  return {
    threads: next,
    undo: {
      source: sourceId,
      target: targetId,
      keys: moved.map((e) => e.id),
      before: { source, target: target ?? null },
      after: { source: next[sourceId] && !next[sourceId].deleted ? next[sourceId] : null, target: nextTarget }
    }
  }
}

/**
 * Puts moved messages back. When neither chat changed since the move, both are as they were before it;
 * otherwise the messages (by key) go from the target back among the source's by time, without `from`.
 * A chat the move made, or emptied, is deleted or brought back.
 */
export function undoMove(threads: Threads, synced: Record<string, number>, undo: MoveUndo, now = Date.now()): Threads {
  const mark = (t: Thread | null | undefined) => (t && !t.deleted ? `${t.u}:${t.m.length}` : "-")
  const source = threads[undo.source]
  const target = threads[undo.target]
  const next: Threads = { ...threads }
  if (mark(source) === mark(undo.after.source) && mark(target) === mark(undo.after.target)) {
    next[undo.source] = { ...undo.before.source, u: later(source, now) }
    if (undo.before.target) next[undo.target] = { ...undo.before.target, u: later(target, now) }
    else emptied(next, undo.target, synced, now)
    return next
  }
  if (!target || target.deleted) return threads
  const keys = new Set(undo.keys)
  const back = target.m.filter((e) => keys.has(entryKey(e))).map(({ from: _from, ...e }) => e as Entry)
  if (!back.length) return threads
  const left = withPageChanges(target.m.filter((e) => !keys.has(entryKey(e))))
  // The move emptied the source: it comes back with its name, pin and tags.
  const base: Thread = source && !source.deleted ? source : { ...undo.before.source, m: [] }
  const at = insertAt(base.m, entryTimes(back)[0])
  const m = withPageChanges([...base.m.slice(0, at), ...back, ...base.m.slice(at)])
  const newest = entryTimes(back).at(-1) ?? null
  next[undo.source] = { ...base, u: later(source, now), a: newest !== null && newest > activity(base) ? newest : activity(base), m }
  if (left.length) next[undo.target] = { ...target, u: later(target, now), m: left }
  else emptied(next, undo.target, synced, now)
  return next
}

/**
 * The sweep after changes from iCloud or the app. A moved message lives where its latest move put it:
 * the copy in the chat it was moved from (brought back by a device that wrote that chat before it heard
 * of the move, or by one still on 2.4) and copies left by older moves are removed. Nothing else is: a
 * message is only removed where another copy of it says it came from. Changed chats get the time `now`
 * (they go up to iCloud); one left empty is deleted.
 */
export function sweepMoved(threads: Threads, synced: Record<string, number>, now = Date.now()): { threads: Threads; changed: boolean } {
  const latest = new Map<string, { thread: string; from: string; at: number }>()
  const live = Object.values(threads).filter((t) => !t.deleted)
  for (const t of live) {
    for (const e of t.m) {
      if (!e.from) continue
      const key = entryKey(e)
      const seen = latest.get(key)
      if (!seen || e.from.at > seen.at || (e.from.at === seen.at && t.id < seen.thread)) latest.set(key, { thread: t.id, from: e.from.chat, at: e.from.at })
    }
  }
  if (!latest.size) return { threads, changed: false }
  const next: Threads = { ...threads }
  let changed = false
  for (const t of live) {
    const kept = t.m.filter((e) => {
      const move = latest.get(entryKey(e))
      return !move || move.thread === t.id || (t.id !== move.from && !e.from)
    })
    if (kept.length === t.m.length) continue
    changed = true
    if (kept.length) next[t.id] = { ...t, u: later(t, now), a: activity(t), m: withPageChanges(kept) }
    else emptied(next, t.id, synced, now)
  }
  return { threads: changed ? next : threads, changed }
}

// ------------------------------------------------------------ search

/** Where a chat matched a search: the chat's name, a message, or a page it was on. */
export interface SearchHit {
  // The message (index in the chat), or -1 for the name, -2 for a page.
  at: number
  // A short excerpt around the first matched word, and where the words are in it.
  excerpt: string
  marks: Array<[number, number]>
}

export interface SearchResult {
  thread: Thread
  hits: SearchHit[]
}

/**
 * Folded for matching, the same length as `text` (positions carry over to the original): lower case,
 * Latin letters without accents (é → e), ё → е, any space a plain space.
 */
export function foldText(text: string): string {
  let out = ""
  for (const ch of text) {
    let f = /\s/.test(ch) ? " " : ch.toLowerCase()
    if (/[À-ɏ]/.test(f)) f = f.normalize("NFD").replace(/[̀-ͯ]/g, "")
    if (f === "ё") f = "е"
    out += f.length === ch.length ? f : ch
  }
  return out
}

/** The words of a query (quotes keep a phrase together). */
export function queryWords(query: string): string[] {
  const words: string[] = []
  for (const m of foldText(query).matchAll(/"([^"]+)"|(\S+)/g)) {
    const word = (m[1] ?? m[2]).trim()
    if (word) words.push(word)
  }
  return words
}

/** An excerpt of `text` around `start`, at most `size` long, with the words in it marked. */
function excerpt(text: string, folded: string, words: string[], start: number, size = 120): Omit<SearchHit, "at"> {
  const from = Math.max(0, Math.min(start - Math.floor(size / 3), text.length - size))
  const to = Math.min(text.length, from + size)
  const lead = from > 0 ? "…" : ""
  const piece = text.slice(from, to).replace(/\s/g, " ")
  const marks: Array<[number, number]> = []
  const window = folded.slice(from, to)
  for (const word of words) {
    let i = window.indexOf(word)
    while (i >= 0) {
      marks.push([lead.length + i, lead.length + i + word.length])
      i = window.indexOf(word, i + word.length)
    }
  }
  marks.sort((a, b) => a[0] - b[0])
  return { excerpt: lead + piece + (to < text.length ? "…" : ""), marks }
}

const plain = (text: string) => stripCitations(text).replace(/[*_`#>|]+/g, "")

/**
 * Chats with every word of `query` (in its name, messages, notes or page titles together), the best
 * first: those named after it, then those where the words meet in one message; then by recent activity.
 * Each comes with up to `maxHits` places that matched.
 */
export function searchThreads(threads: Thread[], query: string, maxHits = 3): SearchResult[] {
  const words = queryWords(query)
  if (!words.length) return []
  const scored: Array<{ result: SearchResult; score: number }> = []
  for (const thread of threads) {
    const name = threadName(thread)
    const fields: Array<{ at: number; text: string }> = [{ at: -1, text: name }]
    thread.m.forEach((e, i) => fields.push({ at: i, text: plain(e.label ? `${e.label} ${e.content}` : e.content) }))
    for (const page of threadPages(thread.m)) fields.push({ at: -2, text: `${page.title} ${page.url}` })
    const tags = threadTags(thread)
    if (tags.length) fields.push({ at: -3, text: tags.map((tag) => `#${tag}`).join(" ") })
    const folded = fields.map((f) => foldText(f.text))
    // Every word somewhere in the chat.
    if (!words.every((w) => folded.some((f) => f.includes(w)))) continue
    const hits: SearchHit[] = []
    let named = 0
    let together = false
    fields.forEach((field, i) => {
      const present = words.filter((w) => folded[i].includes(w))
      if (!present.length) return
      if (field.at === -1) named = present.length
      if (present.length === words.length) together = true
      // The first question is already the chat's name in the list.
      if (hits.length < maxHits && field.at !== -1 && field.text.replace(/\s+/g, " ").trim() !== name) {
        const first = Math.min(...present.map((w) => folded[i].indexOf(w)))
        hits.push({ at: field.at, ...excerpt(field.text, folded[i], present, first) })
      }
    })
    scored.push({ result: { thread, hits }, score: named * 100 + (together ? 10 : 0) })
  }
  return scored.sort((a, b) => b.score - a.score || activity(b.result.thread) - activity(a.result.thread)).map((s) => s.result)
}

// ------------------------------------------------------------ digests for the Pro features

/**
 * The chats as the model gets them for "Ask your chats" and AI search (src/shared/history.ts): newest
 * first, "Ask your chats" chats left out, each with its pages, questions, answers and notes, cut to
 * `perChat` characters (`perAnswer` per answer), all together at most `total`.
 */
export function chatDigests(threads: Thread[], opts: { perChat: number; perAnswer: number; total: number }): ChatDigest[] {
  const out: ChatDigest[] = []
  let size = 0
  for (const thread of liveThreads(Object.fromEntries(threads.map((t) => [t.id, t])))) {
    if (thread.kind === "history") continue
    const lines: string[] = []
    const pages = threadPages(thread.m)
    if (pages.length) lines.push(`Pages: ${pages.map((p) => `${p.title || p.url} (${p.url})`).join("; ")}`)
    for (const e of thread.m) {
      const text = stripCitations(e.content).replace(/\s+/g, " ").trim()
      if (e.note) lines.push(`Note: ${text.slice(0, opts.perAnswer)}`)
      else if (e.role === "user") lines.push(`Q: ${(e.label ?? text).slice(0, 300)}`)
      else lines.push(`A: ${text.slice(0, opts.perAnswer)}${text.length > opts.perAnswer ? "…" : ""}`)
    }
    let text = lines.join("\n").slice(0, opts.perChat)
    if (size + text.length > opts.total) text = text.slice(0, Math.max(0, opts.total - size))
    if (text.length < 40) break
    size += text.length
    out.push({ id: thread.id, title: threadName(thread), date: new Date(activity(thread)).toISOString(), text })
  }
  return out
}

// ------------------------------------------------------------ tags

export const MAX_TAG = 24
const MAX_TAGS = 8

/** A tag as typed, cleaned: no leading #, one space between words, at most MAX_TAG characters. */
export function cleanTag(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").slice(0, MAX_TAG).trim()
}

/** Tags cleaned and without repeats (case ignored, the first spelling kept), at most MAX_TAGS. */
export function cleanTags(raw: unknown[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    const tag = typeof item === "string" ? cleanTag(item) : ""
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag)
  }
  return out.slice(0, MAX_TAGS)
}

/** The chat's tags and those of its answers and notes, without repeats. */
export function threadTags(thread: Thread): string[] {
  return cleanTags([...(thread.tags ?? []), ...thread.m.flatMap((e) => e.tags ?? [])])
}

/** Every tag in use, the most used first (then by name), each with how many chats have it. */
export function allTags(threads: Thread[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const thread of threads) {
    for (const tag of threadTags(thread)) {
      const key = tag.toLowerCase()
      const hit = counts.get(key)
      if (hit) hit.count += 1
      else counts.set(key, { tag, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** True when the chat (or one of its answers or notes) has `tag`. */
export function hasTag(thread: Thread, tag: string): boolean {
  const key = tag.toLowerCase()
  return threadTags(thread).some((t) => t.toLowerCase() === key)
}

/**
 * The list in groups by tag, like folders: each tag in use (in allTags order) with its chats in list
 * order, then the chats without tags. A chat with two tags is in both groups.
 */
export function groupByTag(threads: Thread[]): Array<{ tag: string | null; threads: Thread[] }> {
  const groups: Array<{ tag: string | null; threads: Thread[] }> = allTags(threads).map(({ tag }) => ({ tag, threads: threads.filter((t) => hasTag(t, tag)) }))
  const untagged = threads.filter((t) => threadTags(t).length === 0)
  if (untagged.length) groups.push({ tag: null, threads: untagged })
  return groups
}

/** A colour for a tag (one of 8), the same everywhere for the same name. */
export function tagColor(tag: string): number {
  let hash = 0
  for (const ch of tag.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return hash % 8
}
