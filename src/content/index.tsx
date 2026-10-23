import { render } from "preact"

import { TARGET } from "../shared/config"
import type { ContentRequest } from "../shared/types"
import { App } from "./App"
import { detectPlatform, HOST_TAG } from "./page"
import styles from "./styles.css"

// Runs on every http(s) page (and again if injected on demand). Everything we
// render lives in a closed-off shadow root so page CSS can't break it and our
// CSS can't leak into the page.

declare global {
  interface Window {
    __contextflowBus?: EventTarget
  }
}

function boot(): void {
  if (window.top !== window || window.__contextflowBus) return
  const bus = new EventTarget()
  window.__contextflowBus = bus

  chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
    if (message?.type === "toggle" || message?.type === "open") {
      bus.dispatchEvent(new Event(message.type))
      sendResponse({ ok: true })
    }
    return false
  })

  const mount = () => {
    if (document.querySelector(HOST_TAG)) return
    const host = document.createElement(HOST_TAG)
    host.setAttribute("style", "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;")
    const root = host.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent = styles
    root.appendChild(style)
    const container = document.createElement("div")
    root.appendChild(container)
    document.documentElement.appendChild(host)
    render(<App platform={detectPlatform(TARGET)} bus={bus} />, container)

    // Some sites rebuild <html> children; put the host back if it gets removed.
    new MutationObserver(() => {
      if (!host.isConnected) document.documentElement.appendChild(host)
    }).observe(document.documentElement, { childList: true })
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true })
  else mount()
}

try {
  boot()
} catch (err) {
  console.warn("[ContextFlow] failed to start", err)
}
