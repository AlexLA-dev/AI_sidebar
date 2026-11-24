// «Remind me when my 5 answers are back» (2.8, В7.1), next to the plans at the free limit: a notification on this device
// at the moment the free answers come back (the server's resetsAt). Notifications are asked about here, at the moment
// they're of use (В3.2), through the panel's one reminder path (the background's `remind`, the device's notification);
// the app setup session's single entry point takes this over when it exists (askAnswersBack is the one place to change).
// Kept per reset, so the card says it's set when the limit shows again.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"

import { t, uiLang } from "../../shared/i18n"
import { sendBackground } from "../insert/store"

const KEY = "cf:answersBack"

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

export function AnswersBack({ resetsAt, count, url, onEvent }: {
  // When the free answers come back (ms).
  resetsAt: number
  count: number
  // The page the notification opens.
  url: string
  onEvent: (action: "remind" | "remind_set" | "remind_off") => void
}): VNode | null {
  const [state, setState] = useState<State>("idle")
  useEffect(() => {
    void chrome.storage.local.get(KEY).then((kept) => {
      if (kept[KEY] === resetsAt) setState("set")
    }, () => undefined)
  }, [resetsAt])
  if (resetsAt <= Date.now()) return null

  const ask = async () => {
    setState("asking")
    onEvent("remind")
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
        <span>{t("answersBackOff", clock(resetsAt))}</span>
      ) : state === "failed" ? (
        <span>{t("answersBackFailed", clock(resetsAt))}</span>
      ) : (
        <button type="button" class="cf-link" disabled={state === "asking"} onClick={() => void ask()}>{t("answersBackAsk", String(count))}</button>
      )}
    </p>
  )
}
