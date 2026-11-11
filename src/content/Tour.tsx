import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useState } from "preact/hooks"

import { t, type MessageKey } from "../shared/i18n"
import * as Icon from "./icons"
import { More } from "./ux/MessageUx"

export interface TourStep {
  // The parts of the panel the step lights up: per group, the first of its selectors that is shown.
  // None found: the step is left out (2.6: the chat list's step on a first run, before there's a chat).
  targets: string[][]
  icon: VNode
  title: MessageKey
  body: MessageKey
}

interface Props {
  panel: HTMLElement
  steps: TourStep[]
  onDone: () => void
}

export interface Hole {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 5

function shown(panel: HTMLElement, selectors: string[]): HTMLElement | undefined {
  for (const s of selectors) {
    const el = panel.querySelector<HTMLElement>(s)
    if (el && el.offsetParent !== null) return el
  }
  return undefined
}

/** Whether any part a step lights up is in the panel now. */
export function hasTarget(panel: HTMLElement, targets: string[][]): boolean {
  return targets.some((group) => shown(panel, group) !== undefined)
}

function holeStyle(h: Hole) {
  return { top: `${h.top}px`, left: `${h.left}px`, width: `${h.width}px`, height: `${h.height}px` }
}

/**
 * Where `targets` are in the panel, kept up to date while the panel or they resize or scroll; each one is
 * scrolled into view first. A part taller than the list it's in is cut to what shows of it.
 */
export function useParts(panel: HTMLElement, targets: string[][], key: unknown): Hole[] {
  const [parts, setParts] = useState<Hole[]>([])
  useLayoutEffect(() => {
    const found = targets.map((group) => shown(panel, group)).filter((el): el is HTMLElement => el !== undefined)
    // Quick actions under a long chat can be scrolled out of sight.
    for (const el of found) el.scrollIntoView({ block: "nearest" })
    const measure = () => {
      const p = panel.getBoundingClientRect()
      setParts(found.map((el) => {
        const r = el.getBoundingClientRect()
        const top = Math.max(r.top, p.top)
        const bottom = Math.min(r.bottom, p.bottom)
        return { top: top - p.top - PAD, left: r.left - p.left - PAD, width: r.width + PAD * 2, height: Math.max(0, bottom - top) + PAD * 2 }
      }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    for (const el of found) observer.observe(el)
    panel.addEventListener("scroll", measure, true)
    return () => {
      observer.disconnect()
      panel.removeEventListener("scroll", measure, true)
    }
  }, [panel, key])
  return parts
}

/** Everything lit up, as one box (the shade's hole), or null when nothing is. */
export function holeAround(parts: Hole[]): Hole | null {
  if (parts.length === 0) return null
  const top = Math.min(...parts.map((h) => h.top))
  const left = Math.min(...parts.map((h) => h.left))
  const bottom = Math.max(...parts.map((h) => h.top + h.height))
  const right = Math.max(...parts.map((h) => h.left + h.width))
  return { top, left, width: right - left, height: bottom - top }
}

/** The card's place: on the far side of the lit-up part, or in the middle when there's none. */
export function cardPlace(hole: Hole | null, height: number): Record<string, string> {
  const below = hole !== null && hole.top + hole.height / 2 < height / 2
  return hole === null
    ? { top: "50%", transform: "translateY(-50%)" }
    : below
      ? { top: `${Math.min(hole.top + hole.height + 12, height - 120)}px` }
      : { bottom: `${Math.min(height - hole.top + 12, height - 120)}px` }
}

/** The shade around `hole`, its outline and its parts' rings. */
export function Shade({ hole, parts }: { hole: Hole | null; parts: Hole[] }): VNode {
  return (
    <>
      {hole && <div class={`cf-tour-hole ${parts.length > 1 ? "group" : ""}`} style={holeStyle(hole)} />}
      {parts.length > 1 && parts.map((part, i) => <div key={i} class="cf-tour-ring" style={holeStyle(part)} />)}
    </>
  )
}

/**
 * Four clear boxes over the panel around `hole` (2.6, the guided first request): a tap outside the lit-up part does
 * nothing, a tap inside it reaches what's under it.
 */
export function Blockers({ hole }: { hole: Hole }): VNode {
  const right = hole.left + hole.width
  const bottom = hole.top + hole.height
  return (
    <>
      <div class="cf-tour-block" style={{ top: 0, left: 0, right: 0, height: `${Math.max(0, hole.top)}px` }} />
      <div class="cf-tour-block" style={{ top: `${bottom}px`, left: 0, right: 0, bottom: 0 }} />
      <div class="cf-tour-block" style={{ top: `${hole.top}px`, left: 0, width: `${Math.max(0, hole.left)}px`, height: `${hole.height}px` }} />
      <div class="cf-tour-block" style={{ top: `${hole.top}px`, left: `${right}px`, right: 0, height: `${hole.height}px` }} />
    </>
  )
}

/** Typing must not reach the composer under a tour card. */
export function useBlurPanel(panel: HTMLElement): void {
  useEffect(() => {
    const focused = (panel.getRootNode() as ShadowRoot | Document).activeElement
    if (focused instanceof HTMLElement) focused.blur()
  }, [panel])
}

/** A short tour of the panel: each step lights up parts of it and says what they do. */
export function Tour({ panel, steps: all, onDone }: Props): VNode {
  // The steps whose parts are in the panel when it starts.
  const [steps] = useState(() => all.filter((s) => hasTarget(panel, s.targets)))
  const [index, setIndex] = useState(0)
  const step = steps[index] ?? all[all.length - 1]
  const last = index >= steps.length - 1
  const parts = useParts(panel, step.targets, step)
  const hole = holeAround(parts)
  useBlurPanel(panel)

  return (
    <div class={`cf-tour ${hole ? "" : "dim"}`} role="dialog" aria-modal="true" aria-label={t(step.title)}>
      <Shade hole={hole} parts={parts} />
      <div class="cf-tour-card" style={cardPlace(hole, panel.clientHeight)}>
        <div class="cf-tour-head">
          <span class="cf-tour-icon">{step.icon}</span>
          <span class="cf-tour-count">{t("tourStep", index + 1, Math.max(steps.length, 1))}</span>
        </div>
        <strong>{t(step.title)}</strong>
        <p>{t(step.body)}</p>
        <div class="cf-tour-actions">
          {!last && <button type="button" class="cf-link" onClick={onDone}>{t("tourSkip")}</button>}
          {index > 0 && <button type="button" class="cf-secondary" onClick={() => setIndex(index - 1)}>{t("back")}</button>}
          <button type="button" class="cf-primary" onClick={() => (last ? onDone() : setIndex(index + 1))}>{last ? t("tourDone") : t("tourNext")}</button>
        </div>
      </div>
    </div>
  )
}

/** The chat list and the "…" menu, as the tour shows them (the guided first request ends with them too). */
export function chatsStep(sync: boolean): TourStep {
  return { targets: [[".cf-chats-button"]], icon: <Icon.Chats />, title: "tourChatsTitle", body: sync ? "tourChatsBodySync" : "tourChatsBody" }
}

// 2.6: Settings moved into the header's "…" (2.5) with reminders, watching and tips: the step shows the "…".
export const MENU_STEP: TourStep = { targets: [[".cf-page-more"]], icon: <More size={16} />, title: "tourMenuTitle", body: "tourMenuBody" }

/** The steps: asking (quick actions and the composer), a selection, Google, chats and the "…" menu. */
export function tourSteps(sync: boolean, touch: boolean): TourStep[] {
  return [
    { targets: [[".cf-actions"], [".cf-input"]], icon: <Icon.Sparkle size={16} />, title: "tourAskTitle", body: "tourAskBody" },
    // Build 95: the label is over the field now.
    { targets: [[".cf-ctx-row .cf-ctx", ".cf-ctx-row"]], icon: <Icon.Cursor />, title: "tourSelectTitle", body: "tourSelectBody" },
    { targets: [[".cf-mode"]], icon: <Icon.Search size={14} />, title: "tourGoogleTitle", body: "tourGoogleBody" },
    { targets: [[".cf-send-wrap"]], icon: <Icon.Pencil />, title: "tourNoteTitle", body: touch ? "tourNoteBodyTouch" : "tourNoteBodyMouse" },
    { targets: [[".cf-whole"]], icon: <Icon.Doc />, title: "tourWholeTitle", body: "tourWholeBody" },
    chatsStep(sync),
    MENU_STEP
  ]
}
