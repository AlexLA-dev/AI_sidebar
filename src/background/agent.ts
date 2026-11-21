// The agent in the background (2.7.1, «Сделай на этой странице»): one task per tab, run by the shared runner
// (src/shared/agent/runner.ts) with this tab's page and the server's /api/v2/act as its hands and brain.
// - The task's state lives in storage (session where Safari has it), so a background that Safari put to sleep
//   (about 30 s idle) and a page that navigated mid-task both go on; the panel gets every change pushed.
// - Deferred tasks: kept here, their notifications set through the app (a time) or sent when their page watch fires;
//   the app's list shows them and can cancel them. A tap opens the page with #cf-task=<id> and the panel offers «Начать».
// - «Мои данные»: read and written through the app's store (FormData.swift), never kept in the extension's storage;
//   values reach only the content script that fills a field, after the person's «Заполнить».

import { API_BASE, TARGET, TEST_PLAN } from "../shared/config"
import { liveEntries, modelKey, type FormEntry } from "../shared/agent/formdata"
import { active, answer, drive, newState, type Answer, type AgentState, type RunnerIO } from "../shared/agent/runner"
import { hostOf } from "../shared/agent/sites"
import type { PageMap, StepResult, ToolCall } from "../shared/agent/types"
import { agentDeferred, type Plan } from "../shared/plan"
import { appleCall, appleDevice, deferredReminder, deferredReminderEnd } from "./agentApple"
import { callNative } from "./native"

export interface AgentDeps {
  installId: () => Promise<string>
  entitlementJws: () => Promise<string | null>
  clientInfo: () => Promise<Record<string, unknown>>
  consented: () => Promise<boolean>
  plan: () => Promise<Plan>
  statusChanged: () => void
}

let deps: AgentDeps

const MAX_STEPS = 30
const TASK_KEY = (tab: number) => `cf:agent:${tab}`
export const DEFERRED_KEY = "cf:agentTasks"
const DEFERRED_DAYS = 30

export interface DeferredTask {
  id: string
  request: string
  lang: string
  url: string
  title: string
  // Due at a time (ms), or when this page watch fires.
  at?: number
  watch?: string
  createdAt: number
  // It has a reminder in Apple Reminders too («Также в Напоминания», key cf.agent.<id>).
  reminder?: boolean
}

export type AgentRequest =
  | { type: "agentStart"; request: string; lang: string; deferred?: string }
  | { type: "agentAnswer"; answer: Answer; chosen?: string[] }
  | { type: "agentGet" }
  | { type: "agentAccessOpen"; kind: "reminders" | "calendar" }
  | { type: "agentUndo" }
  | { type: "agentClose" }
  | { type: "agentDefer"; request: string; lang: string; url: string; title: string; at?: number; watch?: string; notifTitle: string; notifBody: string; alsoReminder?: boolean }
  | { type: "agentDeferred" }
  | { type: "agentDeferCancel"; id: string }
  | { type: "formData" }
  | { type: "formDataPut"; changes: FormEntry[] }
  | { type: "formDataICloud"; on: boolean }

// ------------------------------------------------------------ state

const store = (): chrome.storage.StorageArea => (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session ?? chrome.storage.local

async function load(tab: number): Promise<AgentState | null> {
  return ((await store().get(TASK_KEY(tab)))[TASK_KEY(tab)] as AgentState | undefined) ?? null
}

async function save(tab: number, state: AgentState): Promise<void> {
  // «Стоп» pressed while this task ran: the stored stop wins over the running copy.
  const now = await load(tab)
  if (now?.id === state.id && now.status === "stopped" && state.status !== "stopped") {
    state.status = "stopped"
    state.pending = undefined
  }
  await store().set({ [TASK_KEY(tab)]: state })
  // The panel shows it at once (the content script of the tab's top frame).
  chrome.tabs.sendMessage(tab, { type: "agentState", state: forPanel(state) }, { frameId: 0 }, () => void chrome.runtime.lastError)
}

/** What the panel gets: everything but the server's log and the last page text (it shows its own lines). */
function forPanel(state: AgentState): Omit<AgentState, "log" | "data"> & { canUndo: boolean } {
  const { log: _log, data: _data, ...rest } = state
  return { ...rest, canUndo: state.undo.length > 0 }
}

// ------------------------------------------------------------ the tab

function tabMessage<T>(tab: number, message: unknown, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    chrome.tabs.sendMessage(tab, message, { frameId: 0 }, (reply) => {
      clearTimeout(timer)
      if (chrome.runtime.lastError) resolve(null)
      else resolve((reply as T) ?? null)
    })
  })
}

