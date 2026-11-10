// Organizing the chats (2.5, Pro, with suggestions on): the suggestions for the chat the panel shows. Every
// message gets a vector once — its text goes to /api/v2/organize, which keeps nothing — and the vectors stay on
// this device (storage.local, never iCloud), keyed by the message's key and text in the server's vector space.
// The rules are src/shared/organize.ts; the app runs the same ones (Organize.swift).

import { hasPro } from "../shared/plan"
import { API_BASE } from "../shared/config"
import { entryKey, textKey, type Entry } from "../shared/conversation"
import { embedText, judgedTags, judgeText, nameCheckKey, nameStateAfter, nameText, openName, openTags, orgStateFor, suggestMove, tagCandidates, tagTargets, unpackVector, wantsNameCheck, type VectorOf } from "../shared/organize"
import { cleanTitle, liveThreads, threadName, threadTitle, type Thread, type Threads } from "../shared/threads"
import { STORAGE, type OrganizeCountsReply, type OrganizeEvent, type OrganizeNameReply, type OrganizeReply, type StatusInfo } from "../shared/types"

interface Context {
  status: StatusInfo
  installId: string
  jws: string | null
  client: Record<string, unknown>
  // Suggestions are on, and the one AI consent (which lists them) is given.
  on: boolean
}

// Messages that get vectors in one run, sent in batches: a new device catches up over a few panel openings.
const MAX_EMBED_PER_RUN = 640
const BATCH = 128
// Tag checks remembered (the newest), so opening a chat again asks nothing.
const MAX_VERDICTS = 400

interface VectorStore {
  space: string
  // entryKey → "textKey:packed vector": a message whose text changed gets a new vector.
  v: Record<string, string>
}

type Verdicts = Record<string, { v: Array<{ tag: string; fits: boolean; confidence: number }>; at: number }>

type Api = { ok: true; body: Record<string, any> } | { ok: false; code: "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" | "OFF" }

