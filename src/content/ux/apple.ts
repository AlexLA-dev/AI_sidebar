// Calendar and Reminders in the panel (2.7; src/shared/appleItems.ts, AppleItems.swift). The extension's native side
// says whether they can be added on this device and how: written by the extension when the app already has access,
// else handed to the app, which asks once (iPhone and iPad: the link must be followed during the tap itself; a Mac
// opens the app from the extension). Safari only, iOS 17+ and macOS 14+; free for everyone.

import { type AppleItem, itemNotes, MAX_ITEM_TITLE, wallOf } from "../../shared/appleItems"
import { citedNote, entryKey, type Entry } from "../../shared/conversation"
import { reminderText } from "../../shared/reminders"
import { followLink } from "../page"

type Send = <T>(message: unknown) => Promise<T | null>

/** The background, for the windows that have no `send` of their own (the Remind window). */
const bg: Send = <T>(message: unknown) =>
  new Promise<T | null>((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        void chrome.runtime.lastError
        resolve(response ?? null)
      })
    } catch {
      resolve(null)
    }
  })

export interface AppleStatus {
  available: boolean
  platform?: "ios" | "macos"
  // "write": the extension adds it; "none": the app asks first; "denied": Settings; "editor" (events on iPhone and
  // iPad): the app's system editor, which needs no access.
  reminders?: "write" | "none" | "denied"
  events?: "write" | "none" | "denied" | "editor"
  // Full access to Reminders only: the lists, for the card.
  lists?: Array<{ id: string; title: string }>
  defaultList?: string
}

export type AppleOutcome = "saved" | "app" | "denied" | "failed" | "unavailable" | "not-asked"

let known: AppleStatus | null = null

/** What's known now (null until the first answer): the chat asks for the marker only when it's available. */
export function appleNow(): AppleStatus | null {
  return known
}

/** Asks the native side again (a window or a card opens: access may have changed in Settings or the app meanwhile). */
export async function loadApple(send: Send = bg): Promise<AppleStatus> {
  const reply = await send<AppleStatus>({ type: "appleStatus" }).catch(() => null)
  known = reply && typeof reply.available === "boolean" ? reply : { available: false }
  return known
}

/** How an item of `kind` is added from here now. */
export function addWay(s: AppleStatus | null, kind: AppleItem["kind"]): "write" | "app" | "denied" | null {
  if (!s?.available) return null
  const access = kind === "reminder" ? s.reminders : s.events
  if (access === "write") return "write"
  if (access === "denied") return "denied"
  return "app"
}

let pending: { id: string; at: number } | null = null

/**
 * During the tap: on iPhone and iPad, when the extension can't add it, the app opens on a new id (Safari follows a link
 * only from a tap), and the item goes to the app under it a moment later (`takeHandoff`). Nothing on a Mac: the
 * extension opens the app itself.
 */
export function handoffInTap(kind: AppleItem["kind"]): string | undefined {
  pending = null
  if (known?.platform !== "ios" || addWay(known, kind) !== "app") return undefined
  const id = crypto.randomUUID().toLowerCase()
  followLink(`contextflow://add?id=${id}`)
  pending = { id, at: Date.now() }
  return id
}

/** The id the tap just opened the app on (a few seconds at most), once. */
export function takeHandoff(): string | undefined {
  const p = pending
  pending = null
  return p && Date.now() - p.at < 10_000 ? p.id : undefined
}

/** An Add's outcome as the usage registry names it (usage.ts "apple"). */
export function appleAction(outcome: AppleOutcome): string {
  return outcome === "saved" ? "added" : outcome.replace("-", "_")
}

export async function addToApple(send: Send, item: AppleItem, notes: string, opts: { url?: string; key?: string; list?: string; handoff?: string } = {}): Promise<AppleOutcome> {
  const reply = await send<{ outcome?: AppleOutcome }>({ type: "appleAdd", item, notes, ...opts }).catch(() => null)
  return reply?.outcome ?? "unavailable"
}

// ---------------------------------------------------------------- «Также в Напоминания»

const ALSO_KEY = "cf_also_reminders"

/** «Также в Напоминания» in the Remind window: this device's last choice (off until turned on). */
export async function alsoReminders(): Promise<boolean> {
  try {
    const got = await chrome.storage.local.get(ALSO_KEY)
    return got[ALSO_KEY] === true
  } catch {
    return false
  }
}

export function setAlsoReminders(on: boolean): void {
  try {
    void chrome.storage.local.set({ [ALSO_KEY]: on })
  } catch {
    // not kept: off next time
  }
}

/** The key a message's reminder has in Apple Reminders on this device (the app uses the same: MessageReminders). */
export function reminderKey(chat: string, entry: Entry): string {
  return `cf.remind.${chat}.${entryKey(entry)}`
}

/** contextflow://chat?id=…&m=… : the app opens the chat at the message (MessageReminders.link). */
export function chatLink(chat: string, entry: Entry): string {
  return `contextflow://chat?id=${encodeURIComponent(chat)}&m=${encodeURIComponent(entryKey(entry))}`
}

/**
 * A message's reminder in Apple Reminders too, at `at` (moved when it was there already), or taken back (`at` null).
 * Its title is what the notification says; its notes the page and the link back to the message.
 */
export async function mirrorReminder(send: Send, chat: string, entry: Entry, at: number | null): Promise<AppleOutcome | "removed"> {
  const key = reminderKey(chat, entry)
  if (at === null) {
    await send({ type: "appleRemove", key }).catch(() => null)
    return "removed"
  }
  const item: AppleItem = { kind: "reminder", title: reminderText(citedNote(entry)?.note || entry.content, MAX_ITEM_TITLE), confidence: "sure", ...wallOf(at) }
  const url = entry.page && /^https?:\/\//.test(entry.page.url) ? entry.page.url : undefined
  const notes = itemNotes(undefined, { url, chat: chatLink(chat, entry) }, entry.page?.title)
  const outcome = await addToApple(send, item, notes, { url, key, handoff: takeHandoff() })
  void send({ type: "useEvent", f: "apple", a: appleAction(outcome), what: "reminder", via: "remind" })
  return outcome
}

// ---------------------------------------------------------------- the AI's suggestions

/** The reminders and events the server read out of a text (nothing kept there). */
export async function readItems(send: Send, request: { text: string; words?: string; kind?: AppleItem["kind"]; title?: string }): Promise<{ items: AppleItem[] } | { error: string }> {
  const reply = await send<{ items?: AppleItem[]; error?: string }>({ type: "itemsRead", ...request }).catch(() => null)
  if (reply?.items) return { items: reply.items }
  return { error: reply?.error ?? "NETWORK" }
}
