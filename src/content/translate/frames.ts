// The page's side of translating its frames (build 110, the owner: a government site's «Digital Assistant», a chat in
// a frame from another address, stayed in Greek on the translated page). The content script lives in the page itself;
// a frame's words are another document's, which a small script of its own translates (../frame.ts). Here the page
// says, through the background, what it's translated into and when it's back as it was.
//
// Nothing is sent on a page without frames. A frame that loads later, or loads another document, is told then (its
// script starts after its document, so a moment later too).

import type { FramesTell, FrameState } from "../../shared/translate"

let told: FrameState | null = null
let timers: Array<ReturnType<typeof setTimeout>> = []

const framed = () => !!document.querySelector("iframe,frame")

function send(): void {
  if (!told) return
  const message: FramesTell = { type: "trFrames", state: told }
  try {
    void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined)
  } catch {
    // the extension was updated under the page
  }
}

/** Said again a few times: a frame's script starts when its document is done, which is after the frame says it loaded. */
function again(): void {
  for (const t of timers) clearTimeout(t)
  timers = [150, 1_200, 3_500].map((ms) => setTimeout(send, ms))
}

const loaded = (ev: Event): void => {
  const tag = (ev.target as Element | null)?.tagName
  if (tag === "IFRAME" || tag === "FRAME") again()
}

/** The page is translated into `to` (or only its controls are), or is back as it was. */
export function tellFrames(state: { on: boolean; to: string; only: "controls" | null }): void {
  const was = told
  if (!state.on) {
    document.removeEventListener("load", loaded, true)
    for (const t of timers) clearTimeout(t)
    timers = []
    if (!was?.on) return
    told = { ...was, on: false }
    send()
    return
  }
  told = { on: true, to: state.to, only: state.only, url: location.href }
  if (!was?.on) document.addEventListener("load", loaded, true)
  if (!framed()) return
  send()
  again()
}
