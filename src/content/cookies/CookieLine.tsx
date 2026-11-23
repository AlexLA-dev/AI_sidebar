// The cookie closer's confirmation (2.7.1): a small line by the ✦ button, the first few times a banner is answered
// («Закрыл окно cookie: только необходимые»), gone by itself in a moment. After that it stays quiet. Drawn like the
// page hints' line (pagehints/hints.css), on the circle's side and at its height.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { noteTold, type Closed } from "./auto"

declare const __COOKIE_DEBUG__: boolean
const DEBUG = typeof __COOKIE_DEBUG__ !== "undefined" && __COOKIE_DEBUG__

const LINE_MS = 3_200

// A banner answered before the panel was drawn waits here for it.
let waiting: Closed | null = null
const listeners = new Set<(c: Closed) => void>()

/** A banner was answered on this page (auto.ts, a frame's word): the line shows if it's one of the first times. */
export function announceClosed(c: Closed): void {
  if (!c.tell) return
  if (listeners.size) for (const l of listeners) l(c)
  else waiting = c
}

/** Test builds: what the closer left alone and why, in the same place. */
export function announceLeft(why: string, via: string): void {
  if (DEBUG) announceClosed({ via: `${via} · left: ${why}`, tell: true })
}

/** The line to show now (null: none) and its dismissal, for `shown` (the circle is on the screen). */
export function useCookieLine(shown: boolean): { line: Closed | null; close: () => void } {
  const [line, setLine] = useState<Closed | null>(null)
  useEffect(() => {
    const hear = (c: Closed) => setLine(c)
    listeners.add(hear)
    if (waiting) {
      hear(waiting)
      waiting = null
    }
    return () => void listeners.delete(hear)
  }, [])
  useEffect(() => {
    if (!line) return
    // Not shown (the panel is open, the circle hidden): nothing said, and it isn't one of the times.
    if (!shown) {
      setLine(null)
      return
    }
    // Test builds: it stays until the next page, so a test can read it.
    if (DEBUG) return
    void noteTold(line.accepted === true)
    const timer = setTimeout(() => setLine(null), LINE_MS)
    return () => clearTimeout(timer)
  }, [line])
  return { line: shown ? line : null, close: () => setLine(null) }
}

export function CookieLine({ line, side, top, onClose }: { line: Closed; side: "left" | "right"; top: string; onClose: () => void }): VNode {
  return (
    <div class={`cf-ph cf-cookie-line ${side}`} style={{ top }} role="status">
      <button type="button" class="cf-ph-text" onClick={onClose}>
        {t(line.accepted ? "cookieAcceptedLine" : "cookieClosedLine")}{DEBUG ? ` · ${line.via}` : ""}
      </button>
    </div>
  )
}
