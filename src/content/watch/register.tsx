// Page watch (2.5) in the panel, through chat UX's registries (ux/later.ts): the section "Notify me when it
// changes" under Remind in "Come back later…", the eye in the selection bubble (only for a price, stock, a date
// or a status), and this device's watches in "Reminders". Safari only: the checks and the notification need the app.
// The eye opens watching alone (WatchSheet): the owner's notes on build 75, the eye and the bell aren't one menu.

import { TARGET } from "../../shared/config"
import { t } from "../../shared/i18n"
import { addBubbleAction, addLaterSection, addLaterSource } from "../ux/later"
import { watchableAt } from "./at"
import { Eye } from "./icons"
import { watchSource } from "./list"
import { EyeTip, LaterTip } from "./tips"
import { WatchSection } from "./WatchSection"
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
  addLaterSection("watch", (ctx) => (
    <>
      <LaterTip />
      <WatchSection key={`${ctx.url}|${ctx.selection ?? ""}`} url={ctx.url} title={ctx.title} selection={ctx.selection} how="later" close={ctx.close} remind={ctx.remind} />
    </>
  ))

  addLaterSource("watch", watchSource)

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
          openWatchSheet({ url: ctx.url, title: ctx.title, selection: value, how: "bubble" })
          // The page's selection goes, and with it the system's edit menu that would stay over the window.
          document.getSelection()?.removeAllRanges()
          ctx.close()
        })}
      >
        <Eye size={16} />
        <span class="cf-sel-watch-l">{t("watchStart")}</span>
        <EyeTip />
      </button>
    )
  })
}
