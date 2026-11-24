// One-tap purchase from the panel (2.8, В7.2). «Choose» in the plans (the sheet, the plans in the chat at the limit)
// opens the App Store's sheet for that plan and period through the app, which then sends the person back here:
// iPhone and iPad open this page again with #cf-bought=<plan | later | no> (taken out of the address at once); the Mac
// brings Safari's own window back (this tab, its panel as it was). The panel remembers what was being bought, so on
// coming back it reads the plan afresh and says it's on. The page's address goes to the app on this device only (the
// link), never to our server.

import type { PaidPlan, Period, Plan } from "../shared/plan"
import { PLAN_RANK } from "../shared/plan"

const KEY = "cf:buying"
// A purchase this long ago is no longer the one coming back.
const FRESH_MS = 30 * 60_000

export interface Buying {
  plan: PaidPlan
  period: Period
  // The plan before (a purchase that only starts at the renewal leaves it as it is).
  was: Plan
  at: number
}

export async function noteBuying(buying: Buying): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: buying })
  } catch {
    // storage refused: the return still reads the plan when the mark is there
  }
}

export async function readBuying(now = Date.now()): Promise<Buying | null> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Buying | undefined
    return stored && typeof stored.at === "number" && now - stored.at < FRESH_MS ? stored : null
  } catch {
    return null
  }
}

export async function clearBuying(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY)
  } catch {
    // nothing kept
  }
}

/** The app's word in the address (#cf-bought=pro), and the rest of the fragment ("" when it was all ours). */
export function boughtMark(hash: string): { word: string; rest: string } | null {
  const m = /^#cf-bought=([a-z]{2,8})$/.exec(hash)
  return m ? { word: m[1], rest: "" } : null
}

/** Takes the mark out of the address at once (the page's history keeps no trace of it); null when there's none. */
export function takeBoughtMark(): string | null {
  const mark = boughtMark(location.hash)
  if (!mark) return null
  const clean = `${location.pathname}${location.search}${mark.rest}`
  try {
    history.replaceState(history.state, "", clean)
  } catch {
    try { history.replaceState(null, "", clean) } catch { /* a page that won't let its address change: harmless */ }
  }
  return mark.word
}

/** What coming back means: the plan bought is on (a higher plan than before), or nothing changed (cancelled, waiting
 *  for approval, or starting at the renewal). */
export function boughtNow(buying: Buying | null, plan: Plan | null | undefined): PaidPlan | null {
  if (!buying || !plan || plan === "free") return null
  return PLAN_RANK[plan] > PLAN_RANK[buying.was] ? plan : null
}
