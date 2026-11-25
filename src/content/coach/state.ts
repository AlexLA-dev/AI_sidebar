// The coordinator's state on this device (2.8, В3.1): one key, read and written by every tab; never sent anywhere.
// Seeded once from what 2.7 keeps (seed.ts). «Start as a new user» (TestFlight) clears it with the rest of the first run
// (src/shared/firstRun.ts FIRST_RUN_KEYS).

import { COACH_KEY, freshCoach, type CoachState } from "./rules"
import { SEED_KEYS, seedCoach } from "./seed"

export { COACH_KEY }

function valid(kept: unknown): kept is CoachState {
  const s = kept as CoachState | undefined
  return !!s && s.v === 1 && typeof s.first === "number" && !!s.session && typeof s.hints === "object"
}

export async function loadCoach(now: number): Promise<CoachState> {
  try {
    const kept = (await chrome.storage.local.get(COACH_KEY))[COACH_KEY]
    const state = valid(kept) ? { ...freshCoach(now), ...kept } : freshCoach(now)
    if (state.seeded) return state
    const seeded = seedCoach(state, await chrome.storage.local.get([...SEED_KEYS]), now)
    await saveCoach(seeded)
    return seeded
  } catch {
    return freshCoach(now)
  }
}

export async function saveCoach(state: CoachState): Promise<void> {
  await chrome.storage.local.set({ [COACH_KEY]: state }).catch(() => undefined)
}

/** Read, change, write: the stored copy is the one changed (another tab may have written since). */
export async function changeCoach(change: (s: CoachState) => CoachState, now = Date.now()): Promise<CoachState> {
  const next = change(await loadCoach(now))
  await saveCoach(next)
  return next
}

/** Calls `listener` when another tab changed the state. */
export function onCoachChanged(listener: (s: CoachState) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const next = changes[COACH_KEY]?.newValue
    if (area === "local" && valid(next)) listener(next)
  }
  try {
    chrome.storage.onChanged.addListener(handler)
  } catch {
    return () => undefined
  }
  return () => chrome.storage.onChanged.removeListener(handler)
}
