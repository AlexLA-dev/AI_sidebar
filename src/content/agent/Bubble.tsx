// The agent's bubble by the circle (2.7.1, the owner: «закрыть чат… а когда у агента появлялся запрос — бабл с вопросом
// и 2, максимум 3 короткими ответами, прямо над любой страницей… потом нотификация на кружочке, что задача закончена»).
// With the panel closed, a task's question, a step that waits for the person, or how it ended shows here, on any page
// and any tab: a line or two, at most three short answers, a «×». An answer goes the way the panel's does (the step's
// key, checked in the background); money, cards, codes and sign-ins stay the person's (those steps only offer «Готово»).
// A step the person must read first (a price that changed, «not what you asked», a form to check) only opens the chat.
// It lives in our own shadow root and takes only real taps: a page's script can't press it.

import type { VNode } from "preact"

import * as Icon from "../icons"
import { t } from "../../shared/i18n"
import { isCancelChoice } from "../../shared/agent/taskplan"
import { errorText, isAccess, NO_UNDO, selfText, stepText, type PanelAgent } from "./AgentPanel"

export type BubbleKind = "ask" | "confirm" | "self" | "open" | "end"

export interface BubbleData {
  // The step it's for (the answer names it), or the task's end («end:<id>»).
  key: string
  kind: BubbleKind
  text: string
  // A second, quieter line (a step that can't be undone).
  meta?: string
  options: string[]
  // «Другое…»: the question has more answers than fit, or none to tap (it opens the chat).
  other: boolean
  // How it ended (done, or not finished).
  ok?: boolean
  // The task runs in this tab (else «Перейти к вкладке»).
  here: boolean
}

// What the bubble reads: this tab's task, or another tab's notice (the same fields, kept by the background).
export type BubbleSource = Pick<PanelAgent, "id" | "status" | "summary" | "choices" | "pending" | "error" | "askKey">

/** A finished task's summary as one plain line: no Markdown marks, links as their words. */
export function plainLine(md: string, max = 140): string {
  const s = md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-•]\s*/, "").trim())
    .filter(Boolean)
    .join(" · ")
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

const ENDED = new Set(["done", "error", "blocked"])

/** The bubble a task shows with the panel closed, or null while it just works (or the person stopped it). */
export function bubbleOf(s: BubbleSource, key: string, here: boolean): BubbleData | null {
  const base = { key, here, options: [] as string[], other: false }
  const p = s.pending
  switch (s.status) {
    case "asked": {
      // A contact detail to type, or answers that don't fit: the chat (its field, «Запомнить»).
      const choices = (s.choices ?? []).filter((c) => c && !isCancelChoice(c))
      if (s.askKey || choices.length === 0) return { ...base, kind: "open", text: s.summary ?? "" }
      const fit = choices.length > 3 ? choices.slice(0, 2) : choices
      return { ...base, kind: "ask", text: s.summary ?? "", options: fit, other: choices.length > 3 }
    }
    case "confirm":
      if (!p) return null
      // A warning is read in the chat, never approved from a bubble.
      if (p.offRequest || p.price) return { ...base, kind: "open", text: t("agentBubbleCheck", stepText(s)) }
      return { ...base, kind: "confirm", text: stepText(s), meta: NO_UNDO.has(p.verdict.reason) ? t("agentNoUndo") : undefined }
    case "self":
      if (!p) return null
      // Calendar or Reminders access: the app is opened from the chat's own button.
      if (isAccess(s)) return { ...base, kind: "open", text: selfText(s) }
      return { ...base, kind: "self", text: p.verdict.reason === "auth" || p.verdict.reason === "account" ? t("agentBubbleSignIn") : selfText(s) }
    case "fill":
    case "plan":
      return { ...base, kind: "open", text: t(s.status === "plan" ? "agentBubblePlan" : "agentBubbleFill") }
    default: {
      if (!ENDED.has(s.status)) return null
      const unfinished = s.status !== "done" || s.error === "steps" || s.error === "stuck" || s.error === "unbooked"
      const why = s.status === "done" ? plainLine(s.summary ?? "") : s.status === "blocked" ? t("agentBlockedSite") : errorText(s.error, null)
      return { ...base, key: `end:${s.id}`, kind: "end", ok: !unfinished, text: t(unfinished ? "agentBubbleNotDone" : "agentBubbleDone", why || "—") }
    }
  }
}

export interface BubbleActions {
  reply: (text: string) => void
  yes: () => void
  no: () => void
  did: () => void
  notNow: () => void
  // The chat (here) or the task's tab (elsewhere).
  open: () => void
  close: () => void
}

/** Only a real tap counts: a page's script can't press the bubble's buttons for the person. */
const real = (fn: () => void) => (e: Event) => {
  if (!e.isTrusted) return
  e.stopPropagation()
  fn()
}

/** `low`: the circle is in the screen's lower half, so the bubble ends at its bottom edge (else it starts at its top). */
export function AgentBubble({ data, side, top, low, act }: { data: BubbleData; side: "left" | "right"; top: string; low: boolean; act: BubbleActions }): VNode {
  const open = data.here ? t("agentBubbleOpen") : t("agentGoToTab")
  const buttons: Array<{ label: string; on: () => void; primary?: boolean }> =
    data.kind === "ask"
      ? [...data.options.map((o, i) => ({ label: o, on: () => act.reply(o), primary: i === 0 })), ...(data.other ? [{ label: t("agentBubbleOther"), on: act.open }] : [])]
      : data.kind === "confirm"
        ? [{ label: t("agentYes"), on: act.yes, primary: true }, { label: t("agentNo"), on: act.no }]
        : data.kind === "self"
          ? data.here
            ? [{ label: t("agentSelfDone"), on: act.did, primary: true }, { label: t("agentSelfNotNow"), on: act.notNow }]
            : [{ label: open, on: act.open, primary: true }, { label: t("agentSelfDone"), on: act.did }]
          : data.kind === "end"
            ? [{ label: data.here ? t("agentBubbleShow") : t("agentGoToTab"), on: act.open, primary: true }]
            : [{ label: open, on: act.open, primary: true }]
  const mark = data.kind === "end" ? (data.ok ? "done" : "notdone") : "needs"
  return (
    <div class={`cf-agent-bubble ${side} ${mark} ${low ? "low" : "high"}`} style={{ top }} role="status" aria-live="polite" data-key={data.key}>
      <div class="cf-agent-bubble-head">
        <span class={`cf-agent-bubble-mark ${mark}`} aria-hidden="true" />
        <p dir="auto">{data.text}</p>
        <button type="button" class="cf-ph-x" aria-label={t("close")} title={t("close")} tabIndex={-1} onClick={real(act.close)}><Icon.Close /></button>
      </div>
      {data.meta && <p class="cf-agent-bubble-meta" dir="auto">{data.meta}</p>}
      <div class="cf-agent-bubble-actions">
        {buttons.slice(0, 3).map((b) => (
          <button type="button" key={b.label} tabIndex={-1} class={b.primary ? "cf-primary" : "cf-secondary"} dir="auto" onClick={real(b.on)}>{b.label}</button>
        ))}
      </div>
    </div>
  )
}
