// What the extension shares with the ContextFlow app through the native bridge
// (App Group, see SafariWebExtensionHandler.swift): the settings, edited in either place,
// and "moments of value" after which the app may ask for an App Store rating.

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
