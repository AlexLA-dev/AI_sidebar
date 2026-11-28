// The agent's usage events (2.7.1, the owner's «да» on 2026-11-24; names and values in src/shared/usage.ts, feature
// "agent"). One task's start and end, tied by its random id. Kinds and counts only: never a site, a name, a time, the
// request or anything typed.

import type { AgentState } from "./runner.ts"
import { rulesValue } from "../usage.ts"
import type { PageMap } from "./types.ts"
import type { Subject } from "./subject.ts"

export interface AgentUse {
  f: "agent"
  a: "start" | "end" | "accepted" | "rejected" | "question" | "result"
  [field: string]: string | number
}

/** What the task does, by its plan: a booking's kind, a cart, a form to fill, or other. */
export function taskWhat(state: Pick<AgentState, "plan">): string {
  const p = state.plan
  const b = p?.booking
  if (b) return b.kind === "table" ? "book_table" : b.kind === "stay" || b.kind === "rental" ? "book_stay" : b.kind === "appointment" || b.kind === "slot" ? "book_visit" : "other"
  if (p?.perms.some((x) => x.kind === "press" && x.reason === "cart")) return "cart"
  if (p?.perms.some((x) => x.kind === "personal" || x.kind === "fill")) return "form"
  return "other"
}

/** The start page's kind, as the device reads it (never its address). */
export function pageKind(map: PageMap, subject: Subject | null, booking?: { kind: string }): string {
  if (subject?.kind === "product") return "product"
  if (booking && (booking.kind === "stay" || booking.kind === "rental")) return "stay"
  if (booking?.kind === "ticket") return "event"
  if (map.forms.some((f) => f.fillable)) return "form"
  return "other"
}

const ERRORS = new Set(["steps", "stuck", "page", "unbooked", "blocked"])

/** How a task ended: done, stopped by the person, failed (not finished, an error), or left at a question. */
function endOf(s: AgentState): { result: string; err?: string } {
  if (s.status === "stopped") return { result: "stopped" }
  if (s.status === "asked") return { result: "asked" }
  if (s.status === "done" && !s.error) return { result: "done" }
  const err = s.status === "blocked" ? "blocked" : s.error && ERRORS.has(s.error) ? s.error : /UPSTREAM|BUSY/.test(s.error ?? "") ? "upstream" : "other"
  return { result: "failed", err }
}

const ENDED = new Set(["done", "stopped", "error", "blocked"])

/**
 * The events a state change brings, once each (marked on the state, which is saved with them): the start when the
 * task leaves its plan card (or starts without one), the end when it ends. A task cancelled at its card has neither.
 */
export function agentEvents(s: AgentState, now = Date.now()): AgentUse[] {
  const out: AgentUse[] = []
  const ev = (s.ev ??= {})
  const started = s.status !== "plan" && (!s.plan || s.plan.approved === true)
  if (!ev.start && started) {
    ev.start = true
    out.push({ f: "agent", a: "start", task: s.id, what: taskWhat(s), page: s.pageKind ?? "other", card: s.plan && !s.plan.auto ? "shown" : "skipped" })
  }
  if (ev.start && !ev.end && ENDED.has(s.status)) {
    ev.end = true
    const end = endOf(s)
    out.push({
      f: "agent", a: "end", task: s.id, what: taskWhat(s), result: end.result, ...(end.err ? { err: end.err } : {}),
      steps: Math.min(9999, s.step), calls: Math.min(9999, s.step + (s.plan ? 1 : 0)), secs: Math.min(9999, Math.max(0, Math.round((now - s.startedAt) / 1000))),
      recap: s.recapShown ? "yes" : "no",
      // Which of the device's rules refused or held steps, and how often (codes and counts, never what was refused).
      ...(rulesValue(s.ruleCounts) ? { rules: rulesValue(s.ruleCounts) } : {})
    })
  }
  return out
}
