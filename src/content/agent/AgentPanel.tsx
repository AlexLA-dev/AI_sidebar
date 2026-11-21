// The agent in the panel (2.7.1, «Сделать»): the strip while it works (step, Stop), its steps, and what it waits
// for: «Сделать?» (Да / Нет), «Заполнить из «Моих данных»?» (the values only here, each line can be unticked), «Этот шаг —
// ваш» (Готово / Не сейчас). Then the summary, Undo and Close. A blocked site says why in plain words (Amazon: the one
// shared explanation, src/shared/amazon.ts). The strip is the indicator App Review's 2.5.14 asks for.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import type { Answer, AgentState } from "../../shared/agent/runner"
import { AMAZON_TEXT } from "../../shared/amazon"
import { t, type MessageKey } from "../../shared/i18n"
import * as Icon from "../icons"
import { showIn } from "../Consent"
import { Markdown } from "../markdown"

export type PanelAgent = Omit<AgentState, "log" | "data"> & { canUndo: boolean }

interface Props {
  state: PanelAgent
  onAnswer: (a: Answer, chosen?: string[]) => void
  onUndo: () => void
  onClose: () => void
  onHelp: () => void
}

/** The control's name out of the server's "button \"Add to cart\"". */
function nameOf(target: string | null | undefined): string {
  const m = /"(.*)"$/.exec(target ?? "")
  return (m ? m[1] : target ?? "").slice(0, 80)
}

function stepText(state: PanelAgent): string {
  const p = state.pending
  if (!p) return ""
  const name = nameOf(p.target)
  switch (p.call.tool) {
    case "type": return t("agentStepType", (p.call.text ?? "").slice(0, 80), name)
    case "select": return t("agentStepSelect", p.call.option ?? "", name)
    case "go": return p.verdict.reason === "other_site" ? t("agentStepGo", name) : t("agentStepClick", name)
    default: return t("agentStepClick", name)
  }
}

function selfText(state: PanelAgent): string {
  const p = state.pending
  const name = nameOf(p?.target)
  switch (p?.verdict.reason) {
    case "pay": return t("agentSelfPay", name)
    case "send": case "post": return t("agentSelfSend", name)
    case "auth": return t("agentSelfAuth")
    case "consent": case "cookies_accept": return t("agentSelfConsent", name)
    case "rate": return t("agentSelfRate")
    case "file": return t("agentSelfFile")
    default: return t("agentSelfOther", name)
  }
}

// What can't be put back after it's done: a form sent, a cart changed, another site opened.
const NO_UNDO = new Set(["submit", "other_site", "decline", "unknown", "first_here", "off_request"])

function errorText(code: string | undefined, left: number | null | undefined): string {
  switch (code) {
    case "AGENT_LIMIT": return t("agentLimit", String(left ?? ""))
    case "PRO_ONLY": return t("agentProOnly")
    case "page": return t("agentErrorPage")
    case "steps": return t("agentSteps")
    default: return t("agentError")
  }
}

