// The agent in the background (2.7.1, «Сделай на этой странице»): one task per tab, run by the shared runner
// (src/shared/agent/runner.ts) with this tab's page and the server's /api/v2/act as its hands and brain.
// - The task's state lives in storage (session where Safari has it), so a background that Safari put to sleep
//   (about 30 s idle) and a page that navigated mid-task both go on; the panel gets every change pushed.
// - Deferred tasks: kept here, their notifications set through the app (a time) or sent when their page watch fires;
//   the app's list shows them and can cancel them. A tap opens the page with #cf-task=<id> and the panel offers «Начать».
// - «Мои данные»: read and written through the app's store (FormData.swift), never kept in the extension's storage;
//   values reach only the content script that fills a field, after the person's «Заполнить».

import { CHAT_CHARS } from "../shared/agent/chatctx"
import { API_BASE, TARGET, TEST_PLAN } from "../shared/config"
import { liveEntries, modelKey, type FormEntry } from "../shared/agent/formdata"
import { active, answer, approvePlan, drive, newState, pendingKey, type Answer, type AgentState, type PlanApproval, type RunnerIO } from "../shared/agent/runner"
import { noticeLabel, type TaskPlan } from "../shared/agent/taskplan"
import { hostOf, sameSite } from "../shared/agent/sites"
import { venuesOn } from "../shared/agent/venues"
import { agentEvents, type AgentUse } from "../shared/agent/events"
import type { PageMap, StepResult, ToolCall } from "../shared/agent/types"
import { agentDeferred, type Plan } from "../shared/plan"
import { appleCall, appleDevice, calendarFreeLine, calendarSlotFree, deferredReminder, deferredReminderEnd } from "./agentApple"
import { addMinutes, RULES_KEY } from "../shared/agent/rules"
import { callNative } from "./native"
import { PagesSeen } from "./pagesSeen"

export interface AgentDeps {
  installId: () => Promise<string>
  entitlementJws: () => Promise<string | null>
  clientInfo: () => Promise<Record<string, unknown>>
  consented: () => Promise<boolean>
  plan: () => Promise<Plan>
  statusChanged: () => void
  use?: (fields: AgentUse) => void
}

let deps: AgentDeps

const MAX_STEPS = 30
const TASK_KEY = (tab: number) => `cf:agent:${tab}`
// This tab's finished tasks the chat keeps, folded to a line each (2.7.1, the owner): newest last, a few.
const PAST_KEY = (tab: number) => `cf:agentPast:${tab}`
const PAST_MAX = 6
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
  // The plan the person approved when they chose «Позже» on its card: started on the same page, it goes by it.
  plan?: TaskPlan
}

export type AgentRequest =
  | { type: "agentStart"; request: string; lang: string; deferred?: string; chat?: string }
  | { type: "agentAnswer"; answer: Answer; chosen?: string[]; key?: string; via?: "chat" | "bubble" }
  | { type: "agentPlan"; approval: PlanApproval }
  | { type: "agentGet" }
  | { type: "agentAccessOpen"; kind: "reminders" | "calendar"; settings?: boolean }
  | { type: "agentAccess" }
  | { type: "agentUndo" }
  | { type: "agentClose"; keep?: boolean }
  | { type: "agentForgetPast"; id: string }
  | { type: "agentNoticeGet" }
  | { type: "agentSeen"; visible: boolean; words?: AwayWords; doc?: string }
  | { type: "agentPing"; doc?: string }
  | { type: "agentFocus"; id: string }
  | { type: "agentGoTab" }
  | { type: "agentNoticeClear" }
  | { type: "agentNoticeAnswer"; answer: Answer; chosen?: string[]; key: string }
  | { type: "agentDefer"; request: string; lang: string; url: string; title: string; at?: number; watch?: string; notifTitle: string; notifBody: string; alsoReminder?: boolean; plan?: TaskPlan }
  | { type: "agentDeferred" }
  | { type: "agentDeferCancel"; id: string }
  | { type: "formData" }
  | { type: "formDataPut"; changes: FormEntry[] }
  | { type: "formDataICloud"; on: boolean }

// ------------------------------------------------------------ state

