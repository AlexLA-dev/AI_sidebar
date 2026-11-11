// Chats as threads: several conversations, each continued from any page, tab or device until the
// user starts a new one. Pure helpers shared by the content script, the background and tests.

import { entriesFrom, entryKey, entryTimes, MAX_SAVED_PAGE_CHARS, stripCitations, trimSavedPages, withoutText, withPageChanges, type Entry } from "./conversation.ts"
import { marksLine } from "./marks.ts"
import { unaccent } from "./fold.ts"
import type { ChatDigest } from "./history.ts"

export interface Thread {
  id: string
  u: number // last change (ms), decides which copy wins between devices
  m: Entry[]
  a?: number // last message (ms): the list order; renaming changes `u` only (missing = `u`)
  title?: string // set by the user, or by the AI (aiTitle); otherwise the first question names the chat
  // The name the AI gave it ("Name by topic", or renamed as its topic changed; 2.6). While `title` is still this one,
  // the AI may name it again; a name the user typed differs from it, and the AI never touches that one.
  aiTitle?: string
  // What organizing suggested for this chat, with it so every device shows it at once and knows what was turned down
  // (2.6 (93); iCloud "org"). See OrgState.
  org?: OrgState
  pin?: number // pinned: its place among the pinned chats at the top of the list (lower first)
  kind?: "history" // "Ask your chats" (Pro): questions about all the other chats, not a page
  tags?: string[] // the user's tags for the chat (answers and notes have their own, on the entry)
  deleted?: boolean // kept until iCloud knows, so the deletion reaches the other devices
  trashed?: number // in Recently Deleted since then (ms): hidden everywhere, deleted for good TRASH_DAYS later
  // Fields of the iCloud copy this version doesn't know (a newer version wrote them): kept as they came, so they go
  // back with the chat instead of being dropped on the next save.
  x?: Record<string, unknown>
  // On this device only (2.6 (94)): changed since its copy of time `b` (in sync with iCloud then) only in organizing's
  // record, while `u` is still this one. Such a change never replaces a copy another device wrote since (ChatSync.swift
  // `base`): build 93's stale suggestions record put back the old name of a chat renamed on another device.
  ob?: { u: number; b: number }
}

export type Threads = Record<string, Thread>

/**
 * Organizing's suggestions for a chat, kept with it (2.6 (93)): worked out when the chat had `n` messages, the last one
 * `k`; another device shows them at once while the chat is still like that. `mv`: the move (its messages `s`…`e`, the
 * chat `to` or a new one, why, the match %; 2.6 (95) `fr`: an older chat joins this one whole, `to` being this one, shown
 * under message `e`); `tg`: [message key, tag] the check said yes to; `nm`: the name check (what
 * it was about `k`, the name it suggests while open `t`, the names turned down `no`, which never come back).
 * Turning a move or a tag down is on the messages themselves (`dismissed`).
 */
export interface OrgState {
  n: number
  k: string
  mv?: { s: number; e: number; to: string | null; why: "merge" | "page" | "site" | "topic" | "apart"; mt?: number; fr?: string }
  tg?: Array<[string, string]>
  nm?: { k: string; t?: string; no?: string[] }
  // 2.6 (94): the chats a merge into was turned down for (never suggested again).
  mx?: string[]
}

/** An OrgState as read back from iCloud or storage, or undefined if it isn't one. */
export function cleanOrgState(raw: unknown): OrgState | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.n !== "number" || typeof o.k !== "string") return undefined
  const out: OrgState = { n: o.n, k: o.k }
  const mv = o.mv as Record<string, unknown> | undefined
  if (mv && typeof mv.s === "number" && typeof mv.e === "number" && (typeof mv.to === "string" || mv.to === null) && ["merge", "page", "site", "topic", "apart"].includes(String(mv.why))) {
    out.mv = { s: mv.s, e: mv.e, to: mv.to as string | null, why: mv.why as "page", ...(typeof mv.mt === "number" ? { mt: mv.mt } : {}), ...(typeof mv.fr === "string" && mv.fr ? { fr: mv.fr } : {}) }
  }
  if (Array.isArray(o.tg)) {
    const tg = o.tg.filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string").map((x) => [x[0], x[1]] as [string, string])
    if (tg.length) out.tg = tg
  }
  const nm = o.nm as Record<string, unknown> | undefined
  if (nm && typeof nm.k === "string") {
    const no = Array.isArray(nm.no) ? nm.no.filter((x): x is string => typeof x === "string") : []
    out.nm = { k: nm.k, ...(typeof nm.t === "string" && nm.t ? { t: nm.t } : {}), ...(no.length ? { no } : {}) }
  }
  const mx = Array.isArray(o.mx) ? o.mx.filter((x): x is string => typeof x === "string" && x.length > 0).slice(-20) : []
  if (mx.length) out.mx = mx
  return out
}

