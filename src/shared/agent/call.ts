// The model's one call per step: its JSON shape (a structured output, so it can only answer in it) and the check of
// what it said against the page map. A call that fails the check never reaches the page: the model hears why and
// tries again, or the task stops. There's no tool that runs code: `text` is only ever typed into a field as text.

import type { MapItem, PageMap, Role, ToolCall, ToolName } from "./types.ts"

/** How many of a list's options the map gives (content/agent/map.ts optionsOf): a list of this many was cut. */
export const MAP_OPTIONS = 30

export const TOOLS: ToolName[] = ["read_page", "click", "type", "fill", "select", "scroll", "go", "back", "extract", "ask_user", "done", "set_dates", "reminders", "reminder_add", "reminder_done", "calendar", "event_add"]

/** The tools that work on the person's Calendar and Reminders, not on the page. */
export const APPLE_TOOLS = new Set<ToolName>(["reminders", "reminder_add", "reminder_done", "calendar", "event_add"])

/** The answer's shape: every field present, the ones the tool doesn't use null (strict schemas want them all). */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] })

export const CALL_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", enum: TOOLS },
    id: nullable({ type: "string" }),
    text: nullable({ type: "string" }),
    mode: nullable({ type: "string", enum: ["replace", "append"] }),
    key: nullable({ type: "string" }),
    option: nullable({ type: "string" }),
    to: nullable({ type: "string", enum: ["up", "down"] }),
    part: nullable({ type: "integer" }),
    question: nullable({ type: "string" }),
    summary: nullable({ type: "string" }),
    // Calendar and Reminders: plain (not nullable) — "" and 0 when unused. Strict schemas take only so many union-typed
    // fields, and these eight on top of the ten above were too many (the preview answered UPSTREAM).
    ref: { type: "string" },
    list: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    until: { type: "string" },
    minutes: { type: "integer" },
    days: { type: "integer" },
    place: { type: "string" },
    why: { type: "string" },
    // ask_user: 2–4 short answers to offer as buttons ([] when the question is open).
    choices: { type: "array", items: { type: "string" } },
    also: { type: "array", items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"], additionalProperties: false } }
  },
  required: ["tool", "id", "text", "mode", "key", "option", "to", "part", "question", "summary", "ref", "list", "date", "time", "until", "minutes", "days", "place", "why", "choices", "also"],
  additionalProperties: false
}

/** The same shape without set_dates: on a page where it found no date control it isn't offered again (round 142). */
export const CALL_SCHEMA_NO_DATES = { ...CALL_SCHEMA, properties: { ...CALL_SCHEMA.properties, tool: { type: "string", enum: TOOLS.filter((t) => t !== "set_dates") } } }

const TYPE_ROLES = new Set<Role>(["textbox", "textarea", "editor", "combobox"])
const SELECT_ROLES = new Set<Role>(["select", "listbox", "combobox", "radio"])
const CLICK_ROLES = new Set<Role>(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "summary", "combobox", "listbox", "select", "other", "file", "slider", "textbox"])

export const MAX_TYPE_CHARS = 2000
const MAX_WHY = 200

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined)

export type Checked = { ok: true; call: ToolCall; item: MapItem | null } | { ok: false; error: string }

