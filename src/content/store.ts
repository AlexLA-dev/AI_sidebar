import { SPEEDS, type Speed } from "../shared/stretch"
import { CONSENT_VERSION, consentStatus, type ConsentStatus } from "../shared/consent"
import type { Entry } from "../shared/conversation"
import { activity, cleanTitle, liveThreads, moveEntries, newThreadId, prune, purgeTrash, restoreThread, savedThread, trashThread, undoMove, type ActiveThread, type MoveUndo, type Thread, type Threads, cleanTags } from "../shared/threads"
import { MAX_OTHER_PAGE_CHARS } from "../shared/prompt"
import { DEFAULT_SETTINGS, STORAGE, type Settings } from "../shared/types"


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

export async function loadConsent(): Promise<ConsentStatus> {
  return consentStatus(await get<unknown>(STORAGE.consent))
}

export async function giveConsent(): Promise<void> {
  await set(STORAGE.consent, CONSENT_VERSION)
}

/**
 * Calls `listener` when the consent changes in another tab (each tab read it once when its page loaded: a consent
 * given in one tab's panel left the tabs opened before it asking again, the template editor among them).
 */
export function onConsentChanged(listener: (status: ConsentStatus) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[STORAGE.consent]) listener(consentStatus(changes[STORAGE.consent].newValue))
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}

export async function hasSeenTour(): Promise<boolean> {
  return Boolean(await get<boolean>(STORAGE.tourSeen))
}

export async function markTourSeen(): Promise<void> {
  await set(STORAGE.tourSeen, true)
}

/** The plan the panel saw last (null before 2.6 saw any): an upgrade from it starts that plan's tour. */
export async function lastPlanSeen(): Promise<string | null> {
  return (await get<string>(STORAGE.planLast)) ?? null
}

export async function setLastPlanSeen(plan: string): Promise<void> {
  await set(STORAGE.planLast, plan)
}

/** The plans whose tour was shown (finished or skipped): each shows once by itself, then from the "…" menu. */
export async function planToursSeen(): Promise<string[]> {
  return (await get<string[]>(STORAGE.planTours)) ?? []
}

export async function markPlanToursSeen(plans: string[]): Promise<void> {
  const seen = await planToursSeen()
  await set(STORAGE.planTours, [...new Set([...seen, ...plans])])
}

export type HintKey = "chats" | "video" | "pdf"

/** The "first time here" hints already shown. */
export async function seenHints(): Promise<HintKey[]> {
  return (await get<HintKey[]>(STORAGE.hintsSeen)) ?? []
}

export async function markHintSeen(key: HintKey): Promise<void> {
  const seen = await seenHints()
  if (!seen.includes(key)) await set(STORAGE.hintsSeen, [...seen, key])
}

/** Read aloud's last speed (1× until one is chosen). */
export async function listenSpeed(): Promise<Speed> {
  const kept = await get<number>(STORAGE.listenSpeed)
  return (SPEEDS as readonly number[]).includes(kept ?? 1) ? (kept as Speed) ?? 1 : 1
}

export async function setListenSpeed(speed: Speed): Promise<void> {
  await set(STORAGE.listenSpeed, speed)
}

/** Whether the switch-to-yearly line is hidden for now ("Hide": 60 days). */
export async function yearlyHiddenNow(): Promise<boolean> {
  return ((await get<number>(STORAGE.yearlyHiddenUntil)) ?? 0) > Date.now()
}

export async function hideYearly(): Promise<void> {
  await set(STORAGE.yearlyHiddenUntil, Date.now() + 60 * 86_400_000)
}

