import { render } from "preact"

import { SHADOW_MODE, TARGET } from "../shared/config"
import type { ContentRequest } from "../shared/types"
import { uiDirection, uiLang } from "../shared/i18n"
import type { ToolCall } from "../shared/agent/types"
import { act, undo } from "./agent/hands"
import { buildMap } from "./agent/map"
import { App } from "./App"
import { tabPdf, tabSource } from "./context"
import { detectPlatform, HOST_TAG } from "./page"
import { setPanelRoot } from "./root"
import { guardScroll } from "./scrollGuard"
import { keepOverTopLayer } from "./topLayer"
import styles from "./styles.css"
import insertStyles from "./insert/insert.css"
import organizeStyles from "./organize.css"
import uxStyles from "./ux/ux.css"
import { startLiveWatch } from "./watch/live"
// Page watch's section and eye, added to chat UX's window and bubble (2.5).
import "./watch/register"
import watchStyles from "./watch/watch.css"
import tipsStyles from "./tips/tips.css"
import similarStyles from "./similar/similar.css"
import listenStyles from "./listen/listen.css"
import translateStyles from "./translate/translate.css"
import sideStyles from "./side/side.css"
import pageHintStyles from "./pagehints/hints.css"
import inviteStyles from "./invite/invite.css"
import spacesStyles from "./spaces.css"
import collectionsStyles from "./collections.css"
import quietStyles from "./quiet/quiet.css"
import agentStyles from "./agent/agent.css"

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
    // 2.6 (98): a link in a chat opened this page, already open in this tab: the panel opens on that chat.
    if (message?.type === "openChat") {
      bus.dispatchEvent(new CustomEvent("openChat", { detail: { chat: message.chat, at: message.at } }))
      sendResponse({ ok: true })
    }
    // The agent (2.7.1): the background's task asks for the page map, does a step, puts a step back, shows its state.
    const agent = message as unknown as { type: string; call?: ToolCall; undo?: Parameters<typeof undo>[0]; state?: unknown }
    if (agent?.type === "agentMap") {
      sendResponse(buildMap(document))
      return false
    }
    if (agent?.type === "agentAct" && agent.call) {
      act(agent.call).then(sendResponse, (err) => sendResponse({ ok: false, note: String(err).slice(0, 120) }))
      return true
    }
    if (agent?.type === "agentUndoStep" && agent.undo) {
      undo(agent.undo).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }))
      return true
    }
    if (agent?.type === "agentState") {
      bus.dispatchEvent(new CustomEvent("agentState", { detail: agent.state }))
      sendResponse({ ok: true })
    }
    // A new install asks before it opens its «ContextFlow is ready» tab over this page (src/shared/welcomeTab.ts).
    if (message?.type === "here") sendResponse({ ok: true })
    return false
  })

  const mount = () => {
    if (document.querySelector(HOST_TAG)) return
    const host = document.createElement(HOST_TAG)
    host.setAttribute("style", "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;")
    // The panel's own language and direction (Arabic: right to left), never the page's: `all: initial` keeps direction.
    host.setAttribute("dir", uiDirection())
    host.setAttribute("lang", uiLang())
    const root = host.attachShadow({ mode: SHADOW_MODE })
    setPanelRoot(root)
    // The page's touch handlers (Google's) can't stop our lists from scrolling (2.6).
    guardScroll(root)
    const style = document.createElement("style")
    style.textContent = `${styles}
${insertStyles}
${organizeStyles}
${uxStyles}
${watchStyles}
${tipsStyles}
${similarStyles}
${listenStyles}
${translateStyles}
${spacesStyles}
${sideStyles}
${pageHintStyles}
${inviteStyles}
${collectionsStyles}
${quietStyles}
${agentStyles}`
    root.appendChild(style)
    const container = document.createElement("div")
    root.appendChild(container)
    document.documentElement.appendChild(host)
    render(<App platform={detectPlatform(TARGET)} bus={bus} source={tabSource(tabPdf)} />, container)

    // Some sites rebuild <html> children; put the host back if it gets removed.
    new MutationObserver(() => {
      if (!host.isConnected) document.documentElement.appendChild(host)
    }).observe(document.documentElement, { childList: true })
    // Over a site's window in the top layer (a modal dialog, a popover): inside it while the person works there.
    keepOverTopLayer(host)
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true })
  else mount()
  // A watched page the person opened is checked from here (2.5).
  if (TARGET === "safari") startLiveWatch()
}

try {
  boot()
} catch (err) {
  console.warn("[ContextFlow] failed to start", err)
}
