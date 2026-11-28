// Questions the panel gave up on before the background said anything (the director's review of #268, point 4).
//
// A question goes on its own port; if the background is slow to start (busy, just woken), the panel checks it after a
// silent wait and, with no answer, shows «lost its link» (Retry) or asks again once on a fresh port. The first port's
// question was still queued for the background: once the background got to it, it ran it as a job (a second answer, a
// second count against the limit, written into the chat after the panel had taken that question back). The panel now
// notes the question's id here as it gives up, and the background skips a question whose id is noted.

export const DROPPED_KEY = "cf:droppedAsks"
/** Noted ids are kept this long (a queued question reaches a background within minutes or never). */
const KEEP_MS = 60 * 60_000

type Area = { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }
const local = (): Area => (globalThis as unknown as { chrome: { storage: { local: Area } } }).chrome.storage.local

function listed(v: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  if (!v || typeof v !== "object") return out
  for (const [id, at] of Object.entries(v as Record<string, unknown>)) if (typeof at === "number" && now - at < KEEP_MS) out[id] = at
  return out
}

/** The panel: the question `id` is given up on (asked again, or the error shown). */
export async function dropAsk(id: string, area: Area = local(), now = Date.now()): Promise<void> {
  const kept = listed((await area.get([DROPPED_KEY]))[DROPPED_KEY], now)
  await area.set({ [DROPPED_KEY]: { ...kept, [id]: now } })
}

/** The background: the panel gave up on the question `id` before it got here. */
export async function wasDropped(id: string, area: Area = local(), now = Date.now()): Promise<boolean> {
  return id in listed((await area.get([DROPPED_KEY]).catch(() => ({} as Record<string, unknown>)))[DROPPED_KEY], now)
}
