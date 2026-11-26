// Quick insert in the background: templates kept in step with the ContextFlow app and iCloud (through
// the native side, one record per template), the AI (blanks, filling them from the page, search), the
// counters, and the shortcut that opens the list in the page.

import { API_BASE, TARGET } from "../shared/config"
import { INSERT_STORAGE, type AiFailure, type FillResult, type FindResult, type InsertEvent, type InsertRequest, type MarkResult } from "../shared/insert"
import { sortedJson } from "../shared/stored"
import { clipAsk, writeDeadline, type WriteAsk, type WriteFailureCode, type WriteReply } from "../shared/writing"
import { applyTemplates, pendingTemplates, type Templates } from "../shared/templates"
import { DEFAULT_SETTINGS, STORAGE, type ErrorCode, type ProOffer, type Settings, type Usage } from "../shared/types"
import { callNative } from "./native"
import { postEvent } from "./events"

export interface InsertDeps {
  installId: () => Promise<string>
  // The App Store transaction the server checks the plan with (null: free).
  entitlementJws: () => Promise<string | null>
  clientInfo: () => Promise<Record<string, unknown>>
  // 2.8.1: the client fields for an event, which wait briefly for the app's build and «ours» mark (index.ts
  // clientForEvent): a simulator install that only used this feature reached the events unmarked. Requests keep clientInfo.
  eventClient?: () => Promise<Record<string, unknown>>
  consented: () => Promise<boolean>
  // The plan or the allowance may have changed: the panel's status is asked again.
  statusChanged: () => void
}

let deps: InsertDeps

// ------------------------------------------------------------ templates with the app and iCloud

interface NativeTemplates {
  available?: boolean
  templates?: Array<{ id: string; updatedAt: number; data: string }>
}

let syncing: Promise<boolean> | null = null
let syncAgain = false
let pushTimer: ReturnType<typeof setTimeout> | undefined
// The templates value this background last wrote, as sortedJson (Safari hands it back with its keys in its own order):
// its own writes don't start another sync.
let lastWritten = ""

/** Sends this device's template changes to the app (which keeps them in iCloud) and takes everyone else's. */
export function syncTemplates(): Promise<boolean> {
  if (TARGET !== "safari") return Promise.resolve(false)
  if (syncing) {
    syncAgain = true
    return syncing
  }
  syncing = (async () => {
    let changed = false
    for (let round = 0; round < 3; round++) {
      syncAgain = false
      changed = (await syncOnce()) || changed
      if (!syncAgain) break
    }
    return changed
  })().finally(() => {
    syncing = null
  })
  return syncing
}

async function syncOnce(): Promise<boolean> {
  const stored = await chrome.storage.local.get([INSERT_STORAGE.templates, INSERT_STORAGE.syncedTemplates])
  const local = (stored[INSERT_STORAGE.templates] as Templates | undefined) ?? {}
  const synced = (stored[INSERT_STORAGE.syncedTemplates] as Record<string, number> | undefined) ?? {}
  const sent = pendingTemplates(local, synced)
  // Templates go to iCloud with the same switch as the chats ("Sync chats with iCloud"); the app gets them either way.
  const prefs = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] as Partial<Settings> | undefined
  const reply = await callNative<NativeTemplates>("syncTemplates", {
    changes: sent.map((t) => ({ id: t.id, updatedAt: t.updatedAt, data: JSON.stringify(t) })),
    cloud: prefs?.syncChats ?? DEFAULT_SETTINGS.syncChats
  }, 20_000)
  if (!reply?.templates) return false // not in Safari, or an app without templates
  const remote = reply.templates.map((r) => {
    try {
      return JSON.parse(r.data) as unknown
    } catch {
      return null
    }
  })
  // Templates may have changed here while the app answered: merge into the current copy.
  const now = ((await chrome.storage.local.get(INSERT_STORAGE.templates))[INSERT_STORAGE.templates] as Templates | undefined) ?? {}
  const merged = applyTemplates(now, synced, remote, Date.now())
  if (pendingTemplates(merged.templates, merged.synced).length > 0) syncAgain = true
  lastWritten = sortedJson(merged.templates)
  await chrome.storage.local.set({ [INSERT_STORAGE.templates]: merged.templates, [INSERT_STORAGE.syncedTemplates]: merged.synced })
  return merged.changed
}

// ------------------------------------------------------------ the AI

