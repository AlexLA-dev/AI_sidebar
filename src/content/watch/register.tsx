// Page watch (2.5) in the panel, through chat UX's registries (ux/later.ts): the section "Notify me when it
// changes" under Remind in "Come back later…", the eye in the selection bubble (only for a price, stock, a date
// or a status), and this device's watches in "Reminders". Safari only: the checks and the notification need the app.

import { TARGET } from "../../shared/config"
import { t } from "../../shared/i18n"
import { detectWatchable } from "../../shared/watch/detect"
import { addBubbleAction, addLaterSection, addLaterSource, openLater } from "../ux/later"
import { Eye } from "./icons"
import { watchSource } from "./list"
import { WatchSection } from "./WatchSection"

// The window opened from the eye: its section counts the watch as made from the bubble.
let fromEye = false

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
  addLaterSection("watch", (ctx) => {
    const how = fromEye ? "bubble" : "later"
    fromEye = false
    return <WatchSection key={`${ctx.url}|${ctx.selection ?? ""}`} url={ctx.url} title={ctx.title} selection={ctx.selection} how={how} close={ctx.close} remind={ctx.remind} />
  })

  addLaterSource("watch", watchSource)

  addBubbleAction("watch", (ctx) => {
    if (!detectWatchable(ctx.selection)) return null
    return (
      <button
        type="button"
        class="cf-sel-icon cf-sel-watch"
        aria-label={t("watchEye")}
        title={t("watchEye")}
        {...press(() => {
          fromEye = true
          openLater({ selection: ctx.selection, range: ctx.range })
          ctx.close()
        })}
      >
        <Eye size={16} />
        <span class="cf-sel-watch-l">{t("watchStart")}</span>
      </button>
    )
  })
}
