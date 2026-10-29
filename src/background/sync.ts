// What the extension shares through the native bridge (SafariWebExtensionHandler.swift):
// the settings, edited here or in the ContextFlow app (App Group); "moments of value" after
// which the app may ask for an App Store rating; and the running conversation, kept in the
// user's iCloud so it continues on their other devices.

import { conversationForCloud, conversationFromCloud, type Entry } from "../shared/conversation"
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

// ------------------------------------------------------------ conversation in iCloud

interface StoredConversation {
  u: number
  m: Entry[]
}

interface CloudConversation {
  available: boolean
  updatedAt?: number
  data?: string
}

// The copy just written from iCloud: don't send it straight back.
let pulledAt = 0
let pushTimer: ReturnType<typeof setTimeout> | undefined

async function syncEnabled(): Promise<boolean> {
  const stored = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] as Partial<Settings> | undefined
  return stored?.syncChats ?? DEFAULT_SETTINGS.syncChats
}

async function localConversation(): Promise<StoredConversation | null> {
  return ((await chrome.storage.local.get(STORAGE.conversation))[STORAGE.conversation] as StoredConversation | undefined) ?? null
}

async function pushConversation(conversation: StoredConversation): Promise<void> {
  if (!(await syncEnabled())) return
  await callNative("putConversation", { updatedAt: conversation.u, data: conversationForCloud(conversation.m) }, 10_000)
}

/**
 * The panel opened: takes the conversation from iCloud if another device changed it since,
 * and returns it; sends ours instead if it is the newer one (an earlier upload failed).
 */
export async function pullConversation(): Promise<Entry[] | null> {
  if (!(await syncEnabled())) return null
  const remote = await callNative<CloudConversation>("getConversation", {}, 8_000)
  if (!remote?.available) return null // not in Safari, or no iCloud account
  const local = await localConversation()
  const remoteAt = remote.updatedAt ?? 0
  if (local && local.u > remoteAt) {
    void pushConversation(local)
    return null
  }
  if (!remote.data || remoteAt <= (local?.u ?? 0)) return null
  const entries = conversationFromCloud(remote.data)
  if (!entries) return null
  pulledAt = remoteAt
  await chrome.storage.local.set({ [STORAGE.conversation]: { u: remoteAt, m: entries } })
  return entries
}

/** Sends the conversation to iCloud shortly after it changes here (a new answer, New chat, Delete all chats). */
export function watchConversation(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE.conversation]) return
    const conversation = changes[STORAGE.conversation].newValue as StoredConversation | undefined
    if (!conversation || conversation.u === pulledAt) return
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void pushConversation(conversation).catch(() => undefined), 800)
  })
}
