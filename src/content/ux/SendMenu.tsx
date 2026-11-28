// The send button's menu (2.7.1, the owner on build 121): «Заметка» and «Сделать» for a pointer, where a finger's
// swipe on the button isn't there — a right-click (two fingers on a trackpad), or the button held down with the
// pointer. A finger's hold on the button still flips the note as before. Each item turns its mode on, or off again
// when it's the one on. «Сделать» only where a swipe down would give it (Pro and Ultra, not «Ask your chats»).

import type { VNode } from "preact"
import { useEffect, useRef } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"

export function SendMenu({ note, doing, canDo, onNote, onDo, onClose }: {
  note: boolean
  doing: boolean
  canDo: boolean
  onNote: () => void
  onDo: () => void
  onClose: () => void
}): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })
    // Anywhere else in our root, Escape, or the page losing the focus: it goes.
    const root = el.getRootNode() as ShadowRoot | Document
    const away = (e: Event) => {
      if (!(e.target instanceof Node && el.contains(e.target))) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    const timer = window.setTimeout(() => root.addEventListener("pointerdown", away, true), 0)
    el.addEventListener("keydown", key)
    window.addEventListener("blur", onClose)
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener("pointerdown", away, true)
      el.removeEventListener("keydown", key)
      window.removeEventListener("blur", onClose)
    }
  }, [])
  const pick = (act: () => void) => () => {
    act()
    onClose()
  }
  return (
    <div ref={ref} class="cf-msg-menu up cf-send-menu" role="menu">
      <button type="button" role="menuitemcheckbox" aria-checked={note} onClick={pick(onNote)}>
        <Icon.Pencil /> {t("sendMenuNote")}
        {note && <span class="cf-send-menu-on"><Icon.Check /></span>}
      </button>
      {canDo && (
        <button type="button" role="menuitemcheckbox" aria-checked={doing} onClick={pick(onDo)}>
          <Icon.Sparkle size={15} /> {t("agentMode")}
          {doing && <span class="cf-send-menu-on"><Icon.Check /></span>}
        </button>
      )}
    </div>
  )
}

const POINTER_HINT = "cf:noteHintPointer"

/** Whether this device has shown the send button's hint for a pointer (once, 2.7.1). */
export async function pointerHintSeen(): Promise<boolean> {
  try {
    return Boolean((await chrome.storage.local.get(POINTER_HINT))[POINTER_HINT])
  } catch {
    return true
  }
}

export function markPointerHintSeen(): void {
  try {
    void chrome.storage.local.set({ [POINTER_HINT]: true })
  } catch {
    // Shown again next time.
  }
}
