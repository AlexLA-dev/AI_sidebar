// Page watch (2.5) in the panel's "Watching" list (chat UX's, through addLaterSource; 2.5 (77): its own list, not
// "Reminders"): this device's watches, each with its status in the person's language. ✕ stops one (the list asks
// every source; others' ids pass by).

import { t, uiLanguage } from "../../shared/i18n"
import { conditionLine, shown } from "../../shared/watch/line"
import type { Watch } from "../../shared/watch/types"
import type { LaterItem, LaterSource } from "../ux/later"
import { openWatchEdit } from "./WatchSheet"

const PREFIX = "watch:"

/** "5 minutes ago", "yesterday": the time since a check, in the panel's language. */
export function ago(at: number, now = Date.now(), lang = uiLanguage()): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" })
  const s = Math.round((at - now) / 1000)
  if (Math.abs(s) < 60) return rtf.format(0, "minute")
  const m = Math.round(s / 60)
  if (Math.abs(m) < 60) return rtf.format(m, "minute")
  const h = Math.round(m / 60)
  if (Math.abs(h) < 24) return rtf.format(h, "hour")
  return rtf.format(Math.round(h / 24), "day")
}

export function watchRow(w: Watch, now = Date.now()): LaterItem {
  const label = w.label || w.title || w.host
  // While watching: what it waits for and the value now, whole (the owner, build 75: "I can't see what price I set").
  const line = conditionLine(w)
  let status: string
  if (w.metAt) {
    status = w.metValue && w.what !== "page"
      ? t("watchRowMetNow", label, shown(w.metValue), ago(w.metAt, now))
      : t("watchRowMet", label, ago(w.metAt, now))
  } else if (w.mode === "live") {
    status = t("watchRowLive", line)
  } else if (w.checks > 0) {
    status = t("watchRow", line, ago(w.checkedAt, now))
  } else {
    status = t("watchRowNew", line)
  }
  return { id: `${PREFIX}${w.id}`, kind: "watch", title: w.title || w.host, url: w.url, status, sortAt: w.metAt ?? w.checkedAt }
}

/**
 * The list's source. `open`: a watch's row opens watching's own window (its words whole, the value now, change the
 * words, stop it) instead of the page; true only for a watch's row (a reminder's "Open" goes the list's own way).
 * `done` reads the list's rows again after a change.
 */
export const watchSource: LaterSource = {
  kind: "watch",
  open(item, done) {
    if (item.kind !== "watch" || !item.id.startsWith(PREFIX)) return false
    const id = item.id.slice(PREFIX.length)
    void (chrome.runtime.sendMessage({ type: "watchList" }) as Promise<Watch[]>).then((list) => {
      const w = Array.isArray(list) ? list.find((x) => x.id === id) : undefined
      if (w) openWatchEdit(w, () => done?.())
      else if (item.url) window.open(item.url, "_blank", "noopener")
    }, () => undefined)
    return true
  },
  async items() {
    const list = (await chrome.runtime.sendMessage({ type: "watchList" }).catch(() => [])) as Watch[]
    return Array.isArray(list) ? list.map((w) => watchRow(w)) : []
  },
  async cancel(id) {
    if (!id.startsWith(PREFIX)) return
    await chrome.runtime.sendMessage({ type: "watchCancel", id: id.slice(PREFIX.length), via: "list" }).catch(() => undefined)
  }
}
