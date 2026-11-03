// 2.5 in the chat: reminders, the highlight button, the menu of a message and the "Deleted · Undo" bar
// (pinned messages: PinnedBar.tsx).

import type { ComponentChildren, VNode } from "preact"
import { useLayoutEffect, useRef, useState } from "preact/hooks"

import type { Entry } from "../../shared/conversation"
import { t } from "../../shared/i18n"

const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const

export const Bell = ({ size = 15 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
)
export const Marker = ({ size = 15 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></svg>
)
export const More = ({ size = 15 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
)
export const TrashIcon = ({ size = 18 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
)
export const PinIcon = ({ size = 18, filled = false }: { size?: number; filled?: boolean }): VNode => (
  <svg {...base} width={size} height={size} fill={filled ? "currentColor" : "none"}><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" /><path d="M12 15v6" /></svg>
)

// ------------------------------------------------------------ reminder times

/** The preset times, from `now`: in an hour, this evening (18:00, if it's before 17:00), tomorrow at 9, in a week at 9. */
export function remindPresets(now = new Date()): Array<{ key: "uxRemindHour" | "uxRemindEvening" | "uxRemindMorning" | "uxRemindWeek"; at: number }> {
  const at = (days: number, hour: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  // Stage A check only: on a page opened with #cf-ux-test, "In an hour" rings in a minute.
  const test = typeof location !== "undefined" && location.hash.includes("cf-ux-test")
  const out: Array<{ key: "uxRemindHour" | "uxRemindEvening" | "uxRemindMorning" | "uxRemindWeek"; at: number }> = [
    { key: "uxRemindHour", at: now.getTime() + (test ? 60_000 : 3600_000) }
  ]
  if (now.getHours() < 17) out.push({ key: "uxRemindEvening", at: at(0, 18) })
  out.push({ key: "uxRemindMorning", at: at(1, 9) }, { key: "uxRemindWeek", at: at(7, 9) })
  return out
}

/** "Today 18:00", "Tomorrow 9:00", "Fri 9:00", "12 Nov 9:00" in the user's language. */
export function remindLabel(at: number, now = new Date()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(d) - day(now)) / 86_400_000)
  if (days === 0) return `${t("uxToday")} ${time}`
  if (days === 1) return `${t("uxTomorrow")} ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`
}

/** The value for <input type="datetime-local"> (local time, to the minute). */
function localInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ------------------------------------------------------------ pieces

/** The bell under a message with a reminder: when. */
export function RemindChip({ at, onClick }: { at: number; onClick: () => void }): VNode {
  const past = at < Date.now()
  return (
    <button type="button" class={`cf-remind-chip ${past ? "past" : ""}`} onClick={onClick} aria-label={`${t("uxRemind")}: ${remindLabel(at)}`}>
      <Bell size={13} /> {remindLabel(at)}
    </button>
  )
}

/** "When should I remind you?": the presets, a date of one's own, and "Don't remind" for one that's set. */
export function RemindSheet({ current, note, onPick, onCancel, onClose }: {
  current?: number
  note?: string | null
  onPick: (at: number) => void
  onCancel: () => void
  onClose: () => void
}): VNode {
  const [custom, setCustom] = useState<string | null>(null)
  return (
    <div class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cf-sheet" role="dialog" aria-label={t("uxRemindTitle")}>
        <div class="cf-sheet-title"><Bell size={16} /> {t("uxRemindTitle")}</div>
        {remindPresets().map((p) => (
          <button type="button" key={p.key} class="cf-sheet-row" onClick={() => onPick(p.at)}>
            <span>{t(p.key)}</span>
            <span class="cf-sheet-when">{remindLabel(p.at)}</span>
          </button>
        ))}
        {custom === null ? (
          <button type="button" class="cf-sheet-row" onClick={() => setCustom(localInput(Date.now() + 86_400_000))}>
            <span>{t("uxRemindPick")}</span>
          </button>
        ) : (
          <div class="cf-sheet-pick">
            <input type="datetime-local" value={custom} min={localInput(Date.now())} onInput={(e) => setCustom((e.target as HTMLInputElement).value)} />
            <button type="button" class="cf-sheet-ok" disabled={!custom || new Date(custom).getTime() <= Date.now()} onClick={() => custom && onPick(new Date(custom).getTime())}>
              {t("uxRemindSet")}
            </button>
          </div>
        )}
        {current !== undefined && (
          <button type="button" class="cf-sheet-row danger" onClick={onCancel}>{t("uxRemindCancel")}</button>
        )}
        {note && <p class="cf-sheet-note">{note}</p>}
      </div>
    </div>
  )
}

/** A small menu by a message: pin, remind, delete (and on a Mac the same on right-click). */
export function MessageMenu({ pinned, reminded, onPin, onRemind, onDelete, onClose }: {
  pinned: boolean
  reminded: boolean
  onPin: () => void
  onRemind: () => void
  onDelete: () => void
  onClose: () => void
}): VNode {
  return (
    <div class="cf-msg-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <button type="button" role="menuitem" onClick={onPin}><PinIcon size={15} filled={pinned} /> {t(pinned ? "uxUnpin" : "uxPin")}</button>
      <button type="button" role="menuitem" onClick={onRemind}><Bell size={15} /> {t(reminded ? "uxRemindChange" : "uxRemind")}</button>
      <button type="button" role="menuitem" class="danger" onClick={onDelete}><TrashIcon size={15} /> {t("uxDelete")}</button>
    </div>
  )
}

/** "Deleted · Undo" at the bottom of the panel, until the next action. */
export function UndoBar({ text, onUndo, onDone }: { text: string; onUndo: () => void; onDone: () => void }): VNode {
  return (
    <div class="cf-undo" role="status">
      <span>{text}</span>
      <button type="button" onClick={onUndo}>{t("uxUndo")}</button>
      <button type="button" class="cf-undo-x" aria-label={t("close")} onClick={onDone}>×</button>
    </div>
  )
}

/** A small bubble by a selection or a highlight in an answer (fixed; under it on touch, the system menu is above). */
export function FloatAt({ rect, touch, children }: { rect: DOMRect; touch: boolean; children: ComponentChildren }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const vv = window.visualViewport
    const top0 = vv?.offsetTop ?? 0
    const bottom = top0 + (vv?.height ?? window.innerHeight)
    const min = (vv?.offsetLeft ?? 0) + 8
    const max = min + (vv?.width ?? window.innerWidth) - 16 - el.offsetWidth
    el.style.left = `${Math.max(min, Math.min(max, rect.left + rect.width / 2 - el.offsetWidth / 2))}px`
    // On touch, clear of the selection handles and the system's edit menu (iOS 26 shows it right below
    // the selection, older versions above), as the selection buttons on a page.
    const clear = touch ? 70 : 8
    let top = rect.bottom + clear
    if (top + el.offsetHeight > bottom - 12 && rect.top - clear - el.offsetHeight >= top0 + 8) top = rect.top - clear - el.offsetHeight
    el.style.top = `${Math.max(top0 + 8, Math.min(bottom - el.offsetHeight - 12, top))}px`
  }, [rect, touch])
  return (
    <div ref={ref} class={`cf-float ${touch ? "touch" : ""}`} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>
  )
}
