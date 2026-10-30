import type { Entry } from "../shared/conversation"
import { activity, cleanTitle, liveThreads, newThreadId, prune, type ActiveThread, type Thread, type Threads } from "../shared/threads"
import { MAX_OTHER_PAGE_CHARS } from "../shared/prompt"
import { DEFAULT_SETTINGS, STORAGE, type Settings } from "../shared/types"

const MAX_TURNS = 40

async function get<T>(key: string): Promise<T | undefined> {
  try {
    return (await chrome.storage.local.get(key))[key] as T | undefined
  } catch {
    return undefined
  }
}

async function set(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value })
  } catch {
    // storage unavailable (extension reloaded); the UI keeps working in memory
  }
}

function normalize(stored: Partial<Settings> | undefined): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  // 2.0 / 2.1 showed the floating button only on iPhone and iPad ("auto"); now it's on everywhere.
  if (settings.fab === "auto") settings.fab = "on"
  return settings
}

export async function loadSettings(): Promise<Settings> {
  return normalize(await get<Partial<Settings>>(STORAGE.settings))
}

export async function saveSettings(settings: Settings): Promise<void> {
  // The time lets the background merge these settings with the copy edited in the ContextFlow app.
  await chrome.storage.local.set({ [STORAGE.settings]: settings, [STORAGE.settingsUpdatedAt]: Date.now() }).catch(() => undefined)
}

export async function hasConsent(): Promise<boolean> {
  return Boolean(await get<boolean>(STORAGE.consent))
}

export async function giveConsent(): Promise<void> {
  await set(STORAGE.consent, true)
}

export async function hasSeenTour(): Promise<boolean> {
  return Boolean(await get<boolean>(STORAGE.tourSeen))
}

export async function markTourSeen(): Promise<void> {
  await set(STORAGE.tourSeen, true)
}

// The text of recent pages, on this device only, so a "whole chat" answer can include the chat's other pages.
const MAX_PAGE_TEXTS = 30
type PageTexts = Record<string, { title: string; text: string; at: number }>

export async function rememberPageText(url: string, title: string, text: string): Promise<void> {
  if (!text.trim()) return
  const pages = (await get<PageTexts>(STORAGE.pageTexts)) ?? {}
  pages[url] = { title, text: text.slice(0, MAX_OTHER_PAGE_CHARS), at: Date.now() }
  await set(STORAGE.pageTexts, Object.fromEntries(Object.entries(pages).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PAGE_TEXTS)))
}

/** The remembered text of these pages (those this device has), in the same order. */
export async function pageTexts(urls: string[]): Promise<Array<{ title: string; url: string; text: string }>> {
  const pages = (await get<PageTexts>(STORAGE.pageTexts)) ?? {}
  return urls.flatMap((url) => (pages[url] ? [{ title: pages[url].title, url, text: pages[url].text }] : []))
}

/** Times the "swipe the button for a note" hint was shown; -1 once the user has switched to notes. */
export async function noteHintCount(): Promise<number> {
  return (await get<number>(STORAGE.noteHint)) ?? 0
}

export async function setNoteHintCount(count: number): Promise<void> {
  await set(STORAGE.noteHint, count)
}

type LegacyChats = Record<string, { t: string; u: number; m: Entry[] }>

/**
 * The threads (chats) and the one this device shows. The first time, the running conversation of
 * 2.2 (or the latest per-page chat of 2.0 / 2.1) becomes the first thread.
 */
export async function loadThreads(): Promise<{ threads: Threads; active: ActiveThread }> {
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.activeThread]).catch(() => ({} as Record<string, unknown>))
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? (await legacyThreads())
  let active = stored[STORAGE.activeThread] as ActiveThread | undefined
  if (!active) {
    active = { id: liveThreads(threads)[0]?.id ?? newThreadId(), at: Date.now() }
    await chrome.storage.local.set({ [STORAGE.threads]: threads, [STORAGE.activeThread]: active }).catch(() => undefined)
  }
  return { threads, active }
}