const store = (): chrome.storage.StorageArea => (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session ?? chrome.storage.local

// Real Safari (iOS 27 simulator): after a few dozen saves, storage.session refused every write («Exceeded storage
// quota») though only this tab's small state was in it, so a task couldn't start or go on. Each write first removes the
// key; a write still refused goes to storage.local instead, kept only for a few hours (a tab id comes back after a
// restart and must not find an old task).
const LOCAL_FOR = 6 * 3600_000

async function stored(tab: number): Promise<AgentState | null> {
  const key = TASK_KEY(tab)
  const s = ((await store().get(key).catch(() => ({} as Record<string, unknown>)))[key] as AgentState | undefined) ?? null
  if (s || store() === chrome.storage.local) return s
  const l = ((await chrome.storage.local.get(key).catch(() => ({} as Record<string, unknown>)))[key] as (AgentState & { savedAt?: number }) | undefined) ?? null
  if (l && Date.now() - (l.savedAt ?? 0) > LOCAL_FOR) {
    void chrome.storage.local.remove(key)
    return null
  }
  return l
}

async function write(tab: number, state: AgentState): Promise<void> {
  const key = TASK_KEY(tab)
  if (store() !== chrome.storage.local) {
    try {
      await store().remove(key)
      await store().set({ [key]: state })
      void chrome.storage.local.remove(key)
      return
    } catch {
      // the session area is full: below
    }
  }
  await chrome.storage.local.set({ [key]: { ...state, savedAt: Date.now() } })
}

async function forget(tab: number): Promise<void> {
  const key = TASK_KEY(tab)
  await Promise.all([store().remove(key).catch(() => undefined), chrome.storage.local.remove(key).catch(() => undefined)])
}

type PastTask = Omit<ReturnType<typeof forPanel>, "pending"> & { canUndo: false }

async function past(tab: number): Promise<PastTask[]> {
  const key = PAST_KEY(tab)
  const got = (await chrome.storage.local.get(key).catch(() => ({} as Record<string, unknown>)))[key] as PastTask[] | undefined
  return Array.isArray(got) ? got.filter((x) => Date.now() - (x.startedAt ?? 0) < LOCAL_FOR) : []
}

/** The tab's task goes; finished and kept, it stays in the chat as a folded line (without its Undo). */
async function close(tab: number, keep: boolean): Promise<void> {
  const state = await load(tab)
  if (keep && state && !active(state)) {
    const { pending: _p, ...rest } = forPanel(state)
    const list = [...(await past(tab)).filter((x) => x.id !== state.id), { ...rest, undo: [], canUndo: false as const }].slice(-PAST_MAX)
    await chrome.storage.local.set({ [PAST_KEY(tab)]: list })
  }
  await forget(tab)
}

async function forgetPast(tab: number, id: string): Promise<void> {
  await chrome.storage.local.set({ [PAST_KEY(tab)]: (await past(tab)).filter((x) => x.id !== id) })
}

async function load(tab: number): Promise<AgentState | null> {
  const s = await stored(tab)
  // Safari's storage.session gave back the state's empty arrays as one and the same array (real Safari, a task that
  // stopped for the person before its first step): the log's entries then showed as step lines («·») and the lines went
  // to the server as log entries. Each gets its own copy.
  if (s) {
    s.log = [...(s.log ?? [])]
    s.lines = [...(s.lines ?? [])]
    s.undo = [...(s.undo ?? [])]
  }
  return s
}

async function save(tab: number, state: AgentState): Promise<void> {
  // «Стоп» pressed while this task ran: the stored stop wins over the running copy.
  const now = await load(tab)
  if (now?.id === state.id && now.status === "stopped" && state.status !== "stopped") {
    state.status = "stopped"
    state.pending = undefined
  }
  state.touchedAt = Date.now()
  // The task's start and end, once each (marked on the state written now).
  const events = agentEvents(state)
  await write(tab, state)
  for (const e of events) deps.use?.(e)
  // The panel shows it at once (the content script of the tab's top frame).
  chrome.tabs.sendMessage(tab, { type: "agentState", state: forPanel(state) }, { frameId: 0 }, () => void chrome.runtime.lastError)
  if (state.status !== "running" && (now?.id !== state.id || now.status !== state.status)) void noticeElsewhere(tab, state)
  if (away) void awayNote(tab, state)
}

// ------------------------------------------------------------ while the person is out of Safari

// The person left Safari (or the page went hidden) while a task runs or waits (2.7.1, the owner: «нотификацию, если я
// вышел, а он не закончил»). The moment a page goes hidden, «Дело на паузе — откройте Safari» is set a little ahead; every
// step that still runs pushes it on, so it comes only when Safari has really stopped the task (iOS suspends it in the
// background) — never claiming it goes on. Done or waiting for the person while away: «Готово: …» / «Нужны вы: …» at
// once instead. Back in Safari (any page of ours seen, or a tab switch): the one still waiting goes.
const PAUSE_AFTER_MS = 30_000
type AwayWords = { paused: string; done: string; needs: string; title: string; signIn?: string; pay?: string; answer?: string }
let away: { words: AwayWords } | null = null
// A tab switch hides one page and shows another: not leaving Safari.
let switchedAt = 0
// Each page of ours, visible or hidden (away only while none is visible).
const pagesSeen = new PagesSeen()

function runId(state: AgentState): string {
  return `run_${state.id}`
}

async function awayNote(tab: number, state: AgentState): Promise<void> {
  if (TARGET !== "safari" || !away) return
  const tabUrl = await new Promise<string>((resolve) => chrome.tabs.get(tab, (t) => resolve(chrome.runtime.lastError ? state.url : t?.url ?? state.url)))
  const base = { id: runId(state), url: tabUrl, title: away.words.title }
  // On a lock screen: the plan's name for the task and the site, never the request (it holds phones, e-mails, names).
  const what = noticeLabel(state.plan, hostOf(tabUrl))
  if (state.status === "running") {
    await callNative("agent_schedule", { ...base, at: Date.now() + PAUSE_AFTER_MS, body: away.words.paused.replace("{0}", what) }, 6_000)
    return
  }
  const waiting = state.status === "plan" || state.status === "confirm" || state.status === "fill" || state.status === "self" || state.status === "asked"
  const ended = state.status === "done"
  if (!waiting && !ended) {
    await callNative("agent_cancel", { id: runId(state) }, 4_000)
    return
  }
  // Done: what and when it booked («Готово: запись на стрижку · fresha.com, вт 24 ноя, 14:45»); waiting: what for
  // («Нужны вы: вход на сайт · fresha.com»). Never a name, a phone or the request.
  const when = ended && state.booked ? bookedWhen(state.booked.date, state.booked.time) : ""
  const why = waiting ? needWord(state, away.words) : ""
  const body = ended ? away.words.done.replace("{0}", when ? `${what}, ${when}` : what) : away.words.needs.replace("{0}", why ? `${why} · ${what}` : what)
  await callNative("agent_notify", { ...base, body }, 6_000)
}

function bookedWhen(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number)
  const [h, min] = time ? time.split(":").map(Number) : [12, 0]
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(y, m - 1, d, h, min))
  } catch {
    return `${date} ${time}`
  }
}

