// The install's first day on this device (2.8, the plan's rule: on day 1 the only place plans appear is the limit card).
// Day 1 is the device-local calendar day ContextFlow's panel first ran, as the panel session's hint coordinator defines
// it (`cf:coach.first`, ~/ContextFlow-work/panel-28/coordinator-design.md §2); until the coordinator keeps that, the
// first time this asks is kept here (`cf:firstSeen`). Read only: the coordinator's state is its own.

const OWN = "cf:firstSeen"

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** When this device first ran the panel (ms), the coordinator's word first; set now if nobody knows yet. */
export async function firstSeen(now = Date.now()): Promise<number> {
  try {
    const kept = await chrome.storage.local.get(["cf:coach", OWN])
    const coach = (kept["cf:coach"] as { first?: unknown } | undefined)?.first
    if (typeof coach === "number" && coach > 0) return coach
    if (typeof kept[OWN] === "number" && kept[OWN] > 0) return kept[OWN] as number
    await chrome.storage.local.set({ [OWN]: now })
  } catch {
    // storage refused: today counts as the first day
  }
  return now
}

/** Whether it is still the first day (device-local calendar day). */
export function onFirstDay(first: number, now = Date.now()): boolean {
  return localDay(first) === localDay(now)
}

export async function isFirstDay(now = Date.now()): Promise<boolean> {
  return onFirstDay(await firstSeen(now), now)
}