/** The model's raw answer as a call, checked against the map: the tool exists, the element does, the two fit. */
/** `keys`: the person's saved details by key («Мои данные»), the only ones fill may name. */
export function checkCall(raw: unknown, map: PageMap, keys: string[] = []): Checked {
  if (!raw || typeof raw !== "object") return { ok: false, error: "the answer isn't a call" }
  const r = raw as Record<string, unknown>
  const tool = r.tool as ToolName
  if (!TOOLS.includes(tool)) return { ok: false, error: `no tool "${String(r.tool)}"` }
  const call: ToolCall = { tool, why: str(r.why, MAX_WHY) ?? "" }
  const id = str(r.id, 20)
  const item = id ? map.items.find((i) => i.id === id) ?? null : null
  const needsItem = tool === "click" || tool === "type" || tool === "fill" || tool === "select" || tool === "go"
  if (needsItem) {
    if (!id) return { ok: false, error: `${tool} needs an id` }
    if (!item) return { ok: false, error: `no element ${id} on the page now (read the map again)` }
    call.id = id
  }
  switch (tool) {
    case "click": {
      if (!CLICK_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) can't be clicked` }
      if (item!.state?.includes("disabled")) return { ok: false, error: `element ${id} is disabled` }
      slotOf(call, r)
      // Up to 3 more presses on this page, after the first (a service, «any» specialist, a date): the device presses each
      // only if it's still there and it's a free step; anything else waits for its own call.
      const also = (Array.isArray(r.also) ? r.also : []).flatMap((x) => {
        const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>
        const aid = str(o.id, 20)
        const it = aid ? map.items.find((i) => i.id === aid) : null
        return aid && aid !== id && it && CLICK_ROLES.has(it.role) && !it.state?.includes("disabled") ? [{ id: aid, why: str(o.why, MAX_WHY) ?? "" }] : []
      }).slice(0, 3)
      if (also.length) call.also = also
      break
    }
    case "type": {
      if (!TYPE_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) isn't a field` }
      if (item!.state?.includes("readonly") || item!.state?.includes("disabled")) return { ok: false, error: `field ${id} can't be typed into` }
      const text = typeof r.text === "string" ? r.text.slice(0, MAX_TYPE_CHARS) : ""
      // Nothing to type into a field that's empty already (Haiku sent an empty phone: the check then stopped the task
      // with a question). Emptying a filled field is still a call.
      const empty = item!.state?.includes("empty") || (item!.lock !== "personal" && !item!.value)
      if (!text && empty) return { ok: false, error: `type needs the text to put into field ${id} (it is empty already)` }
      call.text = text
      call.mode = r.mode === "append" ? "append" : "replace"
      break
    }
    case "fill": {
      if (!TYPE_ROLES.has(item!.role) && !SELECT_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) isn't a field` }
      const key = str(r.key, 80)
      if (!key || !keys.includes(key)) return { ok: false, error: `no saved detail "${String(r.key ?? "")}" (the saved ones: ${keys.join(", ") || "none"})` }
      call.key = key
      break
    }
    case "select":
      if (!SELECT_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) isn't a list` }
      call.option = str(r.option, 200)
      if (!call.option) return { ok: false, error: "select needs an option" }
      // (The map gives a list's first 30 options only: a list of exactly 30 was cut, and its option may be beyond them —
      // the hands find it in the page's whole list, or say there's none. Round 142's Tiqets country list, decision 15f.)
      if (item!.options?.length && item!.options.length < MAP_OPTIONS && !item!.options.some((o) => sameOption(o, call.option!))) {
        return { ok: false, error: `list ${id} has no option "${call.option}"` }
      }
      slotOf(call, r)
      break
    case "go":
      if (item!.role !== "link") return { ok: false, error: `element ${id} isn't a link` }
      break
    case "scroll":
      if (id) {
        if (!item) return { ok: false, error: `no element ${id}` }
        call.id = id
      } else call.to = r.to === "up" ? "up" : "down"
      break
    case "read_page":
      // (With the outline, a part is one of its §n: 2 … sections + 1.)
      call.part = typeof r.part === "number" && r.part >= 1 && r.part <= Math.max(1, map.outline ? (map.sections ?? 0) + 1 : map.parts) ? Math.floor(r.part) : 1
      break
    case "extract":
      if (id && item) call.id = id
      break
    case "ask_user": {
      call.question = str(r.question, 600)
      if (!call.question) return { ok: false, error: "ask_user needs a question" }
      const choices = (Array.isArray(r.choices) ? r.choices : []).map((c) => str(c, 80)).filter((c): c is string => !!c)
      if (choices.length) call.choices = [...new Set(choices)].slice(0, 4)
      break
    }
    case "done":
      call.summary = str(r.summary, 6000) ?? ""
      // A booking made: what, when and where (the device puts it in the Calendar).
      slotOf(call, r)
      if (call.date && call.time) {
        const place = str(r.place, 200)
        if (place) call.place = place
      }
      break
    case "set_dates":
      // (A day the model names: kept only as YYYY-MM-DD; the device sets it only inside the request's window.)
      if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) call.date = r.date
      break
    case "reminders":
      call.text = str(r.text, 200)
      call.list = str(r.list, 120)
      break
    case "reminder_add": {
      call.text = str(r.text, 200)
      if (!call.text) return { ok: false, error: "reminder_add needs the reminder's text" }
      call.list = str(r.list, 120)
      const when = dayAndTime(r)
      if (typeof when === "string") return { ok: false, error: when }
      Object.assign(call, when)
      break
    }
    case "reminder_done":
      call.ref = str(r.ref, 200)
      if (!call.ref) return { ok: false, error: "reminder_done needs a ref from «reminders»" }
      call.text = str(r.text, 200)
      break
    case "calendar": {
      const when = dayAndTime(r)
      if (typeof when === "string") return { ok: false, error: when }
      if (!when.date) return { ok: false, error: "calendar needs a date" }
      Object.assign(call, when)
      const until = str(r.until, 5)
      if (until && !TIME.test(until)) return { ok: false, error: "until is HH:MM" }
      if (until) call.until = until
      call.minutes = whole(r.minutes, 5, 720, 60)
      call.days = whole(r.days, 1, 14, 1)
      break
    }
    case "event_add": {
      call.text = str(r.text, 200)
      if (!call.text) return { ok: false, error: "event_add needs the event's title" }
      const when = dayAndTime(r)
      if (typeof when === "string") return { ok: false, error: when }
      if (!when.date || !when.time) return { ok: false, error: "event_add needs a date and a time" }
      Object.assign(call, when)
      call.minutes = whole(r.minutes, 5, 24 * 60, 60)
      call.place = str(r.place, 200)
      break
    }
  }
  return { ok: true, call, item }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A call's day and time ("2026-12-05", "19:30"), checked; a time needs a day. */
function dayAndTime(r: Record<string, unknown>): { date?: string; time?: string } | string {
  const date = str(r.date, 10)
  const time = str(r.time, 5)
  if (date && !DATE.test(date)) return "date is YYYY-MM-DD"
  if (time && !TIME.test(time)) return "time is HH:MM"
  if (time && !date) return "a time needs a date"
  return { ...(date ? { date } : {}), ...(time ? { time } : {}) }
}

function whole(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.round(v))) : fallback
}

/** An option as the person or the model names it: the same words, any case and spacing, or the start of it. */
export function sameOption(option: string, wanted: string): boolean {
  const a = option.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  const b = wanted.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  return !!b && (a === b || a.startsWith(b) || (b.length >= 3 && a.includes(b)))
}

/** A time slot pressed in a booking, or a booking made: its date and time as the model gave them, when they are a real
 *  date ("YYYY-MM-DD") and a time ("HH:MM"); the device checks them against the person's Calendar. */
function slotOf(call: ToolCall, r: Record<string, unknown>): void {
  const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : ""
  const time = typeof r.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : ""
  if (date && time) {
    call.date = date
    call.time = time
  }
}
