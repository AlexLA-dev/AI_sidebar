// Page watch (2.5) in the panel, through chat UX's registries (ux/later.ts): the eye in the selection bubble (only
// for a price, stock, a date or a status), after the bell, "Watch this page…" in the header's "…" (the whole page),
// and this device's watches in "Watching" (the header's "…"). Safari only: the checks and the notification need the
// app. The eye and "Watch this page…" open watching alone (WatchSheet).
// 2.5 (77), the director's split: reminders and watching are never one list or one window, so "Remind me about
// this page" has no watching section any more; one tip in the bubble says what the bell and the eye do.

import { TARGET } from "../../shared/config"
import { t } from "../../shared/i18n"
import { addBubbleAction, addLaterSource, openLater, setPageWatch } from "../ux/later"
import { watchableAt } from "./at"
import { Eye } from "./icons"
import { watchSource } from "./list"
import { openWatchSheet } from "./WatchSheet"

// Acts on pointerup, as the bubble's own buttons do: on iPhone the tap also clears the selection and the
// click may never come; a keyboard still sends a click.
let pressed: EventTarget | null = null
const press = (action: () => void) => ({
  onTouchEnd: (e: TouchEvent) => e.preventDefault(),
  onPointerDown: (e: PointerEvent) => {
    pressed = e.currentTarget
    e.preventDefault()
  },
  onPointerUp: (e: PointerEvent) => {
    if (pressed !== e.currentTarget) return
    pressed = null
    action()
  },
  onClick: (e: MouseEvent) => {
    if (e.detail === 0) action()
  }
})

if (TARGET === "safari") {
  addLaterSource("watch", watchSource)

  // The whole page ("when something new appears on the page"), the limit and a page that can't be watched as before;
  // such a page offers "Remind me to look", which opens "Remind me about this page".
  setPageWatch((page) => openWatchSheet({ url: page.url, title: page.title, selection: null, how: "later", remind: () => openLater() }))

  addBubbleAction("watch", (ctx) => {
    // A tap on "40" in "USD 40" selects only the number: the eye watches the price as the page writes it.
    const value = watchableAt(ctx.selection, ctx.range)?.value
    if (!value) return null
    return (
      <button
        type="button"
        class="cf-sel-icon cf-sel-watch"
        aria-label={t("watchEye")}
        title={t("watchEye")}
        {...press(() => {
          openWatchSheet({ url: ctx.url, title: ctx.title, selection: value, how: ctx.panel ? "panel" : "bubble" })
          if (ctx.panel) return
          // The page's selection goes, and with it the system's edit menu that would stay over the window.
          document.getSelection()?.removeAllRanges()
          ctx.close()
        })}
      >
        <Eye size={ctx.panel ? 14 : 16} />
        <span class="cf-sel-watch-l">{t("watchStart")}</span>
      </button>
    )
  })
}
