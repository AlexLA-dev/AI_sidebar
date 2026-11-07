// The guided first request (2.6, the owner: "onboarding requests must not count against the user's limit"). The panel
// marks what it asks during its guide (src/content/Guide.tsx) with `tour: true`. The server honours the mark for an
// install's first few such answers only (cf_tour_take: a count kept with the install, never reset), so sending it on
// every request gains nothing. Such an answer is charged to everything but the install's own daily counter: the
// per-address and the global caps still hold. Until cf_tour_take is in the database (the 2.6 migration), the mark is
// ignored and the answer counts as before.

import type { Counter } from "./db.mts"

/** Whether to try the guide's free answer: marked so, on our key, an ordinary answer (not Google, not "Ask your
 * chats"), and not Pro (whose allowance is weekly and large). */
export function tourAsked(body: Record<string, unknown>, plan: string, google: boolean, history: boolean): boolean {
  return body.tour === true && !google && !history && plan !== "pro"
}

/** The install's own daily counter, which a free guided answer leaves out. */
export const installCounter = (installId: string) => `install:${installId}`

/** The counters a request is charged to: without the install's daily one when the guide's answer is free. */
export function tourCounters(counters: Counter[], installId: string, free: boolean): Counter[] {
  return free ? counters.filter((c) => c.subject !== installCounter(installId)) : counters
}
