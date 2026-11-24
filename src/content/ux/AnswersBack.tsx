// «Remind me when my 5 answers are back» (2.8, В7.1), next to the plans at the free limit: a notification on this device
// at the moment the free answers come back (the server's resetsAt), through the panel's one reminder path (the
// background's `remind`). Notifications not on (never asked, only the quiet setup permission, or turned off): «Turn on
// notifications» opens the app's own ask (setup-28's entry point, contextflow://notifications?why=answers_back&page=…),
// which brings the person back to this page; the reminder is then set again here. Kept per reset.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t, uiLang } from "../../shared/i18n"
import { sendBackground } from "../insert/store"
import { followLink } from "../page"

const KEY = "cf:answersBack"
// Sent to the app's notification ask for this reset: on coming back, the reminder is set again.
const ASKED = "cf:answersBackAsked"

type State = "idle" | "asking" | "set" | "off" | "failed"

/** The reminder's own ids among the panel's reminders (MessageReminders: one per chat and message). */
export const ANSWERS_BACK = { chat: "cf-limit", message: "answers-back" } as const

export type AnswersBackOutcome = "scheduled" | "denied" | "not-asked" | "failed" | "unavailable"
type Send = (message: Record<string, unknown>, opts: { timeoutMs: number; tries: number }) => Promise<{ outcome?: string } | null>

const outcomeOf = (reply: { outcome?: string } | null): AnswersBackOutcome => {
  const outcome = reply?.outcome
  return outcome === "scheduled" || outcome === "denied" || outcome === "not-asked" || outcome === "unavailable" ? outcome : "failed"
}

/**
 * The one place the panel asks for this reminder (and for notifications, when never asked). The director's first
 * acceptance (2.8, iPad, shot 13): allowed in the system's first-time question, and the card said it couldn't be set.
 * The question can outlast the panel's wait for an answer, and Safari may put the page away under it, so the answer
 * never comes back. No answer, then: asked again without the question (the same reminder, so it is set once at most),
 * which finds the permission just given and sets it.
 */
export async function askAnswersBack(at: number, count: number, url: string, ask = true, send: Send = sendBackground, pause = 1_500): Promise<AnswersBackOutcome> {
  const message = { type: "remind", ...ANSWERS_BACK, at, title: "ContextFlow", body: t("answersBackBody", String(count)), url }
  // The background waits for the system's answer up to 90 s; one try, no resend of a question already on screen.
  const first = outcomeOf(await send({ ...message, ask }, { timeoutMs: 100_000, tries: 1 }).catch(() => null))
  if (first !== "failed") return first
  await new Promise((ok) => setTimeout(ok, pause))
  return outcomeOf(await send({ ...message, ask: false }, { timeoutMs: 15_000, tries: 2 }).catch(() => null))
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
  const stateRef = useRef<State>("idle")
  stateRef.current = state
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
      // Back from the app's ask, or back after a try that got no answer: set it again (no question this time).
      if (kept[ASKED] !== resetsAt && stateRef.current !== "failed") return
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
    const outcome = await askAnswersBack(resetsAt, count, url, tapped)
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
        <>
          <span>{t("answersBackFailed", clock(resetsAt))}</span>{" "}
          {/* Never a dead end: try again (the question is asked again only if it was never answered). */}
          <button type="button" class="cf-link" onClick={() => void ask()}>{t("retry")}</button>
        </>
      ) : (
        <button type="button" class="cf-link" disabled={state === "asking"} onClick={() => void ask()}>{t("answersBackAsk", String(count))}</button>
      )}
    </p>
  )
}
