// 2.6 (97): the chat's open suggestions at its top, like the pinned messages' bar — they're easy to miss deep in a
// long chat. One line of the current one; a tap scrolls to it in the chat, flashes it, and the bar moves on to the
// next (after the last, the first again). No suggestion open: no bar. The suggestions are the ones the chat shows under
// its messages (a tag, a move, a new chat, a merge, a name: a move and a name never at once), so taking or turning one
// down here or on another device takes it off the bar as well.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t } from "../shared/i18n"

export interface BarSuggestion {
  // What it is (its chip in the chat has `data-sug` = kind, OrganizeRow) and a stable key.
  kind: "tag" | "move" | "name"
  key: string
  // The message it's under (the chat's order).
  index: number
  // One line, as the chip says it.
  text: string
}

const SEGMENTS = 4

const KIND_ORDER = { tag: 0, move: 1, name: 2 } as const

/** The open suggestions in the chat's order: the one under the earlier message first; under one message as its row
 * shows them (a tag, a move, a name). */
export function inChatOrder(items: BarSuggestion[]): BarSuggestion[] {
  return [...items].sort((a, b) => a.index - b.index || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}

/** A message's start, for a tag's line ("#trips · How long is …"). */
export function preview(text: string, max = 80): string {
  return text.replace(/[#*_`>|[\]]/g, "").replace(/-{3,}/g, "").replace(/\s+/g, " ").trim().slice(0, max)
}

/** The label: "Suggested · 2/3", or "Suggested · 1" for one. */
export function barLabel(shown: number, count: number): string {
  return count > 1 ? t("orgBarOf", shown + 1, count) : t("orgBarOne", count)
}

/** `compact`: one line (the pinned bar is above it). `onOpen` scrolls to it and flashes it. */
export function SuggestionsBar({ items, compact, onOpen }: {
  items: BarSuggestion[]
  compact?: boolean
  onOpen: (item: BarSuggestion) => void
}): VNode | null {
  const [at, setAt] = useState(0)
  const count = items.length
  const keys = items.map((x) => x.key).join(",")
  // Another set of suggestions: from the first again.
  useEffect(() => setAt(0), [keys])
  if (!count) return null
  const shown = Math.min(Math.max(at, 0), count - 1)
  const current = items[shown]
  const first = Math.min(Math.max(0, shown - SEGMENTS + 1), Math.max(0, count - SEGMENTS))
  const segments = items.slice(first, first + SEGMENTS).map((_, i) => first + i)
  const label = barLabel(shown, count)
  return (
    <div class={`cf-sugbar${compact ? " compact" : ""}`} role="region" aria-label={t("orgBarA11y")}>
      <button
        type="button"
        class="cf-sugbar-main"
        aria-label={`${label}: ${current.text}`}
        onClick={() => {
          onOpen(current)
          setAt((shown + 1) % count)
        }}
      >
        <span class="cf-sugbar-segments" aria-hidden="true">
          {segments.map((pos) => <span key={pos} class={pos === shown ? "on" : ""} style={{ height: `${100 / segments.length}%` }} />)}
        </span>
        <span class="cf-sugbar-text">
          <span class="cf-sugbar-label">{label}</span>
          <span class="cf-sugbar-line">{current.text}</span>
        </span>
      </button>
    </div>
  )
}