/** The thread this device shows, and when it was picked (a newer thread from another device takes over). */
export interface ActiveThread {
  id: string
  at: number
}

/** A thread as iCloud stores it (`data` is the JSON conversation), or its deletion. */
export type CloudChange = { id: string; updatedAt: number; data: string; base?: number } | { id: string; deleted: true }

/** The time of the copy a change only to organizing's record was made on, while it's the thread's last change. */
export function orgOnlyBase(t: Thread): number | undefined {
  return t.ob && t.ob.u === t.u ? t.ob.b : undefined
}

/**
 * `next`, a change to organizing's record only of `stored`, marked as such (`ob`) when `stored` was in sync with iCloud
 * (`synced`) or was itself such a change; otherwise (other changes not sent yet) it goes as any change.
 */
export function orgOnly(stored: Thread, next: Thread, synced: Record<string, number>): Thread {
  const { ob: _ob, ...rest } = next
  const base = stored.u <= (synced[stored.id] ?? -Infinity) ? stored.u : orgOnlyBase(stored)
  return base === undefined ? rest : { ...rest, ob: { u: next.u, b: base } }
}

/**
 * Another copy of a chat with what organizing's record `ours` turned down added: the names (`nm.no`, and the open
 * name if it's one of them) and the merges (`mx`), at most 20 of each (ChatSync.swift `rebased`). The rest is theirs.
 */
export function withRefusals(theirs: Thread, ours: OrgState | undefined): Thread {
  const no = ours?.nm?.no ?? []
  const mx = ours?.mx ?? []
  if (!no.length && !mx.length) return theirs
  const org: OrgState = theirs.org ? { ...theirs.org } : { n: 0, k: "" }
  if (no.length) {
    const all = [...(org.nm?.no ?? [])]
    for (const x of no) if (!all.some((y) => y.toLowerCase() === x.toLowerCase())) all.push(x)
    const kept = all.slice(-20)
    const t = org.nm?.t && !kept.some((y) => y.toLowerCase() === org.nm!.t!.toLowerCase()) ? org.nm.t : undefined
    org.nm = { k: org.nm?.k ?? "", ...(t ? { t } : {}), no: kept }
  }
  if (mx.length) org.mx = [...new Set([...(org.mx ?? []), ...mx])].slice(-20)
  return { ...theirs, org }
}

export const MAX_THREADS = 50
export const MAX_TITLE = 80
// Messages kept per chat when the panel saves it.
export const MAX_TURNS = 40
// Per thread: many threads come down in one sync, so they stay well under a CloudKit record's 1 MB
// (room for the messages and the texts of 10 pages).
const CLOUD_MAX_CHARS = 200_000
// Page texts kept on this device across all chats; beyond it the older chats keep theirs only in iCloud.
export const MAX_SAVED_TEXT_CHARS = 2_000_000

/**
 * A new chat's id: a random (version 4) UUID. crypto.randomUUID exists only in a secure context, and the panel runs in
 * the page's: on a plain-http site it's missing, so the same kind of id is made from crypto.getRandomValues.
 */
export function newThreadId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** When the thread last got a message. */
export function activity(thread: Thread): number {
  return thread.a ?? thread.u
}

/** By id: chats that are otherwise equal keep one order (see liveThreads). */
function byId(a: Thread, b: Thread): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Threads that still exist, those in Recently Deleted too, the last one written in first; with the same time, by id.
 * The order the threads come in must not matter: Safari hands them back from storage in its own (2.5 (77): two chats
 * with the same time traded places in the open list every time the chats were stored again).
 */
