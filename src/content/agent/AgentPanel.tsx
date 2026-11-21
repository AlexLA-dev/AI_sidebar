// The agent in the panel (2.7.1, «Сделать»): the strip while it works (step, Stop), its steps, and what it waits
// for: «Сделать?» (Да / Нет), «Заполнить из «Моих данных»?» (the values only here, each line can be unticked), «Этот шаг —
// ваш» (Готово / Не сейчас). Then the summary, Undo and Close. A blocked site says why in plain words (Amazon: the one
// shared explanation, src/shared/amazon.ts). The strip is the indicator App Review's 2.5.14 asks for.

import type { VNode } from "preact"
import { useState } from "preact/hooks"

import type { Answer, AgentState } from "../../shared/agent/runner"
import { AMAZON_TEXT } from "../../shared/amazon"
import { t, type MessageKey } from "../../shared/i18n"
import * as Icon from "../icons"
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
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((state.pending?.fill ?? []).map((l) => l.entryId)))
  const busy = state.status === "running"
  const waiting = state.status === "confirm" || state.status === "fill" || state.status === "self"
  const finished = !busy && !waiting
  const lines = state.lines.slice(-8)
  return (
    <div class="cf-card cf-agent" role="region" aria-label={t("agentMode")} aria-live="polite">
      {(busy || waiting) && (
        <div class="cf-agent-strip">
          <span class={`cf-agent-dot ${busy ? "on" : ""}`} aria-hidden="true" />
          <span class="cf-agent-step">{t("agentWorking", String(Math.max(1, state.step)))}</span>
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
              <li key={l.entryId}>
                <label class="cf-row toggle">
                  <input
                    type="checkbox"
                    checked={chosen.has(l.entryId)}
                    onChange={(e) => {
                      const next = new Set(chosen)
                      if ((e.target as HTMLInputElement).checked) next.add(l.entryId)
                      else next.delete(l.entryId)
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
          <div class="cf-card-actions">
            {state.canUndo && <button type="button" class="cf-secondary" onClick={onUndo}>{t("agentUndo")}</button>}
            <button type="button" class="cf-secondary" onClick={onClose}>{t("close")}</button>
            <button type="button" class="cf-link" onClick={onHelp}>{t("agentHelpLink")}</button>
          </div>
        </div>
      )}
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

/** «Позже»: at a time, or when this page's watch fires (when it has one). */
export function AgentLaterCard({ hasWatch, onSet, onClose, note }: { hasWatch: boolean; onSet: (when: { at?: number; watch?: boolean }) => void; onClose: () => void; note: string | null }): VNode {
  const [kind, setKind] = useState<"at" | "watch">("at")
  const soon = new Date(Date.now() + 3_600_000)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  const [when, setWhen] = useState(local)
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
          {kind === "at" && <input class="cf-input-line" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />}
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
        <button type="button" class="cf-secondary" onClick={onClose}>{t("close")}</button>
      </div>
    </div>
  )
}
