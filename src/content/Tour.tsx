import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useState } from "preact/hooks"

import { t, type MessageKey } from "../shared/i18n"
import * as Icon from "./icons"

export interface TourStep {
  // The parts of the panel the step lights up: per group, the first of its selectors that is shown.
  // None found: the card stands alone.
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

interface Hole {
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

function holeStyle(h: Hole) {
  return { top: `${h.top}px`, left: `${h.left}px`, width: `${h.width}px`, height: `${h.height}px` }
}

/** A short tour of the panel: each step lights up parts of it and says what they do. */
export function Tour({ panel, steps, onDone }: Props): VNode {
  const [index, setIndex] = useState(0)
  const [parts, setParts] = useState<Hole[]>([])
  const step = steps[index]
  const last = index === steps.length - 1

  // Where the step's parts are in the panel, kept up to date while it resizes or scrolls.
  useLayoutEffect(() => {
    const targets = step.targets.map((group) => shown(panel, group)).filter((el): el is HTMLElement => el !== undefined)
    // Quick actions under a long chat can be scrolled out of sight.
    for (const el of targets) el.scrollIntoView({ block: "nearest" })
    const measure = () => {
      const p = panel.getBoundingClientRect()
      setParts(targets.map((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top - p.top - PAD, left: r.left - p.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
      }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    panel.addEventListener("scroll", measure, true)
    return () => {
      observer.disconnect()
      panel.removeEventListener("scroll", measure, true)
    }
  }, [panel, step])

  // Everything lit up stays clear of the shade; each part gets its own outline.
  const hole: Hole | null = parts.length === 0 ? null : (() => {
    const top = Math.min(...parts.map((h) => h.top))
    const left = Math.min(...parts.map((h) => h.left))
    const bottom = Math.max(...parts.map((h) => h.top + h.height))
    const right = Math.max(...parts.map((h) => h.left + h.width))
    return { top, left, width: right - left, height: bottom - top }
  })()

  useEffect(() => {
    // Typing must not reach the composer under the tour.
    const focused = (panel.getRootNode() as ShadowRoot | Document).activeElement
    if (focused instanceof HTMLElement) focused.blur()
  }, [panel])

  // The card goes on the far side of the lit-up part, or in the middle when there's none.
  const height = panel.clientHeight
  const below = hole !== null && hole.top + hole.height / 2 < height / 2
  const cardStyle = hole === null
    ? { top: "50%", transform: "translateY(-50%)" }
    : below
      ? { top: `${hole.top + hole.height + 12}px` }
      : { bottom: `${height - hole.top + 12}px` }

  return (
    <div class={`cf-tour ${hole ? "" : "dim"}`} role="dialog" aria-modal="true" aria-label={t(step.title)}>
      {hole && <div class={`cf-tour-hole ${parts.length > 1 ? "group" : ""}`} style={holeStyle(hole)} />}
      {parts.length > 1 && parts.map((part, i) => <div key={i} class="cf-tour-ring" style={holeStyle(part)} />)}
      <div class="cf-tour-card" style={cardStyle}>
        <div class="cf-tour-head">
          <span class="cf-tour-icon">{step.icon}</span>
          <span class="cf-tour-count">{t("tourStep", index + 1, steps.length)}</span>
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

/** The steps: asking (quick actions and the composer), a selection, Google, chats and settings. */
export function tourSteps(sync: boolean): TourStep[] {
  return [
    { targets: [[".cf-actions"], [".cf-input"]], icon: <Icon.Sparkle size={16} />, title: "tourAskTitle", body: "tourAskBody" },
    { targets: [[".cf-title .cf-ctx", ".cf-title"]], icon: <Icon.Cursor />, title: "tourSelectTitle", body: "tourSelectBody" },
    { targets: [[".cf-mode"]], icon: <Icon.Search size={14} />, title: "tourGoogleTitle", body: "tourGoogleBody" },
    { targets: [[".cf-chats-button"]], icon: <Icon.Chats />, title: "tourChatsTitle", body: sync ? "tourChatsBodySync" : "tourChatsBody" },
    { targets: [[".cf-settings-button"]], icon: <Icon.Gear />, title: "tourSettingsTitle", body: "tourSettingsBody" }
  ]
}