/** What a waiting task needs the person for, in the panel's words (a sign-in, a payment, an answer). */
function needWord(state: AgentState, w: AwayWords): string {
  const reason = state.pending?.verdict.reason ?? ""
  if (state.status === "self" && (reason === "auth" || reason === "account")) return w.signIn ?? ""
  if (state.status === "self" && reason === "pay") return w.pay ?? ""
  if (state.status === "asked") return w.answer ?? ""
  return ""
}

/** Safari is in front again: the notification set for being away goes. */
async function back(): Promise<void> {
  if (!away) return
  away = null
  for (const [tab, state] of await activeTasks()) {
    void tab
    if (TARGET === "safari") void callNative("agent_cancel", { id: runId(state) }, 4_000)
  }
}

/** A page of ours was hidden or seen: away from Safari (as far as we can tell) or back. */
async function seen(visible: boolean, words?: AwayWords, from?: number, doc?: string): Promise<void> {
  if (from !== undefined) pagesSeen.report(from, doc ?? "", visible)
  if (visible) {
    for (const [tab] of await activeTasks()) void resume(tab)
    await back()
    return
  }
  if (!words || Date.now() - switchedAt < 1500) return
  // Another page of ours is still in front (the tab's next page showed before its old one said «hidden»): not away.
  const fronts = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({ active: true }, (t) => resolve(chrome.runtime.lastError ? [] : t ?? [])))
  if (pagesSeen.anyVisible(new Set(fronts.flatMap((t) => (t.id === undefined ? [] : [t.id]))))) return
  away = { words }
  for (const [tab, state] of await activeTasks()) if (state.status === "running") void awayNote(tab, state)
}

/** The tabs with a task that runs or waits for the person. */
async function activeTasks(): Promise<Array<[number, AgentState]>> {
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({}, (t) => resolve(chrome.runtime.lastError ? [] : t ?? [])))
  const out: Array<[number, AgentState]> = []
  for (const t of tabs) {
    if (t.id === undefined) continue
    const st = await load(t.id)
    if (st && active(st)) out.push([t.id, st])
  }
  return out
}

/** The notification's tap opened the page (#cf-task=run_<id>): the task's own tab comes to the front and this one goes. */
async function focusTask(id: string, from: number | undefined): Promise<{ ok: boolean; here?: boolean }> {
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({}, (t) => resolve(chrome.runtime.lastError ? [] : t ?? [])))
  for (const t of tabs) {
    if (t.id === undefined) continue
    const st = await load(t.id)
    if (st?.id !== id) continue
    if (t.id === from) return { ok: true, here: true }
    await new Promise<void>((resolve) => chrome.tabs.update(t.id!, { active: true }, () => resolve(void chrome.runtime.lastError)))
    if (from !== undefined) chrome.tabs.remove(from, () => void chrome.runtime.lastError)
    return { ok: true }
  }
  return { ok: false }
}

// ------------------------------------------------------------ while the person is in another tab

// A task that finished or needs the person while its tab isn't the one in front (2.7.1, the owner: «нотифаил через
// круг когда я в сафари»): the circle in the other tabs gets a ring; a tap there shows a card with «Перейти к вкладке».
const NOTICE_KEY = "cf:agentNotice"

export interface AgentNotice {
  tab: number
  id: string
  request: string
  // done, or what it waits for (plan, confirm, fill, self), or how it ended (asked, stopped, error, blocked).
  status: AgentState["status"]
  summary: string
  at: number
  // What the bubble by the circle asks in the other tabs (2.7.1): the step's key (an answer names it), the step itself
  // (without the form's values), the agent's answers to pick from, how it failed.
  key?: string
  pending?: Omit<NonNullable<AgentState["pending"]>, "fill">
  choices?: string[]
  error?: string
  askKey?: string
}

