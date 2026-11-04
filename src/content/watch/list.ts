// Page watch (2.5) in the panel's "Reminders" list (chat UX's, through addLaterSource): this device's watches,
// each with its status in the person's language. ✕ stops one (the list asks every source; others' ids pass by).

import { t, uiLanguage } from "../../shared/i18n"
import { shownValue } from "../../shared/watch/compare"
import type { Watch } from "../../shared/watch/types"
import type { LaterItem, LaterSource } from "../ux/later"

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
  const shown = (v: string) => shownValue(v, uiLanguage(), { inStock: t("watchInStock"), outOfStock: t("watchOutOfStock") })
  let status: string
  if (w.metAt) {
    status = w.metValue && w.what !== "page"
      ? t("watchRowMetNow", label, shown(w.metValue), ago(w.metAt, now))
      : t("watchRowMet", label, ago(w.metAt, now))
  } else if (w.mode === "live") {
    status = t("watchRowLive", label)
  } else if (w.checks > 0) {
    status = t("watchRow", label, ago(w.checkedAt, now))
  } else {
    status = t("watchRowNew", label)
  }
  return { id: `${PREFIX}${w.id}`, kind: "watch", title: w.title || w.host, url: w.url, status, sortAt: w.metAt ?? w.checkedAt }
}

export const watchSource: LaterSource = {
  async items() {
    const list = (await chrome.runtime.sendMessage({ type: "watchList" }).catch(() => [])) as Watch[]
    return Array.isArray(list) ? list.map((w) => watchRow(w)) : []
  },
  async cancel(id) {
    if (!id.startsWith(PREFIX)) return
    await chrome.runtime.sendMessage({ type: "watchCancel", id: id.slice(PREFIX.length), via: "list" }).catch(() => undefined)
  }
}
