// Page hints in the first days (2.7, plan section 6): the line by the ✦ circle, and what its tap leaves in the panel
// (the how-to in the chat, the feature's button glowing until it's used). Rules and texts: rules.ts; the page's kind:
// detect.ts. The line sits beside the circle on its side, like the translate pill, and never shows with it.

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import { t, type MessageKey } from "../../shared/i18n"
import { panelRoot } from "../root"
import { sendBackground } from "../insert/store"
import { pageIsForeign } from "../translate/TranslatePill"
import { pageKind } from "./detect"
import { afterClose, afterShown, afterTap, afterUsed, hasFeature, HINTS, offerKey, pickHint, type GlowTarget, type HintId, type Plan } from "./rules"
import { loadHints, saveHints, seeded } from "./store"

// Not right as the page opens: a look after this long, and again while the circle is busy elsewhere.
const FIRST_LOOK_MS = 6_500
const RETRY_MS = 3_000
const LOOKS = 10
// A line nobody answers goes away by itself (not a ✕).
const LINE_MS = 15_000

/** The panel's controls that use each feature: a click on one means it was used (and its glow stops). */
const USES: Array<[HintId, string]> = [
  ["summary", '.cf-chip[data-action="summarize"], .cf-chip[data-action="key_points"]'],
  ["similar", '[data-action="similar"], [data-action="sel_similar"]'],
  ["watch", ".cf-page-watch"],
  ["listen", ".cf-page-listen"]
]

const step = (a: string, what: HintId) => void sendBackground({ type: "useEvent", f: "page_hint", a, what })

const typing = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

export interface PageHints {
  // The line by the circle, the how-to in the chat, the button that glows.
  line: HintId | null
  chat: HintId | null
  glow: GlowTarget | null
  // Has the person's plan the feature (the how-to), or is it offered to them.
  has: (id: HintId) => boolean
  tap: () => void
  close: () => void
  doneChat: () => void
}

/**
 * The page's hint, once: looked for a moment after the page opens, while `ready` (the circle shows, the panel is
 * closed, nothing selected); `open` opens the panel on the page's chat.
 */
export function usePageHints({ plan, ready, open }: { plan: Plan; ready: boolean; open: () => void }): PageHints {
  const [line, setLine] = useState<HintId | null>(null)
  const [chat, setChat] = useState<HintId | null>(null)
  const [glow, setGlowState] = useState<{ id: HintId; target: GlowTarget } | null>(null)
  const glowRef = useRef(glow)
  const setGlow = (next: { id: HintId; target: GlowTarget } | null) => {
    glowRef.current = next
    setGlowState(next)
  }
  const lineRef = useRef<HintId | null>(null)
  lineRef.current = line
  const readyRef = useRef(ready)
  readyRef.current = ready
  const planRef = useRef(plan)
  planRef.current = plan
  const done = useRef(false)

  // One look per page, once it has settled.
  useEffect(() => {
    let alive = true
    let looks = 0
    let timer: ReturnType<typeof setTimeout>
    const look = async () => {
      if (!alive || done.current) return
      if (!readyRef.current || typing() || document.visibilityState !== "visible") {
        if (++looks < LOOKS) timer = setTimeout(() => void look(), RETRY_MS)
        return
      }
      done.current = true
      // A page in another language: the translate pill offers it instead.
      if (pageIsForeign()) return
      const now = Date.now()
      const id = pickHint(pageKind(document, location.href), planRef.current, await seeded(await loadHints(now)), now)
      if (!alive || !id) return
      await saveHints(afterShown(await seeded(await loadHints(now)), id, now))
      setLine(id)
      step("shown", id)
      timer = setTimeout(() => setLine((cur) => (cur === id ? null : cur)), LINE_MS)
    }
    timer = setTimeout(() => void look(), FIRST_LOOK_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // A feature used in the panel, any way: never offered again; its glow stops.
  useEffect(() => {
    const root = panelRoot()
    if (!root) return
    const onClick = (e: Event) => {
      const target = e.target as Element | null
      if (!target?.closest) return
      const g = glowRef.current
      for (const [id, selector] of USES) {
        if (!target.closest(selector)) continue
        void loadHints(Date.now()).then((s) => saveHints(afterUsed(s, id)))
        if (g?.id === id) {
          step("used", id)
          setGlow(null)
        }
      }
      // The "…" as the way in (templates' hint): opened, its glow has done its job.
      if (g?.id === "templates" && target.closest(".cf-page-more")) setGlow(null)
    }
    // The question field as the way in (video, a reminder, the calendar): typing in it is using it.
    const onInput = (e: Event) => {
      const g = glowRef.current
      if (g?.target !== "composer" || !(e.target as Element | null)?.closest?.(".cf-composer")) return
      step("used", g.id)
      void loadHints(Date.now()).then((s) => saveHints(afterUsed(s, g.id)))
      setGlow(null)
    }
    root.addEventListener("click", onClick, true)
    root.addEventListener("input", onInput, true)
    return () => {
      root.removeEventListener("click", onClick, true)
      root.removeEventListener("input", onInput, true)
    }
  }, [])

  const tap = useCallback(() => {
    const id = lineRef.current
    if (!id) return
    step("tap", id)
    void loadHints(Date.now()).then((s) => saveHints(afterTap(s)))
    setLine(null)
    setChat(id)
    setGlow({ id, target: HINTS[id].glow })
    open()
  }, [open])

  const close = useCallback(() => {
    const id = lineRef.current
    if (!id) return
    step("dismiss", id)
    setLine(null)
    void loadHints(Date.now()).then((s) => {
      const next = afterClose(s)
      if (next.off && !s.off) step("off", id)
      return saveHints(next)
    })
  }, [])

  return {
    line,
    chat,
    glow: glow?.target ?? null,
    has: (id) => hasFeature(id, planRef.current),
    tap,
    close,
    doneChat: () => setChat(null)
  }
}

const Close = (): VNode => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

/** The line by the circle: its question (a tap opens the panel) and ✕. */
export function HintLine({ id, side, top, onTap, onClose }: { id: HintId; side: "left" | "right"; top: string; onTap: () => void; onClose: () => void }): VNode {
  return (
    <div class={`cf-ph ${side}`} style={{ top }} role="note">
      <button type="button" class="cf-ph-text" onClick={onTap}>{t(HINTS[id].bubble as MessageKey)}</button>
      <button type="button" class="cf-ph-x" aria-label={t("phClose")} title={t("phClose")} onClick={onClose}><Close /></button>
    </div>
  )
}

/** The how-to in full view when it comes (on an iPhone's sheet it came under the question field). Once per element. */
export function revealOnce(el: HTMLElement | null): void {
  if (!el || el.dataset.revealed) return
  el.dataset.revealed = "1"
  requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }))
}

/** The how-to's title and text for the chat (the offer's text for a plan the person doesn't have). */
export function hintText(id: HintId, has: boolean): { title: string; body: string } {
  const spec = HINTS[id]
  const offer = offerKey(id)
  return { title: t(spec.title as MessageKey), body: t((has || !offer ? spec.body : offer) as MessageKey) }
}