async function notice(): Promise<AgentNotice | null> {
  const n = ((await chrome.storage.local.get(NOTICE_KEY).catch(() => ({} as Record<string, unknown>)))[NOTICE_KEY] as AgentNotice | undefined) ?? null
  return n && Date.now() - n.at < LOCAL_FOR ? n : null
}

function tellTabs(n: AgentNotice | null, except?: number): void {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return
    for (const t of tabs ?? []) {
      if (t.id === undefined || t.id === except) continue
      chrome.tabs.sendMessage(t.id, { type: "agentNotice", notice: n }, { frameId: 0 }, () => void chrome.runtime.lastError)
    }
  })
}

function tabActive(tab: number): Promise<boolean> {
  return new Promise((resolve) => chrome.tabs.get(tab, (t) => resolve(!chrome.runtime.lastError && !!t?.active)))
}

async function noticeElsewhere(tab: number, state: AgentState): Promise<void> {
  if (await tabActive(tab)) return
  const p = state.pending
  const n: AgentNotice = {
    tab, id: state.id, request: state.request.slice(0, 200), status: state.status, summary: (state.summary ?? "").slice(0, 300), at: Date.now(),
    key: pendingKey(state), ...(p ? { pending: { call: p.call, verdict: p.verdict, target: p.target, offRequest: p.offRequest, price: p.price, recap: p.recap } } : {}),
    ...(state.choices?.length ? { choices: state.choices.slice(0, 8) } : {}), ...(state.error ? { error: state.error } : {}), ...(state.askKey ? { askKey: state.askKey } : {})
  }
  await chrome.storage.local.set({ [NOTICE_KEY]: n })
  tellTabs(n, tab)
}

async function clearNotice(): Promise<void> {
  if (!(await notice())) return
  await chrome.storage.local.remove(NOTICE_KEY)
  tellTabs(null)
}

/** The bubble's answer in another tab: for the step the notice asked about only (the key), then the task goes on there
 *  and the bubble goes. The same check as the panel's answer (reply): a later step the person hasn't seen isn't it. */
async function noticeAnswer(a: Answer, chosen: string[] | undefined, key: string): Promise<Record<string, unknown>> {
  const n = await notice()
  if (!n || !key || n.key !== key || a === "stop") return { ok: false, code: "STALE" }
  const r = await reply(n.tab, a, chosen, key, "bubble")
  if (r.ok) await clearNotice()
  return { ok: r.ok === true, ...(r.code ? { code: r.code } : {}) }
}

/** «Перейти к вкладке»: the task's tab comes to the front (its panel shows the task), and the ring goes. */
async function goTab(): Promise<boolean> {
  const n = await notice()
  if (!n) return false
  const ok = await new Promise<boolean>((resolve) => chrome.tabs.update(n.tab, { active: true }, () => resolve(!chrome.runtime.lastError)))
  await clearNotice()
  return ok
}

