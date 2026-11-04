// "Reminders" in the panel (2.5, the header's "…" and "All reminders" in "Come back later"): the bells in the
// chats and what's watched (watching's rows, addLaterSource in later.ts), each with its status; a tap opens what
// it's about, ✕ cancels it. Watching runs in Safari, so it can be seen and stopped here without the app.

import type { VNode } from "preact"
import { useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import type { LaterItem } from "./later"
import { Bell, useAboveComposer } from "./MessageUx"

const Eye = ({ size = 16 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

export function RemindersSheet({ items, onOpen, onCancel, onClose }: {
  // null while loading.
  items: LaterItem[] | null
  onOpen: (item: LaterItem) => void
  onCancel: (item: LaterItem) => void
  onClose: () => void
}): VNode {
  const back = useRef<HTMLDivElement>(null)
  useAboveComposer(back)
  return (
    <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cf-sheet cf-later-list" role="dialog" aria-label={t("uxReminders")}>
        <div class="cf-sheet-title"><Icon.List /> {t("uxReminders")}</div>
        {items?.map((item) => (
          <div key={item.id} class={`cf-later-row ${item.here === false ? "elsewhere" : ""}`}>
            <button type="button" class="cf-later-open" onClick={() => onOpen(item)}>
              <span class="cf-later-icon">{item.kind === "remind" ? <Bell size={15} /> : <Eye size={15} />}</span>
              <span class="cf-later-text">
                <span class="cf-later-title">{item.title}</span>
                <span class="cf-later-status">{item.status}</span>
              </span>
            </button>
            <button
              type="button"
              class="cf-later-cancel"
              aria-label={t(item.kind === "remind" ? "uxRemindCancel" : "uxStop")}
              title={t(item.kind === "remind" ? "uxRemindCancel" : "uxStop")}
              onClick={() => onCancel(item)}
            >✕</button>
          </div>
        ))}
        {items && !items.length && (
          <div class="cf-later-empty">
            <strong>{t("uxNoReminders")}</strong>
            <span>{t("uxNoRemindersHint")}</span>
          </div>
        )}
      </div>
    </div>
  )
}
