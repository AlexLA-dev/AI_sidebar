// Every event the background sends to /api/v2/event goes out from here (2.8.1, F4, the director): one after another, in
// the order they happened here, each body made in its turn. Before, each event waited for the app's «ours» mark on its
// own (up to about 9 s) and a later event could reach the server before an earlier one (a close before its open). Now
// the wait for the mark is one, shared (index.ts clientForEvent), and it runs inside the first event's turn, so the
// events behind it wait for it too and keep their order.

import { API_BASE } from "../shared/config"

/** How long one event's request may take before the next one goes (a stuck request never holds the rest). */
const POST_MS = 10_000

let lane: Promise<unknown> = Promise.resolve()

export type Posted = { ok: boolean; status: number } | null

/**
 * Queues an event now; `make` builds its body when its turn comes (null: nothing to send). Resolves with the server's
 * answer, or null when it couldn't be sent.
 */
export function postEvent(make: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null): Promise<Posted> {
  const run = lane.then(async (): Promise<Posted> => {
    const body = await make()
    if (!body) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POST_MS)
    try {
      const res = await fetch(`${API_BASE}/api/v2/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      return { ok: res.ok, status: res.status }
    } finally {
      clearTimeout(timer)
    }
  })
  const settled = run.catch((): Posted => null)
  lane = settled
  return settled
}
