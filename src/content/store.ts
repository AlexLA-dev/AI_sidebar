import { DEFAULT_SETTINGS, STORAGE, type ChatTurn, type Settings } from "../shared/types"

const MAX_CHATS = 40
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

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await get<Partial<Settings>>(STORAGE.settings)) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(STORAGE.settings, settings)
}

export async function hasConsent(): Promise<boolean> {
  return Boolean(await get<boolean>(STORAGE.consent))
}

export async function giveConsent(): Promise<void> {
  await set(STORAGE.consent, true)
}

type ChatStore = Record<string, { t: string; u: number; m: ChatTurn[] }>

export async function loadChat(key: string): Promise<ChatTurn[]> {
  const chats = (await get<ChatStore>(STORAGE.chats)) ?? {}
  return chats[key]?.m ?? []
}

export async function saveChat(key: string, title: string, messages: ChatTurn[]): Promise<void> {
  const chats = (await get<ChatStore>(STORAGE.chats)) ?? {}
  if (messages.length === 0) delete chats[key]
  else chats[key] = { t: title.slice(0, 120), u: Date.now(), m: messages.slice(-MAX_TURNS) }
  const keys = Object.keys(chats).sort((a, b) => chats[b].u - chats[a].u)
  for (const old of keys.slice(MAX_CHATS)) delete chats[old]
  await set(STORAGE.chats, chats)
}

export async function deleteAllChats(): Promise<void> {
  await set(STORAGE.chats, {})
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[STORAGE.settings]) {
      listener({ ...DEFAULT_SETTINGS, ...(changes[STORAGE.settings].newValue as Partial<Settings>) })
    }
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}