/** What the panel gets: everything but the server's log and the last page text (it shows its own lines). */
function forPanel(state: AgentState): Omit<AgentState, "log" | "data"> & { canUndo: boolean } {
  const { log: _log, data: _data, chat: _chat, ...rest } = state
  // Only what was really changed (a field, a box, a list's choice) can be put back: a task that only read has no Undo.
  return { ...rest, canUndo: state.undo.some((u) => !!u && typeof u === "object" && !!u.id && !!u.kind) }
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
  // A request cut off while Safari was in the background (or the network blinked): twice more before the task stops.
  for (let attempt = 0; ; attempt++) {
    const r = await askOnce(body)
    if (r.code !== "NETWORK" || attempt >= 2) return r
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

async function askOnce(body: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  // 2.7.1 (panel-ux-271): what the last iCloud sync did, for the line under the switch in Settings.
  syncedAt?: number
  syncError?: string
}

/** The iCloud choice and the last sync's result, as the app sent them (nothing when it said nothing). */
function formDataState(raw: NativeFormData | null): { icloud?: boolean; syncedAt?: number; syncError?: string } {
  return {
    ...(typeof raw?.icloud === "boolean" ? { icloud: raw.icloud } : {}),
    ...(typeof raw?.syncedAt === "number" ? { syncedAt: raw.syncedAt } : {}),
    ...(typeof raw?.syncError === "string" ? { syncError: raw.syncError } : {})
  }
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
  return { entries: parseEntries(raw), ...formDataState(raw) }
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
  return { entries: parseEntries(raw), ...formDataState(raw) }
}

// ------------------------------------------------------------ running a task

class Superseded extends Error {}

// Stand builds only (the API on a local stand): each phase of a run to the stand's log, so a run that stands still shows
// where. Real builds send nothing.
const TRACE = /^http:\/\/localhost:\d+$/.test(API_BASE)
function trace(tab: number, what: string): void {
  if (!TRACE) return
  void fetch(`${API_BASE}/__trace`, { method: "POST", body: `tab ${tab} ${what}` }).catch(() => undefined)
}

async function traced<T>(tab: number, what: string, p: Promise<T>): Promise<T> {
  trace(tab, `${what} …`)
  try {
    const out = await p
    trace(tab, `${what} ok`)
    return out
  } catch (e) {
    trace(tab, `${what} threw ${String((e as Error)?.message ?? e).slice(0, 80)}`)
    throw e
  }
}

function io(tab: number, gen?: string): RunnerIO {
  // A run that Safari froze and a newer one replaced: it stops at its next ask, act or save, never acting twice.
  const live = async () => {
    if (!gen) return
    const now = await load(tab)
    if (now?.gen && now.gen !== gen) throw new Superseded("superseded")
  }
  return {
    map: (opts) =>
      traced(tab, "map", tabMessage<PageMap>(tab, { type: "agentMap", ...(opts?.money ? { money: true } : {}), ...(opts?.part && opts.part > 1 ? { part: opts.part } : {}) }, 6_000)).then(async (m) => {
        // (Stand builds: what the map holds for a list of places, to see on a device why a list was or wasn't one.)
        if (TRACE && m) {
          const st = await load(tab)
          const area = st?.plan?.booking?.area ?? []
          const cards = m.items.filter((i) => i.card)
          trace(tab, `places v4 venue=${JSON.stringify(st?.plan?.booking?.venue ?? "")} subject=${JSON.stringify(st?.subject ?? "").slice(0, 80)} q=${JSON.stringify((st?.plan?.questions ?? []).map((q) => (q.kind ?? "") + "/" + (q.fact ?? "")))} approved=${st?.plan?.approved} cards=${cards.length} area=${JSON.stringify(area)} match=${JSON.stringify(st?.plan?.booking?.match ?? [])} personal=${st?.plan?.booking?.personal} askPlace=${st?.plan?.askPlace} choose=${st?.chooseVenue} noted=${st?.venues?.list.length ?? -1} venues=${venuesOn(m, area).length} ${cards.slice(0, 3).map((i) => `«${i.label.slice(0, 30)} | ${(i.where ?? "")} | ${i.card!.slice(0, 120)}»`).join(" ")}`)
        }
        return m
      }),
    act: async (call: ToolCall) => {
      await live()
      return traced(tab, `act ${call.tool}`, tabMessage<StepResult>(tab, { type: "agentAct", call }, 12_000))
    },
    waitPage: () => traced(tab, "waitPage", waitComplete(tab)),
    ask: async (body) => {
      await live()
      return (await traced(tab, "ask", ask(body))) as never
    },
    save: async (state) => {
      await live()
      return save(tab, { ...state, ...(gen ? { gen } : {}) })
    },
    mark: async (state) => {
      await live()
      await write(tab, { ...state, ...(gen ? { gen } : {}) })
    },
    // Read once a task (each read goes to the app, and with iCloud on it syncs): kept a couple of minutes.
    entries: async () => (await cachedEntries()).entries,
    policy: { amazon: true },
    maxSteps: MAX_STEPS,
    isStopped: async () => (await load(tab))?.status === "stopped",
    device: cachedDevice,
    apple: appleCall,
    planning: true,
    rules: async () => (await chrome.storage.local.get(RULES_KEY))[RULES_KEY],
    // A start inside the window: the free time may run on past its end by the visit's length.
    calendarFree: (b, days) => calendarFreeLine(b.date, days + 1, b.from, addMinutes(b.until, b.minutes), b.minutes),
    slotFree: calendarSlotFree,
    playbook: { get: playbookGet, put: playbookPut },
    open: async (url) => {
      await live()
      if (!/^https?:\/\//.test(url)) return
      // Never waits on Safari's callback alone (a run stood still after the device opened a place).
      trace(tab, `open ${url.slice(0, 120)}`)
      const complete = waitComplete(tab)
      await Promise.race([new Promise<void>((resolve) => chrome.tabs.update(tab, { url }, () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
      await complete
    }
  }
}

// How a site's booking went (2.7.1): the controls pressed, by site, on the device only; the newest 50 sites.
const PLAYBOOKS_KEY = "agentPlaybooks"
type Playbooks = Record<string, { steps: string[]; at: number }>

async function playbookGet(site: string): Promise<string[] | null> {
  const all = ((await chrome.storage.local.get(PLAYBOOKS_KEY))[PLAYBOOKS_KEY] ?? {}) as Playbooks
  return all[site]?.steps ?? null
}

async function playbookPut(site: string, steps: string[]): Promise<void> {
  const all = ((await chrome.storage.local.get(PLAYBOOKS_KEY))[PLAYBOOKS_KEY] ?? {}) as Playbooks
  all[site] = { steps: steps.slice(0, 12).map((x) => x.slice(0, 60)), at: Date.now() }
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50)
  await chrome.storage.local.set({ [PLAYBOOKS_KEY]: Object.fromEntries(kept) })
}

// What a task reads from the app on every step, read once (2.7.1, the owner on 117: the phone got hot while Do ran —
// each step asked the app for «Мои данные», which syncs with iCloud, and for Calendar and Reminders' access).
let entriesCache: { at: number; value: Promise<{ entries: FormEntry[]; icloud?: boolean }> } | null = null
function cachedEntries(): Promise<{ entries: FormEntry[]; icloud?: boolean }> {
  if (!entriesCache || Date.now() - entriesCache.at > 120_000) entriesCache = { at: Date.now(), value: formData().catch(() => ({ entries: [] })) }
  return entriesCache.value
}
let deviceCache: { at: number; value: Promise<{ reminders: string; calendar: string }> } | null = null
function cachedDevice(): Promise<{ reminders: string; calendar: string }> {
  // Access may change after the person allowed it in the app: read again then (the access step drops the cache).
  if (!deviceCache || Date.now() - deviceCache.at > 60_000) deviceCache = { at: Date.now(), value: appleDevice() }
  return deviceCache.value
}
export function dropAgentCaches(): void {
  entriesCache = null
  deviceCache = null
}

/** The same page, for a deferred task's plan: the address without its fragment. */
const samePage = (a: string, b: string) => a.split("#")[0] === b.split("#")[0]

/**
 * Safari froze the task (its tab or Safari itself in the background) and it stood still: the person is back, so a new run
 * goes on from what was saved (the frozen one, if it ever wakes, stops at its next ask, act or save).
 */
const INFLIGHT_SETTLE_MS = 60_000

const PING_IDLE_MS = 45_000

async function resume(tab: number, idleMs = 15_000): Promise<void> {
  const st = await load(tab)
  trace(tab, `resume? status=${st?.status} idle=${st ? Date.now() - (st.touchedAt ?? 0) : -1} inflight=${!!st?.inflight}`)
  if (!st || st.status !== "running" || Date.now() - (st.touchedAt ?? 0) < idleMs) return
  // A step was on its way when Safari froze the run: not resumed while it may still land; then settled — the model
  // hears that it may or may not have happened and reads the page before doing it again.
  if (st.inflight) {
    if (Date.now() - st.inflight.at < INFLIGHT_SETTLE_MS) return
    st.log.push({ call: st.inflight.call, result: "this step may or may not have happened (Safari paused mid-step): check the page before doing it again" })
    st.inflight = undefined
  }
  const gen = crypto.randomUUID()
  st.gen = gen
  await write(tab, st)
  const p = drive(st, io(tab, gen)).catch((e) => {
    trace(tab, `drive failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    return st
  })
  running.set(tab, p)
  void p.finally(() => {
    if (running.get(tab) === p) running.delete(tab)
  }).then(() => deps.statusChanged())
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

const STALE_RUN_MS = 120_000

async function start(tab: number, url: string, m: Extract<AgentRequest, { type: "agentStart" }>): Promise<Record<string, unknown>> {
  if (!(await deps.consented())) return { ok: false, code: "CONSENT" }
  const plan = await deps.plan()
  if (plan !== "pro" && plan !== "ultra") return { ok: false, code: "PRO_ONLY" }
  const now = await load(tab)
  // A new request over a task still waiting at its plan card replaces it (nothing was done yet); a run that stood still
  // (no save for two minutes, nothing on its way) is stale and goes. A task that's really going on is shown instead.
  if (now && active(now)) {
    const still = Date.now() - (now.touchedAt ?? now.startedAt ?? 0)
    const stale = now.status === "plan" || (now.status === "running" && !now.inflight && still > STALE_RUN_MS)
    if (!stale) return { ok: false, code: "BUSY", state: forPanel(now) }
    await forget(tab)
  }
  const state = newState(crypto.randomUUID(), m.request.slice(0, 2000), m.lang, url, m.deferred)
  // Started inside a chat thread: its last turns go with the plan call, for the request's references (never stored).
  if (typeof m.chat === "string" && m.chat.trim()) state.chat = m.chat.slice(0, CHAT_CHARS + 400)
  if (m.deferred) {
    // Its plan was approved when it was put off: on the same page it goes by it (another page: planned again).
    const d = (await deferredAll()).find((x) => x.id === m.deferred)
    if (d?.plan?.approved && samePage(d.url, url)) state.plan = d.plan
    await removeDeferred(m.deferred, true)
  }
  await save(tab, state)
  const gen = crypto.randomUUID()
  state.gen = gen
  void run(tab, () => drive(state, io(tab, gen))).then(() => deps.statusChanged(), () => undefined)
  return { ok: true, state: forPanel(state) }
}

// The question each tab's last answer went to: a second tap (or the strip and the card both) is the same answer again.
const answered = new Map<number, string>()

async function reply(tab: number, a: Answer, chosen?: string[], key?: string, via: "chat" | "bubble" = "chat"): Promise<Record<string, unknown>> {
  const state = await load(tab)
  if (!state) return { ok: false }
  if (a === "stop") {
    // Stopped at once, even mid-step: the running drive sees the status at its next turn.
    state.status = "stopped"
    state.pending = undefined
    await save(tab, state)
    return { ok: true, state: forPanel(state) }
  }
  // Only for the question on screen, once: never for a later step the person hasn't seen.
  const now = pendingKey(state)
  if (!key || key !== now || answered.get(tab) === key) return { ok: false, code: "STALE", state: forPanel(state) }
  answered.set(tab, key)
  // The person's answer as a count: the recap before a booking taken or dropped; a question answered, and where.
  if (state.pending?.recap && (a === "yes" || a === "no")) deps.use?.({ f: "agent", a: a === "yes" ? "accepted" : "rejected", task: state.id, via })
  else if (state.status === "asked") deps.use?.({ f: "agent", a: "question", task: state.id, via, options: Math.min(9999, state.choices?.length ?? 0), did: "answered" })
  // (An access step answered, or details changed meanwhile: read the app again.)
  dropAgentCaches()
  void run(tab, async () => {
    const fresh = (await load(tab)) ?? state
    // (Queued behind another run: the question may have moved on meanwhile.)
    if (pendingKey(fresh) !== key) return fresh
    return answer(fresh, io(tab, fresh.gen), a, chosen)
  })
  return { ok: true }
}

async function planned(tab: number, approval: PlanApproval): Promise<Record<string, unknown>> {
  const state = await load(tab)
  if (state?.status !== "plan") return { ok: false, state: state && forPanel(state) }
  const a: PlanApproval = { answers: (approval?.answers ?? []).map((x) => String(x ?? "").slice(0, 200)), off: (approval?.off ?? []).map(String) }
  // Each question on the card: answered there or left (counts only).
  state.plan?.questions.forEach((q, i) => deps.use?.({ f: "agent", a: "question", task: state.id, via: "card", options: Math.min(9999, q.options.length), did: a.answers[i]?.trim() ? "answered" : "dismissed" }))
  void run(tab, async () => {
    const fresh = (await load(tab)) ?? state
    return approvePlan(fresh, io(tab, fresh.gen), a)
  }).then(() => deps.statusChanged(), () => undefined)
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
    ...(m.at ? { at: m.at } : {}), ...(m.watch ? { watch: m.watch } : {}), ...(m.plan?.approved ? { plan: m.plan } : {})
  }
  let outcome = "scheduled"
  if (task.at && TARGET === "safari") {
    const r = await callNative<{ outcome: string }>("agent_schedule", { id: task.id, at: task.at, url: task.url, title: m.notifTitle, body: m.notifBody }, 10_000)
    outcome = r?.outcome ?? "failed"
    // Never asked: the card says why and asks on a tap (the system's question, as under a set watch); off: Settings.
    if (outcome !== "scheduled") return { ok: false, code: outcome === "not-asked" ? "NOTIF_ASK" : outcome === "denied" ? "NOTIF_OFF" : "FAILED" }
  }
  // «Также в Напоминания»: the same task in the person's Reminders, due then, without an alert of its own.
  // Titled like the notifications: the plan's name for the task and the site, never the request (Reminders syncs to the
  // Watch, other devices and shared lists).
  if (m.alsoReminder && task.at && (await deferredReminder(task.id, noticeLabel(task.plan, hostOf(task.url)), task.at, task.url))) task.reminder = true
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
    // (Never the request on a lock screen: the site, or the plan's name for the task.)
    const w = words[d.id] ?? { title: "ContextFlow", body: noticeLabel(d.plan, hostOf(d.url)) }
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
        // What broke, briefly (our own code's message, never page content), so the panel can say what failed.
        sendResponse({ ok: false, code: "ERROR", why: String((e as Error)?.message ?? e).slice(0, TEST_PLAN ? 160 : 80) })
      })
      return true
    }
    switch (message?.type) {
      case "agentStart":
        return tab === undefined ? false : respond(start(tab, url, message))
      case "agentAnswer":
        return tab === undefined ? false : respond(reply(tab, message.answer, message.chosen, typeof message.key === "string" ? message.key : undefined, message.via === "bubble" ? "bubble" : "chat"))
      case "agentPlan":
        return tab === undefined ? false : respond(planned(tab, message.approval))
      case "agentGet":
        return tab === undefined ? false : respond(Promise.all([load(tab), past(tab), notice()]).then(async ([s, p, n]) => {
          // The task's own tab is in front again: the ring elsewhere goes, and a task Safari froze goes on.
          if (n && n.tab === tab) await clearNotice()
          void resume(tab)
          return { state: s && forPanel(s), past: p }
        }))
      case "agentSeen":
        return respond(seen(message.visible === true, message.words, tab, typeof message.doc === "string" ? message.doc.slice(0, 40) : "").then(() => ({ ok: true })))
      // The task's page, visible, says it's there every 20 s: a run with no step for 45 s is picked up again (TheFork:
      // a press opened a page and the run never heard back — Safari had paused the background mid-step).
      case "agentPing":
        // (Only a visible page pings: Safari is in front, whatever an older page said.)
        if (tab !== undefined) {
          pagesSeen.report(tab, typeof message.doc === "string" ? message.doc.slice(0, 40) : "", true)
          void back()
        }
        return respond(tab === undefined ? Promise.resolve({ ok: false }) : resume(tab, PING_IDLE_MS).then(() => ({ ok: true })))
      case "agentFocus":
        return respond(focusTask(String(message.id ?? "").replace(/^run_/, ""), tab))
      case "agentNoticeGet":
        return respond(notice().then((n) => ({ notice: n && n.tab !== tab ? n : null })))
      case "agentGoTab":
        return respond(goTab().then((ok) => ({ ok })))
      case "agentNoticeClear":
        return respond(clearNotice().then(() => ({ ok: true })))
      case "agentNoticeAnswer":
        return respond(noticeAnswer(message.answer, Array.isArray(message.chosen) ? message.chosen.map((c: unknown) => String(c ?? "").slice(0, 300)) : undefined, typeof message.key === "string" ? message.key : ""))
      case "agentUndo":
        return tab === undefined ? false : respond(undoAll(tab).then((ok) => ({ ok })))
      case "agentClose":
        return tab === undefined ? false : respond(close(tab, message.keep === true).then(() => past(tab)).then((p) => ({ ok: true, past: p })))
      case "agentForgetPast":
        return tab === undefined ? false : respond(forgetPast(tab, message.id).then(() => ({ ok: true })))
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
        return respond(TARGET === "safari" ? callNative("agent_access_open", { kind: message.kind === "calendar" ? "calendar" : "reminders", ...(message.settings ? { settings: true } : {}) }, 5000).then((r) => r ?? { opened: false }) : Promise.resolve({ opened: false }))
      // Settings' «Календарь и Напоминания»: whether the app may read them now (asked each time the panel shows it).
      case "agentAccess": {
        // Read fresh, and the agent's next look reads it too (the person may have just allowed it in the app).
        deviceCache = null
        return respond(cachedDevice().catch(() => ({ reminders: "unavailable", calendar: "unavailable" })))
      }
      case "agentDeferCancel":
        return respond(removeDeferred(message.id).then(() => ({ ok: true })))
      case "formData":
        return respond(formData())
      case "formDataPut":
        dropAgentCaches()
        return respond(formDataPut(message.changes))
      case "formDataICloud":
        return respond(
          TARGET === "safari"
            ? callNative<NativeFormData>("formdata_icloud", { on: message.on }, 15_000).then((raw) => ({ entries: parseEntries(raw), ...formDataState(raw), icloud: message.on }))
            : Promise.resolve({ entries: [], icloud: false })
        )
      default:
        return false
    }
  })
  // The task's tab came to the front: its ring elsewhere goes. (A tab switch also means Safari is in front.)
  chrome.tabs.onActivated?.addListener(({ tabId }) => {
    switchedAt = Date.now()
    void seen(true)
    void resume(tabId)
    void notice().then((n) => {
      if (n && n.tab === tabId) void clearNotice()
    })
  })
  // A tab the task's own press opened (a site that opens a place with a script, not a link: a hotel's page, 125): the
  // task goes there in its own tab and the extra tab closes, so the task never waits on a page it can't see. Only
  // right after a step of a running task, and only the same site's page.
  chrome.tabs.onCreated?.addListener((t) => {
    const opener = t.openerTabId
    if (t.id === undefined || opener === undefined) return
    void (async () => {
      const st = await load(opener)
      // (Or the person's own tap the task asked for: a page that opens its place in a new tab only for a real tap, 128.)
      const theirs = st?.status === "self" && st.pending?.verdict.reason === "new_tab"
      if (!st || (!theirs && (st.status !== "running" || Date.now() - (st.touchedAt ?? 0) > 8_000))) return
      const url = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => done(t.pendingUrl ?? t.url ?? ""), 4_000)
        const done = (u: string) => {
          clearTimeout(timer)
          chrome.tabs.onUpdated.removeListener(listener)
          resolve(u)
        }
        const listener = (id: number, info: { url?: string }) => {
          if (id === t.id && info.url && /^https?:/.test(info.url)) done(info.url)
        }
        chrome.tabs.onUpdated.addListener(listener)
        if (/^https?:/.test(t.pendingUrl ?? t.url ?? "")) done(t.pendingUrl ?? t.url ?? "")
      })
      const here = await new Promise<string>((resolve) => chrome.tabs.get(opener, (o) => resolve(chrome.runtime.lastError ? "" : o?.url ?? "")))
      if (!url || !here || !sameSite(hostOf(url), hostOf(here))) return
      trace(opener, `the task's press opened a tab: back in the task's own tab (${hostOf(url)})`)
      chrome.tabs.update(opener, { url, active: true }, () => void chrome.runtime.lastError)
      chrome.tabs.remove(t.id!, () => void chrome.runtime.lastError)
    })()
  })
  // A tab that closed takes its task with it.
  chrome.tabs.onRemoved.addListener((tab) => {
    pagesSeen.drop(tab)
    void forget(tab)
    void chrome.storage.local.remove(PAST_KEY(tab))
  })
  // The app may have cancelled some; its list gets this device's.
  setTimeout(() => void syncDeferred().catch(() => undefined), 5_000)
}

/** The keys the model may fill (for tests and the panel's hint). */
export function savedKeys(entries: FormEntry[]): string[] {
  return [...new Set(liveEntries(entries).map(modelKey))]
}
