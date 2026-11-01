// Chats as threads: several conversations, each continued from any page, tab or device until the
// user starts a new one. Pure helpers shared by the content script, the background and tests.

import { entriesFrom, stripCitations, type Entry } from "./conversation.ts"

export interface Thread {
  id: string
  u: number // last change (ms), decides which copy wins between devices
  m: Entry[]
  a?: number // last message (ms): the list order; renaming changes `u` only (missing = `u`)
  title?: string // set by the user; otherwise the first question names the chat
  pin?: number // pinned: its place among the pinned chats at the top of the list (lower first)
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
// Per thread: many threads come down in one sync, so they stay well under a CloudKit record's 1 MB.
const CLOUD_MAX_CHARS = 120_000

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

/** Keeps pinned threads and the newest MAX_THREADS; older ones become deletions so iCloud drops them too. */
export function prune(threads: Threads, now = Date.now()): Threads {
  const keep = new Set(chatList(threads).slice(0, MAX_THREADS).map((t) => t.id))
  const out: Threads = {}
  for (const t of Object.values(threads)) {
    if (t.deleted || keep.has(t.id) || t.m.length === 0) out[t.id] = t
    else out[t.id] = { id: t.id, u: now, m: [], deleted: true }
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
 * last message, dropping the oldest messages if it would not fit.
 */
export function threadForCloud(thread: Thread, maxChars = CLOUD_MAX_CHARS): string {
  const meta = {
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.a !== undefined && thread.a !== thread.u ? { a: thread.a } : {}),
    ...(thread.pin !== undefined ? { pin: thread.pin } : {})
  }
  let start = 0
  let data = JSON.stringify({ ...meta, m: thread.m })
  while (data.length > maxChars && start < thread.m.length) {
    start += 1
    data = JSON.stringify({ ...meta, m: thread.m.slice(start) })
  }
  return data
}

/** A thread read back from iCloud (2.3 build 56 stored just the messages), or null if it isn't one. */
export function threadFromCloud(data: string): Pick<Thread, "m" | "a" | "title" | "pin"> | null {
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
  const { m: raw, a, title, pin } = parsed as Record<string, unknown>
  const m = entriesFrom(raw)
  if (!m) return null
  return {
    m,
    ...(typeof a === "number" ? { a } : {}),
    ...(typeof title === "string" && title.trim() ? { title: cleanTitle(title) } : {}),
    ...(typeof pin === "number" && Number.isFinite(pin) ? { pin } : {})
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

/** Applies what iCloud reports; a local copy changed after the remote one stays (it goes up next). */
export function applyRemote(
  threads: Threads,
  synced: Record<string, number>,
  changed: { id: string; updatedAt: number; data: string }[],
  deleted: string[]
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
  return { threads: nextThreads, synced: nextSynced, changed: touched }
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
 * Changes made in the ContextFlow app (renamed, pinned, deleted chats): a newer copy replaces this
 * one; a deletion keeps a tombstone for a thread iCloud has, so the other devices hear about it.
 * Unlike applyRemote, iCloud doesn't have these yet: they go up with the next sync.
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
  return { threads: next, changed }
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
