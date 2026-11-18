// A tab left open across an update of the app: its panel is cut off from the extension, and so is this script, put
// there by the new background (2.7; src/shared/staleTabs.ts says why, src/background/staleTabs.ts sends it). Nothing
// here asks the extension for anything. It watches the old panel's root, and when the person touches our button or
// panel there, shows one notice by the touch: «ContextFlow was updated. Reload this page», Reload, ×. Right away only
// when the panel is open at that moment. The page is never loaded again by itself: a form may be half filled.

import { SHADOW_MODE } from "../shared/config"
import { t, uiDirection } from "../shared/i18n"
import { noticePlace, panelLooksOpen, type Box, type StaleWords } from "../shared/staleTabs"

declare global {
  interface Window {
    /** Set by the background right before this script, in a tab whose panel didn't answer it. */
    __contextflowStale?: StaleWords
  }
}

const TOLD = "data-cf-stale"
const NOTICE_TAG = "contextflow-notice"

/** The background's words for the notice, taken once (null: this script wasn't sent for that). */
export function takeStaleWords(): StaleWords | null {
  const words = window.__contextflowStale
  if (!words) return null
  window.__contextflowStale = undefined
  return typeof words.text === "string" && typeof words.reload === "string" ? words : null
}

/** Whether this script hears the extension: asked twice a moment apart (a background just starting answers late). */
async function linked(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!chrome.runtime?.id) return false
      const reply = await Promise.race([
        chrome.runtime.sendMessage({ type: "alive" }) as Promise<{ ok?: boolean } | null>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 600))
      ])
      if (reply?.ok === true) return true
    } catch {
      // No way to the extension from here.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

/** How many of a 5×5 grid of points over what's visible are covered by `root` (what's inside its shadow answers as the root itself). */
function covered(root: Element): { hits: number; points: number } {
  const vv = window.visualViewport
  const width = vv?.width ?? window.innerWidth
  const height = vv?.height ?? window.innerHeight
  let hits = 0
  let points = 0
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      points++
      if (document.elementFromPoint(width * fx, height * fy) === root) hits++
    }
  }
  return { hits, points }
}

const STYLE = `
:host { all: initial; }
.box {
  position: fixed; left: 0; top: 0; box-sizing: border-box;
  display: flex; align-items: center; gap: 8px;
  width: max-content; max-width: min(340px, calc(100vw - 16px)); padding: 8px 8px 8px 12px;
  font: 500 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #111827; background: #fff; border: 1px solid rgba(17, 24, 39, 0.1); border-radius: 14px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.22);
  transform-origin: 0 0; -webkit-text-size-adjust: 100%;
}
.text { flex: 1 1 auto; min-width: 0; }
button { all: unset; box-sizing: border-box; flex: none; cursor: pointer; font: inherit; -webkit-tap-highlight-color: transparent; }
.reload { min-height: 34px; padding: 6px 12px; border-radius: 10px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #38bdf8, #2563eb); white-space: nowrap; display: flex; align-items: center; }
.close { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1; color: #6b7280; }
.close:active, .reload:active { opacity: 0.7; }
@media (prefers-color-scheme: dark) {
  .box { color: #f9fafb; background: #1f2937; border-color: rgba(255, 255, 255, 0.14); }
  .close { color: #9ca3af; }
}
`

/**
 * Watches the old panel's root and shows the notice. `root`: the panel's host already on the page when this script
 * came; `words`: the background's (null: this script's own strings). Does nothing when this script hears the
 * extension (the tab isn't cut off: the background asked while the page was still loading) or the tab was told before.
 */
export async function watchStaleTab(root: Element, words: StaleWords | null): Promise<void> {
  if (root.hasAttribute(TOLD) || (await linked()) || root.hasAttribute(TOLD)) return
  root.setAttribute(TOLD, "")
  const say: StaleWords = words ?? { text: t("updatedReload"), reload: t("writeReload"), close: t("close"), dir: uiDirection() }

  let host: HTMLElement | null = null
  let box: HTMLElement | null = null
  let at: { x: number; y: number } | null = null
  let closedAt = 0

  const place = () => {
    if (!host || !box) return
    // Fixed elements count from the layout viewport, a touch and what's visible from the visible part (fixedPlace.ts):
    // the notice's own corner says how far apart they are. On a zoomed page it keeps its size on the glass.
    const corner = host.getBoundingClientRect()
    const vv = window.visualViewport
    const k = 1 / Math.max(1, vv?.scale ?? 1)
    const view: Box = { left: -corner.left, top: -corner.top, right: -corner.left + (vv?.width ?? window.innerWidth), bottom: -corner.top + (vv?.height ?? window.innerHeight) }
    box.style.setProperty("scale", k < 0.99 ? String(k) : "none")
    const spot = noticePlace(at ? { x: at.x - corner.left, y: at.y - corner.top } : null, box.offsetWidth * k, box.offsetHeight * k, view)
    box.style.left = `${spot.left}px`
    box.style.top = `${spot.top}px`
  }

  const hide = () => {
    host?.remove()
    host = null
    box = null
    closedAt = Date.now()
    window.visualViewport?.removeEventListener("resize", place)
    window.visualViewport?.removeEventListener("scroll", place)
  }

  const show = (touch: { x: number; y: number } | null) => {
    at = touch
    if (!host) {
      host = document.createElement(NOTICE_TAG)
      host.setAttribute("style", "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;")
      host.setAttribute("dir", say.dir === "rtl" ? "rtl" : "ltr")
      const shadow = host.attachShadow({ mode: SHADOW_MODE })
      const style = document.createElement("style")
      style.textContent = STYLE
      box = document.createElement("div")
      box.className = "box"
      box.setAttribute("role", "alert")
      const text = document.createElement("span")
      text.className = "text"
      text.textContent = say.text
      const reload = document.createElement("button")
      reload.className = "reload"
      reload.textContent = say.reload
      reload.addEventListener("click", () => location.reload())
      const close = document.createElement("button")
      close.className = "close"
      close.setAttribute("aria-label", say.close)
      close.textContent = "×"
      close.addEventListener("click", hide)
      box.append(text, reload, close)
      shadow.append(style, box)
      document.documentElement.appendChild(host)
      window.visualViewport?.addEventListener("resize", place)
      window.visualViewport?.addEventListener("scroll", place)
    }
    place()
  }

  // The old button does nothing useful any more (its panel would open empty, on the Free plan): a touch on it shows
  // the notice instead. An open panel stays readable, so touches inside it go through.
  const onTouch = (event: Event) => {
    const target = event.target
    if (!(target instanceof Node) || !(target === root || root.contains(target))) return
    const open = panelLooksOpen(covered(root).hits, 25)
    if (!open) {
      event.stopImmediatePropagation()
      if (event.cancelable && event.type !== "pointerdown" && event.type !== "mousedown") event.preventDefault()
    }
    if (event.type !== "pointerdown" && event.type !== "touchstart" && event.type !== "mousedown" && event.type !== "click") return
    // Put away a moment ago inside the open panel: not again at every touch there.
    if (open && Date.now() - closedAt < 60_000) return
    const point = "touches" in event ? (event as TouchEvent).touches[0] : (event as MouseEvent)
    if (!host || event.type === "pointerdown" || event.type === "touchstart") show(point ? { x: point.clientX, y: point.clientY } : null)
  }
  for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) {
    window.addEventListener(type, onTouch, { capture: true, passive: false })
  }

  if (panelLooksOpen(covered(root).hits, 25)) show(null)
}