async function api(ctx: Context, body: Record<string, unknown>): Promise<Api> {
  try {
    const res = await fetch(`${API_BASE}/api/v2/organize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: ctx.installId, client: ctx.client, entitlement: ctx.jws, ...body }),
      signal: AbortSignal.timeout(30_000)
    })
    const out = (await res.json().catch(() => ({}))) as Record<string, any>
    if (res.ok) return { ok: true, body: out }
    const code = out.code === "PRO_ONLY" || out.code === "LIMIT_REACHED" || out.code === "OFF" ? out.code : res.status >= 500 ? "UPSTREAM" : "NETWORK"
    return { ok: false, code }
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}

/** The messages of `chats` (in that order) whose vectors this device lacks, up to `max`. */
function missing(chats: Thread[], store: VectorStore, max: number): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = []
  const seen = new Set<string>()
  for (const t of chats) {
    for (const e of t.m) {
      const text = embedText(e)
      const key = entryKey(e)
      if (!text || seen.has(key) || store.v[key]?.startsWith(`${textKey(text)}:`)) continue
      seen.add(key)
      out.push({ key, text })
      if (out.length >= max) return out
    }
  }
  return out
}

// One run at a time (two panels open, or the list and a chat, don't embed the same twice).
let running: Promise<unknown> = Promise.resolve()
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = running.catch(() => undefined).then(work)
  running = run
  return run
}

/** The suggestions for chat `chatId` now. */
export function organizeChat(chatId: string, ctx: Context): Promise<OrganizeReply> {
  return inTurn(() => organizeOnce(chatId, ctx))
}

/** The device's vectors for `first` and then the other chats (asking for those it lacks), and how to read them. */
async function vectorsFor(first: Thread | null, live: Thread[], ctx: Context, stored: Record<string, unknown>): Promise<{ vectorOf: VectorOf } | { code: OrganizeErrorCode }> {
  const org = ctx.status.organize!
  let store = stored[STORAGE.orgVectors] as VectorStore | undefined
  if (!store || store.space !== org.space) store = { space: org.space, v: {} }

  // Vectors for what lacks them: this chat's messages first, then the other chats', the latest first.
  const todo = missing(first ? [first, ...live.filter((t) => t.id !== first.id)] : live, store, MAX_EMBED_PER_RUN)
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const res = await api(ctx, { op: "embed", texts: batch.map((x) => x.text) })
    if (!res.ok) {
      if (i === 0 && first && !first.m.some((e) => store!.v[entryKey(e)])) return { code: res.code }
      break
    }
    // The server moved to another model: the vectors kept so far no longer compare with new ones.
    if (res.body.space !== store.space) store = { space: String(res.body.space), v: {} }
    batch.forEach((x, j) => {
      if (typeof res.body.vectors?.[j] === "string") store!.v[x.key] = `${textKey(x.text)}:${res.body.vectors[j]}`
    })
  }
  // Vectors of messages no chat has any more go.
  const keys = new Set(live.flatMap((t) => t.m.map(entryKey)))
  for (const key of Object.keys(store.v)) if (!keys.has(key)) delete store.v[key]
  await chrome.storage.local.set({ [STORAGE.orgVectors]: store })

  const kept = store
  const unpacked = new Map<string, Float32Array | null>()
  const vectorOf: VectorOf = (e: Entry) => {
    const text = embedText(e)
    const hit = text ? kept.v[entryKey(e)] : undefined
    const at = hit?.indexOf(":") ?? -1
    if (!hit || at < 0 || hit.slice(0, at) !== textKey(text)) return null
    if (!unpacked.has(hit)) unpacked.set(hit, unpackVector(hit.slice(at + 1)))
    return unpacked.get(hit)
  }
  return { vectorOf }
}

type OrganizeErrorCode = "PRO_ONLY" | "NETWORK" | "LIMIT_REACHED" | "UPSTREAM" | "OFF"

async function organizeOnce(chatId: string, ctx: Context): Promise<OrganizeReply> {
  const org = ctx.status.organize
  if (!org?.on || !ctx.on) return { ok: false, code: "OFF" }
  if (!hasPro(ctx.status.plan)) return { ok: false, code: "PRO_ONLY" }
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.orgVectors, STORAGE.orgVerdicts])
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
  const chat = threads[chatId]
  if (!chat || chat.deleted || chat.kind === "history" || chat.m.length === 0) return { ok: true, move: null, tags: [] }
  const live = liveThreads(threads).filter((t) => t.kind !== "history")
  const vectors = await vectorsFor(chat, live, ctx, stored)
  if ("code" in vectors) return { ok: false, code: vectors.code }
  const { vectorOf } = vectors
  const cfg = org.config

  const move = suggestMove(chat, live, vectorOf, cfg)
  const verdicts = (stored[STORAGE.orgVerdicts] as Verdicts | undefined) ?? {}
  const tags: Array<{ index: number; key: string; tag: string }> = []
  for (const index of tagTargets(chat, cfg)) {
    const candidates = tagCandidates(chat, index, live, vectorOf, cfg)
    if (!candidates.length) continue
    const message = judgeText(chat.m, index)
    const hash = textKey(JSON.stringify([message, candidates.map((c) => [c.tag, c.examples])]))
    if (!verdicts[hash]) {
      const res = await api(ctx, { op: "tags", message, candidates: candidates.map((c) => ({ tag: c.tag, examples: c.examples })) })
      if (!res.ok || !Array.isArray(res.body.verdicts)) break
      verdicts[hash] = { v: res.body.verdicts, at: Date.now() }
    }
    const [tag] = judgedTags(candidates, verdicts[hash].v, cfg)
    if (tag) tags.push({ index, key: entryKey(chat.m[index]), tag })
  }
  const newest = Object.entries(verdicts).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_VERDICTS)
  await chrome.storage.local.set({ [STORAGE.orgVerdicts]: Object.fromEntries(newest) })

  // 2.6: the chat's name, unless the user typed it: checked once the chat has a second question or note, and again
  // when it gets another page or a move changes it. A better one is a suggestion until taken or turned down (2.6 (91):
  // never renamed by itself). The check and its answer go with the chat (2.6 (93)): another device asks nothing again,
  // and a name turned down anywhere never comes back.
  let nm = chat.org?.nm
  // 2.6 (95): first what moves out of the chat (or merges), then its name, once nothing is left to move (the owner:
  // renamed again and again, with odd names for a chat on two topics). A name it had stays hidden meanwhile (openName).
  if (!move && wantsNameCheck(chat)) {
    const key = nameCheckKey(chat)
    if (nm?.k !== key) {
      const current = threadName(chat)
      const res = await api(ctx, { op: "name", chat: nameText(chat.m), current })
      const title = res.ok && typeof res.body.title === "string" ? cleanTitle(res.body.title) : ""
      // Answered: this check is done (a name that fits, or none, suggests nothing), as the app records it.
      if (res.ok) nm = nameStateAfter(nm, key, { fits: res.body.fits === true, title }, current)
    }
  }
  const state = orgStateFor(chat, move, tags, nm)
  const name = openName({ ...chat, org: state })

  return {
    ok: true,
    move: move && {
      ...move,
      // A new chat is named like any chat: after its first question. A merge into this chat names the older one.
      toName: move.from ? threadName(threads[move.from]) : move.to ? threadName(threads[move.to]) : threadTitle(chat.m.slice(move.start, move.end + 1)),
      count: move.from ? threads[move.from].m.length : move.end - move.start + 1
    },
    tags,
    ...(name ? { name } : {}),
    org: state
  }
}


/**
 * The open suggestions of every chat, for the chats list (2.6, "N recommendations"): its move, its suggested name, and
 * the tags it last showed that are still open (2.6 (91): working out every chat's tag candidates again made the list
 * hang). Nothing is asked of the AI here but missing vectors. Only chats with some.
 */
export function organizeCounts(ctx: Context): Promise<OrganizeCountsReply> {
  return inTurn(() => countsOnce(ctx))
}

async function countsOnce(ctx: Context): Promise<OrganizeCountsReply> {
  const org = ctx.status.organize
  if (!org?.on || !ctx.on) return { ok: false, code: "OFF" }
  if (!hasPro(ctx.status.plan)) return { ok: false, code: "PRO_ONLY" }
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.orgVectors])
  const live = liveThreads((stored[STORAGE.threads] as Threads | undefined) ?? {}).filter((t) => t.kind !== "history")
  const vectors = await vectorsFor(null, live, ctx, stored)
  if ("code" in vectors) return { ok: false, code: vectors.code }
  const counts: Record<string, number> = {}
  for (const chat of live) {
    const n = (suggestMove(chat, live, vectors.vectorOf, org.config) ? 1 : 0) + (openName(chat) ? 1 : 0) + openTags(chat).length
    if (n) counts[chat.id] = n
  }
  return { ok: true, counts }
}

/** "Name by topic": a name for chat `chatId` now (the panel puts it on, unless the user typed one meanwhile). */
export async function nameChatNow(chatId: string, ctx: Context): Promise<OrganizeNameReply> {
  const org = ctx.status.organize
  if (!org?.on || !ctx.on) return { ok: false, code: "OFF" }
  if (!hasPro(ctx.status.plan)) return { ok: false, code: "PRO_ONLY" }
  const { [STORAGE.threads]: stored } = await chrome.storage.local.get(STORAGE.threads)
  const chat = (stored as Threads | undefined)?.[chatId]
  if (!chat || chat.deleted || chat.kind === "history" || !chat.m.length) return { ok: false, code: "NETWORK" }
  const res = await api(ctx, { op: "name", chat: nameText(chat.m) })
  if (!res.ok) return { ok: false, code: res.code === "OFF" || res.code === "PRO_ONLY" || res.code === "LIMIT_REACHED" ? res.code : "UPSTREAM" }
  const name = typeof res.body.title === "string" ? cleanTitle(res.body.title) : ""
  return name ? { ok: true, name } : { ok: false, code: "UPSTREAM" }
}

/** An organizing event for the funnel (/api/v2/event): what and where, never text. */
export async function reportOrganize(event: OrganizeEvent, installId: string, client: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...event, surface: "panel", installId, client })
  }).catch(() => undefined)
}