function waitComplete(tab: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      // The page's content script starts a moment after "complete".
      setTimeout(resolve, 400)
    }
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tab && info.status === "complete") done()
    }
    const timer = setTimeout(done, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tab, (t) => {
      if (chrome.runtime.lastError) done()
      else if (t?.status === "complete") setTimeout(done, 300)
    })
  })
}

// ------------------------------------------------------------ the server

async function ask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [installId, client, entitlement] = await Promise.all([deps.installId(), deps.clientInfo(), deps.entitlementJws()])
  try {
    const res = await fetch(`${API_BASE}/api/v2/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, installId, client, entitlement }),
      signal: AbortSignal.timeout(45_000)
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, code: json.code ?? `HTTP_${res.status}`, ...json }
    return json
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}

// ------------------------------------------------------------ «Мои данные»

interface NativeFormData {
  entries?: Array<{ id: string; updatedAt: number; data: string }>
  icloud?: boolean
}

const LOCAL_FORM = "cf:formdata"

function parseEntries(raw: NativeFormData | null): FormEntry[] {
  return (raw?.entries ?? []).flatMap((e) => {
    try {
      const x = JSON.parse(e.data) as FormEntry
      return x && typeof x.id === "string" ? [x] : []
    } catch {
      return []
    }
  })
}

/** «Мои данные» and the iCloud choice (undefined: not asked yet). Safari: the app's store; elsewhere this browser's own. */
export async function formData(): Promise<{ entries: FormEntry[]; icloud?: boolean }> {
  if (TARGET !== "safari") return { entries: ((await chrome.storage.local.get(LOCAL_FORM))[LOCAL_FORM] as FormEntry[] | undefined) ?? [] }
  const raw = await callNative<NativeFormData>("formdata_get", {}, 15_000)
  return { entries: parseEntries(raw), ...(typeof raw?.icloud === "boolean" ? { icloud: raw.icloud } : {}) }
}

async function formDataPut(changes: FormEntry[]): Promise<{ entries: FormEntry[]; icloud?: boolean }> {
  if (TARGET !== "safari") {
    const now = ((await chrome.storage.local.get(LOCAL_FORM))[LOCAL_FORM] as FormEntry[] | undefined) ?? []
    const byId = new Map(now.map((e) => [e.id, e]))
    for (const c of changes) if (!byId.has(c.id) || (byId.get(c.id)!.updatedAt ?? 0) <= c.updatedAt) byId.set(c.id, c)
    const entries = [...byId.values()]
    await chrome.storage.local.set({ [LOCAL_FORM]: entries })
    return { entries }
  }
  const raw = await callNative<NativeFormData>("formdata_put", { changes: changes.map((e) => ({ id: e.id, updatedAt: e.updatedAt, data: JSON.stringify(e) })) }, 15_000)
  return { entries: parseEntries(raw), ...(typeof raw?.icloud === "boolean" ? { icloud: raw.icloud } : {}) }
}

// ------------------------------------------------------------ running a task

function io(tab: number): RunnerIO {
  return {
    map: () => tabMessage<PageMap>(tab, { type: "agentMap" }, 6_000),
    act: (call: ToolCall) => tabMessage<StepResult>(tab, { type: "agentAct", call }, 12_000),
    waitPage: () => waitComplete(tab),
    ask: async (body) => (await ask(body)) as never,
    save: (state) => save(tab, state),
    entries: async () => (await formData()).entries,
    policy: { amazon: true },
    maxSteps: MAX_STEPS,
    isStopped: async () => (await load(tab))?.status === "stopped",
    device: appleDevice,
    apple: appleCall
  }
}

// One drive at a time per tab (an answer that comes while it runs waits for it).
const running = new Map<number, Promise<unknown>>()

function run(tab: number, work: () => Promise<AgentState>): Promise<AgentState> {
  const before = running.get(tab) ?? Promise.resolve()
  const next = before.catch(() => undefined).then(work)
  running.set(tab, next)
  void next.finally(() => {
    if (running.get(tab) === next) running.delete(tab)
  })
  return next
}

async function start(tab: number, url: string, m: Extract<AgentRequest, { type: "agentStart" }>): Promise<Record<string, unknown>> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  const plan = await deps.plan()
  if (plan !== "pro" && plan !== "ultra") return { ok: false, code: "PRO_ONLY" }
  const now = await load(tab)
  if (active(now)) return { ok: false, code: "BUSY", state: now && forPanel(now) }
  const state = newState(crypto.randomUUID(), m.request.slice(0, 2000), m.lang, url, m.deferred)
  if (m.deferred) await removeDeferred(m.deferred, true)
  await save(tab, state)
  void run(tab, () => drive(state, io(tab))).then(() => deps.statusChanged())
  return { ok: true, state: forPanel(state) }
}

async function reply(tab: number, a: Answer, chosen?: string[]): Promise<Record<string, unknown>> {
  const state = await load(tab)
  if (!state) return { ok: false }
  if (a === "stop") {
    // Stopped at once, even mid-step: the running drive sees the status at its next turn.
    state.status = "stopped"
    state.pending = undefined
    await save(tab, state)
    return { ok: true, state: forPanel(state) }
  }
  void run(tab, async () => {
    const fresh = (await load(tab)) ?? state
    return answer(fresh, io(tab), a, chosen)
  })
  return { ok: true }
}

async function undoAll(tab: number): Promise<boolean> {
  const state = await load(tab)
  if (!state?.undo.length) return false
  let ok = true
  for (const u of [...state.undo].reverse()) {
    const r = await tabMessage<{ ok: boolean }>(tab, { type: "agentUndoStep", undo: u }, 6_000)
    if (!r?.ok) ok = false
  }
  state.undo = []
  await save(tab, state)
  return ok
}

// ------------------------------------------------------------ deferred tasks

async function deferredAll(): Promise<DeferredTask[]> {
  const list = ((await chrome.storage.local.get(DEFERRED_KEY))[DEFERRED_KEY] as DeferredTask[] | undefined) ?? []
  const fresh = list.filter((d) => Date.now() - d.createdAt < DEFERRED_DAYS * 86_400_000)
  if (fresh.length !== list.length) await chrome.storage.local.set({ [DEFERRED_KEY]: fresh })
  return fresh
}

async function writeDeferred(list: DeferredTask[]): Promise<void> {
  await chrome.storage.local.set({ [DEFERRED_KEY]: list })
  void syncDeferred()
}

async function removeDeferred(id: string, started = false): Promise<void> {
  const had = (await deferredAll()).find((d) => d.id === id)
  await writeDeferred((await deferredAll()).filter((d) => d.id !== id))
  if (TARGET === "safari") void callNative("agent_cancel", { id })
  // Its reminder in Apple Reminders, when it has one: done when the task started, gone when it was cancelled.
  if (had?.reminder) deferredReminderEnd(id, started)
}

/** The app's copy of the deferred tasks (its "Later" list); the ones cancelled there go here too. */
async function syncDeferred(): Promise<void> {
  if (TARGET !== "safari") return
  const list = await deferredAll()
  const back = await callNative<{ cancelled?: string[] }>("agent_sync", { tasks: list }, 6_000)
  const cancelled = back?.cancelled ?? []
  if (cancelled.length) await chrome.storage.local.set({ [DEFERRED_KEY]: list.filter((d) => !cancelled.includes(d.id)) })
}

async function defer(m: Extract<AgentRequest, { type: "agentDefer" }>): Promise<Record<string, unknown>> {
  const plan = await deps.plan()
  if (plan !== "pro" && plan !== "ultra") return { ok: false, code: "PRO_ONLY" }
  const list = await deferredAll()
  const limit = agentDeferred(plan)
  if (list.length >= limit) return { ok: false, code: "DEFER_LIMIT", limit }
  const task: DeferredTask = {
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    request: m.request.slice(0, 2000), lang: m.lang, url: m.url, title: m.title.slice(0, 200), createdAt: Date.now(),
    ...(m.at ? { at: m.at } : {}), ...(m.watch ? { watch: m.watch } : {})
  }
  let outcome = "scheduled"
  if (task.at && TARGET === "safari") {
    const r = await callNative<{ outcome: string }>("agent_schedule", { id: task.id, at: task.at, url: task.url, title: m.notifTitle, body: m.notifBody }, 10_000)
    outcome = r?.outcome ?? "failed"
    // Never asked: the card says why and asks on a tap (the system's question, as under a set watch); off: Settings.
    if (outcome !== "scheduled") return { ok: false, code: outcome === "not-asked" ? "NOTIF_ASK" : outcome === "denied" ? "NOTIF_OFF" : "FAILED" }
  }
  // «Также в Напоминания»: the same task in the person's Reminders, due then, without an alert of its own.
  if (m.alsoReminder && task.at && (await deferredReminder(task.id, task.request, task.at, task.url))) task.reminder = true
  await writeDeferred([...list, task])
  return { ok: true, task, outcome, reminder: !!task.reminder }
}

// The notification's words for a task its watch woke up (kept with the task when it was set).
const WATCH_WORDS = "cf:agentTaskWords"

/** A page watch fired: its deferred tasks send their notification now (watch.ts calls this). */
export async function deferredWatchMet(watchId: string): Promise<void> {
  if (TARGET !== "safari") return
  const words = ((await chrome.storage.local.get(WATCH_WORDS))[WATCH_WORDS] as Record<string, { title: string; body: string }> | undefined) ?? {}
  for (const d of (await deferredAll()).filter((x) => x.watch === watchId)) {
    const w = words[d.id] ?? { title: hostOf(d.url), body: d.request }
    await callNative("agent_notify", { id: d.id, url: d.url, title: w.title, body: w.body }, 10_000)
  }
}

// ------------------------------------------------------------ wiring

export function startAgent(d: AgentDeps): void {
  deps = d
  chrome.runtime.onMessage.addListener((message: AgentRequest, sender, sendResponse) => {
    const tab = sender.tab?.id
    const url = sender.tab?.url ?? sender.url ?? ""
    const respond = (p: Promise<unknown>) => {
      p.then(sendResponse, (e) => {
        console.error("[agent]", message?.type, e)
        // Test builds name what broke (the simulator pass); real builds keep the plain code.
        sendResponse({ ok: false, code: TEST_PLAN ? `ERROR ${String((e as Error)?.message ?? e).slice(0, 160)}` : "ERROR" })
      })
      return true
    }
    switch (message?.type) {
      case "agentStart":
        return tab === undefined ? false : respond(start(tab, url, message))
      case "agentAnswer":
        return tab === undefined ? false : respond(reply(tab, message.answer, message.chosen))
      case "agentGet":
        return tab === undefined ? false : respond(load(tab).then((s) => ({ state: s && forPanel(s) })))
      case "agentUndo":
        return tab === undefined ? false : respond(undoAll(tab).then((ok) => ({ ok })))
      case "agentClose":
        return tab === undefined ? false : respond(store().remove(TASK_KEY(tab)).then(() => ({ ok: true })))
      case "agentDefer":
        return respond(defer(message).then(async (r) => {
          const task = r.task as DeferredTask | undefined
          if (task?.watch) {
            const words = ((await chrome.storage.local.get(WATCH_WORDS))[WATCH_WORDS] as Record<string, unknown> | undefined) ?? {}
            await chrome.storage.local.set({ [WATCH_WORDS]: { ...words, [task.id]: { title: message.notifTitle, body: message.notifBody } } })
          }
          return r
        }))
      case "agentDeferred":
        return respond(syncDeferred().then(deferredAll).then((tasks) => ({ tasks })))
      case "agentAccessOpen":
        return respond(TARGET === "safari" ? callNative("agent_access_open", { kind: message.kind === "calendar" ? "calendar" : "reminders" }, 5000).then((r) => r ?? { opened: false }) : Promise.resolve({ opened: false }))
      case "agentDeferCancel":
        return respond(removeDeferred(message.id).then(() => ({ ok: true })))
      case "formData":
        return respond(formData())
      case "formDataPut":
        return respond(formDataPut(message.changes))
      case "formDataICloud":
        return respond(
          TARGET === "safari"
            ? callNative<NativeFormData>("formdata_icloud", { on: message.on }, 15_000).then((raw) => ({ entries: parseEntries(raw), icloud: message.on }))
            : Promise.resolve({ entries: [], icloud: false })
        )
      default:
        return false
    }
  })
  // A tab that closed takes its task with it.
  chrome.tabs.onRemoved.addListener((tab) => void store().remove(TASK_KEY(tab)))
  // The app may have cancelled some; its list gets this device's.
  setTimeout(() => void syncDeferred().catch(() => undefined), 5_000)
}

/** The keys the model may fill (for tests and the panel's hint). */
export function savedKeys(entries: FormEntry[]): string[] {
  return [...new Set(liveEntries(entries).map(modelKey))]
}