export function AgentPanel({ state, onAnswer, onUndo, onClose, onHelp }: Props): VNode {
  const [undone, setUndone] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((state.pending?.fill ?? []).map((l) => `${l.id}:${l.entryId}`)))
  const busy = state.status === "running"
  const waiting = state.status === "confirm" || state.status === "fill" || state.status === "self"
  const finished = !busy && !waiting
  const lines = state.lines.slice(-8)
  // The card stays in view as the task goes on: its newest line, its question, its result.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) showIn(ref.current)
  }, [state.status, state.lines.length])
  return (
    <div ref={ref} class="cf-card cf-agent" role="region" aria-label={t("agentMode")} aria-live="polite">
      {(busy || waiting) && (
        <div class={`cf-agent-strip ${busy ? "" : "waiting"}`}>
          <span class={`cf-agent-dot ${busy ? "on" : ""}`} aria-hidden="true" />
          {/* Waiting for the person: the card below says what for; the strip keeps only Stop. */}
          <span class="cf-agent-step">{busy ? t("agentWorking", String(Math.max(1, state.step))) : ""}</span>
          <button type="button" class="cf-secondary cf-agent-stop" onClick={() => onAnswer("stop")}><Icon.Stop /> {t("stop")}</button>
        </div>
      )}
      <p class="cf-agent-request" dir="auto">{state.request}</p>
      {lines.length > 0 && (
        <ol class="cf-agent-lines">
          {lines.map((l, i) => (
            <li key={i} class={l.ok ? "ok" : "no"} dir="auto">
              <span class="cf-agent-mark" aria-hidden="true">{l.ok ? "✓" : "·"}</span> {l.text || nameOf(l.target)}
            </li>
          ))}
        </ol>
      )}

      {state.status === "confirm" && state.pending && (
        <div class="cf-agent-ask">
          <strong>{t("agentConfirmTitle")}</strong>
          <p dir="auto">{stepText(state)}</p>
          {state.pending.offRequest && <p class="cf-agent-warn" dir="auto"><Icon.Alert /> {t("agentOffRequest", state.pending.offRequest)}</p>}
          {NO_UNDO.has(state.pending.verdict.reason) && <p class="cf-hint">{t("agentNoUndo")}</p>}
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" onClick={() => onAnswer("yes")}>{t("agentYes")}</button>
            <button type="button" class="cf-secondary" onClick={() => onAnswer("no")}>{t("agentNo")}</button>
          </div>
        </div>
      )}

      {state.status === "fill" && state.pending?.fill && (
        <div class="cf-agent-ask">
          <strong>{t("agentFillTitle")}</strong>
          <ul class="cf-agent-fill">
            {state.pending.fill.map((l) => (
              <li key={`${l.id}:${l.entryId}`}>
                <label class="cf-row toggle">
                  <input
                    type="checkbox"
                    checked={chosen.has(`${l.id}:${l.entryId}`)}
                    onChange={(e) => {
                      const next = new Set(chosen)
                      if ((e.target as HTMLInputElement).checked) next.add(`${l.id}:${l.entryId}`)
                      else next.delete(`${l.id}:${l.entryId}`)
                      setChosen(next)
                    }}
                  />
                  <span dir="auto">{l.label} ← <b>{l.value}</b></span>
                </label>
              </li>
            ))}
          </ul>
          {state.pending.offRequest && <p class="cf-agent-warn" dir="auto"><Icon.Alert /> {t("agentOffRequest", state.pending.offRequest)}</p>}
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" disabled={chosen.size === 0} onClick={() => onAnswer("yes", [...chosen])}>{t("agentFillButton")}</button>
            <button type="button" class="cf-secondary" onClick={() => onAnswer("no")}>{t("agentFillSkip")}</button>
          </div>
        </div>
      )}

      {state.status === "self" && state.pending && (
        <div class="cf-agent-ask">
          <strong>{t("agentSelfTitle")}</strong>
          <p dir="auto">{selfText(state)}</p>
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" onClick={() => onAnswer("did")}>{t("agentSelfDone")}</button>
            <button type="button" class="cf-secondary" onClick={() => onAnswer("notnow")}>{t("agentSelfNotNow")}</button>
          </div>
        </div>
      )}

      {finished && (
        <div class="cf-agent-end">
          {state.status === "done" && (
            <>
              <strong>{t("agentDoneTitle")}</strong>
              {state.error === "steps" && <p>{t("agentSteps")}</p>}
              {state.summary ? <Markdown text={state.summary} /> : null}
            </>
          )}
          {state.status === "asked" && (
            <>
              <strong>{t("agentAskedTitle")}</strong>
              <p dir="auto">{state.summary}</p>
            </>
          )}
          {state.status === "stopped" && <p>{t("agentStopped")}</p>}
          {state.status === "blocked" && <p>{t(state.error === "site_amazon" ? (AMAZON_TEXT.agent as MessageKey) : "agentBlockedSite")}</p>}
          {state.status === "error" && <p>{errorText(state.error, state.left)}</p>}
          {/* Typed values go back; a press (a size chosen, a box ticked) stays as it is: the line says so plainly. */}
          {undone && !state.canUndo && <p class="cf-hint">{t("agentUndone")}</p>}
          <div class="cf-card-actions">
            {state.canUndo && <button type="button" class="cf-secondary" onClick={() => { setUndone(true); onUndo() }}>{t("agentUndo")}</button>}
            <button type="button" class="cf-secondary" onClick={onClose}>{t("close")}</button>
            <button type="button" class="cf-link" onClick={onHelp}>{t("agentHelpLink")}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The panel stepped aside while a step runs (the sheet): the strip at the bottom, its last step, and Stop. When the
 *  agent needs the person about one control («Сделать?», or a step that is theirs: a box to tick, a sign-in) it stays
 *  aside too: the panel would cover the control (on a short page it can't be scrolled above the panel). The strip then
 *  asks, with the control ringed in view. */
export function AgentStrip({ state, onOpen, onStop, onAnswer }: { state: PanelAgent; onOpen: () => void; onStop: () => void; onAnswer?: (a: Answer) => void }): VNode {
  const last = state.lines[state.lines.length - 1]
  const p = state.pending
  if ((state.status === "self" || state.status === "confirm") && p && onAnswer) {
    const self = state.status === "self"
    return (
      <div class="cf-agent-float ask" role="region" aria-label={t(self ? "agentSelfTitle" : "agentConfirmTitle")} aria-live="polite">
        <button type="button" class="cf-agent-float-main" onClick={onOpen}>
          <span class="cf-agent-float-text">
            <b>{t(self ? "agentSelfTitle" : "agentConfirmTitle")}</b>
            <span class="wrap" dir="auto">{self ? selfText(state) : stepText(state)}</span>
            {!self && p.offRequest && <span class="wrap cf-agent-warn" dir="auto">{t("agentOffRequest", p.offRequest)}</span>}
            {!self && NO_UNDO.has(p.verdict.reason) && <span class="wrap">{t("agentNoUndo")}</span>}
          </span>
        </button>
        <div class="cf-agent-float-actions">
          <button type="button" class="cf-primary" onClick={() => onAnswer(self ? "did" : "yes")}>{t(self ? "agentSelfDone" : "agentYes")}</button>
          <button type="button" class="cf-secondary" onClick={() => onAnswer(self ? "notnow" : "no")}>{t(self ? "agentSelfNotNow" : "agentNo")}</button>
        </div>
      </div>
    )
  }
  return (
    <div class="cf-agent-float" role="status" aria-live="polite">
      <button type="button" class="cf-agent-float-main" onClick={onOpen}>
        <span class="cf-agent-dot on" aria-hidden="true" />
        <span class="cf-agent-float-text">
          <b>{t("agentWorking", String(Math.max(1, state.step)))}</b>
          {last?.text && <span dir="auto">{last.text}</span>}
        </span>
      </button>
      <button type="button" class="cf-secondary cf-agent-stop" onClick={onStop}><Icon.Stop /> {t("stop")}</button>
    </div>
  )
}

/** A deferred task the notification brought: «Начать», and «На этом сайте начинать сразу». */
export function AgentDeferredCard({ request, autoHere, onStart, onCancel, onAuto }: { request: string; autoHere: boolean; onStart: () => void; onCancel: () => void; onAuto: (on: boolean) => void }): VNode {
  return (
    <div class="cf-card cf-agent" role="region" aria-label={t("agentDeferredTitle")}>
      <strong>{t("agentDeferredTitle")}</strong>
      <p class="cf-agent-request" dir="auto">{request}</p>
      <label class="cf-row toggle">
        <input type="checkbox" checked={autoHere} onChange={(e) => onAuto((e.target as HTMLInputElement).checked)} />
        <span>{t("agentDontAskHere")}</span>
      </label>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onStart}>{t("agentStart")}</button>
        <button type="button" class="cf-secondary" onClick={onCancel}>{t("cancel")}</button>
      </div>
    </div>
  )
}

/** A datetime-local value: the local date and time, to the minute. */
function localMinute(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** «Позже»: at a time, or when this page's watch fires (when it has one). */
export function AgentLaterCard({ hasWatch, onSet, onClose, note, onAsk, past }: { hasWatch: boolean; onSet: (when: { at?: number; watch?: boolean }) => void; onClose: () => void; note: string | null; onAsk?: () => void; past?: boolean }): VNode {
  const [kind, setKind] = useState<"at" | "watch">("at")
  const [when, setWhen] = useState(() => localMinute(new Date(Date.now() + 3_600_000)))
  return (
    <div class="cf-card cf-agent" role="region" aria-label={t("agentLater")}>
      <strong>{t("agentLater")}</strong>
      {note ? (
        <p dir="auto">{note}</p>
      ) : (
        <>
          <label class="cf-row toggle">
            <input type="radio" name="cf-agent-later" checked={kind === "at"} onChange={() => setKind("at")} />
            <span>{t("agentLaterAt")}</span>
          </label>
          {kind === "at" && <input class="cf-input-line" type="datetime-local" value={when} min={localMinute(new Date())} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />}
          {kind === "at" && past && <p class="cf-agent-warn" dir="auto">{t("agentLaterPast")}</p>}
          {hasWatch && (
            <label class="cf-row toggle">
              <input type="radio" name="cf-agent-later" checked={kind === "watch"} onChange={() => setKind("watch")} />
              <span>{t("agentLaterWatch")}</span>
            </label>
          )}
        </>
      )}
      <div class="cf-card-actions">
        {!note && (
          <button type="button" class="cf-primary" onClick={() => onSet(kind === "watch" ? { watch: true } : { at: new Date(when).getTime() })}>{t("agentLaterSet")}</button>
        )}
        {/* Notifications never asked for: the system's question on a tap, then the task is set. */}
        {note && onAsk && <button type="button" class="cf-primary" onClick={onAsk}>{t("listenNotifyOn")}</button>}
        <button type="button" class="cf-secondary" onClick={onClose}>{t(note && onAsk ? "listenNotifyLater" : "close")}</button>
      </div>
    </div>
  )
}
