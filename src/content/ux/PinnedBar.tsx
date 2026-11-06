// Pinned messages at the top of a chat, as in Telegram: one bar with one pinned answer or note.
// - Left: a segment per pinned message (up to 4 shown), the one on the bar highlighted.
// - A tap scrolls to that message, flashes it, and the bar moves on to the next older one (after the
//   oldest, the newest again).
// - Scrolling by hand: the bar shows the pinned message nearest above what's on screen (the oldest when
//   all of them are below).
// - Right, with more than one: the list of all of them in the chat's order (the one on the bar marked);
//   a tap on one scrolls to it, ✕ unpins it, "Unpin all" at the bottom.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import type { Entry } from "../../shared/conversation"
import { t } from "../../shared/i18n"

const SEGMENTS = 4
// A tap's own smooth scroll doesn't count as scrolling by hand.
const OWN_SCROLL_MS = 900

const ListIcon = (): VNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" />
  </svg>
)

function preview(text: string): string {
  return text.replace(/[#*_`>|[\]]/g, "").replace(/-{3,}/g, "").replace(/\s+/g, " ").trim().slice(0, 140)
}

/** `items`: the pinned answers and notes in the chat's order (oldest first), with their index in the chat. */
export function PinnedBar({ items, list, onOpen, onUnpin, onUnpinAll }: {
  items: Array<{ index: number; entry: Entry }>
  list: { current: HTMLElement | null }
  onOpen: (index: number) => void
  onUnpin: (index: number) => void
  onUnpinAll: () => void
}): VNode | null {
  // Which one the bar shows: a position in `items` (the newest at first).
  const [at, setAt] = useState(items.length - 1)
  const [listOpen, setListOpen] = useState(false)
  const ownScroll = useRef(0)
  const count = items.length
  const keys = items.map((x) => x.index).join(",")

  // Pinned or unpinned: back to the newest; the list closes when none is left to list.
  useEffect(() => {
    setAt(count - 1)
    if (count < 2) setListOpen(false)
  }, [keys, count])

  // Scrolling by hand: the pinned message nearest above the visible part.
  useEffect(() => {
    const box = list.current
    if (!box || !count) return
    const onScroll = () => {
      if (Date.now() < ownScroll.current) return
      const top = box.getBoundingClientRect().top
      let pick = -1
      items.forEach((it, i) => {
        const el = box.querySelector<HTMLElement>(`[data-index="${it.index}"]`)
        if (el && el.getBoundingClientRect().top < top + 8) pick = i
      })
      setAt(pick >= 0 ? pick : 0)
    }
    box.addEventListener("scroll", onScroll, { passive: true })
    return () => box.removeEventListener("scroll", onScroll)
  }, [keys, count, list])

  if (!count) return null
  const shown = Math.min(Math.max(at, 0), count - 1)
  const current = items[shown]
  const go = (pos: number, next: number) => {
    ownScroll.current = Date.now() + OWN_SCROLL_MS
    onOpen(items[pos].index)
    setAt(next)
  }
  // The segments: a window of up to 4 around the one shown.
  const first = Math.min(Math.max(0, shown - SEGMENTS + 1), Math.max(0, count - SEGMENTS))
  const segments = items.slice(first, first + SEGMENTS).map((_, i) => first + i)

  return (
    <div class="cf-pinbar" role="region" aria-label={t("uxPinned")}>
      <button
        type="button"
        class="cf-pinbar-main"
        aria-label={`${count > 1 ? t("uxPinnedN", shown + 1) : t("uxPinned")}: ${preview(current.entry.content)}`}
        onClick={() => go(shown, shown > 0 ? shown - 1 : count - 1)}
      >
        <span class="cf-pinbar-segments" aria-hidden="true">
          {segments.map((pos) => <span key={pos} class={pos === shown ? "on" : ""} style={{ height: `${100 / segments.length}%` }} />)}
        </span>
        <span class="cf-pinbar-text">
          <span class="cf-pinbar-label">{count > 1 ? t("uxPinnedN", shown + 1) : t("uxPinned")}</span>
          <span class="cf-pinbar-line">
            {current.entry.note && <span class="cf-pinbar-note" />}
            {preview(current.entry.content)}
          </span>
        </span>
      </button>
      {count > 1 && (
        <button type="button" class="cf-pinbar-all" aria-label={t("uxPinnedAll")} title={t("uxPinnedAll")} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
          <ListIcon />
        </button>
      )}
      {listOpen && (
        <div class="cf-pinbar-list" role="menu">
          <div class="cf-pinbar-list-title">{t("uxPinnedAll")}</div>
          {items.map((it, pos) => (
            <div key={it.index} class={`cf-pinbar-item ${pos === shown ? "on" : ""}`}>
              <button
                type="button"
                role="menuitem"
                aria-current={pos === shown ? "true" : undefined}
                onClick={() => {
                  setListOpen(false)
                  go(pos, pos > 0 ? pos - 1 : count - 1)
                }}
              >
                {it.entry.note && <span class="cf-pinbar-note" />}
                <span>{preview(it.entry.content)}</span>
              </button>
              <button type="button" class="cf-pinbar-x" aria-label={t("uxUnpin")} title={t("uxUnpin")} onClick={() => onUnpin(it.index)}>×</button>
            </div>
          ))}
          <button
            type="button"
            class="cf-pinbar-unpin-all"
            onClick={() => {
              setListOpen(false)
              onUnpinAll()
            }}
          >
            {t("uxUnpinAll")}
          </button>
        </div>
      )}
    </div>
  )
}
