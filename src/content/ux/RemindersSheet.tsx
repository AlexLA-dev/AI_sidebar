// The panel's two lists (2.5 (77), the director's split: two words, two icons, never one list), from the header's "…":
// - "Reminders" (the bell; also "All reminders" in "Remind me about this page"): the bells in the chats. A row says
//   what it's about (its chat or page, a note's text, an answer's question and start), wrapped, not cut; a tap opens
//   it in full with "Change reminder", "Open" and "Delete" (2.5 (75), the owner's notes).
// - "Watching" (the eye; Safari): what's watched (watching's rows, addLaterSource in later.ts), each with its status.
//   A tap opens it in watching's window, ✕ stops it: seen and stopped here without the app.
// Empty, each says where its own are set.

import type { VNode } from "preact"
import { useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import type { LaterItem } from "./later"
import { Bell, RemindSheet, TrashIcon, useAboveComposer } from "./MessageUx"

export function RemindersSheet({ kind, items, onOpen, onCancel, onReschedule, onClose }: {
  kind: LaterItem["kind"]
  // This list's rows (null while loading).
  items: LaterItem[] | null
  onOpen: (item: LaterItem) => void
  onCancel: (item: LaterItem) => void
  // A reminder's new time: null once it's set, else why it couldn't be (no notifications on this device).
  onReschedule: (item: LaterItem, at: number, preset: "hour" | "evening" | "morning" | "week" | "custom", words?: string) => Promise<string | null>
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
        <span class="cf-later-icon"><Icon.Eye size={15} /></span>
        <span class="cf-later-text">
          <span class="cf-later-title">{item.title}</span>
          {item.text && <span class="cf-later-body" dir="auto">{item.text}</span>}
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
              {item.quote && <span class="cf-later-quote" dir="auto">{item.quote}</span>}
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

  const watching = kind === "watch"
  const name = t(watching ? "uxWatching" : "uxReminders")
  return (
    <>
      <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div class={`cf-sheet cf-later-list ${kind}`} role="dialog" aria-label={name}>
          <div class="cf-sheet-title">
            {watching ? <Icon.Eye size={16} /> : <Bell size={16} />} {name}
            {/* A long list fills a small screen: it closes here too (2.5 (75)). */}
            <button type="button" class="cf-icon cf-sheet-close" onClick={onClose} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
          </div>
          {items?.filter((item) => item.kind === kind).map((item) => (watching ? watchRow(item) : remindRow(item)))}
          {items && !items.some((item) => item.kind === kind) && (
            <div class="cf-later-empty">
              <strong>{t(watching ? "uxNoWatching" : "uxNoReminders")}</strong>
              <span>{t(watching ? "uxNoWatchingHint" : "uxNoRemindersHint")}</span>
            </div>
          )}
        </div>
      </div>
      {changing && (
        <RemindSheet
          current={changing.item.at}
          note={changing.note}
          quote={changing.item.quote}
          words={changing.item.words}
          onPick={(at, preset, words) => {
            const item = changing.item
            void onReschedule(item, at, preset, words).then((note) => setChanging(note ? { item, note } : null))
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
