// Page hints in the first days (2.7, plan section 6): the line by the ✦ circle, and what its tap leaves in the panel
// (the how-to in the chat, the feature's button glowing until it's used). Rules and texts: rules.ts; the page's kind:
// detect.ts. The line sits beside the circle on its side, like the translate pill, and never shows with it.

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import { t, type MessageKey } from "../../shared/i18n"
import { revealHint } from "../hintReveal"
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
  ["watch", '.cf-page-watch, .cf-chip[data-action="watch"]'],
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
 *
 * `firstRunAhead` (build 110): the person hasn't been through the panel's first run yet. A page looked at then gets
 * no line at all: the first thing ContextFlow says to a new person is the first run itself, not «Find it cheaper?»
 * by a button they have never tapped (the director's clean install: that line on our own site, where the app's
 * «Open Safari» takes everyone). Nothing is counted for it either: the first days' lines start after the first run.
 */
export function usePageHints({ plan, ready, firstRunAhead, open, may, onUsed }: {
  plan: Plan; ready: boolean; firstRunAhead: boolean; open: () => void
  // 2.8: the hint coordinator (src/content/coach): whether this line may show at all now (its day and budget), and
  // its feature used after it.
  may?: (id: HintId) => boolean; onUsed?: (id: HintId) => void
}): PageHints {
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
  const aheadRef = useRef(firstRunAhead)
  aheadRef.current = firstRunAhead
  const mayRef = useRef(may)
  mayRef.current = may
  const usedRef = useRef(onUsed)
  usedRef.current = onUsed
  const done = useRef(false)

  // One look per page, once it has settled.
  useEffect(() => {
    let alive = true
    let looks = 0
    let timer: ReturnType<typeof setTimeout>
    const look = async () => {
      if (!alive || done.current) return
      // The first run is still to come: this page has no line (and none later on it, when the first run is over).
      if (aheadRef.current) {
        done.current = true
        return
      }
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
      // Not today (the first day is quiet, one capability a day, its shows used up): nothing counted for it.
      if (mayRef.current && !mayRef.current(id)) return
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
          usedRef.current?.(id)
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
      usedRef.current?.(g.id)
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
  // 2.7 (108): the chat's list alone is scrolled (scrollIntoView also moved the panel's fixed frame).
  revealHint(el)
}

/** The how-to's title and text for the chat (the offer's text for a plan the person doesn't have). */
export function hintText(id: HintId, has: boolean): { title: string; body: string } {
  const spec = HINTS[id]
  const offer = offerKey(id)
  return { title: t(spec.title as MessageKey), body: t((has || !offer ? spec.body : offer) as MessageKey) }
}
