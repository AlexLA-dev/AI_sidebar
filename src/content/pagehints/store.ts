// The page hints' state on this device (2.7, plan section 6): when they started, what was shown and used, ✕ in a row,
// off or on. Earlier use is read once from what the device already keeps, so nobody is offered what they use.

import { freshState, type HintId, type HintsState } from "./rules"

const KEY = "cf:pageHints"

export async function loadHints(now: number): Promise<HintsState> {
  try {
    const kept = (await chrome.storage.local.get(KEY))[KEY] as Partial<HintsState> | undefined
    return kept && typeof kept.start === "number" ? { ...freshState(now), ...kept } : freshState(now)
  } catch {
    return freshState(now)
  }
}

export async function saveHints(state: HintsState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state }).catch(() => undefined)
}

/** Features the person used before the hints came (2.7): Find similar or reminders in a chat, watches, templates, Listen. */
export function usedFrom(stored: Record<string, unknown>): HintId[] {
  const used = new Set<HintId>()
  const threads = (stored["cf:threads"] ?? {}) as Record<string, { m?: Array<Record<string, unknown>>; deleted?: unknown }>
  for (const thread of Object.values(threads)) {
    for (const m of thread?.m ?? []) {
      if (m?.similar || m?.similarAsk !== undefined) used.add("similar")
      if (m?.remind) used.add("remind")
    }
  }
  const watches = stored["cf:watches"]
  if (watches && typeof watches === "object" && Object.keys(watches).length) used.add("watch")
  const templates = stored["cf:templates"]
  if (templates && typeof templates === "object" && Object.values(templates as Record<string, { deleted?: unknown }>).some((t) => t && !t.deleted)) used.add("templates")
  const voiced = stored["cf:voiced"]
  if (voiced && typeof voiced === "object" && Object.keys(voiced).length) used.add("listen")
  return [...used]
}

export async function seeded(state: HintsState): Promise<HintsState> {
  if (state.seeded) return state
  try {
    const stored = await chrome.storage.local.get(["cf:threads", "cf:watches", "cf:templates", "cf:voiced"])
    const used = new Set([...state.used, ...usedFrom(stored)])
    return { ...state, used: [...used], seeded: true }
  } catch {
    return { ...state, seeded: true }
  }
}

/** The switch in Settings: on unless turned off (there, or by two ✕ in a row). */
export async function hintsOn(): Promise<boolean> {
  return !(await loadHints(Date.now())).off
}

export async function setHintsOn(on: boolean): Promise<void> {
  const state = await loadHints(Date.now())
  await saveHints({ ...state, off: !on, closes: 0 })
}
