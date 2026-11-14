// «Снимок страницы в заметке» (2.7), the background's part: Safari's capture of the visible tab, and the pictures kept
// for notes. In Safari they go to the native side (ShotStore.swift: a file in the App Group, and the person's iCloud in
// its own zone when chats sync there), in parts of SHOT_LIMITS.chunk base64 characters each way; elsewhere (a test
// build), and when the native side can't take one, in this extension's storage. Nothing goes to our server.

import { TARGET } from "../shared/config"
import { chunks, orphanShots, SHOT_LIMITS, shotsInUse, validShotId, type MadeShots } from "../shared/shots"
import { DEFAULT_SETTINGS, STORAGE, type Settings } from "../shared/types"
import type { Threads } from "../shared/threads"
import { callNative } from "./native"

const MADE = "cf:shotsMade"
const LOCAL = (id: string) => `cf:shot:${id}`

export type ShotCode = "UNAVAILABLE" | "FAILED" | "NOT_FOUND"

/** What's on screen in the tab, as a JPEG data URL (device pixels). */
export async function captureTab(windowId: number | undefined): Promise<{ ok: true; data: string } | { ok: false; code: ShotCode; error?: string }> {
  const capture = chrome.tabs?.captureVisibleTab
  if (typeof capture !== "function") return { ok: false, code: "UNAVAILABLE" }
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const done = (url?: string) => {
        const err = chrome.runtime.lastError
        if (err || !url) reject(new Error(err?.message ?? "no image"))
        else resolve(url)
      }
      // Safari and Chrome take the window (or null for the current one) and the options.
      const result = (capture as unknown as (w: number | null, o: object, cb: (u?: string) => void) => unknown)(windowId ?? null, { format: "jpeg", quality: 92 }, done)
      // Safari's browser.* returns a promise and may not call back.
      if (result && typeof (result as Promise<string>).then === "function") (result as Promise<string>).then(resolve, reject)
    })
    return { ok: true, data }
  } catch (err) {
    return { ok: false, code: "FAILED", error: err instanceof Error ? err.message.slice(0, 120) : "unknown" }
  }
}

async function cloudOn(): Promise<boolean> {
  const prefs = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] as Partial<Settings> | undefined
  return prefs?.syncChats ?? DEFAULT_SETTINGS.syncChats
}

/** Keeps a note's picture (a JPEG data URL): in Safari through the native side, else here. Its number of parts. */
export async function putShot(id: string, dataUrl: string): Promise<{ ok: true; parts: number; where: "native" | "local" } | { ok: false }> {
  if (!validShotId(id) || !dataUrl.startsWith("data:image/jpeg;base64,")) return { ok: false }
  const base64 = dataUrl.slice("data:image/jpeg;base64,".length)
  const parts = chunks(base64)
  let where: "native" | "local" = "local"
  if (TARGET === "safari") {
    const cloud = await cloudOn()
    let ok = true
    for (let i = 0; i < parts.length && ok; i++) {
      // The last part waits for iCloud too (the native side gives it up to 28 s).
      const reply = await callNative<{ ok?: boolean }>("shot_put", { id, part: i, of: parts.length, data: parts[i], cloud }, i === parts.length - 1 ? 30_000 : 15_000)
      ok = reply?.ok === true
    }
    if (ok) where = "native"
  }
  if (where === "local") await chrome.storage.local.set({ [LOCAL(id)]: dataUrl })
  const made = ((await chrome.storage.local.get(MADE))[MADE] as MadeShots | undefined) ?? {}
  await chrome.storage.local.set({ [MADE]: { ...made, [id]: { at: Date.now(), parts: parts.length } } })
  return { ok: true, parts: parts.length, where }
}

// The last pictures asked for, kept for a moment (opening one again doesn't go to iCloud again).
const kept = new Map<string, string>()

/** A note's picture as a JPEG data URL: here, from the App Group, or from iCloud (another device made it). */
export async function getShot(id: string, parts: number): Promise<{ ok: true; data: string } | { ok: false; code: ShotCode }> {
  if (!validShotId(id)) return { ok: false, code: "NOT_FOUND" }
  const hit = kept.get(id)
  if (hit) return { ok: true, data: hit }
  const local = (await chrome.storage.local.get(LOCAL(id)))[LOCAL(id)] as string | undefined
  if (local) return { ok: true, data: remember(id, local) }
  if (TARGET !== "safari") return { ok: false, code: "NOT_FOUND" }
  const got: string[] = []
  let offset = 0
  let total = Infinity
  // At most 40 MB: a misbehaving answer can't loop for ever.
  while (offset < total && offset < 40 << 20) {
    const part = await callNative<{ ok?: boolean; data?: string; total?: number; length?: number; code?: string }>("shot_get", { id, parts, offset }, 25_000)
    if (!part?.ok || typeof part.data !== "string" || typeof part.total !== "number" || !part.length) return { ok: false, code: part?.code === "not_found" ? "NOT_FOUND" : "UNAVAILABLE" }
    got.push(part.data)
    total = part.total
    offset += part.length
  }
  return { ok: true, data: remember(id, `data:image/jpeg;base64,${got.join("")}`) }
}

function remember(id: string, data: string): string {
  kept.set(id, data)
  if (kept.size > 4) kept.delete(kept.keys().next().value as string)
  return data
}

async function deleteShot(id: string, parts: number): Promise<void> {
  kept.delete(id)
  await chrome.storage.local.remove(LOCAL(id))
  if (TARGET === "safari") await callNative("shot_delete", { id, parts }, 15_000)
}

/**
 * Pictures made here that no note has had for a week (the note deleted, its chat emptied from Recently Deleted) go,
 * here and in iCloud. Only this device's own: another device's new picture may not have its chat here yet.
 */
export async function sweepShots(now = Date.now()): Promise<number> {
  const stored = await chrome.storage.local.get([MADE, STORAGE.threads])
  const made = (stored[MADE] as MadeShots | undefined) ?? {}
  const gone = orphanShots(made, shotsInUse((stored[STORAGE.threads] as Threads | undefined) ?? {}), now)
  if (!gone.length) return 0
  for (const id of gone) await deleteShot(id, made[id].parts).catch(() => undefined)
  const next = { ...made }
  for (const id of gone) delete next[id]
  await chrome.storage.local.set({ [MADE]: next })
  return gone.length
}

export { SHOT_LIMITS }
