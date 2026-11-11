// What the extension shares through the native bridge (SafariWebExtensionHandler.swift):
// the settings, edited here or in the ContextFlow app (App Group); "moments of value" after
// which the app may ask for an App Store rating; and the chats (threads), kept in the user's
// iCloud so they continue on their other devices.

import { sortedJson } from "../shared/stored"
import { applyAppChanges, applyRemote, markMirrored, markSent, mirrorChanges, pendingChanges, purgeTrash, type CloudChange, type Threads } from "../shared/threads"
import { DEFAULT_SETTINGS, STORAGE, type Settings } from "../shared/types"
import { callNative } from "./native"

interface SharedSettings {
  settings: Partial<Settings> | null
  updatedAt: number
}

// Settings just written from the app's copy, as sortedJson (Safari hands them back with their keys in its own order):
// don't send them straight back.
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
    lastApplied = sortedJson(settings)
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
    if (!settings || sortedJson(settings) === lastApplied) return
    const updatedAt = Number(changes[STORAGE.settingsUpdatedAt]?.newValue ?? Date.now())
    void callNative("setSettings", { settings, updatedAt })
  })
}

// The app asks for a rating (Apple shows it at most 3 times a year) after these many good answers (ReviewGate.swift
// milestones, the same).
export const REVIEW_MOMENTS = new Set([3, 10, 30, 100, 300])

/**
 * Counts a successful answer (an answer streamed to its end, not an error, a refusal or a stop); on a milestone tells
 * the app it's a good moment to ask for a rating (the App Group, read when the app next comes to the front) and returns
 * the milestone, to be counted as due ("rate" "due", 2.6 (100)).
 */
export async function countValueMoment(): Promise<number | null> {
  const count = Number((await chrome.storage.local.get(STORAGE.valueMoments))[STORAGE.valueMoments] ?? 0) + 1
  await chrome.storage.local.set({ [STORAGE.valueMoments]: count })
  if (!REVIEW_MOMENTS.has(count)) return null
  await callNative("reviewMoment", { count })
  return count
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
// The threads value this background last wrote (sortedJson: Safari hands it back with its keys in its own order): its
// own writes don't trigger another sync. Compared as written, Safari's copy never matched, and every sync's own write
// started the next one, every second or so, for as long as Safari ran; the open chat list was redrawn each time, and
// chats with the same time traded places (2.5 (77)).
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
  const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
  // Chats in Recently Deleted for 30 days go for good, their deletions with this sync (2.5 (83)).
  const at = Date.now()
  const threads = purgeTrash((stored[STORAGE.threads] as Threads | undefined) ?? {}, synced, at).threads
  const sent = pendingChanges(threads, synced)
  const result = await callNative<CloudSync>("syncThreads", { token: stored[STORAGE.syncToken] ?? null, changes: sent }, 20_000)
  if (!result?.available) return false // not in Safari, no iCloud account, or offline

  // Threads may have changed here while iCloud answered: apply to the current copy (purged the same way, so the
  // deletions just sent are forgotten, not sent again as chats).
  const now = purgeTrash((await chrome.storage.local.get(STORAGE.threads))[STORAGE.threads] as Threads | undefined ?? {}, synced, at).threads
  const afterSend = markSent(now, synced, sent)
  const merged = applyRemote(afterSend.threads, afterSend.synced, result.changed ?? [], result.deleted ?? [])
  // Changed here during the sync, or newer here than iCloud's copy: send it right away.
  if (pendingChanges(merged.threads, merged.synced).length > 0) again = true
  lastWritten = sortedJson(merged.threads)
  await chrome.storage.local.set({
    [STORAGE.threads]: merged.threads,
    [STORAGE.syncedThreads]: merged.synced,
    [STORAGE.syncToken]: result.token ?? null
  })
  return merged.changed
}

/**
 * Sends thread changes to iCloud shortly after they are saved (a new answer, a new or deleted chat),
 * and every change (iCloud's too) to the ContextFlow app's copy.
 */
export function watchThreads(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE.threads]) return
    clearTimeout(mirrorTimer)
    mirrorTimer = setTimeout(() => void mirrorThreads().catch(() => undefined), 1_200)
    if (sortedJson(changes[STORAGE.threads].newValue ?? {}) === lastWritten) return
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void syncThreads().catch(() => undefined), 800)
  })
}

// ------------------------------------------------------------ the ContextFlow app's copy

interface MirrorReply {
  // Chats renamed, pinned or deleted in the app since the last call, and the time of the latest.
  appChanges?: CloudChange[]
  at?: number
  // A chat the app asked to continue in Safari ("Open in Safari").
  open?: string | null
}

let mirroring: Promise<string | null> | null = null
let mirrorTimer: ReturnType<typeof setTimeout> | undefined

/**
 * When the background starts: a copy for the app made by an older version, or long ago (at most every
 * 10 minutes: Safari starts the background often, and the panel and every chat change mirror anyway).
 */
export async function mirrorOnStart(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE.mirroredAt)
  if (Date.now() - Number(stored[STORAGE.mirroredAt] ?? 0) < 10 * 60_000) return
  await mirrorThreads()
}

/**
 * Keeps the app's copy of the chats (App Group, read by its Chats screen) up to date, and takes the
 * changes made there. Every chat goes, whether iCloud sync is on or not: it stays on this device.
 * `takeOpen` (the panel opening): also returns the chat the app asked to continue, if any — only the
 * panel takes it, so a background start doesn't use it up.
 */
export function mirrorThreads(takeOpen = false): Promise<string | null> {
  if (mirroring) return takeOpen ? mirroring.then(() => mirrorThreads(true), () => mirrorThreads(true)) : mirroring
  mirroring = mirrorOnce(takeOpen).finally(() => {
    mirroring = null
  })
  return mirroring
}

async function mirrorOnce(takeOpen: boolean): Promise<string | null> {
  let open: string | null = null
  let ack: number | null = null
  // Big chats go over several calls; the app's changes come with the first answer.
  for (let round = 0; round < 20; round++) {
    const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.mirroredThreads, STORAGE.syncedThreads])
    const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
    const mirrored = (stored[STORAGE.mirroredThreads] as Record<string, number> | undefined) ?? {}
    const sent = mirrorChanges(threads, mirrored)
    if (round > 0 && sent.length === 0 && ack === null) break
    const reply: MirrorReply | null = await callNative<MirrorReply>("mirrorThreads", { changes: sent, ack, takeOpen: takeOpen && round === 0 }, 10_000)
    if (!reply) return open // not in Safari, or an app without the bridge
    ack = null
    open = reply.open ?? open
    const update: Record<string, unknown> = { [STORAGE.mirroredThreads]: markMirrored(mirrored, sent), [STORAGE.mirroredAt]: Date.now() }
    if (reply.appChanges?.length) {
      const now = (await chrome.storage.local.get(STORAGE.threads))[STORAGE.threads] as Threads | undefined ?? {}
      const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
      const applied = applyAppChanges(now, synced, reply.appChanges)
      if (applied.changed) update[STORAGE.threads] = applied.threads
      // Applied: the app can forget them (next call).
      ack = reply.at ?? null
    }
    await chrome.storage.local.set(update)
    if (sent.length === 0 && ack === null) break
  }
  return open
}
