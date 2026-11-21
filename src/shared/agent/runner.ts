// The agent's task (2.7.1), step by step: ask /api/v2/act, then do the step, wait for the person, or finish. Plain
// logic with its tab, server and storage passed in (the background gives the real ones, the tests fakes), and every
// stop of it kept in the state, so a background Safari wakes up again (about 30 s idle) and a page that navigates go on.
// - free: done at once; «Сделать?» (confirm): waits for Да / Нет; fill: waits for «Заполнить» with the values the
//   person sees (the model and the server never do); the person's own (self): waits for «Готово» or «Не сейчас»;
//   blocked: told back to the model; a blocked site ends the task with its own explanation.
// - Re-checked here before the hands act: a step's class from the server is never trusted to be milder than the
//   device's own check says (classify.ts runs again on the device's map).

import { APPLE_TOOLS } from "./call.ts"
import { classify } from "./classify.ts"
import { keyOfAutocomplete, liveEntries, modelKey, shapeValue, type FormEntry } from "./formdata.ts"
import { hostOf, sameSite, type SitePolicy } from "./sites.ts"
import { buildPlan, checkPlan, covered, personWords, planLine, planNeedsPerson, priceChanged, type TaskPlan } from "./taskplan.ts"
import type { LogEntry, MapItem, PageMap, StepClass, StepResult, StepVerdict, ToolCall } from "./types.ts"

export type AgentStatus = "plan" | "running" | "confirm" | "fill" | "self" | "done" | "asked" | "stopped" | "error" | "blocked"

export interface FillLine {
  entryId: string
  label: string
  value: string
  // The field it goes into, and the detail's key (the log names the key, never the value).
  id: string
  key: string
}

export interface AgentLine {
  // What the step did, in the person's words (the model's "why"), and what came of it.
  text: string
  tool: ToolCall["tool"]
  cls: StepClass
  ok: boolean
  target?: string
  // Done without a question: the plan the person approved allowed it.
  byPlan?: boolean
  // When (ms): test builds show it, to see whether a task stepped while its tab was in the background.
  at?: number
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
  pending?: { call: ToolCall; verdict: StepVerdict; target: string | null; offRequest?: string; fill?: FillLine[]; price?: string }
  // The plan card (status "plan"), then the approved plan the steps go by (2.7.1, the owner's autonomy note).
  plan?: TaskPlan
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
  // The plan's makings (task.phase "plan"): the device classes what was foreseen on its own map.
  plan?: unknown
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
  // The person pressed «Стоп» while a step was on its way (the background's stored state says so).
  isStopped?: () => Promise<boolean>
  // Calendar and Reminders on this device (2.7.1): whether they're there ("yes", "none": not allowed yet, "denied",
  // "unavailable"), and a call of one of their tools, done there (AgentApple.swift).
  device?: () => Promise<{ reminders: string; calendar: string }>
  apple?: (call: ToolCall) => Promise<StepResult>
  // The plan card before the first step (off: every «Сделать?» asks, as before 2.7.1's autonomy).
  planning?: boolean
}

/** Which of the two a Calendar and Reminders tool needs. */
export function appleKind(tool: ToolCall["tool"]): "reminders" | "calendar" {
  return tool === "calendar" || tool === "event_add" ? "calendar" : "reminders"
}

