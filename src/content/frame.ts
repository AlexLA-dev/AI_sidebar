// A frame of a translated page (build 110): this small script runs in every frame and does nothing until the page
// that holds the frame is translated (the background passes the page's word on, translate/frames.ts). Then the frame's
// own words are translated like the page's: what shows first, what comes later as it comes (a chat's next message),
// its buttons, hints and lists. "Original" on the page puts the frame back too.
//
// A frame is part of its page: its requests are counted by the page's address (no answer of its own), and nothing of
// the panel is drawn here.

import { baseLanguage } from "./translateTarget"
import { PageTranslator } from "./translate/engine"
import { pageLanguage } from "./translate/decide"
import { portAsk, storageCache } from "./translate/port"
import { frameState, type FrameState, type FrameTold } from "../shared/translate"
import { consentFrame } from "./cookies/frameMatch"

declare global {
  interface Window {
    __contextflowFrame?: boolean
  }
}

// Smaller than this, a frame holds nothing anyone reads (a tracker's, a button's).
const MIN_WIDTH = 120
const MIN_HEIGHT = 40
// With this many letters on it, a frame says what language it's in.
const TELLING = 200

/** The frame's words are in `to` already (as far as can be told now: a frame still empty isn't). */
function inLanguage(to: string): boolean {
  const text = (document.body?.innerText ?? "").slice(0, 4_000)
  if ((text.match(/\p{L}/gu)?.length ?? 0) < TELLING) return false
  const lang = pageLanguage(document.documentElement.lang ?? "", text)
  return !!lang && baseLanguage(lang) === baseLanguage(to)
}

function boot(): void {
  if (window.top === window || window.__contextflowFrame) return
  window.__contextflowFrame = true
  let engine: PageTranslator | null = null
  let now: FrameState | null = null

  const told = (state: FrameState) => {
    if (!state.on) {
      if (now) engine?.original()
      now = null
      return
    }
    if (now && now.to === state.to && now.only === state.only) {
      now = state
      return
    }
    if (window.innerWidth < MIN_WIDTH || window.innerHeight < MIN_HEIGHT || !document.body || inLanguage(state.to)) return
    if (now) engine?.original()
    now = state
    engine ??= new PageTranslator({
      doc: document,
      url: () => location.href,
      counted: () => now?.url ?? location.href,
      site: () => location.hostname.replace(/^www\./, ""),
      ask: portAsk(),
      cache: storageCache
    })
    void engine.start(state.to, null, state.only)
  }

  chrome.runtime.onMessage.addListener((message: FrameTold) => {
    if (message?.type !== "trFrame") return false
    const state = frameState(message.state)
    if (state) told(state)
    return false
  })
}

// A consent platform's own frame (Sourcepoint, TrustArc): the cookie closer is asked for here only (2.7.1).
function cookieFrame(): void {
  if (window.top === window || !consentFrame(location.href)) return
  try {
    chrome.runtime.sendMessage({ type: "cookieFrameInject" }, () => void chrome.runtime.lastError)
  } catch {
    // the extension was updated under this page
  }
}

try {
  boot()
  cookieFrame()
} catch {
  // a frame the script can't work in: left as it is
}
