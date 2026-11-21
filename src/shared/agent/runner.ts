// The agent's task (2.7.1), step by step: ask /api/v2/act, then do the step, wait for the person, or finish. Plain
// logic with its tab, server and storage passed in (the background gives the real ones, the tests fakes), and every
// stop of it kept in the state, so a background Safari wakes up again (about 30 s idle) and a page that navigates go on.
// - free: done at once; «Сделать?» (confirm): waits for Да / Нет; fill: waits for «Заполнить» with the values the
//   person sees (the model and the server never do); the person's own (self): waits for «Готово» or «Не сейчас»;
//   blocked: told back to the model; a blocked site ends the task with its own explanation.
// - Re-checked here before the hands act: a step's class from the server is never trusted to be milder than the
//   device's own check says (classify.ts runs again on the device's map).

import { classify } from "./classify.ts"
import { liveEntries, modelKey, shapeValue, type FormEntry } from "./formdata.ts"
import { hostOf, sameSite, type SitePolicy } from "./sites.ts"
import type { LogEntry, MapItem, PageMap, StepClass, StepResult, StepVerdict, ToolCall } from "./types.ts"

export type AgentStatus = "running" | "confirm" | "fill" | "self" | "done" | "asked" | "stopped" | "error" | "blocked"

export interface FillLine {
  entryId: string
  label: string
  value: string
}

export interface AgentLine {
  // What the step did, in the person's words (the model's "why"), and what came of it.
  text: string
  tool: ToolCall["tool"]
  cls: StepClass
  ok: boolean
  target?: string
}

export interface AgentState {
  id: string
  request: string
  lang: string
  url: string
  startHost: string
  step: number
  token: string | null
  confirmedHere: boolean
  strongUsed: number
  status: AgentStatus
  log: LogEntry[]
  lines: AgentLine[]
  pending?: { call: ToolCall; verdict: StepVerdict; target: string | null; offRequest?: string; fill?: FillLine[] }
  summary?: string
  error?: string
  // What «Отменить» puts back, newest last.
  undo: NonNullable<StepResult["undo"]>[]
  left?: number | null
  data?: string
  refused?: string
  // The deferred task it came from, when it did.
  deferred?: string
  startedAt: number
}

export interface ActReply {
  ok?: boolean
  code?: string
  call?: ToolCall
  verdict?: StepVerdict
  target?: string | null
  offRequest?: string
  token?: string
  left?: number
  strong?: boolean
}

export interface RunnerIO {
  // The page's map now (null: the page is changing; the runner waits and asks again).
  map(): Promise<PageMap | null>
  // Does a step on the page (null: the page went away mid-step, as a link does).
  act(call: ToolCall): Promise<StepResult | null>
  // Waits for the tab's page to finish loading.
  waitPage(): Promise<void>
  ask(body: Record<string, unknown>): Promise<ActReply>
  save(state: AgentState): Promise<void>
  entries(): Promise<FormEntry[]>
  policy: SitePolicy
  maxSteps: number
}

export function newState(id: string, request: string, lang: string, url: string, deferred?: string): AgentState {
  return {
    id, request, lang, url, startHost: hostOf(url), step: 0, token: null, confirmedHere: false, strongUsed: 0, status: "running",
    log: [], lines: [], undo: [], startedAt: Date.now(), ...(deferred ? { deferred } : {})
  }
}

const STRICT: Record<StepClass, number> = { free: 0, confirm: 1, self: 2, blocked: 3 }

/** The stricter of the server's class and the device's own (the device never acts on a milder one than it sees). */
export function stricter(server: StepVerdict, device: StepVerdict): StepVerdict {
  return STRICT[device.cls] > STRICT[server.cls] ? device : server
}

function line(call: ToolCall, verdict: StepVerdict, target: string | null, ok: boolean, why?: string): AgentLine {
  return { text: why ?? call.why ?? "", tool: call.tool, cls: verdict.cls, ok, ...(target ? { target } : {}) }
}

function noteOf(r: StepResult | null): string {
  if (!r) return "the page went on"
  if (!r.ok) return `failed: ${r.note ?? "it didn't work"}`
  return r.data ? "read the page (below, as extracted)" : r.note ?? "done"
}

/** The values a fill would put in, as the person sees them on the card: the entry for the key, shaped for the field. */
export function fillLines(call: ToolCall, item: MapItem | null, entries: FormEntry[], lang: string): FillLine[] {
  const entry = liveEntries(entries).find((e) => modelKey(e) === call.key)
  if (!entry || !item) return []
  const value = shapeValue(entry, { type: item.type, auto: item.auto, lang, options: item.options, label: item.label })
  return value === null ? [] : [{ entryId: entry.id, label: item.label || entry.label || entry.key, value }]
}

/** Does a step on the page and writes it down. A fill types its value in; the log keeps only the key. */
async function perform(state: AgentState, io: RunnerIO, call: ToolCall, verdict: StepVerdict, target: string | null, value?: string): Promise<void> {
  const doing: ToolCall = call.tool === "fill" ? { ...call, text: value ?? "" } : call
  let result = await io.act(doing)
  if (!result || result.navigated) {
    await io.waitPage()
    result = result ?? { ok: true, navigated: true, note: "the page went on" }
  }
  if (result.undo) state.undo.push(result.undo)
  if (result.data) state.data = result.data
  // A fill's log line has its key, never its value (the log goes to the server with the next step).
  const logged: ToolCall = call.tool === "fill" ? { tool: "fill", id: call.id, key: call.key, why: call.why } : call
  state.log.push({ call: logged, target: target ?? undefined, result: noteOf(result) })
  state.lines.push(line(call, verdict, target, result.ok))
}

