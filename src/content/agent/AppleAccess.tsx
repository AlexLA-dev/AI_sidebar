// Calendar and Reminders access, seen and asked from the panel (2.7.1, the owner: «А в расширении есть явный запрос
// или место в настройках добавить/открыть календарь и напоминания?»). The extension can't ask the system itself: the
// app does (contextflow://access?kind=…), and when the person turned it down before, the app opens the system's
// Settings instead. Shown in Settings, under the calendar rule, and on a booking's plan card.

import type { VNode } from "preact"
import { useEffect, useState } from "preact/hooks"
import { sendBackground } from "../insert/store"
import { t } from "../../shared/i18n"
import { followLink } from "../page"

export type AccessState = "yes" | "none" | "denied" | "unavailable"
export type AccessKind = "calendar" | "reminders"
export interface AppleAccess {
  calendar: AccessState
  reminders: AccessState
}

const UNKNOWN: AppleAccess = { calendar: "unavailable", reminders: "unavailable" }
const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches

/** Access as the app has it now, asked again whenever the panel comes back into view (after the app's question). */
export function useAppleAccess(): AppleAccess {
  const [access, setAccess] = useState<AppleAccess>(UNKNOWN)
  useEffect(() => {
    let live = true
    const check = () => void sendBackground<AppleAccess>({ type: "agentAccess" }).then((a) => live && a && setAccess(a)).catch(() => undefined)
    check()
    const seen = () => document.visibilityState === "visible" && check()
    document.addEventListener("visibilitychange", seen)
    window.addEventListener("focus", check)
    return () => {
      live = false
      document.removeEventListener("visibilitychange", seen)
      window.removeEventListener("focus", check)
    }
  }, [])
  return access
}

/** The system's question through the app; once turned down, the system's Settings (the app opens them). */
export function askAccess(kind: AccessKind, state: AccessState): void {
  const settings = state === "denied"
  if (touch()) {
    followLink(`contextflow://access?kind=${kind}${settings ? "&settings=1" : ""}`)
    return
  }
  try {
    chrome.runtime.sendMessage({ type: "agentAccessOpen", kind, ...(settings ? { settings: true } : {}) }, () => void chrome.runtime.lastError)
  } catch {
    // the person can open the app themselves
  }
}

function buttonText(state: AccessState): string {
  return state === "denied" ? t(touch() ? "accessSettingsIos" : "accessSettingsMac") : t("accessAllow")
}

function Row({ kind, state }: { kind: AccessKind; state: AccessState }): VNode {
  return (
    <div class="cf-row cf-access-row">
      <span class="cf-label">{t(kind === "calendar" ? "accessCalendar" : "accessReminders")}</span>
      <span class={`cf-access-state ${state === "yes" ? "on" : ""}`}>{t(state === "yes" ? "accessYes" : "accessNo")}</span>
      {state !== "yes" && <button type="button" class="cf-secondary cf-access-ask" onClick={() => askAccess(kind, state)}>{buttonText(state)}</button>}
    </div>
  )
}

/** Settings' group: each one's status and its «Разрешить» (nothing where there's no app to ask: Chrome, old systems). */
export function AccessGroup(): VNode | null {
  const access = useAppleAccess()
  if (access.calendar === "unavailable" && access.reminders === "unavailable") return null
  return (
    <section class="cf-group cf-access">
      <span class="cf-label">{t("accessGroup")}</span>
      {access.calendar !== "unavailable" && <Row kind="calendar" state={access.calendar} />}
      {access.reminders !== "unavailable" && <Row kind="reminders" state={access.reminders} />}
      <p class="cf-hint">{t("accessHint")}</p>
    </section>
  )
}

/** Under the rule «Только время, свободное в календаре»: what it needs, and the way to give it. */
export function CalendarNeed(): VNode | null {
  const access = useAppleAccess()
  if (access.calendar === "yes" || access.calendar === "unavailable") return null
  return (
    <p class="cf-hint cf-access-need">
      {t("agentRuleCalNeeds")} · <button type="button" class="cf-link" onClick={() => askAccess("calendar", access.calendar)}>{buttonText(access.calendar)}</button>
    </p>
  )
}
