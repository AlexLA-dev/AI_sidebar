// «Remind me when my 5 answers are back» (2.8, В7.1), next to the plans at the free limit: a notification on this device
// at the moment the free answers come back (the server's resetsAt), through the panel's one reminder path (the
// background's `remind`). Notifications not on (never asked, only the quiet setup permission, or turned off): «Turn on
// notifications» opens the app's own ask (setup-28's entry point, contextflow://notifications?why=answers_back&page=…),
// which brings the person back to this page; the reminder is then set again here. Kept per reset.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t, uiLang } from "../../shared/i18n"
import { sendBackground } from "../insert/store"
import { followLink } from "../page"

const KEY = "cf:answersBack"
// Sent to the app's notification ask for this reset: on coming back, the reminder is set again.
const ASKED = "cf:answersBackAsked"

type State = "idle" | "asking" | "set" | "off" | "failed"

/** The reminder's own ids among the panel's reminders (MessageReminders: one per chat and message). */
export const ANSWERS_BACK = { chat: "cf-limit", message: "answers-back" } as const

/** The one place the panel asks for this reminder (and for notifications, when never asked). */
export async function askAnswersBack(at: number, count: number, url: string): Promise<"scheduled" | "denied" | "not-asked" | "failed" | "unavailable"> {
  const reply = await sendBackground<{ outcome?: string }>({
    type: "remind", ...ANSWERS_BACK, at, ask: true,
    title: "ContextFlow", body: t("answersBackBody", String(count)), url
  })
  const outcome = reply?.outcome
  return outcome === "scheduled" || outcome === "denied" || outcome === "not-asked" || outcome === "unavailable" ? outcome : "failed"
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(uiLang(), { hour: "numeric", minute: "2-digit" })
}

/** The app's notification ask (setup-28), back to `page` afterwards. */
export function notifyLink(page: string): string {
  return `contextflow://notifications?why=answers_back${/^https?:\/\//.test(page) ? `&page=${encodeURIComponent(page.split("#")[0])}` : ""}`
}

export function AnswersBack({ resetsAt, count, url, onEvent }: {
  // When the free answers come back (ms).
  resetsAt: number
  count: number
  // The page the notification opens.
  url: string
  onEvent: (action: "remind" | "remind_set" | "remind_off" | "remind_notify") => void
}): VNode | null {
  const [state, setState] = useState<State>("idle")
  useEffect(() => {
    void chrome.storage.local.get(KEY).then((kept) => {
      if (kept[KEY] === resetsAt) setState("set")
    }, () => undefined)
  }, [resetsAt])
  // Back from the app's notification ask: set it again (once; a «no» there leaves it as it was).
  useEffect(() => {
    const back = async () => {
      if (document.visibilityState !== "visible") return
      const kept = await chrome.storage.local.get(ASKED).catch(() => ({} as Record<string, unknown>))
      if (kept[ASKED] !== resetsAt) return
      void chrome.storage.local.remove(ASKED).catch(() => undefined)
      void ask(false)
    }
    void back()
    document.addEventListener("visibilitychange", back)
    window.addEventListener("focus", back)
    return () => {
      document.removeEventListener("visibilitychange", back)
      window.removeEventListener("focus", back)
    }
  }, [resetsAt])
  if (resetsAt <= Date.now()) return null

  const ask = async (tapped = true) => {
    setState("asking")
    if (tapped) onEvent("remind")
    const outcome = await askAnswersBack(resetsAt, count, url)
    if (outcome === "scheduled") {
      setState("set")
      onEvent("remind_set")
      void chrome.storage.local.set({ [KEY]: resetsAt }).catch(() => undefined)
    } else if (outcome === "denied" || outcome === "not-asked") {
      setState("off")
      onEvent("remind_off")
    } else {
      setState("failed")
    }
  }

  return (
    <p class="cf-answers-back" role="status">
      {state === "set" ? (
        <span>{t("answersBackSet", clock(resetsAt))}</span>
      ) : state === "off" ? (
        <>
          <span>{t("answersBackOff", clock(resetsAt))}</span>{" "}
          {/* In the tap itself: Safari opens the app only for a tap's own navigation. */}
          <button type="button" class="cf-link" onClick={() => {
            onEvent("remind_notify")
            void chrome.storage.local.set({ [ASKED]: resetsAt }).catch(() => undefined)
            followLink(notifyLink(url))
          }}>{t("listenNotifyOn")}</button>
        </>
      ) : state === "failed" ? (
        <span>{t("answersBackFailed", clock(resetsAt))}</span>
      ) : (
        <button type="button" class="cf-link" disabled={state === "asking"} onClick={() => void ask()}>{t("answersBackAsk", String(count))}</button>
      )}
    </p>
  )
}