async function legacyThreads(): Promise<Threads> {
  const conversation = await get<{ u: number; m: Entry[] }>(STORAGE.conversation)
  let entries = conversation?.m ?? []
  let u = conversation?.u ?? Date.now()
  if (!conversation) {
    const legacy = (await get<LegacyChats>(STORAGE.chats)) ?? {}
    const [url, latest] = Object.entries(legacy).sort(([, a], [, b]) => b.u - a.u)[0] ?? []
    if (url && latest) {
      // Those questions were asked on that page: keep it so later pages are told apart.
      entries = latest.m.map((m) => (m.role === "user" && !m.page ? { ...m, page: { url, title: latest.t } } : m))
      u = latest.u
    }
  }
  if (entries.length === 0) return {}
  const id = newThreadId()
  return { [id]: { id, u, m: entries } }
}

/** Shows this thread on this device (a new id = a new, still empty thread). */
export async function setActiveThread(id: string): Promise<void> {
  await set(STORAGE.activeThread, { id, at: Date.now() })
}

export async function saveThread(id: string, entries: Entry[]): Promise<void> {
  const next = entries.slice(-MAX_TURNS)
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const stored = threads[id]
  // Only real changes get a new time: it decides which device's copy wins (iCloud sync),
  // and opening an empty thread doesn't store anything.
  if (stored ? JSON.stringify(stored.m) === JSON.stringify(next) : next.length === 0) return
  const now = Date.now()
  const title = stored && !stored.deleted ? stored.title : undefined
  await set(STORAGE.threads, prune({ ...threads, [id]: { id, u: now, a: now, m: next, ...(title ? { title } : {}) } }))
}

/** Names a chat (an empty name goes back to its first question); it keeps its place in the list. */
export async function renameThread(id: string, name: string): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const stored = threads[id]
  if (!stored || stored.deleted) return
  const title = cleanTitle(name)
  if (title === (stored.title ?? "")) return
  const renamed: Thread = { ...stored, u: Date.now(), a: activity(stored), title }
  if (!title) delete renamed.title
  await set(STORAGE.threads, { ...threads, [id]: renamed })
}

/** Pins a chat at `pin` (its place among the pinned ones) or unpins it (null); its place by activity stays. */
export async function pinThread(id: string, pin: number | null): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const stored = threads[id]
  if (!stored || stored.deleted) return
  const next: Thread = { ...stored, u: Date.now(), a: activity(stored) }
  if (pin === null) delete next.pin
  else next.pin = pin
  await set(STORAGE.threads, { ...threads, [id]: next })
}

export async function deleteThread(id: string): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  if (!threads[id]) return
  const synced = (await get<Record<string, number>>(STORAGE.syncedThreads)) ?? {}
  const next = { ...threads }
  // A chat iCloud has stays as a deletion until the other devices hear about it.
  if (id in synced) next[id] = { id, u: Date.now(), m: [], deleted: true }
  else delete next[id]
  await set(STORAGE.threads, next)
}

export async function deleteAllChats(): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const synced = (await get<Record<string, number>>(STORAGE.syncedThreads)) ?? {}
  const now = Date.now()
  const gone: Threads = {}
  for (const id of Object.keys(threads)) if (id in synced) gone[id] = { id, u: now, m: [], deleted: true }
  await chrome.storage.local.set({ [STORAGE.threads]: gone, [STORAGE.activeThread]: { id: newThreadId(), at: now }, [STORAGE.chats]: {} }).catch(() => undefined)
  await chrome.storage.local.remove([STORAGE.conversation, STORAGE.pageTexts]).catch(() => undefined)
}

/** Calls `listener` when threads change in another tab or come from another device. */
export function onThreadsChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && (changes[STORAGE.threads] || changes[STORAGE.activeThread])) listener()
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[STORAGE.settings]) {
      listener(normalize(changes[STORAGE.settings].newValue as Partial<Settings>))
    }
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}
