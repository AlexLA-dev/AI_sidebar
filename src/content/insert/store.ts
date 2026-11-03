// Quick insert's storage on this device: its settings, Copied, the templates (the background keeps them
// in step with the app and iCloud), how often each was used where, and the last answer or note.

import { addCopied, COPIED_TTL_MS, liveCopied, siteExcluded, siteKey, type CopiedItem } from "../../shared/copied"
import { DEFAULT_INSERT_SETTINGS, INSERT_STORAGE, type InsertEvent, type InsertSettings } from "../../shared/insert"
import { liveTemplates, noteUse, tombstone, type Template, type Templates, type TemplateUse } from "../../shared/templates"
import { STORAGE } from "../../shared/types"
import type { Threads } from "../../shared/threads"
import { toPlainText } from "../../shared/share"

async function get<T>(key: string): Promise<T | undefined> {
  try {
    return (await chrome.storage.local.get(key))[key] as T | undefined
  } catch {
    return undefined
  }
}

async function set(values: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(values)
  } catch {
    // storage unavailable (extension reloaded): the page keeps working without it
  }
}

function onKey(key: string, listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[key]) listener()
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}

export function sendBackground<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        void chrome.runtime.lastError
        resolve(response ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

export function report(event: InsertEvent): void {
  void sendBackground({ type: "qiEvent", event })
}

// ------------------------------------------------------------ settings

export async function loadInsertSettings(): Promise<InsertSettings> {
  return { ...DEFAULT_INSERT_SETTINGS, ...(await get<Partial<InsertSettings>>(INSERT_STORAGE.settings)) }
}

export async function saveInsertSettings(patch: Partial<InsertSettings>): Promise<InsertSettings> {
  const next = { ...(await loadInsertSettings()), ...patch }
  await set({ [INSERT_STORAGE.settings]: next })
  return next
}

export function onInsertSettings(listener: (s: InsertSettings) => void): () => void {
  return onKey(INSERT_STORAGE.settings, () => void loadInsertSettings().then(listener))
}

// ------------------------------------------------------------ Copied

export async function loadCopied(): Promise<CopiedItem[]> {
  return liveCopied((await get<CopiedItem[]>(INSERT_STORAGE.copied)) ?? [], Date.now())
}

/** Keeps a copy (from a page or ContextFlow's Copy) unless Copied is off here or everywhere. */
export async function keepCopied(text: string, host: string, from: CopiedItem["from"]): Promise<void> {
  const settings = await loadInsertSettings()
  if (!settings.copied || (host && siteExcluded(host, settings.copiedOffSites))) return
  const list = (await get<CopiedItem[]>(INSERT_STORAGE.copied)) ?? []
  await set({ [INSERT_STORAGE.copied]: addCopied(list, { text, host: host ? siteKey(host) : "", at: Date.now(), from }, Date.now()) })
}

export async function clearCopied(): Promise<void> {
  await set({ [INSERT_STORAGE.copied]: [] })
}

export async function removeCopied(id: string): Promise<void> {
  const list = (await get<CopiedItem[]>(INSERT_STORAGE.copied)) ?? []
  await set({ [INSERT_STORAGE.copied]: list.filter((c) => c.id !== id) })
}

export function onCopied(listener: () => void): () => void {
  return onKey(INSERT_STORAGE.copied, listener)
}

/** When the oldest copy goes away by itself (to refresh the list). */
export function copiedExpiry(list: CopiedItem[]): number | null {
  return list.length ? Math.min(...list.map((c) => c.at)) + COPIED_TTL_MS : null
}

// ------------------------------------------------------------ templates

export async function loadAllTemplates(): Promise<Templates> {
  return (await get<Templates>(INSERT_STORAGE.templates)) ?? {}
}

export async function loadTemplates(): Promise<Template[]> {
  return liveTemplates(await loadAllTemplates())
}

export async function saveTemplate(t: Template): Promise<void> {
  const all = await loadAllTemplates()
  await set({ [INSERT_STORAGE.templates]: { ...all, [t.id]: t } })
}

export async function deleteTemplate(id: string): Promise<void> {
  const all = await loadAllTemplates()
  if (!all[id]) return
  await set({ [INSERT_STORAGE.templates]: { ...all, [id]: tombstone(all[id], Date.now()) } })
}

export function onTemplates(listener: () => void): () => void {
  return onKey(INSERT_STORAGE.templates, listener)
}

/** The app's and iCloud's changes, pulled now. */
export function syncTemplatesNow(): Promise<{ changed: boolean } | null> {
  return sendBackground<{ changed: boolean }>({ type: "qiSync" })
}

export async function loadUse(): Promise<TemplateUse> {
  return (await get<TemplateUse>(INSERT_STORAGE.templateUse)) ?? {}
}

export async function countUse(id: string, host: string): Promise<void> {
  await set({ [INSERT_STORAGE.templateUse]: noteUse(await loadUse(), id, siteKey(host), Date.now()) })
}

// ------------------------------------------------------------ the first-touch tip

export async function tipSeen(): Promise<boolean> {
  return Boolean(await get<boolean>(INSERT_STORAGE.tipSeen))
}

export async function markTipSeen(): Promise<void> {
  await set({ [INSERT_STORAGE.tipSeen]: true })
}

// ------------------------------------------------------------ From ContextFlow

export interface LastReply {
  text: string
  note: boolean
  at: number
}

/** The latest answer or note in the user's chats (the newest chat first). */
export async function lastReply(): Promise<LastReply | null> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const list = Object.values(threads).filter((t) => !t.deleted && t.m?.length).sort((a, b) => (b.a ?? b.u) - (a.a ?? a.u))
  for (const t of list.slice(0, 3)) {
    for (let i = t.m.length - 1; i >= 0; i--) {
      const m = t.m[i]
      if (m.role === "assistant" || m.note) {
        const text = m.role === "assistant" ? toPlainText(m.content) : m.content
        if (text.trim()) return { text: text.trim(), note: Boolean(m.note), at: t.a ?? t.u }
      }
    }
  }
  return null
}
