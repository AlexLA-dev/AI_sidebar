import type { Entry } from "../shared/conversation"
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

type LegacyChats = Record<string, { t: string; u: number; m: Entry[] }>

/**
 * The running conversation, shared by every tab and page until the user starts a new chat.
 * The first time, it continues the most recent per-page chat of 2.0 / 2.1.
 */
export async function loadConversation(): Promise<Entry[]> {
  const stored = await get<{ u: number; m: Entry[] }>(STORAGE.conversation)
  if (stored) return stored.m
  const legacy = (await get<LegacyChats>(STORAGE.chats)) ?? {}
  const [url, latest] = Object.entries(legacy).sort(([, a], [, b]) => b.u - a.u)[0] ?? []
  if (!url || !latest) return []
  // Those questions were asked on that page: keep it so later pages are told apart.
  return latest.m.map((m) => (m.role === "user" && !m.page ? { ...m, page: { url, title: latest.t } } : m))
}

export async function saveConversation(entries: Entry[]): Promise<void> {
  const next = entries.slice(-MAX_TURNS)
  const stored = await get<{ u: number; m: Entry[] }>(STORAGE.conversation)
  // Only real changes get a new time: it decides which device's conversation is the newest (iCloud sync),
  // and an empty panel on a new device must not replace the conversation from the others.
  if (stored ? JSON.stringify(stored.m) === JSON.stringify(next) : next.length === 0) return
  await set(STORAGE.conversation, { u: Date.now(), m: next })
}

export async function deleteAllChats(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE.conversation]: { u: Date.now(), m: [] }, [STORAGE.chats]: {} }).catch(() => undefined)
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