async function post<T>(action: "mark" | "fill" | "find", payload: Record<string, unknown>, timeoutMs: number): Promise<T | AiFailure> {
  const [installId, entitlement, client] = await Promise.all([deps.installId(), deps.entitlementJws(), deps.clientInfo()])
  try {
    const res = await fetch(`${API_BASE}/api/v2/insert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, installId, client, entitlement, ...payload }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { code?: string; usage?: Usage | null; offer?: ProOffer | null; left?: number | null }
    if (res.ok && body.ok === true) return body as T
    const code = (body.code ?? (res.status === 404 ? "UNAVAILABLE" : res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST")) as ErrorCode | "FILL_LIMIT"
    return { ok: false, code, usage: body.usage ?? null, offer: body.offer ?? null, left: body.left ?? null }
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}

/** Blanks, a title and words to find a new template by (the selected text only; nothing is kept). */
async function mark(text: string): Promise<MarkResult | AiFailure> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  return post<MarkResult>("mark", { text }, 20_000)
}

/** The template's blanks from the open page (only when the user asks; the page text isn't kept). */
async function fill(message: Extract<InsertRequest, { type: "qiFill" }>): Promise<FillResult | AiFailure> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  const result = await post<FillResult>("fill", { text: message.text, blanks: message.blanks, page: message.page, field: message.field }, 25_000)
  deps.statusChanged()
  return result
}

/** Templates by meaning, when the plain search found nothing (titles and keywords only). */
async function find(message: Extract<InsertRequest, { type: "qiFind" }>): Promise<FindResult | AiFailure> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  return post<FindResult>("find", { query: message.query, templates: message.templates }, 20_000)
}

/**
 * «Проверить» и «Переписать» (2.7): the field's text, the page around it and the person's style to /api/v2/write.
 * A tap is one answer: the panel's usage line is asked again after it.
 */
const WRITE_CODES = new Set<WriteFailureCode>(["LIMIT_REACHED", "TOO_LONG", "BUSY", "UPSTREAM", "UNAVAILABLE", "BAD_REQUEST", "PRO_ONLY", "SLOW"])
// The requests on their way, by the name the page gave each: Cancel stops one (qiWriteStop).
const writing = new Map<string, AbortController>()

/**
 * Always answers within the request's deadline (writeDeadline; 2.7 (107): the owner's Check showed «Checking…» for a
 * minute): the server's answer, or SLOW when the deadline passed first (the request is dropped, so the server gives
 * the answer back), or STOPPED after Cancel.
 */
async function write(ask: WriteAsk): Promise<WriteReply> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  const stop = new AbortController()
  let slow = false
  const timer = setTimeout(() => {
    slow = true
    stop.abort()
  }, writeDeadline(ask.action, ask.text.length, ask.live === true))
  if (ask.id) writing.set(ask.id, stop)
  const stopped = new Promise<WriteReply>((resolve) => stop.signal.addEventListener("abort", () => resolve({ ok: false, code: slow ? "SLOW" : "STOPPED" })))
  try {
    return await Promise.race([send(ask, stop.signal), stopped])
  } finally {
    clearTimeout(timer)
    if (ask.id) writing.delete(ask.id)
  }
}

async function send(ask: WriteAsk, signal: AbortSignal): Promise<WriteReply> {
  const [installId, entitlement, client] = await Promise.all([deps.installId(), deps.entitlementJws(), deps.clientInfo()])
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/v2/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId, client, entitlement, ...clipAsk(ask) }),
      signal
    })
  } catch {
    return { ok: false, code: "NETWORK" }
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: unknown; plan?: unknown; code?: string; usage?: Usage | null; offer?: ProOffer | null }
  if (res.ok && body.ok === true && typeof body.text === "string") {
    // A live check isn't an answer: the usage line stays as it is.
    if (!ask.live) deps.statusChanged()
    // The server's plan with it (2.7): the card's «left today» is Free's only (shared/writing.ts freeLeft).
    return { ok: true, text: body.text, ...(typeof body.plan === "string" ? { plan: body.plan } : {}), usage: body.usage ?? null }
  }
  const code = WRITE_CODES.has(body.code as WriteFailureCode) ? (body.code as WriteFailureCode) : res.status === 404 ? "UNAVAILABLE" : res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST"
  if (code === "LIMIT_REACHED") deps.statusChanged()
  return { ok: false, code, usage: body.usage ?? null, offer: body.offer ?? null }
}

// ------------------------------------------------------------ counters

async function report(event: InsertEvent): Promise<void> {
  await postEvent(async () => {
    const [installId, client] = await Promise.all([deps.installId(), (deps.eventClient ?? deps.clientInfo)()])
    return { ...event, installId, client }
  })
}

// ------------------------------------------------------------ wiring

export function startInsert(d: InsertDeps): void {
  deps = d

  chrome.runtime.onMessage.addListener((message: InsertRequest, _sender, sendResponse) => {
    switch (message?.type) {
      case "qiSync":
        syncTemplates().then((changed) => sendResponse({ changed }), () => sendResponse({ changed: false }))
        return true
      case "qiEvent":
        void report(message.event)
        sendResponse({ ok: true })
        return false
      case "qiMark":
        mark(message.text).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
        return true
      case "qiFill":
        fill(message).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
        return true
      case "qiFind":
        find(message).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
        return true
      case "qiWrite":
        write(message.ask).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
        return true
      case "qiWriteStop":
        writing.get(message.id)?.abort()
        sendResponse({ ok: true })
        return false
      default:
        return false
    }
  })

  // Saved or deleted in the panel: to the app and iCloud shortly after.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[INSERT_STORAGE.templates]) return
    if (sortedJson(changes[INSERT_STORAGE.templates].newValue ?? {}) === lastWritten) return
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void syncTemplates().catch(() => undefined), 800)
  })

  // ⌃⇧V (manifest "quick_insert"): the list opens at the caret of the field in use.
  chrome.commands?.onCommand?.addListener((command) => {
    if (command !== "quick_insert") return
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs?.[0]?.id
      if (id !== undefined) chrome.tabs.sendMessage(id, { type: "quickInsert" }, () => void chrome.runtime.lastError)
    })
  })

  // Templates made in the app since the last time.
  setTimeout(() => void syncTemplates().catch(() => undefined), 2_500)
}