/** Runs the task until it needs the person, ends, or fails. Saves the state at every stop. */
export async function drive(state: AgentState, io: RunnerIO): Promise<AgentState> {
  while (state.status === "running") {
    if (state.step >= io.maxSteps) {
      state.status = "done"
      state.summary = state.summary ?? ""
      state.error = "steps"
      break
    }
    let map = await io.map()
    if (!map) {
      await io.waitPage()
      map = await io.map()
    }
    if (!map) {
      state.status = "error"
      state.error = "page"
      break
    }
    const entries = await io.entries().catch(() => [] as FormEntry[])
    const keys = [...new Set(liveEntries(entries).map(modelKey))]
    const reply = await io.ask({
      task: { id: state.id, request: state.request, lang: state.lang, startHost: state.startHost, step: state.step, confirmedHere: state.confirmedHere, token: state.token, strongUsed: state.strongUsed },
      map, log: state.log, ...(state.refused ? { refused: state.refused } : {}), ...(state.data ? { data: state.data } : {}), keys
    })
    state.refused = undefined
    state.data = undefined
    if (!reply.ok || !reply.call || !reply.verdict) {
      state.status = "error"
      state.error = reply.code ?? "UPSTREAM"
      break
    }
    if (state.step === 0) {
      state.token = reply.token ?? null
      if (reply.left !== undefined) state.left = reply.left
    }
    state.step++
    if (reply.strong) state.strongUsed++
    const call = reply.call
    const target = reply.target ?? null
    if (call.tool === "done") {
      state.status = "done"
      state.summary = call.summary ?? ""
      break
    }
    if (call.tool === "ask_user") {
      state.status = "asked"
      state.summary = call.question ?? ""
      break
    }
    // The device's own check, on its own map: never milder than the server's.
    const device = classify(call, { map, startHost: state.startHost, request: state.request, confirmedHere: state.confirmedHere, policy: io.policy })
    const verdict = stricter(reply.verdict, device)
    if (verdict.cls === "blocked") {
      if (verdict.reason.startsWith("site_")) {
        state.status = "blocked"
        state.error = verdict.reason
        break
      }
      state.log.push({ call, target: target ?? undefined, result: `refused: ${verdict.reason}` })
      state.lines.push(line(call, verdict, target, false))
      state.refused = `that step was refused (${verdict.reason})`
      continue
    }
    if (verdict.cls === "self") {
      state.status = "self"
      state.pending = { call, verdict, target }
      break
    }
    if (verdict.cls === "confirm") {
      if (call.tool === "fill") {
        const item = map.items.find((i) => i.id === call.id) ?? null
        const fill = fillLines(call, item, entries, map.lang || state.lang)
        if (!fill.length) {
          state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "failed: that detail doesn't fit this field" })
          continue
        }
        state.status = "fill"
        state.pending = { call, verdict, target, fill, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}) }
      } else {
        state.status = "confirm"
        state.pending = { call, verdict, target, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}) }
      }
      break
    }
    await perform(state, io, call, verdict, target)
    await io.save(state)
  }
  await io.save(state)
  return state
}

export type Answer = "yes" | "no" | "did" | "notnow" | "stop"

/**
 * The person's answer to what the task waits for, then the task goes on. «Да»: the step is done (the fill with the
 * lines the person left ticked); «Нет» and «Не сейчас»: the model hears it; «Готово»: the person did it themselves.
 */
export async function answer(state: AgentState, io: RunnerIO, a: Answer, chosen?: string[]): Promise<AgentState> {
  const pending = state.pending
  if (a === "stop") {
    state.status = "stopped"
    state.pending = undefined
    await io.save(state)
    return state
  }
  if (!pending) return state
  state.pending = undefined
  state.status = "running"
  const { call, verdict, target } = pending
  if (a === "yes" && (state.status === "running") && (verdict.cls === "confirm")) {
    state.confirmedHere = true
    if (call.tool === "fill") {
      const lines = (pending.fill ?? []).filter((l) => !chosen || chosen.includes(l.entryId))
      if (!lines.length) state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "the person chose not to fill it" })
      else await perform(state, io, call, verdict, target, lines[0].value)
    } else {
      await perform(state, io, call, verdict, target)
    }
  } else if (verdict.cls === "self") {
    const did = a === "did" || a === "yes"
    state.log.push({ call, target: target ?? undefined, result: did ? "the person did this step themselves" : "the person didn't do this step now (it's left for them)" })
    state.lines.push(line(call, verdict, target, did))
    if (did) state.confirmedHere = true
  } else {
    state.log.push({ call, target: target ?? undefined, result: "the person said no" })
    state.lines.push(line(call, verdict, target, false))
  }
  await io.save(state)
  return drive(state, io)
}

/** Whether the task is waiting for the person or still working (the panel's strip shows then). */
export function active(state: AgentState | null | undefined): boolean {
  return !!state && (state.status === "running" || state.status === "confirm" || state.status === "fill" || state.status === "self")
}

export { sameSite }
