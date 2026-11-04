// "Reminders" in the panel (2.5, the header's "…" and "All reminders" in "Come back later"): the bells in the
// chats and what's watched (watching's rows, addLaterSource in later.ts), each with its status. A watch: a tap opens
// its page, ✕ stops it. Watching runs in Safari, so it can be seen and stopped here without the app.
// A reminder (2.5 (75), the owner's notes): the row says what it's about (its chat or page, a note's text, an
// answer's question and start), wrapped, not cut; a tap opens it in full with "Change reminder", "Open" and "Delete".

import type { VNode } from "preact"
import { useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import type { LaterItem } from "./later"
import { Bell, RemindSheet, TrashIcon, useAboveComposer } from "./MessageUx"

const Eye = ({ size = 16 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

export function RemindersSheet({ items, onOpen, onCancel, onReschedule, onClose }: {
  // null while loading.
  items: LaterItem[] | null
  onOpen: (item: LaterItem) => void
  onCancel: (item: LaterItem) => void
  // A reminder's new time: null once it's set, else why it couldn't be (no notifications on this device).
  onReschedule: (item: LaterItem, at: number, preset: "hour" | "evening" | "morning" | "week" | "custom") => Promise<string | null>
  onClose: () => void
}): VNode {
  const back = useRef<HTMLDivElement>(null)
  useAboveComposer(back)
  // The reminder opened in full, and the one whose time is being changed.
  const [expanded, setExpanded] = useState<string | null>(null)
  const [changing, setChanging] = useState<{ item: LaterItem; note: string | null } | null>(null)

  const watchRow = (item: LaterItem) => (
    <div key={item.id} class="cf-later-row">
      <button type="button" class="cf-later-open" onClick={() => onOpen(item)}>
        <span class="cf-later-icon"><Eye size={15} /></span>
        <span class="cf-later-text">
          <span class="cf-later-title">{item.title}</span>
          <span class="cf-later-status">{item.status}</span>
        </span>
      </button>
      <button type="button" class="cf-later-cancel" aria-label={t("uxStop")} title={t("uxStop")} onClick={() => onCancel(item)}>✕</button>
    </div>
  )

  const remindRow = (item: LaterItem) => {
    const open = expanded === item.id
    return (
      <div key={item.id} class={`cf-later-item ${open ? "open" : ""} ${item.here === false ? "elsewhere" : ""}`}>
        <div class="cf-later-row remind">
          <button type="button" class="cf-later-open" aria-expanded={open} onClick={() => setExpanded(open ? null : item.id)}>
            <span class="cf-later-icon"><Bell size={15} /></span>
            <span class="cf-later-text">
              <span class="cf-later-title">{item.title}</span>
              {item.question && <span class="cf-later-question">{item.question}</span>}
              {item.text && <span class="cf-later-body">{item.text}</span>}
              <span class="cf-later-status">{item.status}</span>
            </span>
          </button>
          {!open && (
            <button type="button" class="cf-later-cancel" aria-label={t("uxRemindCancel")} title={t("uxRemindCancel")} onClick={() => onCancel(item)}>✕</button>
          )}
        </div>
        {open && (
          <div class="cf-later-actions">
            <button type="button" class="cf-chip" onClick={() => setChanging({ item, note: null })}><Bell size={14} /> {t("uxRemindChange")}</button>
            <button type="button" class="cf-chip" onClick={() => onOpen(item)}>{t("uxRemindOpen")}</button>
            <button type="button" class="cf-chip danger" onClick={() => onCancel(item)}><TrashIcon size={14} /> {t("uxDelete")}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div class="cf-sheet cf-later-list" role="dialog" aria-label={t("uxReminders")}>
          <div class="cf-sheet-title"><Icon.List /> {t("uxReminders")}</div>
          {items?.map((item) => (item.kind === "remind" ? remindRow(item) : watchRow(item)))}
          {items && !items.length && (
            <div class="cf-later-empty">
              <strong>{t("uxNoReminders")}</strong>
              <span>{t("uxNoRemindersHint")}</span>
            </div>
          )}
        </div>
      </div>
      {changing && (
        <RemindSheet
          current={changing.item.at}
          note={changing.note}
          onPick={(at, preset) => {
            const item = changing.item
            void onReschedule(item, at, preset).then((note) => setChanging(note ? { item, note } : null))
          }}
          onCancel={() => {
            const item = changing.item
            setChanging(null)
            setExpanded(null)
            onCancel(item)
          }}
          onClose={() => setChanging(null)}
        />
      )}
    </>
  )
}
