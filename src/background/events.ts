// Every event the background sends to /api/v2/event goes out from here (2.8.1, F4, the director): one after another, in
// the order they happened here, each body made in its turn. Before, each event waited for the app's «ours» mark on its
// own (up to about 9 s) and a later event could reach the server before an earlier one (a close before its open). Now
// the wait for the mark is one, shared (index.ts clientForEvent), and it runs inside the first event's turn, so the
// events behind it wait for it too and keep their order.

import { API_BASE } from "../shared/config"

// The director's review of #268 (point 2), bounded without a redesign:
// - A send is never given up on by us. In #268 it was aborted at 10 s, and a send the server had in fact
//   received was sent again (ext_on, the link: their «pending» marks stayed). Now the lane only stops waiting for it:
//   after HANDOFF_MS the next event goes, and the slow one still ends with the server's answer (or the browser's
//   own network error), which is what its caller acts on.
// - The backlog is bounded: at most MAX_QUEUED events wait; one more is dropped (null). The once-per-install events
//   keep their own «pending» marks in storage, so a dropped one goes on a later start.
// - What still waits when Safari unloads the background is lost, as before; with the hand-off the lane holds at most
//   the first event's wait for the mark (index.ts MARK_WAIT_MS) and HANDOFF_MS per event ahead.

/** How long the lane waits for one event's answer before the next event goes (the slow one isn't stopped). */
export const HANDOFF_MS = 3_000
/** The most events that may wait in the lane. */
export const MAX_QUEUED = 50

let lane: Promise<unknown> = Promise.resolve()
let queued = 0

export type Posted = { ok: boolean; status: number } | null

/**
 * Queues an event now; `make` builds its body when its turn comes (null: nothing to send). Resolves with the server's
 * answer, or null when it couldn't be sent (or was dropped from a full lane).
 */
export function postEvent(make: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null): Promise<Posted> {
  if (queued >= MAX_QUEUED) return Promise.resolve(null)
  queued++
  let answered!: (posted: Posted) => void
  const result = new Promise<Posted>((done) => (answered = done))
  const turn = lane.then(async () => {
    let body: Record<string, unknown> | null = null
    try {
      body = await make()
    } catch {
      body = null
    }
    if (!body) return answered(null)
    const sent = fetch(`${API_BASE}/api/v2/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then((res): Posted => ({ ok: res.ok, status: res.status }), (): Posted => null)
    void sent.then(answered)
    // The next event goes when this one is answered, or HANDOFF_MS on.
    await Promise.race([sent, new Promise((done) => setTimeout(done, HANDOFF_MS))])
  })
  lane = turn.catch(() => undefined).finally(() => {
    queued--
  })
  return result
}
