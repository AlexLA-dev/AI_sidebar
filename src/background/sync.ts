// What the extension shares through the native bridge (SafariWebExtensionHandler.swift):
// the settings, edited here or in the ContextFlow app (App Group); "moments of value" after
// which the app may ask for an App Store rating; and the chats (threads), kept in the user's
// iCloud so they continue on their other devices.

import { applyRemote, markSent, pendingChanges, type Threads } from "../shared/threads"
import { DEFAULT_SETTINGS, STORAGE, type Settings } from "../shared/types"
import { callNative } from "./native"

interface SharedSettings {
  settings: Partial<Settings> | null
  updatedAt: number
}

// Settings just written from the app's copy: don't send them straight back.
let lastApplied = ""

async function localSettings(): Promise<{ settings: Settings | null; updatedAt: number }> {
  const stored = await chrome.storage.local.get([STORAGE.settings, STORAGE.settingsUpdatedAt])
  return {
    settings: (stored[STORAGE.settings] as Settings | undefined) ?? null,
    updatedAt: Number(stored[STORAGE.settingsUpdatedAt] ?? 0)
  }
}

/** Keeps the extension's and the app's settings the same: the more recently changed copy wins. */
export async function syncSettings(): Promise<void> {
  const remote = await callNative<SharedSettings>("getSettings")
  if (!remote) return // not in Safari, or an app without the bridge
  const local = await localSettings()
  if (remote.settings && remote.updatedAt > local.updatedAt) {
    const settings = { ...DEFAULT_SETTINGS, ...local.settings, ...remote.settings }
    lastApplied = JSON.stringify(settings)
    await chrome.storage.local.set({ [STORAGE.settings]: settings, [STORAGE.settingsUpdatedAt]: remote.updatedAt })
  } else if (local.settings && local.updatedAt > remote.updatedAt) {
    await callNative("setSettings", { settings: local.settings, updatedAt: local.updatedAt })
  }
}

/** Sends settings changed in the extension to the app. */
export function watchSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE.settings]) return
    const settings = changes[STORAGE.settings].newValue as Settings | undefined
    if (!settings || JSON.stringify(settings) === lastApplied) return
    const updatedAt = Number(changes[STORAGE.settingsUpdatedAt]?.newValue ?? Date.now())
    void callNative("setSettings", { settings, updatedAt })
  })
}

// The app asks for a rating (Apple shows it at most 3 times a year) after these many good answers.
const REVIEW_MOMENTS = new Set([3, 10, 30, 100, 300])

/** Counts a successful answer; on a milestone tells the app it's a good moment to ask for a rating. */
export async function countValueMoment(): Promise<void> {
  const count = Number((await chrome.storage.local.get(STORAGE.valueMoments))[STORAGE.valueMoments] ?? 0) + 1
  await chrome.storage.local.set({ [STORAGE.valueMoments]: count })
  if (REVIEW_MOMENTS.has(count)) await callNative("reviewMoment", { count })
}

// ------------------------------------------------------------ threads in iCloud

interface CloudSync {
  available: boolean
  token?: string
  changed?: { id: string; updatedAt: number; data: string }[]
  deleted?: string[]
}

let running: Promise<boolean> | null = null
let again = false
let pushTimer: ReturnType<typeof setTimeout> | undefined
// The threads value this background last wrote: its own writes don't trigger another sync.
let lastWritten = ""

async function syncEnabled(): Promise<boolean> {
  const stored = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] as Partial<Settings> | undefined
  return stored?.syncChats ?? DEFAULT_SETTINGS.syncChats
}

/**
 * Sends local thread changes to iCloud and takes the other devices' changes, in one native call.
 * Returns whether any thread here changed. Calls overlapping a running sync run once after it.
 */
export function syncThreads(): Promise<boolean> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    let changed = false
    // A few rounds at most, whatever happens.
    for (let round = 0; round < 3; round++) {
      again = false
      changed = (await syncOnce()) || changed
      if (!again) break
    }
    return changed
  })().finally(() => {
    running = null
  })
  return running
}

async function syncOnce(): Promise<boolean> {
  if (!(await syncEnabled())) return false
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.syncedThreads, STORAGE.syncToken])
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
  const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
  const sent = pendingChanges(threads, synced)
  const result = await callNative<CloudSync>("syncThreads", { token: stored[STORAGE.syncToken] ?? null, changes: sent }, 20_000)
  if (!result?.available) return false // not in Safari, no iCloud account, or offline

  // Threads may have changed here while iCloud answered: apply to the current copy.
  const now = (await chrome.storage.local.get(STORAGE.threads))[STORAGE.threads] as Threads | undefined ?? {}
  const afterSend = markSent(now, synced, sent)
  const merged = applyRemote(afterSend.threads, afterSend.synced, result.changed ?? [], result.deleted ?? [])
  // Changed here during the sync, or newer here than iCloud's copy: send it right away.
  if (pendingChanges(merged.threads, merged.synced).length > 0) again = true
  lastWritten = JSON.stringify(merged.threads)
  await chrome.storage.local.set({
    [STORAGE.threads]: merged.threads,
    [STORAGE.syncedThreads]: merged.synced,
    [STORAGE.syncToken]: result.token ?? null
  })
  return merged.changed
}

/** Sends thread changes to iCloud shortly after they are saved (a new answer, a new or deleted chat). */
export function watchThreads(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE.threads]) return
    if (JSON.stringify(changes[STORAGE.threads].newValue ?? {}) === lastWritten) return
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void syncThreads().catch(() => undefined), 800)
  })
}