/** The device's date, weekday, time and zone, for the model's «tomorrow» and «after 18:00». */
export function nowLine(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
  let zone = ""
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    zone = ""
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${day} ${p(d.getHours())}:${p(d.getMinutes())}${zone ? ` ${zone}` : ""}`
}

export function newState(id: string, request: string, lang: string, url: string, deferred?: string): AgentState {
  return {
    id, request, lang, url, startHost: hostOf(url), step: 0, token: null, confirmedHere: false, strongUsed: 0, status: "running",
    log: [], lines: [], undo: [], startedAt: Date.now(), ...(deferred ? { deferred } : {})
  }
}

const STRICT: Record<StepClass, number> = { free: 0, confirm: 1, self: 2, blocked: 3 }

// Reasons of steps that send or leave: after one, «Отменить» has nothing sensible to put back.
const FINAL = new Set(["submit", "cart", "other_site", "decline", "unknown", "first_here", "off_request"])

/** The stricter of the server's class and the device's own (the device never acts on a milder one than it sees). */
export function stricter(server: StepVerdict, device: StepVerdict): StepVerdict {
  return STRICT[device.cls] > STRICT[server.cls] ? device : server
}

function line(call: ToolCall, verdict: StepVerdict, target: string | null, ok: boolean, why?: string, byPlan?: boolean): AgentLine {
  return { text: why ?? call.why ?? "", tool: call.tool, cls: verdict.cls, ok, ...(target ? { target } : {}), ...(byPlan ? { byPlan: true } : {}), at: Date.now() }
}

function noteOf(r: StepResult | null): string {
  if (!r) return "the page went on"
  if (!r.ok) return `failed: ${r.note ?? "it didn't work"}`
  return r.data ? "read the page (below, as extracted)" : r.note ?? "done"
}

/** The values a fill would put in, as the person sees them on the card: the entry for the key, shaped for the field. */
export function fillLines(call: ToolCall, item: MapItem | null, entries: FormEntry[], lang: string, map?: PageMap): FillLine[] {
  const live = liveEntries(entries)
  const entry = live.find((e) => modelKey(e) === call.key)
  if (!entry || !item) return []
  const line = (it: MapItem, e: FormEntry): FillLine | null => {
    const value = shapeValue(e, { type: it.type, auto: it.auto, lang, options: it.options, label: it.label })
    return value === null ? null : { entryId: e.id, label: it.label || e.label || e.key, value, id: it.id, key: modelKey(e) }
  }
  const first = line(item, entry)
  if (!first) return []
  // The same form's other empty fields whose autocomplete names a saved detail: offered on the same card (each its own
  // tick), so a form takes one «Заполнить», not one per field. Only by autocomplete: no guessing by labels here.
  const more: FillLine[] = []
  if (map && item.form !== undefined) {
    for (const it of map.items) {
      if (it.id === item.id || it.form !== item.form || it.lock === "secret" || !it.state?.includes("empty")) continue
      const k = keyOfAutocomplete(it.auto)
      if (!k || k.part) continue
      const e = live.find((x) => x.key === k.key)
      const l = e && line(it, e)
      if (l && !more.some((m) => m.id === l.id)) more.push(l)
    }
  }
  return [first, ...more]
}

/** Does a step on the page and writes it down. A fill types its value in; the log keeps only the key. */
async function perform(state: AgentState, io: RunnerIO, call: ToolCall, verdict: StepVerdict, target: string | null, value?: string, byPlan?: boolean): Promise<void> {
  const doing: ToolCall = call.tool === "fill" ? { ...call, text: value ?? "" } : call
  // Calendar and Reminders: on the device, not on the page (what they read goes to the next step, like extract).
  if (APPLE_TOOLS.has(call.tool)) {
    const r = io.apple ? await io.apple(call).catch(() => null) : null
    const result = r ?? { ok: false, note: "Calendar and Reminders aren't there on this device" }
    if (result.data) state.data = result.data
    state.log.push({ call, result: noteOf(result) })
    state.lines.push(line(call, verdict, target, result.ok, undefined, byPlan))
    return
  }
  let result = await io.act(doing)
  if (!result || result.navigated) {
    await io.waitPage()
    result = result ?? { ok: true, navigated: true, note: "the page went on" }
  }
  if (result.undo) state.undo.push(result.undo)
  // A step that can't be taken back (a form sent, another site opened): what came before it can't be either, sensibly.
  if (verdict.cls === "confirm" && FINAL.has(verdict.reason)) state.undo = []
  if (result.data) state.data = result.data
  // A fill's log line has its key, never its value (the log goes to the server with the next step).
  const logged: ToolCall = call.tool === "fill" ? { tool: "fill", id: call.id, key: call.key, why: call.why } : call
  state.log.push({ call: logged, target: target ?? undefined, result: `${noteOf(result)}${byPlan ? " (allowed in the plan)" : ""}` })
  state.lines.push(line(call, verdict, target, result.ok, undefined, byPlan))
}

/** The task's request as the server and the checks hear it: the person's words with the plan's answers. */
function words(state: AgentState): string {
  return personWords(state.request, state.plan)
}

/** The plan step (step 0): the plan card when it needs the person, else straight on with it approved. */
async function planStep(state: AgentState, io: RunnerIO, map: PageMap, keys: string[], here: { reminders: string; calendar: string } | null): Promise<"card" | "go" | "stop"> {
  const reply = await io.ask({
    task: { id: state.id, request: state.request, lang: state.lang, startHost: state.startHost, step: 0, confirmedHere: false, token: null, strongUsed: 0, now: nowLine(), phase: "plan", ...(here ? { device: here } : {}) },
    map, log: [], keys
  })
  if (!reply.ok) {
    state.status = "error"
    state.error = reply.code ?? "UPSTREAM"
    return "stop"
  }
  state.token = reply.token ?? null
  if (reply.left !== undefined) state.left = reply.left
  state.step = 1
  // A server without plans answered with a step: none, every «Сделать?» asks (it's asked again as step 1).
  const plan = reply.plan ? buildPlan(checkPlan(reply.plan), { map, startHost: state.startHost, request: state.request, confirmedHere: false, policy: io.policy }) : null
  if (!plan) return "go"
  state.plan = plan
  if (planNeedsPerson(plan)) {
    state.status = "plan"
    return "card"
  }
  plan.approved = true
  return "go"
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
    const here = (await io.device?.().catch(() => null)) ?? null
    if (state.step === 0 && io.planning && !state.plan) {
      const p = await planStep(state, io, map, keys, here)
      if (await io.isStopped?.()) {
        state.status = "stopped"
        break
      }
      if (p !== "go") break
      await io.save(state)
      continue
    }
    const plan = planLine(state.plan)
    const reply = await io.ask({
      task: { id: state.id, request: words(state), lang: state.lang, startHost: state.startHost, step: state.step, confirmedHere: state.confirmedHere, token: state.token, strongUsed: state.strongUsed, now: nowLine(), ...(here ? { device: here } : {}), ...(plan ? { plan } : {}) },
      map, log: state.log, ...(state.refused ? { refused: state.refused } : {}), ...(state.data ? { data: state.data } : {}), keys
    })
    state.refused = undefined
    state.data = undefined
    if (await io.isStopped?.()) {
      state.status = "stopped"
      break
    }
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
    // The model's answer failed the code's check twice: the task ends with an error, not an empty question.
    if (reply.verdict.reason === "bad_call") {
      state.status = "error"
      state.error = "bad_call"
      break
    }
    if (call.tool === "ask_user") {
      state.status = "asked"
      state.summary = call.question ?? ""
      break
    }
    // The device's own check, on its own map: never milder than the server's.
    const device = classify(call, { map, startHost: state.startHost, request: words(state), confirmedHere: state.confirmedHere, policy: io.policy })
    const verdict = stricter(reply.verdict, device)
    // A step the approved plan allows goes without a question (a price changed since the plan, or a step the check
    // found off the request, is never covered: those ask as before).
    const perm = verdict.cls === "confirm" || verdict.cls === "self" ? covered(state.plan, call, verdict, map, words(state), reply.offRequest) : null
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
    if (verdict.cls === "self" && perm) {
      state.confirmedHere = true
      await perform(state, io, call, verdict, target, undefined, true)
      await io.save(state)
      continue
    }
    if (verdict.cls === "self") {
      state.status = "self"
      state.pending = { call, verdict, target }
      break
    }
    // Calendar and Reminders the app hasn't been allowed yet: the person's own step (open the app, allow, «Готово»);
    // turned off in Settings, or not on this device: the model hears it and tells the person.
    if (APPLE_TOOLS.has(call.tool)) {
      const kind = appleKind(call.tool)
      const access = here?.[kind] ?? "unavailable"
      // Asked once already in this task and still not given («Готово» without allowing): not asked again in a loop.
      const askedBefore = state.log.some((e) => e.call && APPLE_TOOLS.has(e.call.tool) && appleKind(e.call.tool) === kind && /asked to allow it/.test(e.result))
      if (access === "none" && askedBefore) {
        state.log.push({ call, result: `refused: ${kind} access still isn't given (the person can allow it in ContextFlow later)` })
        state.lines.push(line(call, verdict, null, false))
        continue
      }
      if (access === "none") {
        state.status = "self"
        state.pending = { call, verdict: { cls: "self", reason: `access_${kind}` }, target: null }
        break
      }
      if (access !== "yes") {
        state.log.push({ call, result: access === "denied" ? `refused: ${kind} access is turned off in Settings → ContextFlow` : `refused: no ${kind} on this device` })
        state.lines.push(line(call, verdict, null, false))
        continue
      }
    }
    if (verdict.cls === "confirm" && perm) {
      state.confirmedHere = true
      if (call.tool === "fill") {
        const item = map.items.find((i) => i.id === call.id) ?? null
        // Only the details the plan named (the same form's others, with their own keys, when they're named too).
        const fill = fillLines(call, item, entries, map.lang || state.lang, map).filter((l) => perm.keys?.includes(l.key))
        if (!fill.length) {
          state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "failed: that detail doesn't fit this field" })
          continue
        }
        for (const l of fill) await perform(state, io, { tool: "fill", id: l.id, key: l.key, why: l.id === call.id ? call.why : "" }, verdict, l.id === call.id ? target : `field "${l.label}"`, l.value, true)
      } else await perform(state, io, call, verdict, target, undefined, true)
      await io.save(state)
      continue
    }
    if (verdict.cls === "confirm") {
      // The plan allowed this button, but the price on the page isn't the one it saw: the card says so.
      const item = map.items.find((i) => i.id === call.id) ?? null
      const price = state.plan?.approved && (verdict.reason === "cart" || verdict.reason === "submit") ? priceChanged(state.plan, map, item?.label ?? "") : null
      if (call.tool === "fill") {
        const fill = fillLines(call, item, entries, map.lang || state.lang, map)
        if (!fill.length) {
          state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "failed: that detail doesn't fit this field" })
          continue
        }
        state.status = "fill"
        state.pending = { call, verdict, target, fill, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}) }
      } else {
        state.status = "confirm"
        state.pending = { call, verdict, target, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}), ...(price ? { price } : {}) }
      }
      break
    }
    await perform(state, io, call, verdict, target)
    await io.save(state)
  }
  await io.save(state)
  return state
}

