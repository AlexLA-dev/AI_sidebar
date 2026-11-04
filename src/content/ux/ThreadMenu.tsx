// A chat in the list on iPhone and iPad (2.5 (75), the owner's notes): the row has its swipes (left: delete, right:
// pin) and one "…" with everything, pin and delete included; the pin, rename, tag and trash buttons stay on a Mac.

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import { listenAround } from "../around"
import * as Icon from "../icons"
import { More, PinIcon, TrashIcon } from "./MessageUx"

export function ThreadMenu({ pinned, onPin, onRename, onTags, onDelete, onClose }: {
  pinned: boolean
  onPin: () => void
  onRename: () => void
  onTags: () => void
  onDelete: () => void
  onClose: () => void
}): VNode {
  const ref = useRef<HTMLDivElement>(null)
  // Under "…", or over it when the list has no room below (the last chats).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const list = el.closest(".cf-threads")?.getBoundingClientRect()
    const anchor = el.parentElement?.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const floor = list?.bottom ?? window.innerHeight
    if (anchor && box.bottom > floor - 4) el.classList.add("up")
  }, [])
  useEffect(() => {
    const away = (_: Event, path: EventTarget[]) => {
      // Its own "…" toggles it.
      if (!path.includes(ref.current as EventTarget) && !path.some((el) => (el as Element).classList?.contains("cf-thread-more"))) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    let stop = () => {}
    const timer = setTimeout(() => {
      if (ref.current) stop = listenAround(ref.current, "pointerdown", away)
      document.addEventListener("keydown", esc, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      stop()
      document.removeEventListener("keydown", esc, true)
    }
  }, [onClose])
  const item = (run: () => void) => () => {
    onClose()
    run()
  }
  return (
    <div ref={ref} class="cf-msg-menu cf-thread-menu" role="menu">
      <button type="button" role="menuitem" onClick={item(onPin)}><PinIcon size={15} filled={pinned} /> {t(pinned ? "unpinChat" : "pinChat")}</button>
      <button type="button" role="menuitem" onClick={item(onRename)}><Icon.Pencil /> {t("renameChat")}</button>
      <button type="button" role="menuitem" onClick={item(onTags)}><Icon.Tag /> {t("tagsEdit")}</button>
      <button type="button" role="menuitem" class="danger" onClick={item(onDelete)}><TrashIcon size={15} /> {t("deleteChat")}</button>
    </div>
  )
}

/** "…" on a chat's row (touch): opens ThreadMenu. */
export function ThreadMoreButton({ open, onToggle }: { open: boolean; onToggle: () => void }): VNode {
  return (
    <button type="button" class="cf-icon cf-thread-tool cf-thread-more" aria-label={t("uxMoreChat")} title={t("uxMoreChat")} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
      <More size={18} />
    </button>
  )
}
