// The cookie closer on a page (2.7.1): when the page is idle, and as it changes for a short while after (banners
// come late), until a banner is answered. The agent's tasks use it too: a banner is answered before the page is read,
// so it's never a step or a question (index.tsx, agentMap).

import { closesOn, COOKIE_KEY, counted, readState, rollDay, tell, type CookieState, type LeftWhy } from "../../shared/cookies/state.ts"
import { closeOnce, pageEnv, tcfSign, type CloseResult } from "./closer.ts"

declare const __COOKIE_DEBUG__: boolean
const DEBUG = typeof __COOKIE_DEBUG__ !== "undefined" && __COOKIE_DEBUG__

// The watch after the page is idle: banners come within seconds; past this, nothing more is looked at.
const WATCH_MS = 20_000
// Changes looked at once after a pause (a burst of a page's changes is one look).
const QUIET_MS = 450
// At most this many looks on a page.
const LOOKS = 30

export interface Closed {
  via: string
  // The confirmation by the ✦ button shows (the first times only).
  tell: boolean
}

async function load(): Promise<CookieState> {
  try {
    return readState((await chrome.storage.local.get(COOKIE_KEY))[COOKIE_KEY])
  } catch {
    return {}
  }
}

async function save(state: CookieState): Promise<void> {
  await chrome.storage.local.set({ [COOKIE_KEY]: state }).catch(() => undefined)
}

function send(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage({ type: "useEvent", f: "cookies", ...message }, () => void chrome.runtime.lastError)
  } catch {
    // the extension was updated under this page: nothing to send to
  }
}

/** Yesterday's counts, once: one event for each platform's answers and each reason banners were left. */
async function reportDay(): Promise<void> {
  const state = await load()
  const { report, state: next } = rollDay(state, Date.now())
  if (next === state) return
  await save(next)
  if (!report) return
  for (const [what, count] of Object.entries(report.done)) send({ a: "closed", what, count })
  for (const [why, count] of Object.entries(report.left)) send({ a: "left", why, count })
}

/** Counts the outcome for today; for an answered banner, whether its confirmation shows. */
export async function record(result: CloseResult): Promise<Closed | null> {
  if (result.status === "none") return null
  let state = await load()
  if (result.status === "done") {
    state = counted(state, Date.now(), { via: result.via })
    await save(state)
    return { via: result.via, tell: tell(state).show || DEBUG }
  }
  await save(counted(state, Date.now(), { left: result.why as LeftWhy }))
  return null
}

let watching = false

/**
 * Answers this page's cookie banner, if the closer is on here: a look now, then on the page's changes for a short
 * while. `closed` hears each banner answered (for the confirmation); `left` (test builds) each one left alone.
 */
export async function startCookieCloser(closed: (c: Closed) => void, left?: (why: string, via: string) => void): Promise<void> {
  if (watching || window.top !== window) return
  watching = true
  await reportDay()
  const state = await load()
  if (!closesOn(state, location.hostname)) return

  const started = Date.now()
  let looks = 0
  let busy = false
  let again = false
  let finished = false
  let timer = 0
  const observer = new MutationObserver(() => {
    if (finished || timer) return
    timer = setTimeout(() => {
      timer = 0
      void look()
    }, QUIET_MS) as unknown as number
  })
  const stop = () => {
    finished = true
    observer.disconnect()
    clearTimeout(timer)
    clearTimeout(end)
  }
  const end = setTimeout(stop, WATCH_MS) as unknown as number

  async function look(): Promise<void> {
    if (finished) return
    if (busy) {
      again = true
      return
    }
    if (++looks > LOOKS || Date.now() - started > WATCH_MS) return stop()
    busy = true
    try {
      const result = await closeOnce(pageEnv(document, tcfSign(document)))
      if (result.status === "done") {
        stop()
        const c = await record(result)
        if (c) closed(c)
        return
      }
      if (result.status === "left") {
        await record(result)
        if (DEBUG) left?.(result.why, result.via)
      }
    } finally {
      busy = false
    }
    if (again && !finished) {
      again = false
      void look()
    }
  }

  observer.observe(document.documentElement, { childList: true, subtree: true })
  await look()
}

/**
 * Before the agent reads a page: its cookie banner answered (whatever the switch, the agent always took «only
 * necessary» itself; a site in the exception list is left as it is), and gone before the page is read.
 */
export async function closeForAgent(): Promise<string | null> {
  const state = await load()
  if ((state.sites ?? []).length && !closesOn({ ...state, off: false }, location.hostname)) return null
  const result = await closeOnce(pageEnv(document, tcfSign(document)))
  if (result.status !== "done") return null
  await record(result)
  return result.via
}

/** A banner answered inside a consent platform's frame of this page (frame.ts, through the background). */
export async function closedInFrame(via: string, closed: (c: Closed) => void): Promise<void> {
  const c = await record({ status: "done", via })
  if (c) closed(c)
}

/** The confirmation showed once more (it shows the first few times only). */
export async function noteTold(): Promise<void> {
  await save(tell(await load()).state)
}

/** Settings' switch and the site exception. */
export async function cookieSettings(): Promise<CookieState> {
  return load()
}

export async function setCookieSettings(patch: (s: CookieState) => CookieState): Promise<CookieState> {
  const next = patch(await load())
  await save(next)
  return next
}

