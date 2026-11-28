// The cookie closer inside a consent platform's own frame (2.7.1): Sourcepoint's message and privacy manager,
// TrustArc's preferences, consentmanager's. frame.js asks the background for this script in such a frame only.
// The page's site (the frame's top) decides whether the closer is on, like on the page itself.

import { closesOn, COOKIE_KEY, readState } from "../../shared/cookies/state.ts"
import { ACCEPT_AFTER_MS, acceptButton, byLabel, firstShown, isWall, pageEnv, press } from "./closer.ts"
import { consentFrame } from "./frameMatch.ts"
import { FRAME_RULES } from "./rules.ts"

declare global {
  interface Window {
    __contextflowCookieFrame?: boolean
  }
}

// We opened a platform's settings in its frame: its settings frame is answered only within this time after.
const STEP_KEY = "cf:cookieStep"
const STEP_MS = 15_000
const WATCH_MS = 12_000
const QUIET_MS = 300

function topHost(): string {
  try {
    const origins = location.ancestorOrigins
    if (origins?.length) return new URL(origins[origins.length - 1]).hostname
  } catch {
    // no ancestor origins here
  }
  try {
    return document.referrer ? new URL(document.referrer).hostname : ""
  } catch {
    return ""
  }
}

function done(via: string, accepted = false): void {
  try {
    chrome.runtime.sendMessage({ type: "cookieFrameDone", via, ...(accepted ? { accepted } : {}) }, () => void chrome.runtime.lastError)
  } catch {
    // the extension was updated under this page
  }
}

async function boot(): Promise<void> {
  if (window.top === window || window.__contextflowCookieFrame) return
  window.__contextflowCookieFrame = true
  const id = consentFrame(location.href)
  const rule = id ? FRAME_RULES[id] : null
  if (!id || !rule) return
  const host = topHost()
  const stored = await chrome.storage.local.get([COOKIE_KEY, STEP_KEY]).catch(() => ({} as Record<string, unknown>))
  const state = readState(stored[COOKIE_KEY])
  if (!host || !closesOn(state, host)) return
  if (rule.ours) {
    const step = stored[STEP_KEY] as { at?: number; host?: string } | undefined
    if (!step || step.host !== host || typeof step.at !== "number" || Date.now() - step.at > STEP_MS) return
    await chrome.storage.local.remove(STEP_KEY).catch(() => undefined)
  }
  const env = pageEnv(document, true, state.accept === true)
  const via = id.replace(/_pm$/, "")
  let finished = false
  let timer = 0
  let noChoiceAt = 0

  const look = async (): Promise<void> => {
    if (finished || !document.body) return
    // A «pay or accept» wall: left to the person (rejecting leads to the subscription), or its «Accept» when they
    // asked for it (Settings: «Если отказаться нельзя — принимать»).
    const wall = isWall(env, document)
    const reject = wall ? null : firstShown(env, document, rule.reject) ?? byLabel(env, document, "reject")
    if (reject) {
      finished = true
      press(reject)
      done(via)
      return
    }
    if (env.accept && !rule.ours) {
      const accept = acceptButton(env, [document])
      // Only once it has offered no way to refuse for a moment (a reject drawn a little later wins).
      if (accept && !noChoiceAt) {
        noChoiceAt = Date.now()
        setTimeout(() => void look(), ACCEPT_AFTER_MS + 200)
      } else if (accept && Date.now() - noChoiceAt >= ACCEPT_AFTER_MS) {
        finished = true
        press(accept)
        done(via, true)
        return
      }
    }
    if (wall) return
    const settings = rule.settings ? firstShown(env, document, rule.settings) : null
    if (settings) {
      finished = true
      await chrome.storage.local.set({ [STEP_KEY]: { at: Date.now(), host } }).catch(() => undefined)
      press(settings)
    }
  }
  const observer = new MutationObserver(() => {
    if (finished || timer) return
    timer = setTimeout(() => {
      timer = 0
      void look()
    }, QUIET_MS) as unknown as number
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  setTimeout(() => {
    finished = true
    observer.disconnect()
  }, WATCH_MS)
  await look()
  if (finished) observer.disconnect()
}

void boot().catch(() => undefined)
