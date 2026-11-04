// Page watch (2.5): what the panel sends the background when someone asks to be told about a change,
// read from the live page: the kind of value, the words around it, the page's markup, the condition in the
// person's language to start from.

import { t } from "../../shared/i18n"
import { detectWatchable, isOutOfStock } from "../../shared/watch/detect"
import { digest, locate, pickSource, readPage, readValue, structured } from "../../shared/watch/extract"
import type { WatchDraft } from "../../shared/watch/messages"

const AROUND = 750

/** The draft for this page and selection ("" or null: the whole page). */
export function draftFor(url: string, title: string, selection: string | null): WatchDraft {
  const html = document.documentElement.outerHTML
  const page = readPage(html)
  const sel = (selection ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
  const what = sel ? detectWatchable(sel) ?? "status" : "page"
  const spot = sel ? locate(page.text, sel) : null
  const at = sel ? page.text.indexOf(sel) : -1
  const around = at >= 0 ? page.text.slice(Math.max(0, at - AROUND), at + sel.length + AROUND) : page.text.slice(0, AROUND * 2)
  let value = sel
  if (what === "page") value = digest(page.text)
  else if (spot) value = readValue(page, { source: pickSource(page, what, sel), what, ...spot }) ?? sel
  return {
    url, title, selection: sel, what, condition: conditionFor(what, sel), around,
    ...(spot ? spot : {}),
    candidates: structured(html),
    value,
    ...(what === "page" ? { text: page.text } : {})
  }
}

/** The words to start from, which the person changes as they like ("when size 42 shows up"). */
export function conditionFor(what: WatchDraft["what"], selection: string): string {
  const now = selection.length > 40 ? `${selection.slice(0, 39)}…` : selection
  switch (what) {
    case "price":
      return t("watchCondPrice", now)
    case "stock":
      return isOutOfStock(selection) ? t("watchCondBack") : t("watchCondStock", now)
    case "date":
      return t("watchCondDate", now)
    case "status":
      return t("watchCondStatus", now)
    default:
      return t("watchCondPage")
  }
}
