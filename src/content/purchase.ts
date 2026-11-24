// One-tap purchase from the panel (2.8, В7.2). «Choose» in the plans (the sheet, the plans in the chat at the limit)
// opens the App Store's sheet for that plan and period through the app, which then sends the person back here:
// iPhone and iPad open this page again with #cf-bought=<plan | later | no> (taken out of the address and the tab's
// history at once); the Mac brings Safari's own window back (this tab, its panel as it was). The panel remembers what
// was being bought, so on coming back it reads the plan afresh and says it's on. The page's address goes to the app on
// this device only (the link), never to our server.

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

// The fragment this page was loaded with (the content script runs as the page loads). The app's return opens the page's
// address with the mark: if this page didn't have it then, it came by a jump within the page, which Safari adds as a
// step to the tab's history (the director's acceptance 3, D2: Back turned on after Cancel, where it was off before).
const LOADED_WITH = typeof location === "undefined" ? "" : location.hash
// The step being taken back (history.back() is not at once: the mark stays in the address until it's done).
let undoing: string | null = null

interface Where {
  location: { hash: string; href: string; pathname: string; search: string }
  history: { state: unknown; back(): void; replaceState(state: unknown, title: string, url: string): void }
  loadedWith: string
}

/**
 * Takes the mark out of the address at once, leaving the tab's history as it was; null when there's none (or it's being
 * taken already). Came by a jump within the page: that step is taken back (Back is then as before the purchase, and goes
 * nowhere new: the step before is this same page). Loaded with it: the address is replaced.
 */
export function takeBoughtMark(where: Where = { location, history, loadedWith: LOADED_WITH }): string | null {
  const { location: at, history: steps } = where
  const mark = boughtMark(at.hash)
  if (!mark) {
    undoing = null
    return null
  }
  if (undoing === at.href) return null
  if (!boughtMark(where.loadedWith)) {
    undoing = at.href
    try {
      steps.back()
      return mark.word
    } catch {
      undoing = null
      // a page that won't let it: the address replaced below
    }
  }
  const clean = `${at.pathname}${at.search}${mark.rest}`
  try {
    steps.replaceState(steps.state, "", clean)
  } catch {
    try { steps.replaceState(null, "", clean) } catch { /* a page that won't let its address change: harmless */ }
  }
  return mark.word
}

/** What coming back means: the plan bought is on (a higher plan than before), or nothing changed (cancelled, waiting
 *  for approval, or starting at the renewal). */
export function boughtNow(buying: Buying | null, plan: Plan | null | undefined): PaidPlan | null {
  if (!buying || !plan || plan === "free") return null
  return PLAN_RANK[plan] > PLAN_RANK[buying.was] ? plan : null
}