export function storedThreads(threads: Threads): Thread[] {
  return Object.values(threads).filter((t) => !t.deleted && t.m.length > 0).sort((a, b) => activity(b) - activity(a) || byId(a, b))
}

/** The chats the user has: stored, and not in Recently Deleted. Everything the panel lists, searches or asks uses these. */
export function liveThreads(threads: Threads): Thread[] {
  return storedThreads(threads).filter((t) => t.trashed === undefined)
}

// ------------------------------------------------------------ Recently Deleted (2.5)
// 2.5 (83), the owner: «надо сделать … Trash, где до 30 дней пусть хранятся удаленные чаты». A chat the user deletes
// goes to Recently Deleted (`trashed`, its time bumped like any edit, so iCloud takes it to the other devices) and is
// deleted for good TRASH_DAYS later, by whichever device sees it first, through the usual deletion (a tombstone for a
// chat iCloud has). Deleting all chats in Settings still deletes them at once.

export const TRASH_DAYS = 30
const DAY = 86_400_000

/** The chats in Recently Deleted, the last one deleted first. */
export function trashedThreads(threads: Threads): Thread[] {
  return storedThreads(threads).filter((t) => t.trashed !== undefined).sort((a, b) => b.trashed! - a.trashed! || byId(a, b))
}

/** Days until a chat in Recently Deleted is deleted for good: 30 just after, never less than 1 while it's there. */
export function trashDaysLeft(thread: Thread, now = Date.now()): number {
  if (thread.trashed === undefined) return TRASH_DAYS
  return Math.min(TRASH_DAYS, Math.max(1, Math.ceil((thread.trashed + TRASH_DAYS * DAY - now) / DAY)))
}

/**
 * Moves a chat to Recently Deleted, or null when there's none to move. Its place by last message stays (`a` is set:
 * a missing `a` means `u`, and `u` changes), so it comes back where it was.
 */
export function trashThread(threads: Threads, id: string, now = Date.now()): Threads | null {
  const t = threads[id]
  if (!t || t.deleted || t.trashed !== undefined || t.m.length === 0) return null
  return { ...threads, [id]: { ...t, u: later(t, now), a: activity(t), trashed: now } }
}

/**
 * Brings a chat back from Recently Deleted, or null when it isn't there. It goes back to its place by its last real
 * message, not to the top (the owner hates chats jumping: 2.5 (77)); its name, pin, tags and messages are as they were.
 */
export function restoreThread(threads: Threads, id: string, now = Date.now()): Threads | null {
  const t = threads[id]
  if (!t || t.deleted || t.trashed === undefined) return null
  const { trashed: _trashed, ...rest } = t
  return { ...threads, [id]: { ...rest, u: later(t, now), a: activity(t) } }
}

/**
 * Deletes chats in Recently Deleted for good: those there TRASH_DAYS or longer, and `ids` (Delete Now, Delete All)
 * whatever their age. The usual deletion: a tombstone for a chat iCloud has, so it goes on the other devices too.
 */
export function purgeTrash(threads: Threads, synced: Record<string, number>, now = Date.now(), ids: string[] = []): { threads: Threads; purged: string[] } {
  const asked = new Set(ids)
  const purged = Object.values(threads)
    .filter((t) => !t.deleted && t.trashed !== undefined && (asked.has(t.id) || now - t.trashed >= TRASH_DAYS * DAY))
    .map((t) => t.id)
  if (!purged.length) return { threads, purged }
  const next = { ...threads }
  for (const id of purged) emptied(next, id, synced, now)
  return { threads: next, purged }
}