/** "Show tips" in Settings: the tour and the hints come back. */
export async function resetHints(): Promise<void> {
  await set(STORAGE.hintsSeen, [])
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

/** Page visits that showed the hint about the field and Note by a selection; -1 once one was used. */
export async function selHintCount(): Promise<number> {
  return (await get<number>(STORAGE.selHint)) ?? 0
}

export async function setSelHintCount(count: number): Promise<void> {
  await set(STORAGE.selHint, count)
}

/** The subscription period the auto-renew question was asked in (answered or put off), on this device. */
export async function renewalAskedPeriod(): Promise<string | null> {
  return (await get<string>(STORAGE.renewalAsked)) ?? null
}

/** How many times the Pro offer card was shown to an install that ran out of answers before; -1 once answered. */
export async function offerCardCount(): Promise<number> {
  return (await get<number>(STORAGE.offerCard)) ?? 0
}

export async function setOfferCardCount(count: number): Promise<void> {
  await set(STORAGE.offerCard, count)
}

type LegacyChats = Record<string, { t: string; u: number; m: Entry[] }>

/**
 * The threads (chats) and the one this device shows. The first time, the running conversation of
 * 2.2 (or the latest per-page chat of 2.0 / 2.1) becomes the first thread. Chats in Recently Deleted for
 * TRASH_DAYS are deleted for good here (with iCloud sync off too); a chat shown here that went to Recently Deleted
 * (on another device) gives way to a new one.
 */
export async function loadThreads(): Promise<{ threads: Threads; active: ActiveThread }> {
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.activeThread, STORAGE.syncedThreads]).catch(() => ({} as Record<string, unknown>))
  let threads = (stored[STORAGE.threads] as Threads | undefined) ?? (await legacyThreads())
  let active = stored[STORAGE.activeThread] as ActiveThread | undefined
  const update: Record<string, unknown> = {}
  if (!active) {
    active = { id: liveThreads(threads)[0]?.id ?? newThreadId(), at: Date.now() }
    update[STORAGE.threads] = threads
    update[STORAGE.activeThread] = active
  }
  const expired = purgeTrash(threads, (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {})
  if (expired.purged.length) update[STORAGE.threads] = threads = expired.threads
  if (threads[active.id]?.trashed !== undefined) update[STORAGE.activeThread] = active = { id: newThreadId(), at: Date.now() }
  if (Object.keys(update).length) await chrome.storage.local.set(update).catch(() => undefined)
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

/** Stores a chat's messages; `kind` marks a new "Ask your chats" chat (a chat keeps its kind). */
export async function saveThread(id: string, entries: Entry[], kind?: "history"): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  // Only real changes get a new time: it decides which device's copy wins (iCloud sync).
  const next = savedThread(threads[id], id, entries, Date.now(), kind)
  if (next) await set(STORAGE.threads, prune({ ...threads, [id]: next }))
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

/** Sets a chat's own tags; it keeps its place in the list. */
export async function setThreadTags(id: string, tags: string[]): Promise<void> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const stored = threads[id]
  if (!stored || stored.deleted) return
  const clean = cleanTags(tags)
  if (JSON.stringify(clean) === JSON.stringify(stored.tags ?? [])) return
  const next: Thread = { ...stored, u: Date.now(), a: activity(stored) }
  if (clean.length) next.tags = clean
  else delete next.tags
  await set(STORAGE.threads, { ...threads, [id]: next })
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

/**
 * Moves a chat the user deleted to Recently Deleted (2.5 (83)); returns it as it was, or null when there's none. It
 * goes to iCloud like any edit, so it's in Recently Deleted on every device.
 */
export async function trashChat(id: string): Promise<Thread | null> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const next = trashThread(threads, id)
  if (!next) return null
  await set(STORAGE.threads, next)
  return threads[id]
}

/** Brings a chat back from Recently Deleted, to its place by its last message. Returns it, or null. */
export async function restoreChat(id: string): Promise<Thread | null> {
  const threads = (await get<Threads>(STORAGE.threads)) ?? {}
  const next = restoreThread(threads, id)
  if (!next) return null
  await set(STORAGE.threads, next)
  return next[id]
}

/** Delete Now and Delete All in Recently Deleted: these chats are deleted for good, on every device. */
export async function purgeChats(ids: string[]): Promise<Threads> {
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.syncedThreads]).catch(() => ({} as Record<string, unknown>))
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
  const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
  const { threads: next, purged } = purgeTrash(threads, synced, Date.now(), ids)
  if (purged.length) await set(STORAGE.threads, next)
  return next
}

/** Deletes a chat at once: a question stopped before its answer that was all the chat had (not the user's delete). */
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
  // The messages' vectors (organizing) go with the chats, and what was read aloud (2.6, kept in the background).
  await chrome.storage.local.remove([STORAGE.conversation, STORAGE.pageTexts, STORAGE.orgVectors, STORAGE.orgVerdicts]).catch(() => undefined)
  await new Promise<void>((resolve) => chrome.runtime.sendMessage({ type: "speechClear" }, () => {
    void chrome.runtime.lastError
    resolve()
  }))
}

// ------------------------------------------------------------ organizing (2.5)

/**
 * Moves messages `start`…`end` of chat `sourceId` to chat `targetId` (a new chat when there's none): see
 * moveEntries. Returns both chats after it and what "Undo" needs, or null when it can't be moved.
 */
export async function moveBlock(sourceId: string, start: number, end: number, targetId: string): Promise<{ threads: Threads; undo: MoveUndo } | null> {
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.syncedThreads]).catch(() => ({} as Record<string, unknown>))
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
  const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
  const moved = moveEntries(threads, synced, sourceId, start, end, targetId)
  if (!moved) return null
  await set(STORAGE.threads, prune(moved.threads))
  return moved
}

/** "Undo" after a move: both chats as they were (or the messages back by key when one changed since). */
export async function undoBlockMove(undo: MoveUndo): Promise<Threads> {
  const stored = await chrome.storage.local.get([STORAGE.threads, STORAGE.syncedThreads]).catch(() => ({} as Record<string, unknown>))
  const threads = (stored[STORAGE.threads] as Threads | undefined) ?? {}
  const synced = (stored[STORAGE.syncedThreads] as Record<string, number> | undefined) ?? {}
  const next = undoMove(threads, synced, undo)
  await set(STORAGE.threads, next)
  return next
}

/**
 * The cards about organizing on this device: the question to turn suggestions on (answered), "Everything in one
 * chat?" (the chats it was shown in, when last, closed for good), the one after the third tag, the first one taken.
 */
export interface OrganizeCards {
  consent?: "accepted" | "declined"
  mess?: { chats: string[]; at: number; closed?: true }
  thirdTag?: true
  firstWin?: true
}

export async function organizeCards(): Promise<OrganizeCards> {
  return (await get<OrganizeCards>(STORAGE.orgCards)) ?? {}
}

export async function setOrganizeCards(patch: Partial<OrganizeCards>): Promise<OrganizeCards> {
  const next = { ...(await organizeCards()), ...patch }
  await set(STORAGE.orgCards, next)
  return next
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