export interface PlanApproval {
  // The questions' answers, in order ("" for one left blank).
  answers: string[]
  // The permissions the person unticked.
  off: string[]
}

/** «Начать» on the plan card: the answers and the ticks kept, then the task goes on alone. */
export async function approvePlan(state: AgentState, io: RunnerIO, a: PlanApproval): Promise<AgentState> {
  if (state.status !== "plan" || !state.plan) return state
  const plan = state.plan
  plan.answers = plan.questions.map((q, i) => ({ q: q.q, a: (a.answers[i] ?? "").slice(0, 200) }))
  plan.perms = plan.perms.map((p) => ({ ...p, on: !a.off.includes(p.id) }))
  plan.approved = true
  state.status = "running"
  await io.save(state)
  return drive(state, io)
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
  if (a === "yes" && verdict.cls === "confirm") {
    state.confirmedHere = true
    if (call.tool === "fill") {
      const lines = (pending.fill ?? []).filter((l) => !chosen || chosen.includes(`${l.id}:${l.entryId}`) || chosen.includes(l.entryId))
      if (!lines.length) state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "the person chose not to fill it" })
      for (const l of lines) await perform(state, io, { tool: "fill", id: l.id, key: l.key, why: l.id === call.id ? call.why : "" }, verdict, l.id === call.id ? target : `field "${l.label}"`, l.value)
    } else {
      await perform(state, io, call, verdict, target)
    }
  } else if (verdict.cls === "self") {
    const did = a === "did" || a === "yes"
    const access = verdict.reason.startsWith("access_")
    state.log.push({ call, target: target ?? undefined, result: access ? (did ? "the person was asked to allow it in ContextFlow: call the tool again" : "the person didn't allow it now: go on without it") : did ? "the person did this step themselves" : "the person didn't do this step now (it's left for them)" })
    // (Access given: no line of its own; the tool's own step, called again, writes one.)
    if (!access) state.lines.push(line(call, verdict, target, did))
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
  return !!state && (state.status === "plan" || state.status === "running" || state.status === "confirm" || state.status === "fill" || state.status === "self")
}

export { sameSite }