/** The list of chats: pinned ones first in their order, then the others, the last one written in first. */
export function chatList(threads: Threads): Thread[] {
  const live = liveThreads(threads)
  return [...live.filter((t) => t.pin !== undefined).sort((a, b) => a.pin! - b.pin! || byId(a, b)), ...live.filter((t) => t.pin === undefined)]
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

/** Whether the user named the chat themselves (the AI never renames it then). */
export function namedByUser(thread: Thread): boolean {
  return Boolean(thread.title) && thread.title !== thread.aiTitle
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
 * When the chat last got a message once its messages are `m` (2.5 (77), the owner's note: two chats kept swapping
 * places). Only a question, an answer or a note that's new here (by key) moves it up, to when it was written;
 * a highlight, a pin, a reminder, a tag, an organizing hint, a message deleted or put back keep its place.
 */
export function activityAfter(stored: Thread | undefined, m: Entry[], now: number): number {
  if (!stored || stored.deleted || stored.m.length === 0) return now
  const had = new Set(stored.m.map(entryKey))
  let a = activity(stored)
  for (const e of m) if (!had.has(entryKey(e))) a = Math.max(a, e.t ?? now)
  return a
}

/**
 * The thread with new messages as of `now`: its name, pin, tags and kind stay (a deleted thread
 * comes back as a new one), and its place in the list moves only for a new message (activityAfter).
 * `kind` marks a new "Ask your chats" thread. A chat written in while in Recently Deleted (still open here when
 * another device deleted it) comes back out of it, as when an older version writes it.
 */
export function withMessages(stored: Thread | undefined, id: string, m: Entry[], now: number, kind?: "history"): Thread {
  const keep = stored && !stored.deleted ? stored : undefined
  const keptKind = keep?.kind ?? kind
  return {
    id, u: now, a: activityAfter(keep, m, now), m,
    ...(keep?.title ? { title: keep.title } : {}),
    ...(keep?.aiTitle ? { aiTitle: keep.aiTitle } : {}),
    ...(keep?.org ? { org: keep.org } : {}),
    ...(keep?.pin !== undefined ? { pin: keep.pin } : {}),
    ...(keep?.tags?.length ? { tags: keep.tags } : {}),
    ...(keptKind ? { kind: keptKind } : {}),
    ...(keep?.x ? { x: keep.x } : {})
  }
}

/**
 * What saving the panel's messages of a chat stores, or null when there's nothing to store: its last MAX_TURNS
 * messages, page texts for its last few pages (they go to iCloud with it). Messages as they were read (a chat
 * opened, or brought by iCloud or the app) aren't stored again: trimming them would give the chat a new copy, and
 * drop a long chat's first messages, with nothing done here.
 */
export function savedThread(stored: Thread | undefined, id: string, entries: Entry[], now: number, kind?: "history"): Thread | null {
  if (stored && !stored.deleted && JSON.stringify(stored.m) === JSON.stringify(entries)) return null
  const next = trimSavedPages(entries.slice(-MAX_TURNS))
  // Opening an empty thread doesn't store anything.
  if (stored ? JSON.stringify(stored.m) === JSON.stringify(next) : next.length === 0) return null
  return withMessages(stored, id, next, now, kind)
}

/**
 * Keeps pinned threads and the newest MAX_THREADS; older ones become deletions so iCloud drops them too.
 * Chats in Recently Deleted stay, outside that count: they go by themselves (purgeTrash).
 * Page texts stay within `maxText` characters on this device, the pinned and latest chats first, Recently
 * Deleted's last.
 */
export function prune(threads: Threads, now = Date.now(), maxText = MAX_SAVED_TEXT_CHARS): Threads {
  const list = chatList(threads)
  const keep = new Set(list.slice(0, MAX_THREADS).map((t) => t.id))
  const trash = trashedThreads(threads)
  for (const t of trash) keep.add(t.id)
  const out: Threads = {}
  for (const t of Object.values(threads)) {
    if (t.deleted || keep.has(t.id) || t.m.length === 0) out[t.id] = t
    else out[t.id] = { id: t.id, u: now, m: [], deleted: true }
  }
  let size = 0
  for (const t of [...list, ...trash]) {
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
      const base = orgOnlyBase(t)
      out.push({ id: t.id, updatedAt: t.u, data: threadForCloud(t), ...(base !== undefined ? { base } : {}) })
    }
  }
  return out
}

/**
 * A thread as iCloud stores it: JSON with its messages and, when set, its name and the time of its
 * last message. If it would not fit, the oldest page texts go first, then the oldest messages.
 * The fields a newer version wrote that this one doesn't know (`x`) go back as they came.
 */
export function threadForCloud(thread: Thread, maxChars = CLOUD_MAX_CHARS): string {
  const meta = {
    ...thread.x,
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.aiTitle ? { ait: thread.aiTitle } : {}),
    ...(thread.org ? { org: thread.org } : {}),
    ...(thread.a !== undefined && thread.a !== thread.u ? { a: thread.a } : {}),
    ...(thread.pin !== undefined ? { pin: thread.pin } : {}),
    ...(thread.kind ? { k: thread.kind } : {}),
    ...(thread.tags?.length ? { tags: thread.tags } : {}),
    ...(thread.trashed !== undefined ? { trashed: thread.trashed } : {})
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

// The fields of a thread's iCloud JSON this version reads; any other is kept in `x` as it came.
const CLOUD_FIELDS = new Set(["m", "a", "title", "ait", "org", "pin", "k", "tags", "trashed"])

/**
 * A thread read back from iCloud (2.3 build 56 stored just the messages), or null if it isn't one. Fields it doesn't
 * know are kept (`x`): 2.4 dropped those it didn't know, and saving such a chat there takes it out of Recently Deleted.
 */
export function threadFromCloud(data: string): Pick<Thread, "m" | "a" | "title" | "aiTitle" | "org" | "pin" | "kind" | "tags" | "trashed" | "x"> | null {
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
  const { m: raw, a, title, ait, org, pin, k, tags, trashed } = parsed as Record<string, unknown>
  const m = entriesFrom(raw)
  if (!m) return null
  const unknown = Object.entries(parsed).filter(([key]) => !CLOUD_FIELDS.has(key))
  return {
    m,
    ...(typeof a === "number" ? { a } : {}),
    ...(typeof title === "string" && title.trim() ? { title: cleanTitle(title) } : {}),
    ...(typeof ait === "string" && ait.trim() ? { aiTitle: cleanTitle(ait) } : {}),
    ...(cleanOrgState(org) ? { org: cleanOrgState(org) } : {}),
    ...(typeof pin === "number" && Number.isFinite(pin) ? { pin } : {}),
    ...(k === "history" ? { kind: "history" as const } : {}),
    ...(Array.isArray(tags) && cleanTags(tags).length ? { tags: cleanTags(tags) } : {}),
    ...(typeof trashed === "number" && Number.isFinite(trashed) ? { trashed } : {}),
    ...(unknown.length ? { x: Object.fromEntries(unknown) } : {})
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
  const own = current && !current.deleted && current.trashed === undefined ? current : undefined
  const latest = liveThreads(threads)[0]
  if (latest && latest.id !== active.id && activity(latest) > Math.max(active.at, own ? activity(own) : 0)) return { id: latest.id, m: latest.m }
  // The chat picked here went to Recently Deleted (on another device): a new chat, not that one's id, which the next
  // question would write over.
  if (current?.trashed !== undefined && !current.deleted) return { id: newThreadId(), m: [] }
  return { id: active.id, m: own?.m ?? [] }
}

// ------------------------------------------------------------ the copy the ContextFlow app reads

/**
 * What the app's copy of the chats (App Group, see ChatMirror.swift) lacks: threads changed since
 * `mirrored` (the time of each thread the app has), and deletions of threads it has that are gone here.
 * Unlike iCloud, the app gets every chat, synced or not, at most `maxChars` of data in one go; those in Recently
 * Deleted too, for its own Recently Deleted.
 */
export function mirrorChanges(threads: Threads, mirrored: Record<string, number>, maxChars = 900_000): CloudChange[] {
  const out: CloudChange[] = []
  let size = 0
  for (const id of Object.keys(mirrored)) {
    const t = threads[id]
    if (!t || t.deleted || t.m.length === 0) out.push({ id, deleted: true })
  }
  for (const t of storedThreads(threads)) {
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
    const made: Thread = { id: c.id, u: c.updatedAt, ...app }
    if (c.base !== undefined && local && !local.deleted && local.u > c.base) {
      // 2.6 (94): organizing's record, made in the app on a copy this one has changed since: this one, with what the app
      // turned down, newer than both (so the app's copy takes it too); sent to iCloud as such a change again.
      next[c.id] = orgOnly(local, { ...withRefusals(local, app.org), u: Math.max(local.u, c.updatedAt) + 1 }, synced)
    } else {
      next[c.id] = c.base === undefined ? made : local ? orgOnly(local, made, synced) : { ...made, ob: { u: made.u, b: c.base } }
    }
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
 * page's text along when the source keeps it on an earlier message. The target keeps its time of last message
 * (its place in the list); the source's becomes that of its last message left. A source
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
  // Not from or into a chat in Recently Deleted.
  if (source.trashed !== undefined || target?.trashed !== undefined) return null
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= source.m.length) return null
  const times = entryTimes(source.m)
  const into = target?.m ?? []
  const moved = withPageText(source.m.slice(start, end + 1), source.m, into)
    .map((e) => ({ ...e, id: entryKey(e), from: { chat: sourceId, at: now } }))
  const rest = withPageChanges([...source.m.slice(0, start), ...source.m.slice(end + 1)])
  const at = insertAt(into, times[start])
  const newest = times[end]
  const m = withPageChanges([...into.slice(0, at), ...moved, ...into.slice(at)])
  // A chat the block goes to keeps its place in the list (2.5 (77): a move isn't a new message); a new one goes
  // where the block's last message was.
  const nextTarget: Thread = target
    ? { ...target, u: later(stored, now), a: activity(target), m }
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
 * Folded for matching as template search folds (fold.ts): lower case, accents off in every language ("phan hoi"
 * finds "Phản hồi", "مرحبا" finds "مَرْحَبًا", "елка" finds "Ёлка", "strasse" finds "Straße"), any space a plain space.
 */
export function foldText(text: string): string {
  return unaccent(text).replace(/\s/g, " ")
}

/** A text folded for matching, and where each folded character came from in the original. */
interface Folded {
  text: string
  // For each character of `text`: where the letter it comes from starts and ends in the original.
  from: number[]
  to: number[]
}

// Letters as folded, the alphabets in use (a few hundred).
const folds = new Map<string, string>()

/**
 * The same fold letter by letter (a letter with the marks after it, so a text typed with separate accents folds
 * alike), keeping positions for an excerpt's marks. Only for the few places shown; null in the rare text that folds
 * otherwise letter by letter than as a whole (Korean typed as separate jamo).
 */
function foldMap(text: string): Folded | null {
  const out: Folded = { text: "", from: [], to: [] }
  for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    let f = folds.get(m[0])
    if (f === undefined) {
      f = foldText(m[0])
      if (folds.size < 4096) folds.set(m[0], f)
    }
    for (let i = 0; i < f.length; i++) {
      out.from.push(m.index)
      out.to.push(m.index + m[0].length)
    }
    out.text += f
  }
  return out.text === foldText(text) ? out : null
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

/** An excerpt of `text` around the first of `words`, at most `size` long, with the words in it marked. */
function excerpt(text: string, words: string[], size = 120): Omit<SearchHit, "at"> {
  const folded = foldMap(text)
  const starts = folded ? words.map((w) => folded.text.indexOf(w)).filter((i) => i >= 0).map((i) => folded.from[i]) : []
  const start = starts.length ? Math.min(...starts) : 0
  const from = Math.max(0, Math.min(start - Math.floor(size / 3), text.length - size))
  const to = Math.min(text.length, from + size)
  const lead = from > 0 ? "…" : ""
  const piece = text.slice(from, to).replace(/\s/g, " ")
  const marks: Array<[number, number]> = []
  for (const word of folded ? words : []) {
    let i = folded!.text.indexOf(word)
    while (i >= 0) {
      const s = folded!.from[i]
      const e = folded!.to[i + word.length - 1]
      if (s >= from && e <= to) marks.push([lead.length + s - from, lead.length + e - from])
      i = folded!.text.indexOf(word, i + word.length)
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
        hits.push({ at: field.at, ...excerpt(field.text, present) })
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
      else {
        lines.push(`A: ${text.slice(0, opts.perAnswer)}${text.length > opts.perAnswer ? "…" : ""}`)
        if (e.marks?.length) lines.push(`Highlighted: ${marksLine(e.marks)}`)
      }
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
