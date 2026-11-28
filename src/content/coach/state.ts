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

// This tab's changes, one after another: two at once (the first opening counts itself and ends the ✦ pulse in the same
// tap) each read the same stored copy and the second write lost the first's change (the simulator pass, 2.8).
let lane: Promise<unknown> = Promise.resolve()

/** The stored copy as it is now (no seeding: that ran on the first read). */
async function storedNow(): Promise<unknown> {
  return (await chrome.storage.local.get(COACH_KEY))[COACH_KEY]
}

/**
 * Read, change, write: the stored copy is the one changed, this tab's changes in turn. 2.8.1 (F6, the director):
 * another tab's write between this tab's read and its write was lost (a hint's show or the session's one hint, then a
 * second hint in that session). Right before writing, the stored copy is read again; when another tab wrote meanwhile,
 * the change is made again on that copy (changes are plain functions of the state), up to three times. What's left is
 * the moment between that last read and the write, not the change's whole way.
 */
export function changeCoach(change: (s: CoachState) => CoachState, now = Date.now()): Promise<CoachState> {
  const run = lane.then(() => changeStored(change, now, loadCoach, storedNow, saveCoach))
  lane = run.catch(() => undefined)
  return run
}

/** changeCoach's steps, apart from the storage (tests). */
export async function changeStored(
  change: (s: CoachState) => CoachState,
  now: number,
  load: (now: number) => Promise<CoachState>,
  peek: () => Promise<unknown>,
  save: (s: CoachState) => Promise<void>
): Promise<CoachState> {
  let base = await load(now)
  let next = change(base)
  for (let i = 0; i < 3; i++) {
    const kept = await peek()
    if (!valid(kept)) break
    const latest = { ...freshCoach(now), ...kept }
    if (JSON.stringify(latest) === JSON.stringify(base)) break
    base = latest
    next = change(base)
  }
  await save(next)
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
