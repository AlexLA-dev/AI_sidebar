// The agent's Calendar and Reminders (2.7.1): the runner's `device` and `apple` (runner.ts), done by the native side
// (AgentApple.swift) and said back to the model in a few plain lines. What goes to the model is only what these lines
// carry: list names and counts, the reminders the task's words or list found (title, list, due date), free times or
// busy/free. Never an event's title, never a reminder's notes.

import { TARGET } from "../shared/config"
import type { StepResult, ToolCall } from "../shared/agent/types"
import { callNative } from "./native"

type Access = "yes" | "none" | "denied" | "unavailable"

function access(v: unknown): Access {
  return v === "yes" || v === "none" || v === "denied" ? v : "unavailable"
}

export async function appleDevice(): Promise<{ reminders: Access; calendar: Access }> {
  if (TARGET !== "safari") return { reminders: "unavailable", calendar: "unavailable" }
  const r = await callNative<Record<string, unknown>>("agent_apple", { op: "status" }, 4000)
  return { reminders: access(r?.reminders), calendar: access(r?.calendar) }
}

interface Found {
  access?: string
  lists?: Array<{ name: string; open: number }>
  items?: Array<{ ref: string; title: string; list: string; due?: string }>
  defaultList?: string
  noList?: string
  more?: number
  free?: boolean | Array<{ from: string; until: string }>
  exact?: boolean
  busy?: number
  from?: string
  until?: string
  outcome?: string
  list?: string
  title?: string
  calendar?: string
  error?: string
}

const q = (s: string) => `«${s.replace(/[«»\n]/g, " ").slice(0, 200)}»`

/** One call, on the device. */
export async function appleCall(call: ToolCall): Promise<StepResult> {
  if (TARGET !== "safari") return { ok: false, note: "Calendar and Reminders aren't there in this browser" }
  const op: Record<string, unknown> = { op: call.tool }
  if (call.tool === "reminders") Object.assign(op, { query: call.text ?? "", list: call.list ?? "" })
  if (call.tool === "reminder_add") Object.assign(op, { title: call.text ?? "", list: call.list ?? "", date: call.date ?? "", time: call.time ?? "" })
  if (call.tool === "reminder_done") Object.assign(op, { ref: call.ref ?? "" })
  if (call.tool === "calendar") Object.assign(op, { date: call.date ?? "", time: call.time ?? "", until: call.until ?? "", minutes: call.minutes ?? 60, days: call.days ?? 1 })
  if (call.tool === "event_add") Object.assign(op, { title: call.text ?? "", date: call.date ?? "", time: call.time ?? "", minutes: call.minutes ?? 60, place: call.place ?? "" })
  const r = await callNative<Found>("agent_apple", op, 15_000)
  if (!r) return { ok: false, note: "the device didn't answer" }
  if (r.access && r.access !== "yes") return { ok: false, note: r.access === "denied" ? "access is turned off in Settings → ContextFlow" : "no access yet" }
  switch (call.tool) {
    case "reminders": {
      const lines = [`Reminder lists: ${(r.lists ?? []).map((l) => `${q(l.name)} (${l.open} open)`).join(", ") || "none"}.`]
      if (r.defaultList) lines.push(`New reminders go to ${q(r.defaultList)} unless a list is named.`)
      if (r.noList) lines.push(`No list is called ${q(r.noList)}.`)
      if (call.text || call.list) {
        const items = r.items ?? []
        lines.push(items.length ? `Open reminders found (${items.length}${r.more ? `, ${r.more} more not shown` : ""}):` : "No open reminders found for that.")
        for (const i of items) lines.push(`- ref=${i.ref} ${q(i.title)} in ${q(i.list)}${i.due ? `, due ${i.due}` : ""}`)
      }
      return { ok: true, note: "read the person's reminders (below)", data: `From the person's Reminders on their device:\n${lines.join("\n")}` }
    }
    case "calendar": {
      if (r.error) return { ok: false, note: "that date isn't one" }
      if (r.exact) return { ok: true, note: r.free === true ? `${r.from}–${r.until} is free in the person's calendar` : `${r.from}–${r.until} is busy in the person's calendar (${r.busy} event${r.busy === 1 ? "" : "s"})` }
      const slots = Array.isArray(r.free) ? r.free : []
      return {
        ok: true,
        note: slots.length ? `free times of ${call.minutes ?? 60} minutes or more: ${slots.map((s) => `${s.from}–${s.until.slice(11)}`).join("; ")}` : "no free time of that length then"
      }
    }
    case "reminder_add":
      if (r.outcome === "exists") return { ok: true, note: `it's already there, open, in ${q(r.list ?? "")} (not added again)` }
      return r.outcome === "saved" ? { ok: true, note: `added to ${q(r.list ?? "")}` } : { ok: false, note: "it couldn't be added" }
    case "reminder_done":
      return r.outcome === "saved" ? { ok: true, note: "marked done" } : { ok: false, note: r.outcome === "missing" ? "that reminder isn't there any more" : "it couldn't be marked done" }
    case "event_add":
      return r.outcome === "saved" ? { ok: true, note: `added to the calendar ${q(r.calendar ?? "")}` } : { ok: false, note: "it couldn't be added" }
  }
  return { ok: false, note: "not a Calendar or Reminders tool" }
}

/** A deferred task's reminder too («Также в Напоминания»): due, no alert of its own (the task's notification rings). */
/** «Также в Напоминания»: `title` is the task's short name and site (never the person's request). */
export async function deferredReminder(id: string, title: string, at: number, url: string): Promise<boolean> {
  if (TARGET !== "safari") return false
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, "0")
  const r = await callNative<Found>("agent_apple", {
    op: "reminder_add", key: `cf.agent.${id}`, noAlarm: true, title: title.slice(0, 200),
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}`, notes: url
  }, 10_000)
  return r?.outcome === "saved" || r?.outcome === "exists"
}

/** The deferred task started (done) or was cancelled: its reminder is marked done or taken away. */
export function deferredReminderEnd(id: string, done: boolean): void {
  if (TARGET === "safari") void callNative("apple_remove", { key: `cf.agent.${id}`, done })
}
