// The panel header's "…" (2.5, the director's layout): where Settings was. "Come back later…" (a reminder on this
// page; watching it joins there), "Reminders" (with how many are active) and Settings; more actions on the page go
// here too.

import type { VNode } from "preact"
import { useEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import { onTapAway, throughClass } from "./away"

export function PageMenu({ reminders, onLater, onReminders, onSettings, onClose }: {
  reminders: number
  onLater: () => void
  onReminders: () => void
  onSettings: () => void
  onClose: () => void
}): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    let off = (): void => undefined
    // After this click is done; its own "…" toggles it.
    const timer = setTimeout(() => {
      off = onTapAway(el, (path) => path.includes(el) || throughClass(path, "cf-page-more"), onClose)
      document.addEventListener("keydown", esc, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      off()
      document.removeEventListener("keydown", esc, true)
    }
  }, [onClose])
  return (
    <div ref={ref} class="cf-msg-menu cf-page-menu" role="menu">
      <button type="button" role="menuitem" onClick={onLater}><Icon.Clock /> {t("uxLater")}</button>
      <button type="button" role="menuitem" onClick={onReminders}><Icon.List /> {reminders > 0 ? t("uxRemindersN", reminders) : t("uxReminders")}</button>
      <button type="button" role="menuitem" onClick={onSettings}><Icon.Gear /> {t("settings")}</button>
    </div>
  )
}
