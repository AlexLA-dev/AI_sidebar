// The agent in the panel (2.7.1, «Сделать»): the strip while it works (step, Stop), its steps, and what it waits
// for: «Сделать?» (Да / Нет), «Заполнить из «Моих данных»?» (the values only here, each line can be unticked), «Этот шаг —
// ваш» (Готово / Не сейчас). Then the summary, Undo and Close. A blocked site says why in plain words (Amazon: the one
// shared explanation, src/shared/amazon.ts). The strip is the indicator App Review's 2.5.14 asks for.

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import type { Answer, AgentState, PlanApproval } from "../../shared/agent/runner"
import { factLabel, isCancelChoice, savedAnswers, type Perm, type PlanSelf, type TaskPlan } from "../../shared/agent/taskplan"
import { AMAZON_TEXT } from "../../shared/amazon"
import { TEST_PLAN } from "../../shared/config"
import type { FormKey } from "../../shared/agent/formdata"
import { t, type MessageKey } from "../../shared/i18n"
import { askAccess } from "./AppleAccess"
import { keyName } from "./MyDetails"
import * as Icon from "../icons"
import { showIn } from "../Consent"
import { followLink } from "../page"
import { Markdown } from "../markdown"

export type PanelAgent = Omit<AgentState, "log" | "data"> & { canUndo: boolean }

/** «Позже» from the plan card: when, and «Также в Напоминания». */
export interface LaterChoice {
  when: { at?: number; watch?: boolean }
  also: boolean
}

interface Props {
  state: PanelAgent
  onAnswer: (a: Answer, chosen?: string[]) => void
  // The plan card's «Начать» (now), or «Позже» with its time.
  onPlan?: (approval: PlanApproval, later?: LaterChoice) => void
  // What «Позже» can offer here: this page's watch, a reminder too.
  later?: { hasWatch: boolean; canAlso: boolean; past?: boolean }
  // An earlier task of this tab, kept in the chat folded (no Undo; Close takes it out of the chat).
  past?: boolean
  // «Начать» didn't reach the agent: what failed, on the plan card (it can be pressed again).
  planFailed?: string | null
  // The person's saved facts by name (factKey → value), for the plan's questions about them; and keeping new answers.
  saved?: Record<string, string>
  onRemember?: (facts: Array<{ fact: string; value: string; key?: FormKey }>) => void
  onUndo: () => void
  onClose: () => void
  onHelp: () => void
}

/** The control's name out of the server's "button \"Add to cart\"". */
function nameOf(target: string | null | undefined): string {
  const m = /"(.*)"$/.exec(target ?? "")
  return (m ? m[1] : target ?? "").slice(0, 80)
}

/** A day and time as the person reads them ("Sat, 5 Dec, 19:30"), in the panel's language. */
function when(date?: string, time?: string): string {
  if (!date) return ""
  const [y, m, d] = date.split("-").map(Number)
  const [h, min] = (time ?? "").split(":").map(Number)
  const at = new Date(y, m - 1, d, time ? h : 12, time ? min : 0)
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(at)
  } catch {
    return `${date}${time ? ` ${time}` : ""}`
  }
}

function stepText(state: PanelAgent): string {
  const p = state.pending
  if (!p) return ""
  const name = nameOf(p.target)
  const c = p.call
  switch (c.tool) {
    case "reminder_add": {
      if (!c.list) return c.date ? t("agentStepReminderAddDefaultDue", c.text ?? "", when(c.date, c.time)) : t("agentStepReminderAddDefault", c.text ?? "")
      return c.date ? t("agentStepReminderAddDue", c.text ?? "", c.list, when(c.date, c.time)) : t("agentStepReminderAdd", c.text ?? "", c.list)
    }
    case "reminder_done": return t("agentStepReminderDone", c.text ?? "")
    case "event_add": return t("agentStepEventAdd", c.text ?? "", `${when(c.date, c.time)}${c.place ? `, ${c.place}` : ""}`)
  }
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
    case "access_reminders": return t("agentSelfAccessReminders")
    case "access_calendar": return t("agentSelfAccessCalendar")
    default: return t("agentSelfOther", name)
  }
}

/** The app asks for Calendar or Reminders (the extension can't): iPhone and iPad follow its link in the tap itself, a Mac
 *  has the extension open it. */
