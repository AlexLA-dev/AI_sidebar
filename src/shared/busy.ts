// Answers that take a while, run off the panel (2.6 (91), with similar-26: Find similar in the background, and any
// long answer later). Whoever runs one marks it busy and done; the panel shows it: a "working" row in that chat, a
// spinner on its row in the chat list, and a dot on the round button once it's done while the person was elsewhere
// (unread until they open the chat). Everything is in chrome.storage.local, so the background, the panel on any page
// and the toolbar popup see the same.

const BUSY = "cf:busy"
const UNREAD = "cf:unread"
const VIEWING = "cf:viewing"

export type BusyMap = Record<string, { kind: string; since: number }>
export type UnreadItem = { id: string; at: number; kind: string }
export type BusyState = { busy: BusyMap; unread: UnreadItem[] }

// A run that never said "done" (the browser closed it) stops counting after this long.
const STALE_MS = 10 * 60_000

async function read<T>(key: string, fallback: T): Promise<T> {
  try {
    return ((await chrome.storage.local.get(key))[key] as T | undefined) ?? fallback
  } catch {
    return fallback
  }
}

async function write(values: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(values)
  } catch {
    // No storage: nothing shown.
  }
}

/** The busy chats (stale ones dropped) and the unread ones. */
export async function readBusy(now = Date.now()): Promise<BusyState> {
  const busy = await read<BusyMap>(BUSY, {})
  const live = Object.fromEntries(Object.entries(busy).filter(([, b]) => now - b.since < STALE_MS))
  return { busy: live, unread: await read<UnreadItem[]>(UNREAD, []) }
}

/** A long answer started for the chat `threadId` (the id the panel saves the chat under). */
export async function markBusy(threadId: string, kind: string): Promise<void> {
  const busy = await read<BusyMap>(BUSY, {})
  await write({ [BUSY]: { ...busy, [threadId]: { kind, since: Date.now() } } })
}

/** It ended (answered or failed): not busy; unread unless the panel shows that chat right now. */
export async function markDone(threadId: string, { ok }: { ok: boolean }): Promise<void> {
  const busy = await read<BusyMap>(BUSY, {})
  const kind = busy[threadId]?.kind ?? "answer"
  const { [threadId]: _, ...rest } = busy
  const viewing = await read<{ id: string | null }>(VIEWING, { id: null })
  const unread = await read<UnreadItem[]>(UNREAD, [])
  const seen = viewing.id === threadId
  await write({
    [BUSY]: rest,
    [UNREAD]: seen ? unread.filter((u) => u.id !== threadId) : [...unread.filter((u) => u.id !== threadId), { id: threadId, at: Date.now(), kind: ok ? kind : `${kind}:error` }]
  })
}

/** The panel shows this chat (null: the panel is closed or shows something else). */
export async function setViewing(threadId: string | null): Promise<void> {
  await write({ [VIEWING]: { id: threadId, at: Date.now() } })
}

/** The chat was opened: no longer unread. */
export async function clearUnread(threadId: string): Promise<void> {
  const unread = await read<UnreadItem[]>(UNREAD, [])
  if (unread.some((u) => u.id === threadId)) await write({ [UNREAD]: unread.filter((u) => u.id !== threadId) })
}

/** Calls `cb` with the state now and whenever it changes. */
export function onBusy(cb: (state: BusyState) => void): () => void {
  let alive = true
  const update = () => void readBusy().then((s) => alive && cb(s))
  update()
  const handler = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && (BUSY in changes || UNREAD in changes)) update()
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    // No storage events: the state as it was.
  }
  return () => {
    alive = false
    try {
      chrome.storage.onChanged.removeListener(handler)
    } catch {
      // Already gone.
    }
  }
}
