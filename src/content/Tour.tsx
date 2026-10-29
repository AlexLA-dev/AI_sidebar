import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useState } from "preact/hooks"

import { t, type MessageKey } from "../shared/i18n"
import * as Icon from "./icons"

export interface TourStep {
  // What the step points at in the panel (the first selector found); none: the card stands alone.
  targets: string[]
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

/** A short tour of the panel: each step lights up a part of it and says what it does. */
export function Tour({ panel, steps, onDone }: Props): VNode {
  const [index, setIndex] = useState(0)
  const [hole, setHole] = useState<Hole | null>(null)
  const step = steps[index]
  const last = index === steps.length - 1

  // Where the step's target is in the panel, kept up to date while the panel resizes.
  useLayoutEffect(() => {
    const measure = () => {
      const target = step.targets.map((s) => panel.querySelector<HTMLElement>(s)).find((el) => el && el.offsetParent !== null)
      if (!target) return setHole(null)
      const p = panel.getBoundingClientRect()
      const r = target.getBoundingClientRect()
      setHole({ top: r.top - p.top - PAD, left: r.left - p.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [panel, step])

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
      {hole && <div class="cf-tour-hole" style={{ top: `${hole.top}px`, left: `${hole.left}px`, width: `${hole.width}px`, height: `${hole.height}px` }} />}
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

/** The steps: asking, a selection, Google, chats and settings. */
export function tourSteps(sync: boolean): TourStep[] {
  return [
    { targets: [".cf-empty .cf-actions", ".cf-input"], icon: <Icon.Sparkle size={16} />, title: "tourAskTitle", body: "tourAskBody" },
    { targets: [".cf-title .cf-ctx", ".cf-title"], icon: <Icon.Cursor />, title: "tourSelectTitle", body: "tourSelectBody" },
    { targets: [".cf-mode"], icon: <Icon.Search size={14} />, title: "tourGoogleTitle", body: "tourGoogleBody" },
    { targets: [".cf-chats-button"], icon: <Icon.Chats />, title: "tourChatsTitle", body: sync ? "tourChatsBodySync" : "tourChatsBody" },
    { targets: [".cf-settings-button"], icon: <Icon.Gear />, title: "tourSettingsTitle", body: "tourSettingsBody" }
  ]
}