function openAppFor(state: PanelAgent): void {
  const kind = state.pending?.verdict.reason === "access_calendar" ? "calendar" : "reminders"
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
  if (touch) followLink(`contextflow://access?kind=${kind}`)
  else {
    try {
      chrome.runtime.sendMessage({ type: "agentAccessOpen", kind }, () => void chrome.runtime.lastError)
    } catch {
      // the panel stays; the person can open the app themselves
    }
  }
}

const isAccess = (state: PanelAgent) => !!state.pending?.verdict.reason.startsWith("access_")

// What can't be put back after it's done: a form sent, a cart changed, another site opened.
// (Not "off_request": that's about the request, not the step; a box it would tick can be unticked.)
const NO_UNDO = new Set(["submit", "other_site", "decline", "unknown", "first_here"])

function errorText(code: string | undefined, left: number | null | undefined, limit?: number): string {
  switch (code) {
    case "AGENT_LIMIT": return t("agentLimit", String(limit ?? left ?? ""))
    case "PRO_ONLY": return t("agentProOnly")
    case "page": return t("agentErrorPage")
    case "steps": return t("agentSteps")
    default: return t("agentError")
  }
}

/** A permission as the plan card says it. */
function permText(p: Perm, host: string): string {
  switch (p.kind) {
    case "press": return t("agentStepClick", p.label)
    case "personal": return t("agentPermPersonal", p.label)
    case "fill": return t("agentPermFill", p.label || (p.keys ?? []).map((k) => keyName({ key: k as FormKey, label: "" })).join(", "))
    case "consent": return t("agentPermConsent", host)
    default:
      return p.reason === "event_add" ? t("agentPermEvent", p.label) : p.reason === "reminder_done" ? t("agentPermReminderDone", p.label) : t("agentPermReminder", p.label)
  }
}

/** A line of the plan: the model's words, or, for a step the person does, theirs («Купить сейчас» — нажмёте вы). */
function planStepText(plan: TaskPlan, i: number, line: string): VNode | string {
  const own = plan.self.find((x) => x.step === i)
  if (!own) return line
  return <><span class="cf-agent-you">{t("agentYouMark")}</span> {t("agentPlanStepYours", own.label)}</>
}

/** A step the person will do, as the plan card lists it. */
function selfLine(x: PlanSelf): string {
  switch (x.reason) {
    case "pay": return t("agentPlanSelfPay", x.label)
    case "send": case "post": return t("agentPlanSelfSend", x.label)
    case "auth": case "account": return t("agentPlanSelfAuth")
    default: return x.label
  }
}

const CAL_ASK_KEY = "agentCalAskDone"

/** «Учитывать календарь? · Разрешить ×»: once per install, until allowed or dismissed. */
function CalendarAsk({ state }: { state: "none" | "denied" }): VNode | null {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    try {
      chrome.storage.local.get(CAL_ASK_KEY, (r) => setShown(!r?.[CAL_ASK_KEY]))
    } catch {
      setShown(true)
    }
  }, [])
  const done = () => {
    setShown(false)
    try {
      void chrome.storage.local.set({ [CAL_ASK_KEY]: true })
    } catch {
      // shown again next time
    }
  }
  if (!shown) return null
  return (
    <p class="cf-agent-meta cf-access-need" dir="auto">
      {t("agentPlanCalAsk")} · <button type="button" class="cf-link" onClick={() => { askAccess("calendar", state); done() }}>{t(state === "denied" ? (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "accessSettingsIos" : "accessSettingsMac") : "accessAllow")}</button>
      <button type="button" class="cf-icon-btn cf-access-x" aria-label={t("close")} onClick={done}>×</button>
    </p>
  )
}

/** The task's plan (2.7.1): what it will do, its questions (options and «Своё»), what may go without a question (each
 *  can be unticked), what the person does themselves, «Сейчас / Позже», and one «Начать». */
