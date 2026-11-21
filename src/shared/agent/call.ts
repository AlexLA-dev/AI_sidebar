// The model's one call per step: its JSON shape (a structured output, so it can only answer in it) and the check of
// what it said against the page map. A call that fails the check never reaches the page: the model hears why and
// tries again, or the task stops. There's no tool that runs code: `text` is only ever typed into a field as text.

import type { MapItem, PageMap, Role, ToolCall, ToolName } from "./types.ts"

export const TOOLS: ToolName[] = ["read_page", "click", "type", "select", "scroll", "go", "back", "extract", "ask_user", "done"]

/** The answer's shape: every field present, the ones the tool doesn't use null (strict schemas want them all). */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] })

export const CALL_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", enum: TOOLS },
    id: nullable({ type: "string" }),
    text: nullable({ type: "string" }),
    mode: nullable({ type: "string", enum: ["replace", "append"] }),
    option: nullable({ type: "string" }),
    to: nullable({ type: "string", enum: ["up", "down"] }),
    part: nullable({ type: "integer" }),
    question: nullable({ type: "string" }),
    summary: nullable({ type: "string" }),
    why: { type: "string" }
  },
  required: ["tool", "id", "text", "mode", "option", "to", "part", "question", "summary", "why"],
  additionalProperties: false
}

const TYPE_ROLES = new Set<Role>(["textbox", "textarea", "editor", "combobox"])
const SELECT_ROLES = new Set<Role>(["select", "listbox", "combobox", "radio"])
const CLICK_ROLES = new Set<Role>(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "summary", "combobox", "listbox", "select", "other", "file", "slider", "textbox"])

export const MAX_TYPE_CHARS = 2000
const MAX_WHY = 200

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined)

export type Checked = { ok: true; call: ToolCall; item: MapItem | null } | { ok: false; error: string }

/** The model's raw answer as a call, checked against the map: the tool exists, the element does, the two fit. */
export function checkCall(raw: unknown, map: PageMap): Checked {
  if (!raw || typeof raw !== "object") return { ok: false, error: "the answer isn't a call" }
  const r = raw as Record<string, unknown>
  const tool = r.tool as ToolName
  if (!TOOLS.includes(tool)) return { ok: false, error: `no tool "${String(r.tool)}"` }
  const call: ToolCall = { tool, why: str(r.why, MAX_WHY) ?? "" }
  const id = str(r.id, 20)
  const item = id ? map.items.find((i) => i.id === id) ?? null : null
  const needsItem = tool === "click" || tool === "type" || tool === "select" || tool === "go"
  if (needsItem) {
    if (!id) return { ok: false, error: `${tool} needs an id` }
    if (!item) return { ok: false, error: `no element ${id} on the page now (read the map again)` }
    call.id = id
  }
  switch (tool) {
    case "click":
      if (!CLICK_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) can't be clicked` }
      if (item!.state?.includes("disabled")) return { ok: false, error: `element ${id} is disabled` }
      break
    case "type": {
      if (!TYPE_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) isn't a field` }
      if (item!.state?.includes("readonly") || item!.state?.includes("disabled")) return { ok: false, error: `field ${id} can't be typed into` }
      const text = typeof r.text === "string" ? r.text.slice(0, MAX_TYPE_CHARS) : ""
      call.text = text
      call.mode = r.mode === "append" ? "append" : "replace"
      break
    }
    case "select":
      if (!SELECT_ROLES.has(item!.role)) return { ok: false, error: `element ${id} (${item!.role}) isn't a list` }
      call.option = str(r.option, 200)
      if (!call.option) return { ok: false, error: "select needs an option" }
      if (item!.options?.length && !item!.options.some((o) => sameOption(o, call.option!))) {
        return { ok: false, error: `list ${id} has no option "${call.option}"` }
      }
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
      call.part = typeof r.part === "number" && r.part >= 1 && r.part <= Math.max(1, map.parts) ? Math.floor(r.part) : 1
      break
    case "extract":
      if (id && item) call.id = id
      break
    case "ask_user":
      call.question = str(r.question, 600)
      if (!call.question) return { ok: false, error: "ask_user needs a question" }
      break
    case "done":
      call.summary = str(r.summary, 6000) ?? ""
      break
  }
  return { ok: true, call, item }
}

/** An option as the person or the model names it: the same words, any case and spacing, or the start of it. */
export function sameOption(option: string, wanted: string): boolean {
  const a = option.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  const b = wanted.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  return !!b && (a === b || a.startsWith(b) || (b.length >= 3 && a.includes(b)))
}
