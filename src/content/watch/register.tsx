// Page watch (2.5) in the panel, through chat UX's registries (ux/later.ts): the section "Notify me when it
// changes" under Remind in "Come back later…", and the eye in the selection bubble, only for a price, stock,
// a date or a status. Safari only: the checks and the notification need the app.

import { TARGET } from "../../shared/config"
import { t } from "../../shared/i18n"
import { detectWatchable } from "../../shared/watch/detect"
import { addBubbleAction, addLaterSection, openLater } from "../ux/later"
import { WatchSection } from "./WatchSection"

// The window opened from the eye: its section counts the watch as made from the bubble.
let fromEye = false

function Eye() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

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
    return <WatchSection key={`${ctx.url}|${ctx.selection ?? ""}`} url={ctx.url} title={ctx.title} selection={ctx.selection} how={how} close={ctx.close} />
  })

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
        <Eye />
        <span class="cf-sel-watch-l">{t("watchStart")}</span>
      </button>
    )
  })
}