function PlanCard({ plan, host, onPlan, later, onStop, failed, saved, onRemember }: { plan: TaskPlan; host: string; onPlan: (a: PlanApproval, later?: LaterChoice) => void; later?: Props["later"]; onStop: () => void; failed?: string | null; saved?: Record<string, string>; onRemember?: (facts: Array<{ fact: string; value: string }>) => void }): VNode {
  // Questions about the person come pre-filled from «Мои данные» (the owner on 117: «не спрашивать снова»); a value not
  // among the options shows as the person's own words, to change if they like.
  const pre = savedAnswers(plan, saved ?? {})
  const [answers, setAnswers] = useState<string[]>(() => pre)
  const [own, setOwn] = useState<boolean[]>(() => plan.questions.map((q, i) => !!pre[i] && !q.options.includes(pre[i])))
  // «Запомнить» under each question about the person: on by default.
  const [keep, setKeep] = useState<boolean[]>(() => plan.questions.map((q) => !!q.fact))
  const [off, setOff] = useState<Set<string>>(() => new Set())
  const [mode, setMode] = useState<"now" | "later">("now")
  const [laterChoice, setLaterChoice] = useState<LaterChoice | null>(null)
  const answered = answers.every((a) => a.trim())
  const approval = (): PlanApproval => ({ answers, off: [...off] })
  // «Начать» is never a silent no-op (TestFlight 117: a pale, disabled «Start» under an unanswered question looked like a
  // button that did nothing): pressed early, it says which question is left, and that question is marked.
  const [missing, setMissing] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const start = () => {
    const left = answers.findIndex((a) => !a.trim())
    if (left >= 0) {
      setMissing(left)
      return
    }
    if (mode === "later" && !laterChoice) return
    setMissing(null)
    setSending(true)
    // What to keep in «Мои данные»: the answers about the person that are new or changed.
    // A choice on this site («pref:Мастер») is kept under the site's name, for this site only.
    const facts = plan.questions.flatMap((q, i) => {
      const label = q.fact ? factLabel(q.fact, plan.site) : ""
      return label && keep[i] && answers[i].trim() && answers[i].trim() !== pre[i] ? [{ fact: label, value: answers[i].trim() }] : []
    })
    if (facts.length) onRemember?.(facts)
    onPlan(approval(), mode === "later" && laterChoice ? laterChoice : undefined)
  }
  const set = (i: number, v: string, isOwn: boolean) => {
    setAnswers(answers.map((a, j) => (j === i ? v : a)))
    setOwn(own.map((o, j) => (j === i ? isOwn : o)))
    if (missing === i && v.trim()) setMissing(null)
  }
  return (
    <div class="cf-agent-plan">
      <strong>{t("agentPlanTitle")}</strong>
      {plan.steps.length > 0 && (
        <ol class="cf-agent-plan-steps">
          {plan.steps.map((l, i) => <li key={i} dir="auto">{planStepText(plan, i, l)}</li>)}
        </ol>
      )}
      {/* A booking: how it will choose, so «Начать» is all it takes (the director on 120). */}
      {plan.how && (plan.how.rating > 0 || plan.how.calendar) && (
        <p class="cf-agent-meta" dir="auto">
          {[plan.how.rating ? t("agentPlanHow", plan.how.rating.toLocaleString()) : "", plan.how.calendar ? t("agentPlanHowCal") : ""].filter(Boolean).join(" · ")}
        </p>
      )}
      {/* The calendar rule without access to the Calendar: asked here once per install, never skipped silently. */}
      {plan.how?.ask && <CalendarAsk state={plan.how.ask} />}
      {/* What the request's «во втором», «в тот ресторан» were taken to mean, from the chat it was started in. */}
      {plan.fromChat && <p class="cf-agent-meta" dir="auto">{t("agentPlanFromChat", plan.fromChat)}</p>}
      {plan.questions.map((q, i) => (
        <div class={`cf-agent-q ${missing === i ? "missing" : ""}`} key={i}>
          <p dir="auto">{q.q}</p>
          <div class="cf-agent-options" role="radiogroup" aria-label={q.q}>
            {q.options.map((o) => (
              <button type="button" key={o} role="radio" aria-checked={!own[i] && answers[i] === o} class={`cf-chip ${!own[i] && answers[i] === o ? "on" : ""}`} dir="auto" onClick={() => set(i, o, false)}>{o}</button>
            ))}
            <button type="button" role="radio" aria-checked={own[i]} class={`cf-chip ${own[i] ? "on" : ""}`} onClick={() => set(i, own[i] ? answers[i] : "", true)}>{t("agentPlanOwn")}</button>
          </div>
          {q.fact && factLabel(q.fact, plan.site) && (
            <label class="cf-row toggle cf-agent-remember">
              <input type="checkbox" checked={keep[i]} onChange={(e) => setKeep(keep.map((k, j) => (j === i ? (e.target as HTMLInputElement).checked : k)))} />
              <span>{pre[i] ? t("agentPlanFromSaved") : t("agentPlanRemember")}</span>
            </label>
          )}
          {own[i] && (
            <input
              class="cf-input-line"
              dir="auto"
              value={answers[i]}
              aria-label={q.q}
              ref={(el) => {
                if (el && !answers[i]) el.focus({ preventScroll: true })
              }}
              onInput={(e) => set(i, (e.target as HTMLInputElement).value, true)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
          )}
        </div>
      ))}
      {plan.perms.length > 0 && (
        <>
          <p class="cf-agent-plan-h">{t("agentPlanAllowed")}</p>
          <ul class="cf-agent-fill">
            {plan.perms.map((p) => (
              <li key={p.id}>
                <label class="cf-row toggle">
                  <input type="checkbox" checked={!off.has(p.id)} onChange={(e) => {
                    const next = new Set(off)
                    if ((e.target as HTMLInputElement).checked) next.delete(p.id)
                    else next.add(p.id)
                    setOff(next)
                  }} />
                  <span dir="auto">{permText(p, host)}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.self.length > 0 && (
        <>
          <p class="cf-agent-plan-h">{t("agentPlanSelf")}</p>
          <ul class="cf-agent-plan-self">
            {plan.self.map((x, i) => <li key={i} dir="auto"><span class="cf-agent-you">{t("agentYouMark")}</span> {selfLine(x)}</li>)}
          </ul>
        </>
      )}
      <div class="cf-seg cf-agent-when" role="radiogroup" aria-label={t("agentLater")}>
        <button type="button" role="radio" aria-checked={mode === "now"} class={mode === "now" ? "on" : ""} onClick={() => setMode("now")}>{t("agentPlanNow")}</button>
        <button type="button" role="radio" aria-checked={mode === "later"} class={mode === "later" ? "on" : ""} onClick={() => setMode("later")}>{t("agentLater")}</button>
      </div>
      {mode === "later" && <LaterFields hasWatch={!!later?.hasWatch} canAlso={!!later?.canAlso} past={!!later?.past} onChange={setLaterChoice} />}
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" disabled={sending} onClick={start}>
          {mode === "later" ? t("agentLaterSet") : t("agentStart")}
        </button>
        <button type="button" class="cf-secondary" onClick={onStop}>{t("cancel")}</button>
      </div>
      {missing !== null && plan.questions[missing] && <p class="cf-agent-warn" role="alert" dir="auto">{t("agentPlanAnswerFirst", plan.questions[missing].q)}</p>}
      {failed && <p class="cf-agent-warn" role="alert" dir="auto">{failed}</p>}
    </div>
  )
}

// Steps that only read: a task made only of them answered a question, and its answer shows under the folded line.
const READS = new Set(["read_page", "scroll", "extract", "back", "go", "reminders", "calendar"])

/** A finished task's mark on its folded line: done, waiting for an answer, stopped, or didn't work. */
function markOf(status: PanelAgent["status"], error?: string): { sign: string; text: string; cls: string } {
  // Stopped short (the step limit, no progress): not ✓ (TestFlight 118).
  if (status === "done" && (error === "steps" || error === "stuck" || error === "unbooked")) return { sign: "…", text: t("agentMarkUnfinished"), cls: "stop" }
  switch (status) {
    case "done": return { sign: "✓", text: t("agentDoneTitle"), cls: "ok" }
    case "asked": return { sign: "⏸", text: t("agentMarkPaused"), cls: "wait" }
    case "stopped": return { sign: "■", text: t("agentMarkStopped"), cls: "stop" }
    default: return { sign: "!", text: t("agentMarkFailed"), cls: "fail" }
  }
}

export function AgentPanel({ state, onAnswer, onUndo, onClose, onHelp, onPlan, later, past, planFailed, saved, onRemember }: Props): VNode {
  // A finished task folds to one line (2.7.1, the owner: «свёрнутыми по дефолту в одну строку… с возможностью
  // развернуть»); a tap opens its steps and its result.
  // A task that just failed or was refused stays open with its reason (121 sweep: a bare «!» line hid «tasks used up»).
  const [open, setOpen] = useState(() => !past && (state.status === "error" || state.status === "blocked"))
  useEffect(() => {
    if (!past && (state.status === "error" || state.status === "blocked")) setOpen(true)
  }, [state.status, past])
  const [undone, setUndone] = useState(false)
  // One answer per question: the buttons go quiet on the first tap (the background also refuses a second).
  const [sent, setSent] = useState(false)
  const reply = (a: Answer, chosen?: string[]) => {
    if (sent) return
    setSent(true)
    onAnswer(a, chosen)
  }
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((state.pending?.fill ?? []).map((l) => `${l.id}:${l.entryId}`)))
  const busy = state.status === "running"
  const planning = state.status === "plan"
  const waiting = state.status === "confirm" || state.status === "fill" || state.status === "self" || state.status === "asked"
  const finished = !busy && !waiting && !planning
  // The agent's question: the offered answers as buttons, or the person's own words.
  const [replyText, setReplyText] = useState("")
  // A contact detail «Мои данные» hasn't got: the typed answer may be kept there (on, like the plan card's «Запомнить»).
  const [keep, setKeep] = useState(true)
  const own = (text: string) => {
    if (keep && state.askKey) onRemember?.([{ fact: "", value: text, key: state.askKey as FormKey }])
    reply("reply", [text])
  }
  // The model's «Отмена» among its choices: the card has its own Cancel (the owner on 118: one, not two).
  const choices = (state.choices ?? []).filter((c) => !isCancelChoice(c))
  // A line with nothing to say (no words from the model, no control) isn't shown: it read as a stray «·».
  // While it works, the newest few; a finished task opened from its line shows every step that ran (the director: the
  // cookie step was missing from an opened booking).
  const shown = state.lines.filter((l) => l.text || l.target)
  const lines = finished ? shown : shown.slice(-8)
  // The card stays in view as the task goes on: its newest line, its question, its result.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current && !past) showIn(ref.current)
  }, [state.status, state.lines.length])
  if (finished && !open) {
    const mark = markOf(state.status, state.error)
    const answerOnly = state.status === "done" && !past && !!state.summary && state.lines.every((l) => READS.has(l.tool))
    return (
      <div ref={ref} class="cf-card cf-agent folded" role="region" aria-label={t("agentMode")}>
        <button type="button" class="cf-agent-row" aria-expanded={false} title={t("agentShowSteps")} onClick={() => setOpen(true)}>
          <span class={`cf-agent-row-mark ${mark.cls}`} aria-label={mark.text} title={mark.text}>{mark.sign}</span>
          <span class="cf-agent-row-text" dir="auto">{state.request}</span>
          <span class="cf-agent-row-more" aria-hidden="true">›</span>
        </button>
        {answerOnly && <div class="cf-agent-row-answer"><Markdown text={state.summary ?? ""} /></div>}
      </div>
    )
  }
  return (
    <div ref={ref} class="cf-card cf-agent" role="region" aria-label={t("agentMode")} aria-live="polite">
      {finished && (
        <button type="button" class="cf-agent-row" aria-expanded={true} onClick={() => setOpen(false)}>
          <span class={`cf-agent-row-mark ${markOf(state.status, state.error).cls}`} aria-label={markOf(state.status, state.error).text}>{markOf(state.status, state.error).sign}</span>
          <span class="cf-agent-row-text open" dir="auto">{state.request}</span>
          <span class="cf-agent-row-more open" aria-hidden="true">›</span>
        </button>
      )}
      {(busy || waiting) && (
        <div class={`cf-agent-strip ${busy ? "" : "waiting"}`}>
          <span class={`cf-agent-dot ${busy ? "on" : ""}`} aria-hidden="true" />
          {/* The step it's at: working on it (with the step's own line, as the strip under the page shows), or waiting for
              the person (the card below says what for). */}
          <span class="cf-agent-step">
            <b>{busy ? (state.step === 0 ? t("agentPlanReading") : t("agentWorking", String(Math.max(1, state.step)))) : t("agentWaitingStep", String(Math.max(1, state.step)))}</b>
            {busy && lines.length > 0 && lines[lines.length - 1].text && <span dir="auto">{lines[lines.length - 1].text}</span>}
          </span>
          <button type="button" class="cf-secondary cf-agent-stop" onClick={() => onAnswer("stop")}><Icon.Stop /> {t("stop")}</button>
        </div>
      )}
      {!finished && <p class="cf-agent-request" dir="auto">{state.request}</p>}
      {/* Started without the card: what it took as known (2.7.1: «Бронирую… · Стоп»; Stop is on the strip). */}
      {busy && state.plan?.auto && <p class="cf-agent-meta" dir="auto">{t("agentAutoLine", (state.plan.answers ?? []).map((a) => a.a).filter(Boolean).join(" · ") || "—")}</p>}
      {planning && state.plan && onPlan && <PlanCard key={`${state.id}-${planFailed ?? ""}-${Object.keys(saved ?? {}).length}`} plan={state.plan} host={hostName(state.url)} onPlan={onPlan} later={later} onStop={() => onAnswer("stop")} failed={planFailed} saved={saved} onRemember={onRemember} />}
      {/* The plan's lines while it works by it (what it said it would do). */}
      {(busy || waiting) && state.plan?.approved && state.plan.steps.length > 0 && lines.length === 0 && (
        <ol class="cf-agent-plan-steps">{state.plan.steps.map((l, i) => <li key={i} dir="auto">{planStepText(state.plan!, i, l)}</li>)}</ol>
      )}
      {lines.length > 0 && (
        <ol class="cf-agent-lines">
          {lines.map((l, i) => (
            // Test builds: when each step ran, from the task's start (the background-tab probe), on hover only (the owner
            // on 118: one type scale, no «+80s» in the log).
            <li key={i} class={l.ok ? "ok" : "no"} dir="auto" title={TEST_PLAN && l.at ? `+${Math.round((l.at - state.startedAt) / 1000)}s` : undefined}>
              {/* The person's own step (ticked a box, signed in) is theirs, never the agent's ✓. */}
              {/* (A box the plan let the agent tick is the agent's step.) */}
              {l.cls === "self" && !l.byPlan
                ? <span class="cf-agent-you">{t("agentYouMark")}</span>
                : <span class="cf-agent-mark" aria-hidden="true">{l.ok ? "✓" : "·"}</span>} {l.tool === "event_add" && l.ok ? t("agentLineCalendar", l.text) : l.text || nameOf(l.target)}
            </li>
          ))}
        </ol>
      )}

      {state.status === "confirm" && state.pending && (
        <div class="cf-agent-ask">
          <strong>{t("agentConfirmTitle")}</strong>
          <p dir="auto">{stepText(state)}</p>
          {state.pending.offRequest && <p class="cf-agent-warn" dir="auto"><Icon.Alert /> {t("agentOffRequest", state.pending.offRequest)}</p>}
          {state.pending.price && <p class="cf-agent-warn" dir="auto"><Icon.Alert /> {t("agentPriceChanged", state.pending.price)}</p>}
          {NO_UNDO.has(state.pending.verdict.reason) && <p class="cf-agent-meta">{t("agentNoUndo")}</p>}
          <div class="cf-card-actions">
            <button type="button" class="cf-primary" disabled={sent} onClick={() => reply("yes")}>{t("agentYes")}</button>
            <button type="button" class="cf-secondary" disabled={sent} onClick={() => reply("no")}>{t("agentNo")}</button>
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
            <button type="button" class="cf-primary" disabled={sent || chosen.size === 0} onClick={() => reply("yes", [...chosen])}>{t("agentFillButton")}</button>
            <button type="button" class="cf-secondary" disabled={sent} onClick={() => reply("no")}>{t("agentFillSkip")}</button>
          </div>
        </div>
      )}

      {state.status === "asked" && (
        <div class="cf-agent-ask">
          <strong>{t("agentAskedTitle")}</strong>
          <p dir="auto">{state.summary}</p>
          {choices.length > 0 && (
            <div class="cf-agent-options">
              {choices.map((c) => <button type="button" key={c} class="cf-chip" dir="auto" disabled={sent} onClick={() => reply("reply", [c])}>{c}</button>)}
            </div>
          )}
          <div class="cf-agent-reply">
            <input class="cf-input-line" dir="auto" value={replyText} placeholder={t("agentPlanOwn")} onInput={(e) => setReplyText((e.target as HTMLInputElement).value)} onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter" && replyText.trim()) own(replyText.trim())
            }} onKeyUp={(e) => e.stopPropagation()} />
            <button type="button" class="cf-primary" disabled={sent || !replyText.trim()} onClick={() => own(replyText.trim())}>{t("send")}</button>
            <button type="button" class="cf-secondary" onClick={() => onAnswer("stop")}>{t("cancel")}</button>
          </div>
          {state.askKey && (
            <label class="cf-row toggle cf-agent-remember">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} />
              <span>{t("agentPlanRemember")}</span>
            </label>
          )}
        </div>
      )}

      {state.status === "self" && state.pending && (
        <div class="cf-agent-ask">
          <strong>{t("agentSelfTitle")}</strong>
          <p dir="auto">{selfText(state)}</p>
          <div class="cf-card-actions">
            {isAccess(state) && <button type="button" class="cf-primary" onClick={() => openAppFor(state)}>{t("agentOpenApp")}</button>}
            <button type="button" class={isAccess(state) ? "cf-secondary" : "cf-primary"} disabled={sent} onClick={() => reply("did")}>{t("agentSelfDone")}</button>
            <button type="button" class="cf-secondary" disabled={sent} onClick={() => reply("notnow")}>{t("agentSelfNotNow")}</button>
          </div>
        </div>
      )}

      {finished && (
        <div class="cf-agent-end">
          {state.status === "done" && (
            <>
              <strong>{t(state.error === "steps" || state.error === "stuck" || state.error === "unbooked" ? "agentMarkUnfinished" : "agentDoneTitle")}</strong>
              {(state.error === "steps" || state.error === "stuck") && <p>{t(state.error === "stuck" ? "agentStuck" : "agentSteps")}</p>}
              {state.summary ? <Markdown text={state.summary} /> : null}
              {state.calSkipped && <p class="cf-agent-meta">{t("agentCalNotChecked")}</p>}
            </>
          )}

          {state.status === "stopped" && <p>{t("agentStopped")}</p>}
          {state.status === "blocked" && <p>{t(state.error === "site_amazon" ? (AMAZON_TEXT.agent as MessageKey) : "agentBlockedSite")}</p>}
          {state.status === "error" && <p>{errorText(state.error, state.left, state.limit)}</p>}
          {/* Typed values go back; a press (a size chosen, a box ticked) stays as it is: the line says so plainly. */}
          {undone && !state.canUndo && <p class="cf-agent-meta">{t("agentUndone")}</p>}
          <div class="cf-card-actions">
            {state.canUndo && !past && <button type="button" class="cf-secondary" onClick={() => { setUndone(true); onUndo() }}>{t("agentUndo")}</button>}
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
  // One answer per question (the strip's buttons too), reset when the question changes.
  const [sentFor, setSentFor] = useState("")
  const key = `${state.status}:${state.step}`
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
            {!self && p.price && <span class="wrap cf-agent-warn" dir="auto">{t("agentPriceChanged", p.price)}</span>}
            {!self && NO_UNDO.has(p.verdict.reason) && <span class="wrap cf-agent-meta">{t("agentNoUndo")}</span>}
          </span>
        </button>
        <div class="cf-agent-float-actions">
          {self && isAccess(state) && <button type="button" class="cf-primary" onClick={() => openAppFor(state)}>{t("agentOpenApp")}</button>}
          <button type="button" class={self && isAccess(state) ? "cf-secondary" : "cf-primary"} disabled={sentFor === key} onClick={() => { setSentFor(key); onAnswer(self ? "did" : "yes") }}>{t(self ? "agentSelfDone" : "agentYes")}</button>
          <button type="button" class="cf-secondary" disabled={sentFor === key} onClick={() => { setSentFor(key); onAnswer(self ? "notnow" : "no") }}>{t(self ? "agentSelfNotNow" : "agentNo")}</button>
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

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** «Позже»'s choices (the plan card's, and the card's of its own): at a time, or when this page's watch fires. */
function LaterFields({ hasWatch, canAlso, past, onChange }: { hasWatch: boolean; canAlso: boolean; past: boolean; onChange: (c: LaterChoice | null) => void }): VNode {
  const [kind, setKind] = useState<"at" | "watch">("at")
  // «Также в Напоминания» (2.7.1): the task in Apple Reminders too, due then, without a second alert.
  const [also, setAlso] = useState(false)
  const [when, setWhen] = useState(() => localMinute(new Date(Date.now() + 3_600_000)))
  useEffect(() => {
    const at = new Date(when).getTime()
    onChange(kind === "watch" ? { when: { watch: true }, also: false } : Number.isFinite(at) ? { when: { at }, also } : null)
  }, [kind, also, when])
  return (
    <>
      <label class="cf-row toggle">
        <input type="radio" name="cf-agent-later" checked={kind === "at"} onChange={() => setKind("at")} />
        <span>{t("agentLaterAt")}</span>
      </label>
      {kind === "at" && <input class="cf-input-line" type="datetime-local" value={when} min={localMinute(new Date())} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />}
      {kind === "at" && past && <p class="cf-agent-warn" dir="auto">{t("agentLaterPast")}</p>}
      {kind === "at" && canAlso && (
        <label class="cf-row toggle">
          <input type="checkbox" checked={also} onChange={(e) => setAlso((e.target as HTMLInputElement).checked)} />
          <span>{t("appleAlso")}</span>
        </label>
      )}
      {hasWatch && (
        <label class="cf-row toggle">
          <input type="radio" name="cf-agent-later" checked={kind === "watch"} onChange={() => setKind("watch")} />
          <span>{t("agentLaterWatch")}</span>
        </label>
      )}
    </>
  )
}

/** «Позже»'s own card: what came of it (set, or notifications to allow), and the choices again for a time already past. */
export function AgentLaterCard({ hasWatch, onSet, onClose, note, onAsk, past, canAlso }: { hasWatch: boolean; onSet: (when: { at?: number; watch?: boolean }, also: boolean) => void; onClose: () => void; note: string | null; onAsk?: () => void; past?: boolean; canAlso?: boolean }): VNode {
  const [choice, setChoice] = useState<LaterChoice | null>(null)
  return (
    <div class="cf-card cf-agent" role="region" aria-label={t("agentLater")}>
      <strong>{t("agentLater")}</strong>
      {note ? <p dir="auto">{note}</p> : <LaterFields hasWatch={hasWatch} canAlso={!!canAlso} past={!!past} onChange={setChoice} />}
      <div class="cf-card-actions">
        {!note && <button type="button" class="cf-primary" disabled={!choice} onClick={() => choice && onSet(choice.when, choice.also)}>{t("agentLaterSet")}</button>}
        {/* Notifications never asked for: the system's question on a tap, then the task is set. */}
        {note && onAsk && <button type="button" class="cf-primary" onClick={onAsk}>{t("listenNotifyOn")}</button>}
        <button type="button" class="cf-secondary" onClick={onClose}>{t(note && onAsk ? "listenNotifyLater" : "close")}</button>
      </div>
    </div>
  )
}

/** Another tab's task by the ✦ circle (2.7.1): done, or waiting for the person there; «Перейти к вкладке» brings it. */
export function AgentNoticeCard({ notice, side, top, onGo, onClose }: { notice: { request: string; status: PanelAgent["status"]; summary: string }; side: "left" | "right"; top: string; onGo: () => void; onClose: () => void }): VNode {
  const waiting = notice.status === "plan" || notice.status === "confirm" || notice.status === "fill" || notice.status === "self" || notice.status === "asked"
  const mark = waiting ? { sign: "•", text: t("agentNoticeNeeds"), cls: "wait" } : markOf(notice.status)
  return (
    <div class={`cf-agent-notice ${side}`} style={{ top }} role="status" aria-live="polite">
      <div class="cf-agent-notice-head">
        <span class={`cf-agent-row-mark ${mark.cls}`} aria-hidden="true">{mark.sign}</span>
        <b>{mark.text}</b>
        <button type="button" class="cf-ph-x" aria-label={t("close")} title={t("close")} onClick={onClose}><Icon.Close /></button>
      </div>
      <p class="cf-agent-notice-req" dir="auto">{notice.request}</p>
      {!waiting && notice.summary && <p class="cf-agent-notice-sum" dir="auto">{notice.summary}</p>}
      <button type="button" class="cf-primary" onClick={onGo}>{t("agentGoToTab")}</button>
    </div>
  )
}
