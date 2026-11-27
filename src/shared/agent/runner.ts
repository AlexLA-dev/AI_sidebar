// The agent's task (2.7.1), step by step: ask /api/v2/act, then do the step, wait for the person, or finish. Plain
// logic with its tab, server and storage passed in (the background gives the real ones, the tests fakes), and every
// stop of it kept in the state, so a background Safari wakes up again (about 30 s idle) and a page that navigates go on.
// - free: done at once; «Сделать?» (confirm): waits for Да / Нет; fill: waits for «Заполнить» with the values the
//   person sees (the model and the server never do); the person's own (self): waits for «Готово» or «Не сейчас»;
//   blocked: told back to the model; a blocked site ends the task with its own explanation.
// - Re-checked here before the hands act: a step's class from the server is never trusted to be milder than the
//   device's own check says (classify.ts runs again on the device's map).

import { APPLE_TOOLS } from "./call.ts"
import { dayItems, dayOf, dayWords, daysInText, isDateLabel, showsDay, weekdayOnly } from "./dates.ts"
import { wordTest } from "./match.ts"
import { BOOKING_WORDS, CANCEL_TERMS_WORDS, NEXT_FREE_WORDS } from "./words.ts"
export { dayItems, isDateLabel }
import { classify } from "./classify.ts"
import { countRefusal } from "./counts.ts"
import { keyOfAutocomplete, liveEntries, modelKey, shapeValue, withNameParts, type FormEntry } from "./formdata.ts"
import { hostOf, sameSite, siteOfHost, type SitePolicy } from "./sites.ts"
import { pageSubject, subjectLine, titleName } from "./subject.ts"
import { cardsOf, onVenue, rankVenues, venueNote, venueOf, venuesOn, type Venue } from "./venues.ts"
import { addDays, freeLineIn, honestChoices, looksLikeSlot, nearerTimes, pageChoices, readRules, rulesLine, shiftZone, timesIn } from "./rules.ts"
import { setDates, type DatesIO, type DatesResult } from "./setdates.ts"
import { pageKind } from "./events.ts"
import { addContactFill, NAME_SAID, bareLabel, buildPlan, contactField, contactKind, requestGives, pathOf, checkPlan, contactAsked, covered, fieldKind, keyKind, factKey, factLabel, missingPress, personWords, requestWithAnswers, planLine, planNeedsPerson, contactInWords, priceChanged, saidInWords, savedAnswers, type Perm, type PlanBooking, type PlanQuestion, type TaskPlan, DAY_KINDS, sameTaskPage, windowOf } from "./taskplan.ts"
import type { LogEntry, MapItem, PageMap, StepClass, StepResult, StepVerdict, ToolCall } from "./types.ts"
import type { AgentRule } from "../usage.ts"

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
  // The device closed a layer over the page that wasn't the task (a promotion, the site's app, notifications).
  popup?: boolean
}

/** What the booking's last press will book, said before it only when it isn't what the person asked (another day, time
 *  or place) or it's the first booking on a site that shows its cancellation terms (2.7.1, B2). */
export interface Recap {
  place?: string
  date?: string
  // A stay's or a rental's last day.
  dateEnd?: string
  time?: string
  // What the request asked, when the booking differs from it.
  askedDate?: string
  askedTime?: string
  otherPlace?: boolean
  // The page's own sentence about cancelling (its words, shown as they are).
  terms?: string
  // Said under a «Do it?» for the press (the plan didn't allow it), not instead of it.
  press?: boolean
}

export interface AgentState {
  id: string
  request: string
  lang: string
  url: string
  startHost: string
  step: number
  token: string | null
  // (Kept for old states: a «Да» given somewhere in the task. What counts now is confirmedSites.)
  confirmedHere: boolean
  // The sites a «Да» (or the person's own step, or the plan) was given on in this task: a free step on a site the task
  // came to later asks first (the security review: one «Да» used to count for any site after a redirect).
  confirmedSites?: string[]
  // The host the task is on now.
  host?: string
  strongUsed: number
  status: AgentStatus
  log: LogEntry[]
  lines: AgentLine[]
  pending?: { call: ToolCall; verdict: StepVerdict; target: string | null; offRequest?: string; fill?: FillLine[]; price?: string; recap?: Recap }
  // The plan card (status "plan"), then the approved plan the steps go by (2.7.1, the owner's autonomy note).
  plan?: TaskPlan
  summary?: string
  error?: string
  // What «Отменить» puts back, newest last.
  undo: NonNullable<StepResult["undo"]>[]
  left?: number | null
  // The day's tasks of the plan, said when they ran out («(… a day)» was empty: the server's limit wasn't kept).
  limit?: number
  data?: string
  refused?: string
  // The deferred task it came from, when it did.
  deferred?: string
  startedAt: number
  // Which run of it is the live one (the background starts a new one when Safari froze the last), and its last save.
  gen?: string
  touchedAt?: number
  // A step on its way to the page (written before it's sent, cleared after): a run Safari froze mid-step leaves it, and
  // the next run settles it instead of doing the step blindly again.
  inflight?: { step: number; call: ToolCall; at: number }
  // Calendar or Reminders were read in this task: text typed into a page that isn't the person's own words asks first
  // (the security review: a page's hidden instructions could have the agent type what it read there into a field).
  readDevice?: boolean
  // «done» came once before a press the plan lists as the agent's own had happened: the model was sent back for it.
  doneNudged?: boolean
  // The page as last read, and how many reads in a row found it the same (TestFlight 118: 25 reads of a date with no
  // free time, then «too many steps»).
  lastSig?: string
  stillReads?: number
  lastWasRead?: boolean
  // ask_user's answers offered as buttons, and the person's answers to the agent's questions (theirs to type).
  choices?: string[]
  replies?: string[]
  // A booking whose calendar rule couldn't be kept: the app has no access (the result says so).
  calSkipped?: boolean
  // The one place, product or specialist the start page is about (subject.ts): the task's target unless the request
  // names another (the owner on 121).
  subject?: string
  // The booking provider's form (a frame on the start page) the device opened on its own page.
  widgetOpened?: string
  // The last turns of the chat the task was started from (chatctx.ts): the plan call only, for the request's references.
  chat?: string
  // The contact detail the question asks for, when «Мои данные» hasn't got it (the panel offers to keep the answer).
  askKey?: string
  // A booking (2.7.1, the owner: «оглядывался и на свободные слоты в календаре»): the person's rules as the model hears
  // them, the Calendar's free times for it (worked out on the device: only times), how this site's booking went last
  // time, the time slot pressed (checked against the Calendar), and what was booked (said by «done»).
  rules?: string
  calendar?: string
  playbook?: string
  slot?: { date: string; time: string }
  // The day and time slot the agent pressed for the booking (what its last press will book), and whether the recap
  // before that press was shown (B2: only once).
  picked?: { date?: string; time?: string }
  recapShown?: boolean
  // The usage events already sent for this task (src/shared/agent/events.ts), and its start page's kind.
  ev?: { start?: boolean; end?: boolean }
  pageKind?: string
  // A question sent back once because the page's own date field showed another day (B3).
  widgetNudged?: boolean
  // Waits for a control the page showed disabled (a bad call on it), at most two.
  disabledWaits?: number
  // The map's part the model asked for (read_page), read at the next step only.
  readPart?: number
  // The pages this task has been on, in order (origin and path): «back» goes only to the one before, never past the
  // task's first page (round 141: a second «back» left the site for a blank page).
  trail?: string[]
  // A «done» sent back once on a page that asks for the person's details (details_next).
  detailsNudged?: boolean
  // Pages (origin and path) where set_dates found no date control: it isn't run there again (round 141's real sites: up
  // to nine calls in a run, each «no date control recognised»).
  datesNone?: string[]
  // A stay's or a rental's days as set_dates set them (its first day, and its last when known): pressing either by hand
  // afterwards is never refused (round 141: a stays site's last day refused as «before the asked day» and «pressed already»).
  stay?: { in: string; out?: string }
  // The outline's parts the model opened on this page (read_page with an outline): they stay open (round 139).
  openParts?: { page: string; parts: number[] }
  slotRefusals?: number
  // The person's standing rule for how many people (guests, tickets, seats) when the request doesn't say.
  ruleParty?: number
  // Date presses without progress (a time to choose), the last date pressed, and whether a fully greyed strip was
  // tapped once to wake it.
  dateSteps?: number
  lastDate?: string
  wokeStrip?: boolean
  // The page has shown the booking's day (a strip's «Sat 26 Dec», a calendar's «26» under «December»), and whether a
  // question before that was sent back once (a salon booking site, 124: «26 декабря нет, ближайшая суббота — 5 декабря» without the
  // calendar ever opened; the page had 26 Dec free and 5 Dec greyed).
  // Contact details answered on the plan card and not kept in «Мои данные»: filled by key in this task only.
  oneTime?: Array<{ key: string; value: string }>
  // Slots the device already pointed a nearer or earlier free time for (said once each: 127).
  nearSaid?: string[]
  sawDate?: boolean
  dateNudged?: boolean
  // A question sent back once because the page named its next free day.
  nextNudged?: boolean
  // The person chose to pick the specialist on the place's page: that one question passes when it comes.
  askSpecialist?: boolean
  // Layers over the page the device closed itself (at most three a task), and the presses they came after.
  popups?: number
  closedAfter?: string[]
  // A window's days pressed in this task, in order (decision 14a), whether a later one was sent back for an earlier
  // offered one, and whether the question for a window with no offered day passed (14c).
  windowPressed?: string[]
  windowEarlier?: boolean
  windowAsked?: boolean
  // Cookie layers the device refused itself (decision 13a: at most three a task, once per page address).
  cookieDevice?: number
  cookiePages?: string[]
  // A question asking leave to use a contact the person gave was sent back (decision 13b: once a task).
  givenAsk?: boolean
  // Contact fields a booking's sending press was sent back for while empty (decision 13c: once per field).
  contactEmpty?: string[]
  // The booking's day as the page shows it greyed (a strip greys days it hasn't loaded: a booking site's «Sat 26 Dec» answered
  // «full», with its next free day once pressed), and whether it was pressed once to hear the page.
  greyTarget?: string
  pressedTarget?: boolean
  // The rules let the agent choose the place; how many times a question was sent back to try the next one.
  chooseVenue?: boolean
  // The plan's place question asked (askPlace): once.
  placeAsked?: boolean
  venueNudges?: number
  minRating?: number
  // The places that fit (ranked on the device from a results list), and the ones already tried.
  venues?: { list: Venue[]; tried: string[] }
  booked?: { date: string; time: string; place?: string }
  // The line the last step made, checked against the page that step led to (a day in it only when the page shows it set).
  lineCheck?: number
  // The booking's last press refused because the page didn't show its days set (128: a stay booked with «Choose your
  // dates» on its page), and the days the page showed when that press went.
  dateRefusals?: number
  bookedDays?: { date: string; dateEnd?: string }
  daysAtPress?: { date: string; dateEnd?: string }
  // The booking's press that went (the director on d05b60bb: «Your stay is booked», then «Do it? Press "Reserve"» again):
  // the one the person said yes to on the recap card, or the plan's permission that stood for that card. From it on, no
  // other booking press, unless the page asked for more details since (a form after the first press); how many refused.
  bookPress?: { target: string; at: number; yes: boolean }
  // No booking press recorded, but a sign of a booking at the end (the done's confirmed day, a confirmation on the page):
  // neither «booked» nor «nothing was booked» is said.
  bookUnseen?: boolean
  // The control the last counted date step pressed (a press of it that changed nothing gives the step back).
  lastDateId?: string
  bookAgain?: number
  // The place the person chose on the plan card: a later question about the place is the model's, refused (one question,
  // once), and how many times.
  cardPlace?: string
  placeAgain?: number
  // How many times each of the device's rules refused or held a step in this task, by code (the end event says so: codes and
  // counts only, never what was refused).
  ruleCounts?: Partial<Record<AgentRule, number>>
  // The address the last tap's page tried to open in a new tab (shown as a link, gone to through the usual checks), and
  // what the tap was on; places whose tap changed nothing (never offered again as a choice).
  openedLink?: { url: string; from: string; page?: string }
  placeOpened?: string
  dead?: string[]
  // Pages whose own search was asked for once before a place was opened from them (128).
  searchNudged?: string[]
  // Fields of someone else's booking the person's saved contact was kept out of once (128).
  otherLeft?: string[]
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
  limit?: number
  strong?: boolean
  // The plan's makings (task.phase "plan"): the device classes what was foreseen on its own map.
  plan?: unknown
}

export interface RunnerIO {
  // The page's map now (null: the page is changing; the runner waits and asks again). `money`: with every amount on the
  // page (it reads the whole page's text: only when the plan's price check needs it).
  map(opts?: { money?: boolean; part?: number; open?: number[]; openUrl?: string; words?: string[] }): Promise<PageMap | null>
  // Keeps the state without telling the panel (the in-flight mark before a step: no extra render).
  mark?: (state: AgentState) => Promise<void>
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
  // «Правила поручений» as stored (the defaults when there are none).
  rules?: () => Promise<unknown>
  // The Calendar's free times for a booking, on the device, with the rules' buffers ("2026-11-24 17:00–19:30; …",
  // "none"); and whether one time is free (null: can't tell).
  calendarFree?: (b: PlanBooking, days: number) => Promise<string | null>
  slotFree?: (date: string, time: string, minutes: number) => Promise<boolean | null>
  // How a site's booking went last time (the controls pressed, in order), kept on the device.
  playbook?: { get(site: string): Promise<string[] | null>; put(site: string, steps: string[]): Promise<void> }
  // Opens a page in the task's tab by its address (the next place by the rules) and waits for it.
  open?: (url: string) => Promise<void>
}

/** Which of the two a Calendar and Reminders tool needs. */
export function appleKind(tool: ToolCall["tool"]): "reminders" | "calendar" {
  return tool === "calendar" || tool === "event_add" ? "calendar" : "reminders"
}

/** The device's date, weekday, time and zone, for the model's «tomorrow» and «after 18:00». */
/** The person's today, YYYY-MM-DD, and zone. */
function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    return ""
  }
}

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
async function perform(state: AgentState, io: RunnerIO, call: ToolCall, verdict: StepVerdict, target: string | null, value?: string, byPlan?: boolean, booking?: boolean): Promise<StepResult | null> {
  const doing: ToolCall = call.tool === "fill" ? { ...call, text: value ?? "" } : call
  // Calendar and Reminders: on the device, not on the page (what they read goes to the next step, like extract).
  if (APPLE_TOOLS.has(call.tool)) {
    const r = io.apple ? await io.apple(call).catch(() => null) : null
    const result = r ?? { ok: false, note: "Calendar and Reminders aren't there on this device" }
    if (result.data) {
      state.data = result.data
      state.readDevice = true
    }
    state.log.push({ call, result: noteOf(result) })
    state.lines.push(line(call, verdict, target, result.ok, undefined, byPlan))
    return result
  }
  state.inflight = { step: state.step, call: call.tool === "fill" ? { tool: "fill", id: call.id, key: call.key } : call, at: Date.now() }
  await (io.mark ?? io.save)(state)
  // The address a tap's page tried to open in a new tab, gone to here (its «go» passed the checks like any other).
  const opening = (call.tool === "go" || call.tool === "click") && call.id === NEW_TAB_ID && state.openedLink && io.open ? state.openedLink : null
  let result = opening ? await io.open!(opening.url).then(() => ({ ok: true, navigated: true, note: "the page went on" }) as StepResult, () => ({ ok: false, note: "it couldn't be opened" }) as StepResult) : await io.act(doing)
  if (opening) state.openedLink = undefined
  state.inflight = undefined
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
  // A tap that changed nothing isn't done (128: five ✓ «Opening Harbour View Suites again…» on a card that never opened).
  const idle = (call.tool === "click" || call.tool === "go") && /^nothing changed on the page/.test(result.note ?? "")
  state.lines.push(line(call, verdict, target, result.ok && !idle, undefined, byPlan))
  state.lineCheck = state.lines.length - 1
  const pressed = /"(.*)"$/.exec(target ?? "")?.[1] ?? ""
  if (idle && pressed && !state.dead?.includes(pressed)) state.dead = [...(state.dead ?? []), pressed]
  // A day pressed that changed nothing (a calendar showing each day twice, one copy dead) isn't a date step that «went
  // nowhere»: the count and the «pressed already» mark go back, so the day's other copy can be pressed.
  if (idle && call.id && state.lastDateId === call.id) {
    state.dateSteps = Math.max(0, (state.dateSteps ?? 0) - 1)
    state.lastDate = undefined
    state.lastDateId = undefined
  }
  // A press that changed nothing, beside a choice still at its first option or 0 (the director on ffb2b665: a room table's
  // «I'll reserve» with «Select rooms» at 0 — pressed, then three reads and the task ended): the log says which, so the
  // model sets it and presses again.
  if (idle && call.id) {
    const after = await io.map().catch(() => null)
    const near = after ? untouchedNear(after, call.id) : []
    if (near.length) state.log[state.log.length - 1].result += `; beside it, still at their first option: ${near.join(", ")} — set the one the request needs (a number of rooms, a size, a time), then press it again`
  }
  // (The place a tap opened from a list, by its card's name: the recap names it when the page doesn't.)
  if (!idle && pressed && (state.venues?.list.some((v) => v.name === pressed) || result.opened)) state.placeOpened = pressed
  if (result.opened) {
    state.openedLink = { url: result.opened, from: pressed }
    state.log[state.log.length - 1].result = `the page tried to open ${result.opened} in a new tab, which the browser keeps the task out of: to open it here, go to link #${NEW_TAB_ID}`
  }
  // The page's world couldn't be watched and the tap did nothing: the browser likely blocked a new tab the agent's tap
  // can't open. The person taps it themselves; the device follows the tab it opens (background: onCreated).
  if (result.tabBlocked && state.status === "running") {
    state.log[state.log.length - 1].result = "nothing changed: the page may have tried to open a new tab, which the browser blocks for the agent's tap — the person taps it themselves"
    state.status = "self"
    state.pending = { call, verdict: { cls: "self", reason: "new_tab" }, target }
  }
  // The booking's last press went: what it booked is the days the page showed then (the «done» may leave them out).
  if (verdict.cls === "confirm" && verdict.reason === "submit" && result.ok && state.daysAtPress) state.bookedDays = state.daysAtPress
  if (booking && result.ok && call.tool !== "fill" && state.plan?.booking) state.bookPress = { target: target ?? call.id ?? "", at: state.log.length, yes: !byPlan }
  return result
}

/** An address as the map writes a link's: its path on the same site, its host and path on another. */
function mapHref(url: string, page: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/^www\./, "")
    const path = `${u.pathname}${u.search}`.slice(0, 120)
    return sameSite(host, hostOf(page)) ? path : `${host}${path}`.slice(0, 140)
  } catch {
    return url
  }
}

/** The map item the address a tap tried to open in a new tab stands as (the model goes to it like any link). */
export const NEW_TAB_ID = "newtab"

// The request pointing into the chat it came from, in the panel's languages: an ordinal, «that one», «the one you
// suggested», «there» (a place the chat named). Without one, a place only the chat names isn't the person's.
const POINT_WORDS = /(?<!\p{L})(that|those|the (first|second|third|last|same|one you)|one you (found|suggested|recommended)|you (found|suggested|recommended)|your (suggestion|pick)|there|тот|та|того|ту|этот|эту|этого|там|туда|перв\p{L}*|втор\p{L}*|трет\p{L}*|последн\p{L}*|предложенн\p{L}*|найденн\p{L}*|т(ой|ом) же|той|цей|цю|той самий|там|перш\p{L}*|друг(ий|а|е|ого|у)|остан\p{L}*|запропонован\p{L}*|знайден\p{L}*|diese[nmrs]?|dort|ersten?|zweiten?|dritten?|letzten?|vorgeschlagen|celui|celle|là|premier|première|deuxième|second|troisième|dernier|proposé|ese|esa|ese mismo|allí|ahí|primer[oa]?|segund[oa]|tercer[oa]?|últim[oa]|sugerid[oa]|quell[oaie]|lì|là|prim[oa]|second[oa]|terz[oa]|ultim[oa]|suggerit[oa]|aquel[ae]?|lá|sugerid[oa]|şu|o otel|orada|ilk|ikinci|üçüncü|en son|önerdiğin|ذلك|تلك|هناك|الأول|الثاني|الثالث|الأخير|المقترح|đó|ấy|thứ nhất|thứ hai|thứ ba|cuối|bạn gợi ý)(?!\p{L})/iu
// (Chinese, Japanese and Korean words sit between other letters: no word edges there.)
const POINT_CJK = /その|あの|そこ|最初|[2２二]番目|[3３三]番目|最後|おすすめ|거기|첫\s*번째|두\s*번째|세\s*번째|마지막|추천한|그\s*(곳|숙소|호텔|식당)|那个|那個|那家|那裡|那里|第[一二三]|最后|最後|推荐的|推薦的/u
export const POINTS = { test: (text: string) => POINT_WORDS.test(text) || POINT_CJK.test(text) }

const squashName = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

/** The names of the places this page lists: its place cards, and links that are a card's own (no address: a script opens them). */
function pagePlaces(map: PageMap): string[] {
  const own = (i: MapItem) => i.role === "link" && (!!i.card || !i.href) && i.label.trim().length >= 3 && i.label.trim().length <= 80
  return [...new Set([...venuesOn(map).map((v) => v.name), ...map.items.filter(own).map((i) => i.label.trim())])]
}

/** The place the chat's assistant suggested, among this page's: the one the plan's «From the chat» names, else the first
 *  the chat's last answer names. Data from the chat, never instructions: it only orders a question's options. */
export function chatSuggestion(chat: string, fromChat: string, places: string[]): string {
  const said = places.find((n) => fromChat && namedIn(n, fromChat))
  if (said) return said
  const answers = chat.split("\n").filter((l) => l.startsWith("assistant:"))
  const last = (answers.at(-1) ?? "").toLocaleLowerCase()
  const at = places.map((n) => ({ n, i: last.indexOf(n.toLocaleLowerCase()) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)
  return at[0]?.n ?? ""
}

/** One more refusal or hold by the device's rule `code` (counted for the task's end event). */
function rule(state: AgentState, code: AgentRule): void {
  state.ruleCounts = { ...state.ruleCounts, [code]: Math.min(99, (state.ruleCounts?.[code] ?? 0) + 1) }
}

/** Which slot rule a slot refusal is (the messages slotRefusal and slotWhy write). */
export function slotCode(why: string): AgentRule {
  return /^a time slot: say its date/.test(why) ? "slot_time" : / is outside the time /.test(why) ? "slot_window" : / is free on the page and /.test(why) ? "slot_nearer" : "slot_busy"
}

/** The place of this page (or of the places the agent found) the person's answer names: the one sharing the most of its
 *  name's distinctive words with the answer, two at least (or its whole name); "" for none or a tie. */
export function placeInReply(text: string, state: Pick<AgentState, "venues">, map: PageMap): string {
  const words = (t: string) => new Set((t.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !COMMON.has(w) && !/^\d+$/.test(w)))
  const said = words(text)
  // (Places only: the agent's found ones and the page's rated links, a review count or not («… 8.8 Excellent», a
  // «Similar properties» card) — a hotel's own room rows aren't places.)
  const rated = map.items.flatMap((i) => venueOf(i, map.url)?.name ?? (i.role === "link" && /(?<![\d.,])(10|[1-9])[.,]\d(?![\d.,])/.test(i.label) ? [i.label] : []))
  const names = [...new Set([...(state.venues?.list.map((v) => v.name) ?? []), ...rated].map(placeName).filter((n) => n.length >= 3))]
  const scored = names.map((n) => ({ n, k: namedIn(n, text) ? 99 : [...words(n)].filter((w) => said.has(w)).length })).filter((x) => x.k >= 2).sort((a, b) => b.k - a.k)
  if (!scored.length || (scored[1] && scored[1].k === scored[0].k && squashName(scored[1].n) !== squashName(scored[0].n))) return ""
  return scored[0].n
}

// (Words in so many places' names that sharing them says nothing.)
const COMMON = new Set(["hotel", "hotels", "apartment", "apartments", "house", "restaurant", "with", "from", "instead", "book", "this", "that", "there"])

/** A place's distinctive words (not «hotel», «restaurant»…). */
function placeWords(name: string): string[] {
  return [...new Set(fold2(placeName(name)).match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !COMMON.has(w) && !/^\d+$/.test(w))
}

/** Whether a place's name is the chosen one: every distinctive word of the chosen name is in it. */
function samePlace(chosen: string, name: string): boolean {
  const want = placeWords(chosen)
  const have = new Set(placeWords(name))
  return want.length > 0 && want.every((w) => have.has(w))
}

/**
 * A press on a list of places that belongs to another place than the chosen one: why it's refused, or null. The place a
 * control belongs to is its own link's, or the place whose link heads it on the list (the nearest place link before it,
 * within its card's reach). Only on a page that lists the chosen place too (its own link is named in the refusal), and
 * never on the chosen place's own page (a «similar places» card there is not the place).
 */
export function otherPlace(state: Pick<AgentState, "plan">, map: PageMap, item: MapItem): string | null {
  const chosen = state.plan?.booking?.venue
  if (!chosen) return null
  const at = map.items.indexOf(item)
  if (at < 0) return null
  const places = map.items.map((i) => ({ i, v: venueOf(i, map.url) })).filter((x) => !!x.v) as Array<{ i: MapItem; v: Venue }>
  if (places.length < 2) return null
  const right = places.find((x) => samePlace(chosen, x.v.name))
  if (!right || onVenue(map.url, right.v)) return null
  let own = venueOf(item, map.url)
  if (!own) {
    // (The nearest place link before it, with no more than 25 controls between: a card's reach.)
    for (let k = at - 1; k >= Math.max(0, at - 25) && !own; k--) own = venueOf(map.items[k], map.url)
  }
  if (!own || samePlace(chosen, own.name) || own.url === right.v.url) return null
  return `«${item.label.slice(0, 60)}» belongs to «${placeName(own.name).slice(0, 60)}», not «${chosen}», the place chosen: press «${chosen}»'s own link (id ${right.i.id}), not another place's`
}

/** A place's name out of a card's label: before its rating, distance or price («… The Palm Suites - Adults Only 8.8 Excellent…»). */
function placeName(label: string): string {
  return label.split(/\s+\d|\s[·•|]\s|\n/)[0].trim().slice(0, 100)
}

/** The person chose this place: the booking's from now on, and the plan's answer about the place says it. */
function choosePlace(state: AgentState, name: string): void {
  const plan = state.plan
  if (!plan?.booking) return
  plan.booking.venue = name
  plan.askPlace = false
  state.chooseVenue = false
  state.cardPlace = name
  const where = plan.questions.findIndex((q) => q.kind === "venue" || q.fact === "venue" || q.place)
  const answers = plan.answers ?? []
  if (where >= 0 && answers[where]) answers[where] = { ...answers[where], a: name }
  else answers.push({ q: "Where to book", a: name })
  plan.answers = answers
}

/** The choices in the same form as a control (or near it on the page, when it's in none) still at their first option, 0 or
 *  empty: «"Select rooms" (0)». At most three. */
export function untouchedNear(map: PageMap, id: string): string[] {
  const at = map.items.findIndex((i) => i.id === id)
  if (at < 0) return []
  const it = map.items[at]
  const near = it.form !== undefined ? map.items.filter((i) => i.form === it.form) : map.items.slice(Math.max(0, at - 12), at + 13)
  const choice = (i: MapItem) => (i.role === "select" || i.role === "combobox" || i.role === "listbox") && !!i.options?.length
  const untouched = (i: MapItem) => {
    const v = (i.value ?? "").trim()
    return !v || v === i.options![0] || /^0(\s|$)/.test(v)
  }
  return near.filter((i) => i.id !== id && choice(i) && untouched(i)).slice(0, 3).map((i) => `«${i.label.slice(0, 40)}» (${(i.value ?? "").trim() || "empty"})`)
}

/** A booking task that ended with no booking press gone: nothing was booked, whatever the model's words say. */
export function nothingBooked(s: Pick<AgentState, "status" | "plan" | "bookPress" | "bookUnseen">): boolean {
  return s.status === "done" && !!s.plan?.booking && !s.bookPress && !s.bookUnseen
}

// A booking's confirmation in a page's words, in the panel's languages: a booking or reservation confirmed, its number.
// Narrow on purpose (a list's «booked 12 times today» isn't one).
const CONFIRMED = new RegExp([
  "\\b(booking|reservation|appointment|order)\\s+(is\\s+|has\\s+been\\s+)?confirmed\\b",
  "\\b(your|the)\\s+(booking|reservation|table|stay|room|appointment|visit)\\s+(is|has\\s+been)\\s+(confirmed|booked)\\b",
  "\\b(booking|reservation|confirmation)\\s+(number|code|id)\\b",
  "бронировани[ея]\\s+подтвержден|номер\\s+бронировани|запись\\s+подтвержден|заказ\\s+подтвержден",
  "бронювання\\s+підтверджен|номер\\s+бронювання",
  "buchung\\s+(ist\\s+)?bestätigt|reservierung\\s+(ist\\s+)?bestätigt|buchungsnummer|reservierungsnummer",
  "réservation\\s+(est\\s+)?confirmée|numéro\\s+de\\s+réservation",
  "reserva\\s+(está\\s+|foi\\s+)?confirmada|número\\s+de\\s+(la\\s+)?reserva|número\\s+da\\s+reserva",
  "prenotazione\\s+(è\\s+)?confermata|numero\\s+di\\s+prenotazione",
  "rezervasyon(unuz)?\\s+onaylandı|rezervasyon\\s+numarası",
  "đặt\\s+(chỗ|phòng)\\s+(đã\\s+được\\s+)?xác\\s+nhận|mã\\s+đặt\\s+(chỗ|phòng)",
  "تم\\s+تأكيد\\s+الحجز|رقم\\s+الحجز",
  "予約が確定|予約番号|予約を承りました",
  "예약이\\s*확정|예약\\s*번호|예약이\\s*완료",
  "预订成功|预订已确认|预订号|預訂成功|預訂已確認|預訂編號"
].join("|"), "iu")

/** Whether a page shows a booking's confirmation. */
export function confirmedOnPage(map: PageMap): boolean {
  return CONFIRMED.test(`${map.title ?? ""}\n${map.text}`)
}

/** The last step the task did, as its line says (for «how far it got»). */
export function lastDone(s: Pick<AgentState, "lines">): string {
  return [...(s.lines ?? [])].reverse().find((l) => l.ok && l.text)?.text ?? ""
}

/** One place's own booking page: its title names it (as the page shows it), no list of places, and the booking's own
 *  controls (days, times, a date field, a details form). A page titled by its action («Book») is no place's own. */
export function ownBookingPage(map: PageMap): boolean {
  if (venuesOn(map).length || !titleName(map)) return false
  return detailsForm(map) || map.items.some((i) => i.type === "date" || isDateLabel(i.label) || looksLikeSlot(i.label))
}

/** A date control that opens the page's date picker rather than choosing a day in it: it says it opens a popup or a list,
 *  or it's a date field. */
export function opensPicker(_map: PageMap, item: MapItem): boolean {
  if (item.state?.some((x) => x === "popup" || x === "collapsed" || x === "expanded")) return true
  return item.role === "combobox" || item.role === "textbox" || item.type === "date"
}

/** Why another booking press is refused, or null: the booking's press went already, and the page asked for nothing
 *  more since (no detail typed, filled or chosen after it). */
export function pressedAlready(state: AgentState, map: PageMap): string | null {
  const b = state.bookPress
  if (!b) return null
  const more = state.log.slice(b.at).some((e) => (e.call.tool === "fill" || e.call.tool === "type" || e.call.tool === "select") && !/^(failed|refused|the person)/.test(e.result))
  if (more) return null
  const shows = `${map.title ? `${map.title}: ` : ""}${map.text.replace(/\s+/g, " ").trim()}`.slice(0, 220)
  return `the booking's press already went: ${b.target} was pressed ${b.yes ? "with the person's yes" : "as the plan allows"}, and this page now shows: "${shows}". Never press it or another booking button again (the person would book twice): call done saying what was booked, or, if the page shows the booking failed, call done and say in the summary what is wrong`
}

/** Why a question about which place is refused, or null: the person chose the place on the card, the question offers
 *  places again (two or more of them, or that one among its choices), and doesn't say what's wrong with the chosen one
 *  (it names it outside its choices) — a place whose tap did nothing may always be asked about. */
export function askedPlaceAgain(state: AgentState, call: ToolCall, map: PageMap): string | null {
  const chosen = state.cardPlace
  if (!chosen || state.dead?.some((d) => namedIn(chosen, d))) return null
  const choices = call.choices ?? []
  const places = [...new Set([...pagePlaces(map), ...(state.venues?.list.map((v) => v.name) ?? []), chosen])]
  const offered = places.filter((n) => choices.some((c) => namedIn(n, c)) || namedIn(n, call.question ?? ""))
  const chosenOffered = choices.some((c) => namedIn(chosen, c))
  if (offered.length < 2 && !chosenOffered) return null
  // (Saying why: the chosen place named in the question, not offered again as a choice.)
  if (!chosenOffered && namedIn(chosen, call.question ?? "")) return null
  return `the person already chose the place on the plan card: «${chosen}». Don't ask which place again: open it and book there. Ask about the place only if it can't be opened or has nothing free for the days — then say so about «${chosen}» in the question and offer the other places, not it`
}

/** Whether a plan step is the asking of a question (most of the question's words, two or more, are in the step). */
export function asksSame(step: string, question: string): boolean {
  const words = (t: string) => new Set((t.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))
  const q = words(question)
  const st = words(step)
  const shared = [...q].filter((w) => st.has(w)).length
  return shared >= 2 && shared >= Math.ceil(q.size * 0.6)
}

/** The chat's suggested place as a place question's first option (moved there, or added with the page's own spelling),
 *  nothing picked: the person chooses. Over the question's size, the last of the page's places goes, never the card's
 *  own last option («Other…», «pick for me»). */
export function suggestFirst(q: PlanQuestion, name: string, listed: Set<string>): void {
  const opts = [...q.options]
  const notes = q.notes ? [...q.notes] : undefined
  const cap = Math.max(4, opts.length)
  const i = opts.findIndex((o) => squashName(o) === squashName(name))
  if (i > 0) {
    const [o] = opts.splice(i, 1)
    opts.unshift(o)
    if (notes) notes.unshift(...notes.splice(i, 1))
  } else if (i < 0) {
    opts.unshift(name)
    notes?.unshift("")
    while (opts.length > cap) {
      let j = -1
      for (let k = opts.length - 1; k > 0; k--) if (listed.has(squashName(opts[k]))) { j = k; break }
      if (j < 0) j = opts.length - 2
      if (j <= 0) break
      opts.splice(j, 1)
      notes?.splice(j, 1)
    }
  }
  q.options = opts
  if (notes) q.notes = notes
  delete q.pick
  q.place = true
}

/** Today on the device (YYYY-MM-DD), the year a day without one is read against. */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * A step's line names a day only when the page it led to shows that day set (128: «Opening Harbour View Suites… for
 * 2 nights from Fri, Dec 4» on a page that said «Choose your dates»): otherwise the line keeps only what was pressed.
 */
export function checkDayLine(state: AgentState, map: PageMap): void {
  const i = state.lineCheck
  state.lineCheck = undefined
  const l = i === undefined ? undefined : state.lines[i]
  if (!l?.text || !l.ok) return
  const near = state.plan?.booking?.date ?? todayIso()
  const days = daysInText(l.text, near)
  // (The step's own control is that day — a strip's «Thu 26 Nov» pressed —, or the day the device saw pressed: kept.)
  const own = (d: string) => (!!l.target && dayOf(/"(.*)"$/.exec(l.target)?.[1] ?? "", d) === d) || state.picked?.date === d
  if (days.some((d) => !showsDay(map, d) && !own(d))) l.text = ""
}

/**
 * The booking's last press while the page doesn't show its days set, said to the model; null when it does (128: a stay
 * booked with no dates, its steps and summary naming them). A stay's or a rental's two days are on the page it's booked
 * on; one day counts once the page showed it, or it was pressed.
 */
export function unsetDays(state: AgentState, map: PageMap): string | null {
  return bookingDays(state, map) ? null : daysRefusal(state)
}

/**
 * Why a place shouldn't be opened from this page yet, or null: a booking by days on a page with its own date fields
 * whose list doesn't carry those days (its address and its text don't name them) — the fields not set, or set and its
 * search not pressed. Said once per page.
 */
export function searchFirst(state: AgentState, map: PageMap): string | null {
  const b = state.plan?.booking
  if (!b?.date || !b.dateEnd || state.searchNudged?.includes(map.url)) return null
  const fields = map.items.filter((i) => i.type === "date" || ((i.role === "textbox" || i.role === "combobox") && !!i.value && daysInText(i.value, b.date).length > 0))
  if (!fields.length) return null
  let address = map.url
  try {
    address = decodeURIComponent(map.url)
  } catch {
    // (An address that doesn't decode is read as it is.)
  }
  const listed = daysInText(`${address}\n${map.title}\n${map.text}`, b.date)
  if (listed.includes(b.date) && listed.includes(b.dateEnd)) return null
  const has = (d: string) => fields.some((i) => !!i.value && daysInText(i.value, b.date).includes(d))
  const set = has(b.date) && has(b.dateEnd)
  return `this list doesn't carry the ${b.kind}'s days (${dayWords(b.date)} to ${dayWords(b.dateEnd)}) yet: ${set ? "its date fields have them, but its search wasn't pressed" : "set them in its own date fields"} — press this page's own search (Search, Apply, Update) first, then open the place from the new list, so its page has the days`
}

/**
 * The days the booking's last press books, as the page shows them set; null when it doesn't. The asked days, or the
 * ones the person chose in their answers (128, the director: the asked day had nothing and they took another), or a
 * day pressed past the date checks. A day only on offer (a strip showing it) counts only while no other day is set.
 */
export function bookingDays(state: AgentState, map: PageMap): { date: string; dateEnd?: string } | null {
  const b = state.plan?.booking
  if (!b?.date) return null
  const replied = daysInText((state.replies ?? []).join("\n"), b.date).filter((d) => showsDay(map, d)).sort()
  if (b.dateEnd) {
    if (showsDay(map, b.date) && showsDay(map, b.dateEnd)) return { date: b.date, dateEnd: b.dateEnd }
    return replied.length >= 2 ? { date: replied[0], dateEnd: replied[replied.length - 1] } : null
  }
  if (showsDay(map, b.date)) return { date: b.date }
  if (replied.length) return { date: replied[0] }
  if (state.picked?.date) return { date: state.picked.date }
  // (A table left on the page's own day, another one set, while the strip merely offered the asked one.)
  if (state.sawDate && !otherDaySet(map, b.date)) return { date: b.date }
  return null
}

function daysRefusal(state: AgentState): string {
  const b = state.plan!.booking!
  if (b.dateEnd) return `the page doesn't show this ${b.kind}'s dates set (${dayWords(b.date)} to ${dayWords(b.dateEnd)}), so this press would book without them or for other dates: never press it so. Set the dates on the page first (its own date fields, then its Search, Apply or Update), or open the place again from a list that has the dates; if the page can't take them, ask_user with what it shows`
  return `the page doesn't show the booking's day (${dayWords(b.date)}) set, so this press would book without it or for another day: never press it so. Choose the day on the page first; if the page can't take it, ask_user with what it shows`
}

/** Another day than this one set on the page: a date field's value, or a day control marked chosen. */
function otherDaySet(map: PageMap, iso: string): boolean {
  if (widgetDay(map, iso)) return true
  return map.items.some((i) => i.label.length <= 60 && isDateLabel(i.label) && !!i.state?.some((x) => x === "selected" || x === "checked" || x === "pressed" || x === "current") && dayOf(i.label, iso) !== null && dayOf(i.label, iso) !== iso)
}

/** The map as it goes to the server: the page's amounts stay on the device (they're for its own price check). */
function sent(map: PageMap): PageMap {
  // The amounts and other sites' frame addresses stay on the device (the device acts on those itself).
  const { money: _money, frames: _frames, ...rest } = map
  // A card's text beside its link is the device's own reading of places.
  return rest.items.some((i) => i.card) ? { ...rest, items: rest.items.map(({ card: _card, ...i }) => i) } : rest
}

/** A «Да» given on the site the task is on now. */
function confirmHere(state: AgentState): void {
  const site = siteOfHost(state.host || state.startHost)
  if (!site) return
  state.confirmedSites = [...new Set([...(state.confirmedSites ?? []), site])]
  state.confirmedHere = true
}

/** Whether a «Да» was given on this host's site in this task. */
export function confirmedOn(state: AgentState, host: string): boolean {
  return !!host && !!state.confirmedSites?.includes(siteOfHost(host))
}

// Decision 13 (round 142): contacts quoted in a text, by pattern only — an e-mail address, or a run of 7+ digits of any
// script with «+», spaces, dashes, brackets or dots and no words; dates written with digits aren't phones.
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10]
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    const c = d.codePointAt(0) ?? 0
    const z = DIGIT_ZEROS.find((z) => c >= z && c <= z + 9)
    return z === undefined ? d : String(c - z)
  })
}
const EMAIL_RUN = /[^\s@<>()«»"“”'、，。：:;,]+@[^\s@<>()«»"“”'、，。：:;,]+\.\p{L}{2,}/gu
const PHONE_RUN = /\+?\p{Nd}[\p{Nd}\s().\-]{5,}\p{Nd}/gu
// (A run that is itself a date — «2026-12-05», «05.12.2026» — isn't a phone; a phone's own «123-45-67» is.)
const DATE_RUN = /^(?:\p{Nd}{4}[-./]\p{Nd}{1,2}[-./]\p{Nd}{1,2}|\p{Nd}{1,2}[-./]\p{Nd}{1,2}[-./]\p{Nd}{2,4})$/u
export function contactsQuoted(text: string): Array<{ kind: "email" | "phone"; value: string }> {
  const emails = [...text.matchAll(EMAIL_RUN)].map((m) => m[0].replace(/[.。]+$/u, ""))
  const rest = text.replace(EMAIL_RUN, " ")
  const phones = [...rest.matchAll(PHONE_RUN)].map((m) => m[0].trim()).filter((v) => !DATE_RUN.test(v) && asciiDigits(v).replace(/\D/g, "").length >= 7)
  return [...emails.map((value) => ({ kind: "email" as const, value })), ...phones.map((value) => ({ kind: "phone" as const, value }))]
}
/** Whether the person gave this contact: in their words (as saidInWords reads them, or the same digits in any script),
 *  or it is a live saved entry's value. */
export function contactGiven(c: { kind: "email" | "phone"; value: string }, said: string, saved: FormEntry[]): boolean {
  if (c.kind === "email") {
    const v = c.value.toLocaleLowerCase()
    return saidInWords(said, c.value) || said.toLocaleLowerCase().includes(v) || saved.some((e) => e.value.trim().toLocaleLowerCase() === v)
  }
  const digits = (x: string) => asciiDigits(x).replace(/\D/g, "")
  const d = digits(c.value)
  if (saidInWords(said, c.value)) return true
  if (contactsQuoted(said).some((q) => q.kind === "phone" && digits(q.value) === d)) return true
  return d.length >= 7 && saved.some((e) => digits(e.value) === d)
}
/** The first contact field of a kind the person gave that is still empty on this page (decision 13c), or null. Only the
 *  pressed control's own form counts: a field in another form (a sign-up or newsletter beside the booking) is skipped;
 *  a field in no form, or a press in no form, counts as before (the director's follow-up 1). */
export function emptyGivenField(map: PageMap, given: Set<string>, done: string[], pressForm?: number): { item: MapItem; kind: string } | null {
  for (const item of map.items) {
    if (item.role !== "textbox" || done.includes(item.id) || item.state?.some((x) => x === "disabled" || x === "readonly")) continue
    if (pressForm !== undefined && item.form !== undefined && item.form !== pressForm) continue
    const kind = contactField(item)
    if (!kind || !given.has(kind)) continue
    const empty = item.lock ? !!item.state?.includes("empty") : !(item.value ?? "").trim()
    if (empty) return { item, kind }
  }
  return null
}

/** The fields this task typed or filled (a page that keeps a field's old «empty» after typing isn't sent back for it). */
function typedIds(state: AgentState): string[] {
  return state.log.filter((l) => (l.call.tool === "type" || l.call.tool === "fill") && l.call.id && !/^(refused|held)/.test(l.result ?? "")).map((l) => l.call.id!)
}

/** The task's request as the server and the checks hear it: the person's words with the plan's answers. */
function words(state: AgentState): string {
  const said = personWords(state.request, state.plan)
  return state.replies?.length ? `${said}\n${state.replies.join("\n")}` : said
}

/** The plan step (step 0): the plan card when it needs the person, else straight on with it approved. */
async function planStep(state: AgentState, io: RunnerIO, map: PageMap, keys: string[], here: { reminders: string; calendar: string } | null, entries: FormEntry[]): Promise<"card" | "go" | "stop"> {
  const rules = readRules(await io.rules?.().catch(() => null))
  const calendarOn = rules.calendar && here?.calendar === "yes" && !!io.calendarFree
  const site = siteOfHost(hostOf(map.url))
  const book = site ? await io.playbook?.get(site).catch(() => null) : null
  if (book?.length) state.playbook = playbookLine(book)
  state.rules = rulesLine(rules, calendarOn)
  state.ruleParty = rules.party
  state.chooseVenue = rules.chooseVenue
  state.minRating = rules.rating
  const subject = pageSubject(map)
  if (subject) state.subject = subjectLine(subject, hostOf(map.url))
  const reply = await io.ask({
    task: { id: state.id, request: state.request, lang: state.lang, startHost: state.startHost, step: 0, confirmedHere: false, token: null, strongUsed: 0, now: nowLine(), phase: "plan", ...(here ? { device: here } : {}), rules: state.rules, ...(state.playbook ? { playbook: state.playbook } : {}), ...(state.chat ? { chat: state.chat } : {}), ...(state.subject ? { subject: state.subject } : {}) },
    map: sent(map), log: [], keys
  })
  if (!reply.ok) {
    state.status = "error"
    state.error = reply.code ?? "UPSTREAM"
    if (reply.limit) state.limit = reply.limit
    return "stop"
  }
  state.token = reply.token ?? null
  if (reply.left !== undefined) state.left = reply.left
  state.step = 1
  // The chat went with the plan only (what it resolved is the plan's fromChat): not kept with the task. (Read once more
  // below, on the device, for the place its assistant suggested.)
  const chatText = state.chat ?? ""
  state.chat = undefined
  // A server without plans answered with a step: none, every «Сделать?» asks (it's asked again as step 1).
  const plan = reply.plan ? buildPlan(checkPlan(reply.plan), { map, startHost: state.startHost, request: state.request, confirmedHere: false, policy: io.policy }) : null
  state.pageKind = pageKind(map, subject, plan?.booking)
  if (!plan) return "go"
  state.plan = plan
  // Which place to book, by what it is, not by its words (128: «venue» was kept in My details; a fact is written in the
  // request's language): the question the prompt marks, or one whose options are places this page lists (its links).
  const listed = new Set([...venuesOn(map).map((v) => v.name), ...map.items.filter((i) => i.role === "link" && i.href).map((i) => i.label)].map(squashName))
  for (const q of plan.questions) if (q.fact === "venue" || q.options.filter((o) => listed.has(squashName(o))).length >= 2) q.place = true
  // A place the request (or the chat it came from) doesn't name isn't the model's to pick on the plan (124, the director:
  // a home page's first «Featured» salon taken silently): the place is asked on the card or chosen by the rules.
  // The chat counts only where the person's own words point into it («the second one», «that hotel»): a place the
  // assistant suggested there isn't their choice (129: «From the chat: … Old Town Guesthouse» for a request naming none) —
  // it's asked, the suggestion first among the options when the page lists it.
  let chatPick = ""
  if (plan.booking?.venue && plan.fromChat && namedIn(plan.booking.venue, plan.fromChat) && !namedIn(plan.booking.venue, state.request) && !(subject?.kind === "place" && subject.name === plan.booking.venue) && !POINTS.test(state.request)) {
    chatPick = plan.booking.venue
    delete plan.booking.venue
    // (Nor does a plan step that chooses it: the card asks instead.)
    plan.steps = plan.steps.filter((l) => !namedIn(chatPick, l))
    // (Nor does the card's «From the chat» line say it, below: that line is what the person's words took from the chat.)
  }
  // The place the assistant suggested in the chat, named by the plan in a field of its own (the director on 03a95321:
  // the model's own question once left it out, once put it first): never the booking's place by itself, it's the first
  // option of whichever place question the card shows, when this page lists it. A booking already placed (the request
  // names or points to its place, or this is one place's page) has nothing to ask.
  let suggested = (plan.chatPlace ?? "").trim()
  delete plan.chatPlace
  // The model leaves that field empty at times (the iPad, 2 runs in 9: no question, the task went on by the rules): the
  // device reads it itself — a place of this page the plan's «From the chat» names, else the first of this page's places
  // the chat's last answer names — unless the request points into the chat («the second one»: its own choice).
  if (!suggested && chatText && plan.booking && !plan.booking.venue && subject?.kind !== "place" && !POINTS.test(state.request)) suggested = chatSuggestion(chatText, plan.fromChat ?? "", pagePlaces(map))
  if (!chatPick && suggested && plan.booking && !plan.booking.venue && subject?.kind !== "place" && !namedIn(suggested, state.request)) {
    chatPick = suggested
    plan.steps = plan.steps.filter((l) => !namedIn(chatPick, l))
  }
  if (chatPick && plan.fromChat) plan.fromChat = plan.fromChat.replace(new RegExp(`\\s*[,;·—–-]?\\s*${chatPick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu"), "").replace(/^[\s,;·—–-]+|[\s,;·—–-]+$/gu, "")
  if (plan.booking?.venue && !(subject?.kind === "place" && subject.name === plan.booking.venue) && !namedIn(plan.booking.venue, `${state.request} ${plan.fromChat ?? ""}`)) delete plan.booking.venue
  // The window's days, worked out here from its kind (round 142, the director's item 4); a request for «the first free
  // time» that names no window takes the standing rule's «up to N days later».
  if (plan.booking) Object.assign(plan.booking, windowOf(plan.booking, localDay(), rules.days ?? 0, nightsIn(state.request), plan.booking.tz || localZone()))
  // A request that gives a window of days (round 141, the director's 8c): the day is the window's, never a question —
  // set_dates goes through it (a plan asked «which check-in day?» on «any two nights this month»).
  if (plan.booking?.dayLast || (plan.booking?.window && plan.booking.window !== "none")) plan.questions = plan.questions.filter((q) => !dayQuestion(q))
  // On one place's page, a booking that names no other is there: no choosing, no «I'll pick the place».
  if (subject?.kind === "place" && plan.booking && !plan.booking.venue) plan.booking.venue = subject.name
  if (subject && plan.booking?.venue) state.chooseVenue = false
  // (A stay or a rental is booked by days: the Calendar's free hours don't decide it.)
  if (plan.booking && calendarOn && !DAY_KINDS.has(plan.booking.kind)) {
    // Asked in the device's own clock, said to the model in the place's (a table in Paris from Nicosia).
    const b = plan.booking
    const from = shiftZone(b.date, b.from, b.tz)
    const until = shiftZone(b.date, b.until, b.tz)
    const free = (await io.calendarFree!({ ...b, date: from.date, from: from.time, until: until.date === from.date ? until.time : "23:59" }, rules.days).catch(() => null)) ?? undefined
    state.calendar = free && free !== "none" ? freeLineIn(free, b.tz) : free
    plan.how = { rating: rules.chooseVenue && !b.venue ? rules.rating : 0, calendar: true }
    // The booking in the Calendar afterwards: a permission of the plan, ticked (the device adds it itself, from the time
    // that was booked, with the booking page's link).
    if (!plan.perms.some((p) => p.kind === "apple" && p.reason === "event_add")) plan.perms.push({ id: "pcal", kind: "apple", reason: "event_add", label: plan.label || site, host: hostOf(map.url), on: true })
  }
  if (!state.calendar) state.rules = rulesLine(rules, false)
  if (plan.booking && !plan.how) plan.how = { rating: rules.chooseVenue && !plan.booking.venue ? rules.rating : 0, calendar: false }
  // The rule says «free in the calendar» but the app may not read it: the card offers it, the result says it wasn't
  // checked (never a silent skip).
  if (plan.booking && plan.how && rules.calendar && !DAY_KINDS.has(plan.booking.kind) && (here?.calendar === "none" || here?.calendar === "denied")) {
    plan.how.ask = here.calendar
    state.calSkipped = true
  }
  // Where to book, shown (124, the owner: «переуточнять… если эта деталь не была уточнена»): a booking that names no
  // place, on a results list, gets the place the rules would choose as a picked, changeable answer, with the next two.
  // The plan's own question about the place offers only places this page shows (125: three hotels from the model's
  // memory on a home page with none of them); fewer than two left, it's not asked here (the agent asks from a real list).
  const shown = `${map.text} ${map.items.map((i) => `${i.label} ${i.card ?? ""}`).join(" ")}`.toLocaleLowerCase()
  plan.questions = plan.questions.flatMap((q) => {
    if (q.fact !== "venue" && q.fact !== "pref:place") return [q]
    const options = q.options.filter((o) => shown.includes(o.toLocaleLowerCase()))
    return options.length >= 2 ? [{ ...q, options, ...(q.pick && options.includes(q.pick) ? {} : { pick: undefined }) }] : []
  })
  let placesListed = false
  if (plan.booking && !plan.booking.venue && rules.chooseVenue && !plan.questions.some((q) => q.kind === "venue" || q.fact === "venue" || q.place)) {
    // A results list whose cards come after the first part of the map (restaurant and salon sites' filters and map first,
    // 124): the next parts are read on the device for the places (never sent to the model).
    let seen = map
    for (let p = 2; !venuesOn(seen, plan.booking.area ?? []).length && p <= Math.min(map.parts, 4); p++) {
      const more = await io.map({ part: p }).catch(() => null)
      if (!more) break
      seen = { ...seen, items: [...seen.items, ...more.items] }
    }
    const cards = cardsOf(seen)
    const ranked = rankVenues(venuesOn(seen, plan.booking.area ?? []), cards, plan.booking.match ?? [], rules.rating, plan.booking.area ?? [], true).slice(0, 3)
    // A place that matters to the person (an appointment: a salon, a clinic) is theirs to choose: the page's best by the
    // rules with their rating and area, the one they went to last time, and «pick for me by my rules»; only a
    // remembered one is chosen already. A table at «any Italian» is the rules' choice, shown chosen and changeable.
    const personal = plan.booking.personal ?? plan.booking.kind === "appointment"
    const saidLast = savedFacts(entries)[factKey(factLabel("pref:place", plan.site ?? site))] ?? ""
    const last = saidLast.startsWith("@") ? "" : saidLast
    const fromChat = chatPick && venuesOn(seen, []).some((v) => squashName(v.name) === squashName(chatPick)) ? venuesOn(seen, []).find((v) => squashName(v.name) === squashName(chatPick))!.name : ""
    const names = [...(fromChat ? [fromChat] : []), ...ranked.map((v) => v.name).filter((n) => n !== fromChat)].slice(0, 3)
    const options = [...(last && !names.includes(last) ? [last] : []), ...names, "@auto"]
    const notes = options.map((o) => (o === last ? "@last" : o === "@auto" ? "" : venueNote(ranked.find((v) => v.name === o)!, cards)))
    placesListed = ranked.length > 0
    if (ranked.length || (personal && last)) {
      plan.questions.push({ q: "", kind: "venue", fact: "pref:place", options, notes, min: rules.rating, ...(!personal && ranked.length ? { pick: ranked[0].name } : {}) })
      // The question shows the choice: no «I'll pick the place» line besides it.
      if (plan.how) plan.how.rating = 0
    }
  }
  // The chat's suggestion, dropped as the place, comes back as the question's first option even where the page's places
  // aren't links the device can rank (129, the iPad: the stand's script-opened cards; no question was asked at all).
  if (chatPick && plan.booking && !plan.booking.venue && !plan.questions.some((q) => q.kind === "venue" || q.fact === "venue" || q.place)) {
    const own = (i: MapItem) => i.role === "link" && (!!i.card || !i.href) && i.label.trim().length >= 3 && i.label.trim().length <= 80
    const labels = [...new Set([...venuesOn(map).map((v) => v.name), ...map.items.filter(own).map((i) => i.label.trim())])]
    const first = labels.find((l) => squashName(l) === squashName(chatPick)) ?? (shown.includes(chatPick.toLocaleLowerCase()) ? chatPick : "")
    if (first) {
      const options = [first, ...labels.filter((l) => l !== first).slice(0, 2), ...(rules.chooseVenue ? ["@auto"] : [])]
      plan.questions.push({ q: "", kind: "venue", fact: "pref:place", options, notes: options.map(() => ""), min: rules.rating, place: true })
      if (plan.how) plan.how.rating = 0
    }
  }
  // Whichever place question is on the card — the model's own (it left the suggestion out, or put it in the middle) or
  // the device's — has the chat's suggestion first, chosen by nobody yet: the person picks.
  if (chatPick && plan.booking && !plan.booking.venue) {
    const q = plan.questions.find((x) => x.kind === "venue" || x.fact === "venue" || x.fact === "pref:place" || x.place)
    const onPage = [...venuesOn(map).map((v) => v.name), ...map.items.filter((i) => i.role === "link").map((i) => i.label.trim())].find((n) => squashName(n) === squashName(chatPick)) ?? (shown.includes(chatPick.toLocaleLowerCase()) ? chatPick : "")
    if (q && onPage) suggestFirst(q, onPage, listed)
  }
  // A page that is the booking's own form (its booking press is on this page, no places listed): there's no place to
  // choose, so no «I'll pick the place» (the director on 126, a stand's one-form page).
  if (plan.booking && plan.how && !placesListed && !venuesOn(map).length && plan.perms.some((p) => p.kind === "press" && p.reason === "submit" && !!p.ids?.length && p.path === pathOf(map.url))) plan.how.rating = 0
  // A place that's the person's to choose isn't «I'll pick the place»: the agent asks once it has a real list.
  if (plan.booking?.personal && !plan.booking.venue && plan.how && !plan.questions.some((q) => q.kind === "venue" || q.fact === "venue" || q.place)) plan.how.rating = 0
  // (A question about the place — the device's or the plan's own — is the choice: no «I'll pick the place» beside it, 130.)
  if (plan.how && plan.questions.some((q) => q.kind === "venue" || q.fact === "venue" || q.place)) plan.how.rating = 0
  // Nor a step saying the agent will ask it (run 4 on d05b60bb: «Asking you which stay to book», then asked again after
  // the card): the plan's own place question's words, mostly in a step, make it that step.
  for (const q of plan.questions.filter((x) => (x.kind === "venue" || x.fact === "venue" || x.place) && x.q.trim())) plan.steps = plan.steps.filter((l) => !asksSame(l, q.q))
  // A personal service's open choices, asked on the card unless the request names them (the owner on 123: «переуточнять
  // … если эта деталь не была уточнена»): the specialist («any» first, then the page's names) and the service when more
  // than one fits; a remembered answer pre-fills them. Built on the device from the plan's fields, so they're never
  // skipped; a question the plan already asks about the same names isn't asked twice.
  const b = plan.booking
  if (b?.kind === "appointment") {
    const asks = (names: string[]) => plan.questions.some((q) => q.options.some((o) => names.includes(o)))
    const lastSpecialist = savedFacts(entries)[factKey(factLabel("pref:specialist", plan.site ?? site))] ?? ""
    if (b.specialists?.length && !b.specialistNamed && !asks(b.specialists)) plan.questions.push({ q: "", kind: "specialist", fact: "pref:specialist", options: ["@any", ...b.specialists.slice(0, 3)] })
    // No names before the place's own page (a home page, a list): «any», last time's, or «I'll choose on the place's
    // page» — then the one question with the page's real names comes there.
    else if (!b.specialists?.length && !b.specialistNamed && !b.venue && placesListed) {
      const opts = ["@any", ...(lastSpecialist && lastSpecialist !== "@any" && lastSpecialist !== "@page" ? [lastSpecialist] : []), "@page"]
      plan.questions.push({ q: "", kind: "specialist", fact: "pref:specialist", options: opts, notes: opts.map((o) => (o === lastSpecialist ? "@last" : "")) })
    }
    if ((b.services?.length ?? 0) >= 2 && !asks(b.services!)) {
      const named = b.serviceNamed && b.services!.includes(b.serviceNamed) ? b.serviceNamed : ""
      if (!named) plan.questions.push({ q: "", kind: "service", fact: "pref:service", options: b.services!.slice(0, 3) })
    }
  }
  // A contact detail the booking will ask for and «Мои данные» hasn't got: asked on the card with «Запомнить», not
  // mid-task (the director on 124). The plan names the ones its booking will ask for.
  // One the request already gives («почта maria@example.com») isn't asked again (the director on 125); and when the request
  // carries someone's details, a contact still asked is likely theirs: not kept in «Мои данные» by default.
  if (plan.booking?.contacts?.length) {
    const have = new Set(liveEntries(entries).map((e) => e.key))
    const said = `${state.request} ${plan.fromChat ?? ""}`
    // (Someone's details in the request: a contact or a name written in it, typed by the plan — not a site's search box
    // the plan took for a personal field, 126.)
    // (127: «for Maria Kim» carries a name without the word «name»: a contact field the plan types from the request's words.)
    const forSomeone = plan.perms.some((p) => p.kind === "personal") && (requestGives(plan, said).size > 0 || NAME_SAID.test(said))
    for (const key of plan.booking.contacts) {
      if (!have.has(key) && !contactInWords(key, said) && !plan.questions.some((q) => q.key === key)) plan.questions.push({ q: "", kind: "contact", key, options: [], ...(forSomeone ? { once: true } : {}) })
    }
  }
  // The booking's contact form (a later page): the saved name, e-mail and phone go in as the plan's fill.
  addContactFill(plan, liveEntries(entries).map((e) => e.key), hostOf(map.url), `${state.request} ${plan.fromChat ?? ""}`, liveEntries(entries).find((e) => e.key === "name.full")?.value ?? "")
  // Nothing left to ask (every answer known from «Мои данные», this site's remembered choices or the rules; nothing paid;
  // a site booked on before): no card, the task starts with its answers in one line and Stop.
  // (A place the rules picked counts as known: the card would only show it.)
  const pre = savedAnswers(plan, savedFacts(entries)).map((a, i) => a || plan.questions[i]?.pick || "")
  if (rules.auto && plan.booking && !!book?.length && pre.every((a) => !!a.trim()) && goesAlone(plan, map)) {
    plan.answers = plan.questions.map((q, i) => ({ q: q.q || (q.kind === "venue" ? "Where to book" : ""), a: pre[i] }))
    placeFromAnswers(state, plan, pre)
    // (A booking for someone else keeps the person's own saved contacts unticked: asked if a field needs them.)
    plan.perms = plan.perms.map((p) => ({ ...p, on: !(p.reason === "contact" && plan.forOther) }))
    plan.approved = true
    plan.auto = true
    return "go"
  }
  if (planNeedsPerson(plan)) {
    state.status = "plan"
    return "card"
  }
  placeFromAnswers(state, plan, [])
  plan.approved = true
  return "go"
}


// A booking form another site serves in a frame of this page (a restaurant's or a salon's provider widget): its title,
// name or address speaks of booking in one of the 15 languages («Reservation widget», «/reservations/…», «予約»).
const bookingWord = wordTest(BOOKING_WORDS)
export function bookingFrame(f: { src: string; host: string; title?: string }): boolean {
  let where = f.host
  try {
    where = `${f.host} ${new URL(f.src).pathname}`
  } catch {
    // the address as it is
  }
  return bookingWord(`${f.title ?? ""} ${where.replace(/[/._\-?=&#+%]+/g, " ")}`)
}

const SEARCH_BOX = /search|find|treatment|salon|cuisine|restaurant|location|where|what are you looking|поиск|найти|искать|suche|recherch|buscar|cerca|pesquis|検索|검색|搜索|搜尋|بحث|tìm/i

/** A date press as the page and the task stand: why it isn't done, or null to go on. */
// Decision 14: a window's days (date to dayLast) are all asked days for a booking that isn't by days (a stay's or a
// rental's own two days keep their rules).
function windowOfPlan(state: AgentState): { first: string; last: string } | null {
  const b = state.plan?.booking
  return b && b.dayLast && b.dayLast > b.date && !DAY_KINDS.has(b.kind) ? { first: b.date, last: b.dayLast } : null
}
/** The days the page's day controls offer (not greyed), with their dates, earliest first. */
export function offeredDays(map: PageMap, near: string): Array<{ date: string; item: MapItem }> {
  const out: Array<{ date: string; item: MapItem }> = []
  for (const i of map.items) {
    if (!isDateLabel(i.label) || greyedItem(i) || opensPicker(map, i)) continue
    const d = dayOf(i.label, near)
    if (d && !out.some((o) => o.date === d)) out.push({ date: d, item: i })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
/** Every day the page's day controls show (greyed or not), earliest first. */
function shownDays(map: PageMap, near: string): string[] {
  return [...new Set(map.items.filter((i) => isDateLabel(i.label) && !opensPicker(map, i)).map((i) => dayOf(i.label, near)).filter((d): d is string => !!d))].sort()
}

export function dateStep(state: AgentState, map: PageMap, item: MapItem, call?: ToolCall): string | null {
  if (looksLikeSlot(item.label)) {
    // A time is for the day the page has chosen (a salon booking site, 124: «Sat 26 Dec» greyed and pressed wasn't chosen; 11:30 was
    // the first day's, «booked» as the 26th): the day it's said to be on must be the chosen one.
    const day = (call?.date && /^\d{4}-\d{2}-\d{2}$/.test(call.date) ? call.date : "") || state.plan?.booking?.date || ""
    if (day) {
      const chosen = map.items.filter((i) => isDateLabel(i.label) && i.state?.some((x) => x === "selected" || x === "pressed" || x === "current" || x === "checked"))
      const mine = dayItems(map, day)
      const words = dayWords(day)
      if (chosen.length && mine.length && !chosen.some((c) => mine.some((m) => m.id === c.id)))
        return `the page's chosen day is «${chosen[0].label}», not ${words}: the times shown are for that day. Press ${words} first, or ask with what the page shows`
      if (!chosen.length && mine.length && mine.every(greyedItem))
        return `${words} shows greyed and isn't chosen on the page, so the times shown aren't for it: read what the page says for that day (that it's full, or the next day it's free) and ask_user with the page's real nearest options`
    }
    // A time: the dates got somewhere.
    state.dateSteps = 0
    return null
  }
  if (!isDateLabel(item.label)) return null
  // A control that opens the picker isn't a day chosen (the director's real-site run on 10eed066: a picker's button showing
  // «26 Nov 2026» refused six times as «before the asked day»): one that says it opens a popup or a list, a date field, or
  // Day cells in a calendar or a strip are still checked.
  if (opensPicker(map, item)) return null
  const greyed = greyedItem
  if (greyed(item)) {
    // The day asked for, greyed: pressed once, the page's answer is what counts (a strip greys days not loaded yet).
    const target = state.plan?.booking?.date
    if (target && !state.pressedTarget && dayItems(map, target).some((i) => i.id === item.id)) {
      state.pressedTarget = true
      state.sawDate = true
      return null
    }
    const days = map.items.filter((i) => isDateLabel(i.label))
    // A strip that shows every day greyed until one is tapped: one tap, then read again.
    if (days.length >= 3 && days.every(greyed) && !state.wokeStrip) {
      state.wokeStrip = true
      return null
    }
    return `«${item.label}» is shown as not available on the page (greyed or disabled): don't press it. Choose an available day the rules allow (the page may name its next free day), or ask_user once with the page's real nearest options`
  }
  // Another day than the asked one (124, a restaurant's widget: «Sat 28 Nov» pressed for «Saturday 26 December»): never
  // an earlier one; a later one only once the page has shown the asked day (full, or not there).
  const asked = state.plan?.booking?.date
  const pressed = asked ? dayOf(item.label, asked) : null
  // The stay set_dates set (a window's stay, its first day landed): its own two days are always the person's request.
  if (state.stay && pressed && (pressed === state.stay.in || pressed === state.stay.out || (!state.stay.out && pressed > state.stay.in && pressed <= addDays(state.stay.in, 30)))) {
    if (!state.stay.out && pressed > state.stay.in) state.stay.out = pressed
    state.lastDate = item.label
    state.lastDateId = item.id
    return null
  }
  // A stay's or a rental's last day (check-out, return), once the first was pressed: the range's second press.
  const end = state.plan?.booking?.dateEnd
  if (end && pressed === end && state.lastDate && state.lastDate !== item.label) {
    state.lastDate = item.label
    return null
  }
  // A stay's or a rental's days are the request's own (check-in, check-out): another day is the person's to choose, never
  // the rules' (125, the iPad: 27 pressed as check-in for «26 to 28»).
  if (asked && pressed && end && pressed !== asked && pressed !== end && state.plan?.booking && DAY_KINDS.has(state.plan.booking.kind))
    return `«${item.label}» isn't a day of this ${state.plan.booking.kind} (${dayWords(asked)} to ${dayWords(end)}): press only those two. A picker may show the chosen days only in its own grid (selected, in range) until its own «Done»/«Apply»: read that, then press it; if those days really can't be chosen, ask_user with what the page shows`
  // A day inside the request's window (decision 14a: «this week», a strip offering only 29 and 30 Nov for a window from
  // the 27th): an asked day, never «isn't the asked day». Earliest first: a later one while the page offers an earlier
  // window day this task hasn't pressed is sent back once. Distinct days pressed in ascending order walk the window and
  // don't count toward «two date steps went nowhere».
  const win = windowOfPlan(state)
  if (win && pressed && pressed >= win.first && pressed <= win.last) {
    const tried = state.windowPressed ?? []
    const earlier = offeredDays(map, win.first).find((o) => o.date >= win.first && o.date < pressed && !tried.includes(o.date))
    if (earlier && !state.windowEarlier) {
      state.windowEarlier = true
      return `«${item.label}» is inside the request's window, but the page offers an earlier day in it, «${earlier.item.label}» (${dayWords(earlier.date)}): press that one first — the earliest free day comes first`
    }
    state.sawDate = true
    state.picked = { date: pressed }
    if (state.lastDate === item.label) return `«${item.label}» was pressed already: the page answered it. Choose another available day the rules allow, or ask_user once with the page's real nearest options`
    const ascending = !tried.includes(pressed) && tried.every((d) => d < pressed)
    state.windowPressed = [...tried, pressed]
    if (!ascending) {
      const steps = (state.dateSteps ?? 0) + 1
      if (steps > 2) return "two date steps went nowhere: don't press more dates. ask_user once now, with the page's real nearest options: the next free day the page names, another specialist on the asked day, another place"
      state.dateSteps = steps
    }
    state.lastDate = item.label
    state.lastDateId = item.id
    return null
  }
  if (asked && pressed && pressed !== asked) {
    if (pressed < asked) return `«${item.label}» is before the asked day (${dayWords(asked)}): go to the asked day instead (the calendar's next-month arrow, or the date strip scrolled)`
    if (!state.sawDate && !dayItems(map, asked).length) return `«${item.label}» isn't the asked day (${dayWords(asked)}), and the page hasn't shown that day yet: go to it first`
  }
  if (pressed && asked && !(end && pressed === end)) state.picked = { date: pressed }
  const steps = (state.dateSteps ?? 0) + 1
  if (state.lastDate === item.label) return `«${item.label}» was pressed already: the page answered it. Choose another available day the rules allow, or ask_user once with the page's real nearest options`
  if (steps > 2) return "two date steps went nowhere: don't press more dates. ask_user once now, with the page's real nearest options: the next free day the page names, another specialist on the asked day, another place"
  state.dateSteps = steps
  state.lastDate = item.label
  state.lastDateId = item.id
  return null
}

const cancelWord = wordTest(CANCEL_TERMS_WORDS)

/** The page's own words about cancelling (a sentence of its text, or a short control naming the terms), or "". */
export function cancelTerms(map: PageMap): string {
  const sentence = map.text.split(/(?<=[.!?。！？])\s+|\n+/).map((x) => x.trim()).find((x) => x.length >= 8 && x.length <= 220 && cancelWord(x))
  if (sentence) return sentence
  return map.items.find((i) => (i.role === "link" || i.role === "button" || i.role === "summary" || i.role === "other") && i.label.length <= 80 && cancelWord(i.label))?.label ?? ""
}

/** The recap before the booking's last press, or null when it's what was asked on a site booked on before (B2). */
export function recapOf(state: AgentState, map: PageMap, always = false): Recap | null {
  const b = state.plan?.booking
  if (!b) return null
  const p = { ...(state.picked ?? {}), ...(state.daysAtPress ? { date: state.daysAtPress.date } : {}) }
  const otherDay = !!p.date && p.date !== b.date
  const otherTime = !!b.at && !!p.time && p.time !== b.at
  // The place it opened isn't the first one chosen (the next one, when the first had no slot that fits).
  const otherPlace = (state.venues?.tried.length ?? 0) > 1
  const terms = state.playbook ? "" : cancelTerms(map)
  // A day the request named only by its weekday («next Friday» on a Wednesday: this week's or the next?): its date is in
  // front of the person before the last press (128).
  const vague = weekdayOnly(state.request ?? "", todayIso())
  if (!otherDay && !otherTime && !otherPlace && !terms && !vague && !always) return null
  const tried = state.venues?.tried.at(-1)
  // (Whatever way the place was chosen: the list's, the request's, the page's own name, the card the agent opened — 129:
  // «Booking: Fri, Dec 4 – Sun, Dec 6» with no place after the stay was opened from a script-opened card.)
  const subject = pageSubject(map)
  const place = (tried && state.venues?.list.find((v) => v.url === tried)?.name) || b.venue || (subject?.kind === "place" ? subject.name : "") || state.placeOpened || ""
  return {
    ...(place ? { place: place.slice(0, 80) } : {}),
    ...(p.date || b.date ? { date: p.date || b.date } : {}),
    ...(b.dateEnd ? { dateEnd: state.daysAtPress?.dateEnd ?? b.dateEnd } : {}),
    ...(p.time ? { time: p.time } : {}),
    ...(otherDay ? { askedDate: b.date } : {}),
    ...(otherTime ? { askedTime: b.at } : {}),
    ...(otherPlace ? { otherPlace: true } : {}),
    ...(terms ? { terms: terms.slice(0, 220) } : {})
  }
}

/** A date field on the page (a widget's own setting) whose value is another day than the asked one, or null. */
export function widgetDay(map: PageMap, iso: string, end?: string): MapItem | null {
  for (const i of map.items) {
    if (!i.value || i.lock || !(i.type === "date" || ((i.role === "textbox" || i.role === "combobox" || i.role === "select") && (isDateLabel(i.value) || /^\d{4}-\d{2}-\d{2}$/.test(i.value))))) continue
    const day = /^\d{4}-\d{2}-\d{2}$/.test(i.value) ? i.value : dayOf(i.value, iso)
    // (A stay's check-out field holding its last day is the booking's own, 129: «Check-out shows 2026-12-06, not 4 Dec».)
    if (day && day !== iso && day !== end) return i
  }
  return null
}

/** A link's full address without its fragment, or "". */
function linkTo(href: string, page: string): string {
  try {
    return new URL(href, page).toString().split("#")[0]
  } catch {
    return ""
  }
}

/** The days a link's address carries (its query's YYYY-MM-DD values) when none of them is the booking's, or null. */
export function staleDates(href: string, b: PlanBooking | undefined): string | null {
  if (!b) return null
  let days: string[] = []
  try {
    days = [...new URL(href, "https://x.invalid").searchParams.values()].filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
  } catch {
    return null
  }
  if (!days.length || days.includes(b.date) || (b.dateEnd && days.includes(b.dateEnd))) return null
  return days.slice(0, 2).join(", ")
}

export function seesDate(map: PageMap, iso: string): boolean {
  return dayItems(map, iso).length > 0
}

// The page naming its next free day or time, in any of the 15 languages (lexicon).
const nextFreeWord = wordTest(NEXT_FREE_WORDS)

/** Where the page names its next free day: the sentence of its text that says so, and a control that goes there. */
export function nextFreeSaid(map: PageMap): { text: string; button?: string } | null {
  const button = map.items.find((i) => (i.role === "button" || i.role === "link") && i.label.length <= 60 && nextFreeWord(i.label))?.label
  const sentence = map.text.split(/(?<=[.!?。！？])\s+|\n+/).map((x) => x.trim()).find((x) => x.length <= 200 && nextFreeWord(x))
  if (!sentence && !button) return null
  return { text: (sentence ?? button ?? "").slice(0, 160), ...(button ? { button } : {}) }
}

/** A day or slot the page shows as not choosable (marked by the map). */
function greyedItem(i: MapItem): boolean {
  return !!i.state?.some((x) => x === "unavailable" || x === "disabled")
}

/** Whether the page asks for the person's details: an empty field of theirs (name, e-mail, phone) on screen. */
export function detailsForm(map: PageMap): boolean {
  return map.items.some((i) => i.lock === "personal" && !i.value && i.where !== "above" && i.where !== "below" && (i.role === "textbox" || i.role === "combobox"))
}

/** A value as compared with a saved one (spaces, case and a phone's separators aside). */
function normalizeValue(v: string): string {
  return v.toLocaleLowerCase().replace(/[\s()\-.]+/g, "").trim()
}

/** A results list seen in a booking whose place the agent chooses: its fitting places, ranked, kept with the task; the
 *  place the tab is on now counts as tried. */
function noteVenues(state: AgentState, map: PageMap): void {
  const b = state.plan?.booking
  if (!b || b.venue || !(state.chooseVenue || state.plan?.askPlace) || !state.plan?.approved) return
  if (!state.venues) {
    const list = venuesOn(map, b.area ?? [])
    if (list.length) {
      // (Places to ask the person about are only ones in the area the request names: a home page's promoted hotels
      // elsewhere aren't a list to ask from, 125.)
      // So are places on the task's start page, which isn't a search's answer (a home page's promoted places).
      const strict = !!state.plan?.askPlace || sameTaskPage(state.url, map.url)
      const ranked = rankVenues(list, cardsOf(map), b.match ?? [], state.minRating ?? 4.5, b.area ?? [], strict).slice(0, 8)
      if (ranked.length) state.venues = { list: ranked, tried: [] }
    }
  }
  const here = state.venues?.list.find((v) => onVenue(map.url, v))
  if (here && !state.venues!.tried.includes(here.url)) state.venues!.tried.push(here.url)
}

function venuesLine(v: NonNullable<AgentState["venues"]>): string {
  return v.list.map((x, i) => `${i + 1}. «${x.name}» (${x.rating}, ${x.reviews} reviews)${v.tried.includes(x.url) ? " — tried" : ""}`).join("; ")
}

/** The next place by the rules, opened by its own link (never the model's «back»); false when none is left. */
async function openNext(state: AgentState, io: RunnerIO, why: string): Promise<boolean> {
  const next = state.venues?.list.find((v) => !state.venues!.tried.includes(v.url))
  if (!next || !io.open) return false
  state.venues!.tried.push(next.url)
  state.dateSteps = 0
  state.lastDate = undefined
  state.wokeStrip = false
  state.sawDate = state.pressedTarget = state.dateNudged = false
  state.greyTarget = undefined
  await io.open(next.url)
  state.log.push({ call: { tool: "go", why: next.name }, result: `the device opened the next place by the rules, «${next.name}» (${next.rating}, ${next.reviews} reviews), because ${why.slice(0, 160)}` })
  state.lines.push(line({ tool: "go" }, { cls: "free", reason: "next_place" }, null, true, next.name))
  state.stillReads = 0
  state.slotRefusals = 0
  state.lastWasRead = false
  await io.save(state)
  return true
}

/** The person's saved facts by the name a plan asks them by (factKey → value). */
function savedFacts(entries: FormEntry[]): Record<string, string> {
  return Object.fromEntries(liveEntries(entries).filter((e) => e.key === "fact").map((e) => [factKey(e.label), e.value]))
}

/**
 * Whether a booking's plan may start without its card: what it may do is pressing the booking's own button, putting
 * saved details into the fields the plan saw, and the Calendar event, and nothing on the way is paid (no price to
 * pay, no payment page, no deposit or no-show fee, no step of the person's that pays). Signing in, a code or a
 * captcha still stop it later, as the person's.
 */
export function goesAlone(plan: TaskPlan, map: PageMap): boolean {
  // A booking's price (a haircut's €18, paid there) isn't paying now; paying online is the page's (a payment page, card
  // fields, a deposit or no-show fee, a «Pay» button) and always the person's.
  if ((plan.prices.length && !plan.booking) || map.pay || map.deposit || plan.self.some((x) => x.reason === "pay")) return false
  return plan.perms.every((p) => (p.kind === "press" && p.reason === "submit") || p.kind === "fill" || (p.kind === "apple" && p.reason === "event_add"))
}

/** How a site's booking went last time, as the model hears it. */
function playbookLine(steps: string[]): string {
  return `Last time on this site the booking went: ${steps.map((x) => `«${x}»`).join(" → ")}. Go the same way while the pages match; when they don't, go on as usual. It is only a hint: what each step may do is decided as always.`
}

/** The controls a finished booking pressed, in order (no typed or filled values): next time's hint. */
export function playbookOf(log: LogEntry[]): string[] {
  const out: string[] = []
  for (const e of log) {
    if (!e.call || (e.call.tool !== "click" && e.call.tool !== "select") || /^(failed|refused)/.test(e.result)) continue
    const label = (e.call.tool === "select" ? e.call.option : /"(.*)"$/.exec(e.target ?? "")?.[1]) ?? ""
    const t = label.replace(/\s+/g, " ").trim().slice(0, 60)
    if (t && out[out.length - 1] !== t) out.push(t)
  }
  return out.slice(0, 12)
}

/** The times a page offers as free for the slot being chosen: a time list's options, or its slot buttons (not greyed). */
function freeTimes(map: PageMap, call: ToolCall, item?: MapItem): string[] {
  if (call.tool === "select" && item?.options?.length) return item.options.filter((o) => !/\[unavailable\]$/.test(o)).flatMap((o) => timesIn(o).slice(0, 1))
  return map.items.filter((i) => (i.role === "button" || i.role === "link" || i.role === "radio" || i.role === "option") && looksLikeSlot(i.label) && !i.state?.some((x) => x === "unavailable" || x === "disabled")).flatMap((i) => timesIn(i.label).slice(0, 1))
}

/**
 * A time slot pressed in a booking that looks at the Calendar: the model says its date and time, and the device checks
 * them against the person's events (with the buffers). A busy one is refused, whatever the model thought; a refusal's
 * reason goes back to it. (null: the step goes on.)
 */
async function slotRefusal(state: AgentState, io: RunnerIO, call: ToolCall, label: string, map?: PageMap, item?: MapItem): Promise<string | null> {
  const b = state.plan?.booking
  if (!b || (call.tool !== "click" && call.tool !== "select")) return null
  if (!looksLikeSlot(label)) return null
  const date = /^\d{4}-\d{2}-\d{2}$/.test(call.date ?? "") ? call.date! : ""
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(call.time ?? "") ? call.time! : ""
  if (!date || !time) return "a time slot: say its date (YYYY-MM-DD) and time (HH:MM) in date and time when you press it, so the device can check it"
  const why = await slotWhy(state, io, b, date, time, map, call, item)
  // Only a slot that went through is the booking's (127: 19:30 refused after 20:00 was chosen, and the recap said 19:30).
  if (!why) state.picked = { date, time }
  return why
}

async function slotWhy(state: AgentState, io: RunnerIO, b: PlanBooking, date: string, time: string, map?: PageMap, call?: ToolCall, item?: MapItem): Promise<string | null> {
  // The request's window (its time widened by the rules), checked with or without the Calendar (a restaurant, 121 sweep:
  // 13:15 pressed for «17:30»).
  if (b.from && b.until && (time < b.from || time > b.until)) return `${time} is outside the time the request and the rules allow (${b.from}–${b.until}): choose a slot inside it, or ask with the page's nearest real slots`
  // The nearest free time to the one the request names is the device's sum, not the model's (127: 19:30 booked for
  // «19:10» with 19:00 free, 19:30 for «20:10» with 20:00 free): a nearer one the page offers is chosen instead.
  // With no time named, the earliest free one in the part of the day asked (127 stand: «Monday morning», 09:30 free,
  // 10:00 chosen). Said once per slot: a model that keeps its choice after hearing it (a grid of several days whose
  // times aren't this day's) goes on.
  const target = b.at || (b.from && b.until ? b.from : "")
  const once = `${date} ${time}`
  if (target && map && !state.nearSaid?.includes(once)) {
    let nearer = nearerTimes(target, time, freeTimes(map, call!, item), b.from, b.until)
    if (nearer.length && state.calendar && io.slotFree) {
      const fits: string[] = []
      for (const t of nearer.slice(0, 3)) {
        const h = shiftZone(date, t, b.tz)
        if ((await io.slotFree(h.date, h.time, b.minutes).catch(() => null)) !== false) fits.push(t)
      }
      nearer = fits
    }
    if (nearer.length) {
      state.nearSaid = [...(state.nearSaid ?? []), once].slice(-12)
      return b.at
        ? `${nearer[0]} is free on the page and nearer to the asked ${b.at} than ${time}: choose ${nearer[0]}`
        : `${nearer[0]} is free on the page and earlier in the asked time (${b.from}–${b.until}) than ${time}: with no time named, the earliest free one — choose ${nearer[0]}`
    }
  }
  if (!state.calendar || !io.slotFree) return null
  // The page's time is the place's; the Calendar is asked in the device's.
  const here = shiftZone(date, time, b.tz)
  const free = await io.slotFree(here.date, here.time, b.minutes).catch(() => null)
  if (free === false) return `${date} ${time} is busy in the person's calendar (their event, with time to get there). Free then: ${state.calendar}. Choose another time the rules allow and say in the summary why`
  if (free === true) state.slot = { date, time }
  return null
}

/** Runs the task until it needs the person, ends, or fails. Saves the state at every stop. */
export async function drive(state: AgentState, io: RunnerIO): Promise<AgentState> {
  while (state.status === "running") {
    if (state.step >= io.maxSteps) {
      state.status = "done"
      // Never only «too many steps»: what it got to, from its last line (the panel shows it as not finished).
      state.summary = state.summary || lastWords(state)
      state.error = "steps"
      break
    }
    // Two steps left: the model hears it should finish now and say what it found, or ask how to go on.
    if (state.step >= io.maxSteps - 2 && !state.refused) state.refused = "only 2 steps are left: call done now saying what you found and what is left for the person, or ask_user with choices for the way on"
    // The page's amounts only when a price may be checked: the plan's first look, or a plan that saw prices.
    // A booking reads them too: a deposit or a no-show fee on its page makes paying the person's step.
    const money = (state.step === 0 && !!io.planning && !state.plan) || (!!state.plan?.approved && (state.plan.prices.length > 0 || !!state.plan.booking))
    // (A read that fails while the page is changing, a site's form opened on its own page on the iPad, 124: the same as
    // no answer — wait for the page and read again, never the task's end.)
    // The part of the map the model asked for with read_page (a long slot list: the times after noon come in part 2;
    // 125, the iPad: four reads of part 1 again, then «stuck»); the next step is back on the first part.
    const part = state.readPart
    state.readPart = undefined
    const opts = { money, ...(part ? { part } : {}), ...(state.openParts?.parts.length ? { open: state.openParts.parts, openUrl: state.openParts.page } : {}), words: requestWords(state.request) }
    // (An empty map — the page between two documents after «back» — is no map: read again, never sent to the server, which
    // refused it, the director's real-site run on 10eed066.)
    const read = async () => {
      const m = await io.map(opts).catch(() => null)
      return m && (m.items.length || m.text.trim()) ? m : null
    }
    let map = await read()
    if (!map) {
      await io.waitPage().catch(() => {})
      map = await read()
    }
    if (!map) {
      await io.waitPage().catch(() => {})
      map = await read()
    }
    if (!map) {
      state.status = "error"
      state.error = "page"
      break
    }
    state.host = hostOf(map.url)
    const pageNow = pageLink(map.url)
    if (pageNow && state.trail?.[state.trail.length - 1] !== pageNow) state.trail = [...(state.trail ?? []), pageNow].slice(-30)
    // (The address the last tap's page tried to open in a new tab: a link on this map, only while it's the same page.)
    if (state.openedLink && state.openedLink.page && state.openedLink.page !== map.url) state.openedLink = undefined
    if (state.openedLink && !state.openedLink.page) state.openedLink.page = map.url
    // (Never a stale one: the check and the open go by the same address.)
    map = { ...map, items: map.items.filter((i) => i.id !== NEW_TAB_ID) }
    if (state.openedLink) map.items.push({ id: NEW_TAB_ID, role: "link", label: `${state.openedLink.from || "new tab"} (opens in a new tab)`.slice(0, 80), href: mapHref(state.openedLink.url, map.url) } as MapItem)
    checkDayLine(state, map)
    noteVenues(state, map)
    // A layer over the page that isn't the task (rewards, a newsletter, the site's app, notifications, location): closed
    // by its own «Not now» / «×» as a free step, never a question, never «Accept» or «Allow» (the director on 124). Only
    // once the person started the task; cookie banners are the cookie closer's.
    // (The same layer back after the same press, 124: a «Collect points… Keep earning» step a «Continue» opens: that press
    // leads through it, so it's left to the model with a word, not closed again.)
    const lastPress = [...state.log].reverse().find((l) => l.call.tool === "click" && !/closed a layer over the page/.test(l.result ?? ""))?.target
    if (map.promo && lastPress && (state.closedAfter ?? []).includes(lastPress)) {
      if (!state.refused) state.refused = `a layer over the page came back after «${lastPress}» ("${map.promo.label}" closes it): it's that press's next step — go through it with its own button to continue, unless it only offers something the task doesn't need`
    } else if (map.promo && (!io.planning || state.plan?.approved) && (state.popups ?? 0) < 3) {
      state.popups = (state.popups ?? 0) + 1
      if (lastPress) state.closedAfter = [...(state.closedAfter ?? []), lastPress]
      await perform(state, io, { tool: "click", id: map.promo.id, why: "" }, { cls: "free", reason: "close" }, `button "${map.promo.label.slice(0, 60)}"`)
      const shown = state.lines[state.lines.length - 1]
      if (shown) shown.popup = true
      const logged = state.log[state.log.length - 1]
      if (logged) logged.result = `${logged.result} (the device closed a layer over the page that wasn't the task)`
      continue
    }
    // A cookie layer the product's closer left (decision 13a): the device refuses optional cookies itself by the
    // layer's own control the classifier calls cookies_reject — never an accept, which stays the person's — once per
    // page address and three a task; when that changes nothing the banner is the model's, as before.
    if ((!io.planning || state.plan?.approved) && (state.cookieDevice ?? 0) < 3 && !(state.cookiePages ?? []).includes(map.url)) {
      const ctx = { map, startHost: state.startHost, request: words(state), confirmedHere: confirmedOn(state, hostOf(map.url)), policy: io.policy }
      const reject = map.items.find((i) => {
        if (i.where !== "dialog" || (i.role !== "button" && i.role !== "link")) return false
        const v = classify({ tool: "click", id: i.id, why: "" }, ctx)
        return v.cls === "free" && v.reason === "cookies_reject"
      })
      if (reject) {
        state.cookieDevice = (state.cookieDevice ?? 0) + 1
        state.cookiePages = [...(state.cookiePages ?? []), map.url]
        rule(state, "cookie_device")
        await perform(state, io, { tool: "click", id: reject.id, why: "" }, { cls: "free", reason: "cookies_reject" }, `button "${reject.label.slice(0, 60)}"`)
        const shown = state.lines[state.lines.length - 1]
        if (shown) shown.popup = true
        const logged = state.log[state.log.length - 1]
        if (logged) logged.result = `${logged.result} (the device refused optional cookies itself: «${reject.label.slice(0, 60)}»)`
        continue
      }
    }
    if (state.plan?.approved && state.plan.booking?.date && !state.sawDate) {
      const days = dayItems(map, state.plan.booking.date)
      // (Or set in the page's own date field: a stay list with «Check-in 2026-12-04», 129.)
      if (days.some((i) => !greyedItem(i)) || showsDay(map, state.plan.booking.date)) state.sawDate = true
      else if (days.length) state.greyTarget = days[0].label
      // A window whose first day the page's day control doesn't offer (decision 14b: a strip listing only bookable days,
      // 29 and 30 Nov for a window from the 27th): that is the page's answer for it, when the earliest day it shows is
      // later than the first and no later than a week after the window's end; a control parked far away isn't.
      const win = windowOfPlan(state)
      const shown = win && !days.length ? shownDays(map, win.first) : []
      if (win && shown.length && shown[0] > win.first && shown[0] <= addDays(win.last, 7)) {
        state.sawDate = true
        const inWin = offeredDays(map, win.first).filter((o) => o.date >= win.first && o.date <= win.last)
        const nearest = offeredDays(map, win.first).find((o) => o.date > win.last)
        const line = inWin.length
          ? `the page's day control doesn't offer ${dayWords(win.first)}; the days it offers in the request's window: ${inWin.map((o) => `«${o.item.label}»`).join(", ")} — the earliest first`
          : `the page's day control doesn't offer ${dayWords(win.first)}, and none in the request's window${nearest ? `; the page's nearest day is «${nearest.item.label}» (${dayWords(nearest.date)})` : ""}`
        if (!state.refused) state.refused = line
      }
    }
    // A booking whose form is a booking provider's frame on this page (a restaurant's provider widget, 121 sweep: «I've tried "Book a
    // table" five times»): the device opens that form on its own page, once; the provider counts as this task's site.
    const widget = state.plan?.approved && state.plan.booking && !state.widgetOpened ? map.frames?.find(bookingFrame) : undefined
    if (widget && io.open) {
      state.widgetOpened = widget.src
      await io.open(widget.src)
      state.confirmedSites = [...new Set([...(state.confirmedSites ?? []), siteOfHost(widget.host)])]
      state.log.push({ call: { tool: "go", why: widget.host }, result: `the booking form is ${widget.host}'s frame on this page, which you can't see inside: the device opened it on its own page — go on there` })
      state.lines.push(line({ tool: "go" }, { cls: "free", reason: "booking_form" }, null, true, widget.host))
      continue
    }
    // No progress: reads in a row on a page that didn't change. Two: the model is told to stop reading and say what it
    // found (or ask how to go on); four: the task stops, not finished.
    const sig = pageSig(map)
    state.stillReads = state.lastWasRead && state.lastSig === sig ? (state.stillReads ?? 0) + 1 : 0
    state.lastSig = sig
    state.lastWasRead = false
    if ((state.stillReads ?? 0) >= 4 && !detailsForm(map) && (await openNext(state, io, "the page stopped changing"))) continue
    if ((state.stillReads ?? 0) >= 4) {
      state.status = "done"
      state.error = "stuck"
      state.summary = state.summary || lastWords(state)
      break
    }
    if ((state.stillReads ?? 0) >= 2) state.refused = "no progress: the page hasn't changed over your last reads. Don't read it again. If the person's words, their answers or <rules> already decide what to do now (another time inside the window, the next day the rules allow: press it), do it; otherwise tell them what you found and ask how to go on (ask_user with choices), or call done"
    const stored = withNameParts(await io.entries().catch(() => [] as FormEntry[]))
    // The card's contact answers not kept in «Мои данные» count for this task (filled by key, like saved ones).
    const extra = (state.oneTime ?? []).filter((o) => !liveEntries(stored).some((e) => e.key === o.key))
    const entries = extra.length ? [...stored, ...extra.map((o) => ({ id: `once-${o.key}`, key: o.key, label: "", value: o.value, updatedAt: 0 }) as FormEntry)] : stored
    const keys = [...new Set(liveEntries(entries).map(modelKey))]
    const here = (await io.device?.().catch(() => null)) ?? null
    if (state.step === 0 && io.planning && !state.plan) {
      const p = await planStep(state, io, map, keys, here, entries)
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
      task: { id: state.id, request: requestWithAnswers(state.request, state.plan), lang: state.lang, startHost: state.startHost, step: state.step, confirmedHere: confirmedOn(state, hostOf(map.url)), token: state.token, strongUsed: state.strongUsed, now: nowLine(), ...(here ? { device: here } : {}), ...(plan ? { plan } : {}), ...(state.rules ? { rules: state.rules } : {}), ...(state.calendar ? { calendar: state.calendar } : {}), ...(state.playbook ? { playbook: state.playbook } : {}), ...(state.venues ? { venues: venuesLine(state.venues) } : {}), ...(state.subject ? { subject: state.subject } : {}), ...(state.datesNone?.includes(pageKey(map.url)) ? { noDates: true } : {}) },
      map: sent(map), log: state.log, ...(state.refused ? { refused: state.refused } : {}), ...(state.data ? { data: state.data } : {}), keys
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
      if (reply.limit) state.limit = reply.limit
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
    // set_dates: the device sets the booking's dates itself (setdates.ts); the plan's days only.
    if (call.tool === "set_dates") {
      await datesStep(state, io, map, call)
      await io.save(state)
      continue
    }
    // «back» only to a page this task was on before, on the task's site: the task's first page is the floor.
    if (call.tool === "back") {
      const trail = state.trail ?? []
      const before = trail.length >= 2 ? trail[trail.length - 2] : ""
      if (!before || siteOfHost(hostOf(before)) !== siteOfHost(state.startHost)) {
        rule(state, "back_floor")
        state.log.push({ call, result: `refused: «back» here would leave the pages of this task (this is the first page it opened, or the one before it is another site's): use this page's own links or search instead` })
        state.refused = "«back» would leave this task's pages: use the page's own links or search"
        await io.save(state)
        continue
      }
      state.trail = trail.slice(0, -1)
    }
    if (call.tool === "done") {
      // A press the plan lists as the agent's own hasn't happened: one more step for it, or «done» again with the
      // reason in the summary (the stand: a cart «done» before its «Add to cart»).
      // (Not once the booking's press went: run 1 on d05b60bb pressed «Reserve» again for a planned «Book now» the page
      // never had, after «Your stay is booked».)
      const missing = state.bookPress ? null : missingPress(state.plan, state.log)
      if (missing && !state.doneNudged) {
        state.doneNudged = true
        rule(state, "done_press")
        state.log.push({ call: { tool: "done" }, result: `refused: the plan's press "${missing.label}" hasn't happened yet — do it now, or call done again and say in the summary why it is left` })
        await io.save(state)
        continue
      }
      // A page that asks for the person's details is the booking's next step, not its end (the director, round 141: at
      // an empty «Enter your details» the agent ended and said the booking might have gone through): sent back once.
      if (state.plan?.booking && !state.detailsNudged && !confirmedOnPage(map) && map.items.some((i) => i.lock === "personal" && (i.state ?? []).includes("empty") && i.where !== "above" && i.where !== "below")) {
        state.detailsNudged = true
        rule(state, "details_next")
        state.log.push({ call: { tool: "done" }, result: `refused: this page asks for the person's details — the booking's next step, not its end: fill them from <saved> (ask once for one that's missing), then press the booking's own button; never tell the person a booking may have gone through when the page shows no confirmation` })
        await io.save(state)
        continue
      }
      state.status = "done"
      state.summary = call.summary ?? ""
      await afterBooking(state, io, call, here, map)
      break
    }
    // The model's answer failed the code's check twice: the task ends with an error, not an empty question.
    // …except a control the page shows disabled while it settles (a salon's «Continue» greyed for a moment after a
    // service was added: three tries at it ended the task): the device waits for the page and reads again, twice.
    if (reply.verdict.reason === "bad_call" && /is disabled/.test(reply.call?.why ?? "") && (state.disabledWaits ?? 0) < 2) {
      state.disabledWaits = (state.disabledWaits ?? 0) + 1
      await io.waitPage().catch(() => {})
      state.log.push({ call: { tool: "read_page", why: "" }, result: `${reply.call?.why ?? "that control is disabled"} on the page now (it may still be loading): the device waited and reads the page again — choose what it shows enabled, or wait for it` })
      continue
    }
    if (reply.verdict.reason === "bad_call") {
      state.status = "error"
      state.error = "bad_call"
      break
    }
    // A booking whose place the agent chose (the request named none): before a question, the next place or two by the
    // rules (a salon booking site, 120: it asked about the first barbershop's slots instead of trying the next).
    // A form asking for the person's details is the booking going on, not the place failing (the director on 23e9:
    // a restaurant was left for a required e-mail): no next place for it.
    // The specialist question the person asked for on the place's page («I'll choose there»): it passes the question
    // guards below once (they're for questions about places and days).
    const chosenAsk = call.tool === "ask_user" && !!state.askSpecialist
    if (chosenAsk) state.askSpecialist = false
    // The place question the plan left to the agent (askPlace), asked from a list of places: once, past the guards below.
    const placeAsk = call.tool === "ask_user" && !!state.plan?.askPlace && !state.placeAsked && !!state.venues?.list.length
    if (placeAsk) state.placeAsked = true
    // (In the last two steps a question goes to the person: the device opening the next place instead spent the last
    // step and the task ended with nobody asked, 126 on a hotel site.)
    const details = detailsForm(map) || chosenAsk || placeAsk || state.step >= io.maxSteps - 2
    if (call.tool === "ask_user" && !details && state.plan?.booking && !state.plan.booking.venue && state.chooseVenue && (state.venueNudges ?? 0) < 2 && (await openNext(state, io, call.question ?? ""))) {
      state.venueNudges = (state.venueNudges ?? 0) + 1
      continue
    }
    // (Not on a page that is one place's own booking page — it lists no places and has the booking's own controls: days,
    // times, a date field, a details form — the director's real-site run on 10eed066: a restaurant's, a salon's and a
    // hotel's own pages refused every question.)
    if (call.tool === "ask_user" && !details && state.plan?.booking && !state.plan.booking.venue && state.chooseVenue && (state.venueNudges ?? 0) < 2 && !state.venues && !ownBookingPage(map)) {
      state.venueNudges = (state.venueNudges ?? 0) + 1
      // No list was ever seen (a home page, an error page with a search box, one featured place): the site's own search
      // finds the places, never «back» to a list that isn't there (a salon marketplace, 121 sweep: it went back to nothing and
      // then said it had checked several places).
      const box = map.items.find((i) => (i.role === "textbox" || i.role === "combobox") && !i.lock && (i.type === "search" || SEARCH_BOX.test(i.label)))
      rule(state, "place_find")
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: box ? `refused: the request names no place, so it's yours to find: type what the request asks (the service or cuisine, and the area) into the site's search box #${box.id} "${box.label.slice(0, 60)}", search, then choose from the list by the rules` : "refused: the request names no place, so it's yours to find: open the site's own search or the category that fits (its search box, «Barbers», «Restaurants»), then choose from the list by the rules; ask only after two places didn't fit, with their real slots" })
      continue
    }
    // The asked day shown greyed and never pressed (a strip that greys days it hasn't loaded): the device presses it once
    // itself and the page's answer goes to the model, instead of a question about a day nobody looked at (a salon booking site, 124:
    // sent back once, the model asked again; pressed, «full», with its next free day).
    // A window with no offered day in it on the page (decision 14c): the question that offers the page's nearest day
    // beyond the window is a true question — it passes at once, once (the day of the person's answer is then the asked
    // day, as before).
    const winNow = call.tool === "ask_user" && !details && state.plan?.approved && !state.windowAsked ? windowOfPlan(state) : null
    const offeredNow = winNow ? offeredDays(map, winNow.first) : []
    const askDays = winNow ? daysInText(`${call.question ?? ""} ${(call.choices ?? []).join(" ")}`, winNow.first) : []
    const windowTrue = !!winNow && state.sawDate === true && !offeredNow.some((o) => o.date >= winNow.first && o.date <= winNow.last) && offeredNow.some((o) => o.date > winNow.last && askDays.includes(o.date))
    if (windowTrue) state.windowAsked = true
    const greyDay = !windowTrue && call.tool === "ask_user" && !details && state.plan?.approved && state.plan.booking?.date && !state.sawDate && !state.pressedTarget
      ? dayItems(map, state.plan.booking.date).find(greyedItem)
      : undefined
    if (greyDay) {
      state.pressedTarget = true
      state.sawDate = true
      await perform(state, io, { tool: "click", id: greyDay.id, why: `«${greyDay.label}» pressed once to read the page's answer for the asked day` }, { cls: "free", reason: "click" }, `button "${greyDay.label.slice(0, 60)}"`)
      rule(state, "day_grey")
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `held: the device pressed the asked day «${greyDay.label}» first (it showed greyed); read the page's answer for it, then go on or ask with what the page shows` })
      continue
    }
    // The page names its own next free day (in its words, or a button to it) and the model asks
    // instead (124, a salon strip: «27 and 28 have no times, open only until 9 Dec» while the page said its next free
    // day was the 28th): sent back once with the page's own words, so the rules decide or the question offers that day.
    if (!windowTrue && call.tool === "ask_user" && !details && state.plan?.approved && state.plan.booking && !state.nextNudged) {
      const said = nextFreeSaid(map)
      if (said) {
        state.nextNudged = true
        const why = `the page names its next free day: «${said.text}»${said.button ? `, with its own control «${said.button}»` : ""}. Go there (that control, or that day) and choose by the rules and the request; ask only if that day doesn't fit them, offering it. Don't call days closed the page didn't say were`
        rule(state, "next_free")
        state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `refused: ${why}` })
        state.refused = why
        continue
      }
    }
    // A booking widget whose own date field shows another day than the asked one (B3: «your time isn't available» read
    // as no slot): sent back once to set the field first.
    const field = !windowTrue && call.tool === "ask_user" && !details && state.plan?.approved && state.plan.booking?.date && !state.widgetNudged ? widgetDay(map, state.plan.booking.date, state.plan.booking.dateEnd) : null
    if (field) {
      state.widgetNudged = true
      const why = `the page's own date field «${field.label.slice(0, 40)}» shows ${field.value}, not ${dayWords(state.plan!.booking!.date)}: set it to the asked day first (and the party, then the time), read the page's slots for that day, then go on; ask only with what it shows then`
      rule(state, "date_field")
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A question about the booking's day before the page ever showed that day: sent back once, to go to it first.
    if (call.tool === "ask_user" && !details && state.plan?.approved && state.plan.booking?.date && !state.sawDate && !state.dateNudged) {
      state.dateNudged = true
      // (Round 141, design-141: the device goes to the day itself — and, with a window, on to the next days — instead of
      // sending the model there; the model's question is answered by what the page shows then.)
      if (!state.greyTarget) {
        const went = await datesStep(state, io, map, { tool: "set_dates", why: "", date: state.plan.booking.date }, true)
        if (went && !went.fallback) {
          state.refused = `your question came before the page had shown the day; the device went to it itself: ${went.line}. Go on from what the page shows now; ask only with what it showed`
          await io.save(state)
          continue
        }
      }
      const day = dayWords(state.plan.booking.date)
      const why = state.greyTarget
        ? `«${state.greyTarget}» shows greyed, which can mean the page hasn't loaded that day yet: press it once and read what the page says (its free times, or that it's full and its next free day), then go on; ask only with days and times the page showed as free`
        : `the page hasn't shown ${day} yet, so whether it's free isn't known: go to that day first — when the page shows no dates yet, choose what the request asks to reach them (the closest fitting service's own choose or book button; a near name is fine), then the page's calendar or date button and its «next month» arrow, or the date strip scrolled — read it, then go on; ask only with days the page showed as free`
      rule(state, "day_unseen")
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // The place was the person's answer on the card: a question about the place again is refused with that answer (one
    // question, once) — unless the chosen place couldn't be opened or has nothing for the days, and the question says so.
    const placeAgain = call.tool === "ask_user" && !chosenAsk && !placeAsk ? askedPlaceAgain(state, call, map) : null
    if (placeAgain && (state.placeAgain ?? 0) < 2) {
      state.placeAgain = (state.placeAgain ?? 0) + 1
      rule(state, "place_again")
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `refused: ${placeAgain}` })
      state.refused = placeAgain
      continue
    }
    // A question asking leave to use a contact the person gave (decision 13b: «please confirm +44 20 7946 0000 so I can
    // type it»): sent back once a task; a second such question goes to the person.
    if (call.tool === "ask_user" && !state.givenAsk) {
      const quoted = contactsQuoted(`${call.question ?? ""}\n${(call.choices ?? []).join("\n")}`)
      const hit = quoted.find((c) => contactGiven(c, words(state), liveEntries(entries)))
      // The same question with no value quoted (the director's follow-up 2: «Salon Mira needs your phone number… What
      // is it?» while the request gives it): one e-mail or phone asked for by contactAsked's own words, and the person's
      // words carry one of that kind by pattern. Never for a name; one allowance with the quoted kind.
      const askedKind = quoted.length ? null : contactKind(contactAsked(call.question ?? "") ?? "")
      const inWords = askedKind === "email" || askedKind === "phone" ? contactsQuoted(words(state)).find((c) => c.kind === askedKind) : undefined
      if (hit || inWords) {
        state.givenAsk = true
        const why = hit
          ? `the person gave «${hit.value}» themselves: type it as written (or fill the saved one); ask only for a detail they didn't give`
          : `the person's request gives their ${inWords!.kind}: «${inWords!.value}»: type it as written; ask only for a detail they didn't give`
        rule(state, "given_ask")
        state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: `refused: ${why}` })
        state.refused = why
        continue
      }
    }
    if (call.tool === "ask_user") {
      // The person answers (a button or their own words) and the task goes on (TestFlight 118: «На завтра мест нет…
      // Записать на 24-е? [Да] [Другой день] [Отмена]»).
      state.status = "asked"
      state.summary = call.question ?? ""
      // Times the page doesn't show (taken from the Calendar alone, a salon booking site 2) aren't offered.
      state.choices = honestChoices(pageChoices(call.choices ?? [], pageTimes(map)), map, state.dead)
      // A contact detail «Мои данные» hasn't got (asked once): the answer may be kept there.
      const key = details ? contactAsked(call.question ?? "") : null
      state.askKey = key && !liveEntries(entries).some((e) => e.key === key) ? key : undefined
      break
    }
    // The device's own check, on its own map: never milder than the server's.
    // The control as classed now goes with the step: the hands check it's still that one before they act.
    const seenItem = call.id ? map.items.find((i) => i.id === call.id) : undefined
    // A saved detail into a field that asks for another kind (a restaurant site: the full name into «email»): refused, and the
    // model hears which detail the field wants and whether «Мои данные» has it (else: ask the person once).
    const wants = call.tool === "fill" && call.key && seenItem ? fieldKind(seenItem, keyOfAutocomplete(seenItem.auto)?.key ?? null) : null
    if (wants && call.key && (wants.includes(".") ? wants !== call.key : wants !== keyKind(call.key))) {
      const has = liveEntries(entries).some((e) => (wants.includes(".") ? modelKey(e) === wants : keyKind(modelKey(e)) === wants))
      const why = `the field "${seenItem!.label}" asks for the ${wants}, not ${call.key}${has ? `: fill it with the saved ${wants}` : `; <saved> has no ${wants}: ask the person for it once (ask_user naming it)`}`
      rule(state, "field_kind")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A saved contact only into a field of its own kind (129: «Fill in from My details? Destination ← Alex Test» on a stay's
    // search box): refused to the model, never put to the person. A field with no contact kind takes no saved contact.
    const fillKind = call.tool === "fill" && call.key && seenItem ? contactKind(call.key) : null
    // (A long label — «Your full name as in your passport» — read by its words when the page marks the field personal.)
    const fieldIs = seenItem ? contactField(seenItem) ?? (seenItem.lock === "personal" ? contactKind(fieldKind(seenItem, null) ?? contactAsked(seenItem.label) ?? "") : null) : null
    if (fillKind && fieldIs !== fillKind) {
      const why = `the field "${seenItem!.label.slice(0, 60)}" isn't a ${fillKind} field: a saved ${fillKind} never goes into it. If it's the page's search or another field the request answers, type the request's own words there (type)`
      rule(state, "contact_kind")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A detail the request gives isn't filled from «Мои данные» (127: «for Maria Kim, maria@example.com» — the card offered
    // the saved Alex Test's name and e-mail, ticked): the request's own words go in.
    const said = words(state)
    const given = requestGives(state.plan, said)
    // (One the person gave: a saved value that is the request's own goes in as it.)
    const own = (key: string, value?: string) => !given.has(contactKind(key) ?? "") || (!!value && saidInWords(said, value))
    const givenKind = call.tool === "fill" && call.key ? contactKind(call.key) : null
    if (givenKind && !own(call.key!, liveEntries(entries).find((e) => modelKey(e) === call.key)?.value)) {
      const why = `the request gives the ${givenKind} itself: type the request's own words into that field (type), never a saved ${givenKind}`
      rule(state, "given_words")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A booking for someone the request names (128: Maria Kim's table went out with the saved alex.test@…): the person's
    // own saved contact goes into a field the page doesn't require only when they ticked it on the card or answered it here.
    // (Required by the page's state or its «*»; refused once per field: the form may ask for it after the press, and then
    // the person is asked with the value shown, never a loop.)
    const required = !!seenItem && (!!seenItem.state?.includes("required") || bareLabel(seenItem.label) !== seenItem.label.trim())
    const otherKind = call.tool === "fill" && call.key && state.plan?.forOther && seenItem && !required && !state.otherLeft?.includes(seenItem.id) ? contactKind(call.key) : null
    if (otherKind && !state.plan!.perms.some((p) => p.reason === "contact" && p.on && p.keys?.includes(call.key!)) && !state.oneTime?.some((o) => o.key === call.key)) {
      state.otherLeft = [...(state.otherLeft ?? []), seenItem!.id]
      const why = `this booking is for someone the request names: the saved ${otherKind} is the person's own, not theirs, and the page doesn't require this field — leave it empty and go on`
      rule(state, "other_person")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A stay's or a rental's place opened from a list whose own search hasn't taken the days (128: the model typed the
    // dates and opened a stay without pressing Search, twice in three; the stay page said «Choose your dates» and the task
    // ended in questions): sent back once per page — set the days in its fields and press its search first.
    const unsearched = seenItem && (call.tool === "click" || call.tool === "go") && seenItem.role === "link" && call.id !== NEW_TAB_ID ? searchFirst(state, map) : null
    if (unsearched) {
      state.searchNudged = [...(state.searchNudged ?? []), map.url]
      rule(state, "search_first")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${unsearched}` })
      state.refused = unsearched
      continue
    }
    // A place that doesn't fit the request or the rules (a French restaurant for «Italian») isn't opened.
    // Dates (124, the owner on a salon booking site: 11 steps re-pressing «Sat, Dec 26» that the page showed greyed): a day or a
    // slot the page shows as unavailable is never pressed (when the whole strip is greyed, one may be tapped once to
    // wake it); the same date isn't pressed twice; after two date steps without progress, the one question.
    // A menu or a picker the last press opened (shown expanded now) pressed again would close it (a batch's last press
    // opened a colour list, the model pressed it again «to open it», four times): its list is what to choose from.
    const lastCall = state.log[state.log.length - 1]?.call
    if (seenItem && call.tool === "click" && seenItem.state?.includes("expanded") && lastCall?.tool === "click" && lastCall.id === call.id) {
      const why = `«${seenItem.label.slice(0, 60)}» is open now (its last press opened it): choose from the list it shows; pressing it again would close it`
      rule(state, "list_open")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    const dateRefusal = seenItem && (call.tool === "click" || call.tool === "select") && state.plan?.booking ? dateStep(state, map, seenItem, call) : null
    if (dateRefusal) {
      rule(state, "date_step")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${dateRefusal}` })
      state.refused = dateRefusal
      continue
    }
    // A link whose address carries other days than the booking's (a results list searched before the dates were
    // changed, 125: a hotel's link with the old check-in): the search goes again first.
    const stale = seenItem?.href && (call.tool === "click" || call.tool === "go") && state.plan?.approved ? staleDates(seenItem.href, state.plan.booking) : null
    if (stale) {
      const why = `that link carries other dates (${stale}) than the booking's: run the page's search again with the request's dates (its Search or Apply), then choose from the new list`
      rule(state, "link_dates")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    const place = seenItem && (call.tool === "click" || call.tool === "go") ? venueOf(seenItem, map.url) : null
    // The place is the person's to choose (askPlace) and a list is open: it's asked before one is opened (125, a clinic
    // site: a dentist opened without the question).
    // (Any link of the places found — a list with no ratings too — by its address.)
    const listed = seenItem?.href && (call.tool === "click" || call.tool === "go") && state.venues ? state.venues.list.find((v) => linkTo(seenItem.href!, map.url) === v.url) : undefined
    if ((place || listed) && state.plan?.askPlace && !state.placeAsked && state.venues?.list.length) {
      const best = state.venues.list.slice(0, 2).map((v) => `«${v.name}» (${v.rating}, ${v.reviews})`).join(", ")
      const why = state.chooseVenue
        ? `which place is the person's choice: ask_user once now with the two best by the rules (${best}) and a third choice to let you choose by the rules; open one only after the answer`
        : `which place is the person's choice (their rules say not to choose one for them): ask_user once now with the first places the list shows (${best}); open one only after the answer`
      rule(state, "place_ask")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    if (place && state.venues && !state.venues.list.some((v) => v.url === place.url)) {
      const fit = state.venues.list.filter((v) => !state.venues!.tried.includes(v.url)).map((v) => `«${v.name}»`).slice(0, 4).join(", ")
      rule(state, "place_unfit")
      state.log.push({ call, target: target ?? undefined, result: `refused: «${place.name}» doesn't fit the request or the rules${fit ? `; the ones that do: ${fit}` : ""}` })
      state.refused = "choose a place from <venues>"
      continue
    }
    // The place is chosen (the request named it, or the person picked it): a press that belongs to another place on a
    // list — its own link, or a control in the card that place heads («See availability») — is refused, with the chosen
    // place's own link (the director's device pass on 72264bba: «Opening Harmony Bay Hotel» opened another hotel's page,
    // then about ten steps went to finding the link again).
    const other = seenItem && (call.tool === "click" || call.tool === "go") ? otherPlace(state, map, seenItem) : null
    if (other) {
      rule(state, "place_other")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${other}` })
      state.refused = other
      continue
    }
    if (seenItem) call.expect = { label: seenItem.label, role: seenItem.role, ...(seenItem.lock ? { lock: seenItem.lock } : {}) }
    const device = classify(call, { map, startHost: state.startHost, request: words(state), confirmedHere: confirmedOn(state, hostOf(map.url)), policy: io.policy })
    let verdict = stricter(reply.verdict, device)
    if (state.readDevice && call.tool === "type" && verdict.cls === "free" && !saidInWords(words(state), call.text ?? "")) verdict = { cls: "confirm", reason: "device_data" }
    // A contact field takes only what the person said, answered or saved — never a value made up or derived (127: «Alex»
    // typed into Name, taken from the e-mail just given).
    const typedKind = verdict.cls !== "blocked" && call.tool === "type" && seenItem && (call.text ?? "").trim() ? contactField(seenItem) : null
    if (typedKind && !saidInWords(words(state), call.text ?? "") && !liveEntries(entries).some((e) => normalizeValue(e.value) === normalizeValue(call.text ?? ""))) {
      const has = liveEntries(entries).some((e) => contactKind(modelKey(e)) === typedKind)
      const why = `«${(call.text ?? "").slice(0, 40)}» isn't in the person's words, their answers or <saved>: never make up or derive a ${typedKind}; ${has ? `fill the saved ${typedKind} (fill with its key)` : `ask_user for their ${typedKind} once`}`
      rule(state, "made_up")
      state.log.push({ call: { ...call, text: "" }, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A step the approved plan allows goes without a question (a price changed since the plan, or a step the check
    // found off the request, is never covered: those ask as before).
    let perm: Perm | null = verdict.cls === "confirm" || verdict.cls === "self" ? covered(state.plan, call, verdict, map, words(state), reply.offRequest) : null
    // A saved detail whose value is the one the person wrote in the request: the plan's «type your details» covers it.
    // Typing a saved detail's own value into a field the plan meant to fill with it: the plan's fill covers it.
    if (!perm && call.tool === "type" && verdict.reason === "personal" && state.plan?.approved && !reply.offRequest && call.id) {
      const filling = state.plan.perms.find((p) => p.kind === "fill" && p.on && (!!p.ids?.includes(call.id!) || p.reason === "contact") && sameSite(p.host, hostOf(map.url)))
      const typed = normalizeValue(call.text ?? "")
      if (filling && typed && liveEntries(entries).some((e) => filling.keys?.includes(modelKey(e)) && normalizeValue(e.value) === typed)) perm = filling
    }
    if (!perm && call.tool === "fill" && verdict.reason === "fill" && state.plan?.approved && !reply.offRequest) {
      const typing = state.plan.perms.find((p) => p.kind === "personal" && p.on)
      const lines = typing ? fillLines(call, map.items.find((i) => i.id === call.id) ?? null, entries, map.lang || state.lang, map) : []
      const said = words(state)
      if (typing && lines.length && lines.every((l) => saidInWords(said, l.value))) perm = { ...typing, keys: lines.map((l) => l.key), ids: lines.map((l) => l.id) }
    }
    // A count that isn't the request's (people, tickets, rooms, children: report-137, a table «for 2» set to «12 people»
    // from a large-party list): refused, with what the list offers; when the request's number isn't there, ask.
    const countWhy = verdict.cls !== "blocked" && state.plan?.booking ? countRefusal(call, seenItem, map, words(state), state.ruleParty) : null
    if (countWhy) {
      rule(state, "count_other")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${countWhy}` })
      state.refused = countWhy
      continue
    }
    // The press that sends a booking while a contact the person gave is still empty on the page (decision 13c, ru book:
    // name and phone typed, the e-mail the request gave never, «Забронировать» pressed): sent back once per field; the
    // second press goes through. Saved details alone don't trigger it.
    const emptyGiven = verdict.cls !== "blocked" && verdict.reason === "submit" && call.tool === "click" ? emptyGivenField(map, new Set([...requestGives(state.plan, words(state)), ...contactsQuoted(words(state)).map((c) => c.kind)]), [...(state.contactEmpty ?? []), ...typedIds(state)], seenItem?.form) : null
    if (emptyGiven) {
      state.contactEmpty = [...(state.contactEmpty ?? []), emptyGiven.item.id]
      const why = `«${emptyGiven.item.label.slice(0, 60)}» is still empty and the person gave their ${emptyGiven.kind}: type it first, then press; if this field is for something else, press again`
      rule(state, "contact_empty")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A time slot that clashes with the person's Calendar is never pressed (checked on the device).
    if (verdict.cls !== "blocked") {
      const busy = await slotRefusal(state, io, call, call.tool === "select" ? call.option ?? "" : seenItem?.label ?? "", map, seenItem)
      if (busy) {
        rule(state, slotCode(busy))
        state.log.push({ call, target: target ?? undefined, result: `refused: ${busy}` })
        state.refused = busy
        // Three in a row: it can't be settled this way; the task stops, not finished, with what it got to (never a loop).
        state.slotRefusals = (state.slotRefusals ?? 0) + 1
        if (state.slotRefusals >= 3 && (await openNext(state, io, "no free time there fitted the person's calendar"))) continue
        if (state.slotRefusals >= 3) {
          state.status = "done"
          state.error = "stuck"
          state.summary = state.summary || lastWords(state)
          break
        }
        continue
      }
      state.slotRefusals = 0
    }
    // The booking's press went already (the person's yes on its recap, or the plan's permission for it): no second one,
    // by the plan or as «Do it?» — the model hears it went and what the page shows; it ends with done or says in words
    // what is wrong. A form that asked for more since (details typed after the first press) is the booking going on.
    const again = verdict.cls === "confirm" && verdict.reason === "submit" && call.tool !== "fill" && state.plan?.booking ? pressedAlready(state, map) : null
    if (again) {
      rule(state, "book_again")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${again}` })
      state.lines.push(line(call, verdict, target, false))
      state.refused = again
      state.bookAgain = (state.bookAgain ?? 0) + 1
      if (state.bookAgain >= 3) {
        state.status = "done"
        state.summary = state.summary || lastWords(state)
        break
      }
      continue
    }
    // A booking press the page asked for after the booking's press (a form wanting more): never by the plan's
    // permission — the plan presses the booking silently at most once per task; this one is the person's «Do it?» with
    // the recap (the director on c874eefa: a plan-booked table, a field typed again, a ticked «Book» pressed silently).
    if (perm && state.bookPress && verdict.cls === "confirm" && verdict.reason === "submit" && call.tool !== "fill" && state.plan?.booking) {
      perm = null
      rule(state, "book_hold")
      state.log.push({ call, target: target ?? undefined, result: `held for the person: the booking's press already went in this task (${state.bookPress.target}), so another booking press goes only with their yes` })
    }
    // The booking's last press goes only with its days set on the page (128); three refusals in a row end the task, not
    // finished, never a loop.
    if (verdict.cls === "confirm" && verdict.reason === "submit" && state.plan?.booking) {
      const unset = unsetDays(state, map)
      if (unset) {
        rule(state, "days_unset")
        state.log.push({ call, target: target ?? undefined, result: `refused: ${unset}` })
        state.refused = unset
        state.dateRefusals = (state.dateRefusals ?? 0) + 1
        if (state.dateRefusals >= 3) {
          state.status = "done"
          state.error = "unbooked"
          state.summary = state.summary || lastWords(state)
          break
        }
        continue
      }
      state.daysAtPress = bookingDays(state, map) ?? undefined
    }
    if (verdict.cls === "blocked") {
      if (verdict.reason.startsWith("site_")) {
        state.status = "blocked"
        state.error = verdict.reason
        break
      }
      rule(state, "blocked")
      state.log.push({ call, target: target ?? undefined, result: `refused: ${verdict.reason}` })
      state.lines.push(line(call, verdict, target, false))
      state.refused = `that step was refused (${verdict.reason})`
      continue
    }
    if (verdict.cls === "self" && perm) {
      confirmHere(state)
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
        rule(state, "apple_access")
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
        rule(state, "apple_access")
        state.log.push({ call, result: access === "denied" ? `refused: ${kind} access is turned off in Settings → ContextFlow` : `refused: no ${kind} on this device` })
        state.lines.push(line(call, verdict, null, false))
        continue
      }
    }
    // The booking's last press, allowed by the plan: said first when it isn't what the person asked, or when it's the
    // first booking on this site and the page shows its cancellation terms (B2); otherwise it goes as approved.
    const standsFor = verdict.cls === "confirm" && !!perm && verdict.reason === "submit" && !state.recapShown && !!state.plan?.booking
    const recap = standsFor ? recapOf(state, map) : null
    if (recap) {
      state.recapShown = true
      state.status = "confirm"
      state.pending = { call, verdict, target, recap }
      break
    }
    if (verdict.cls === "confirm" && perm) {
      confirmHere(state)
      if (call.tool === "fill") {
        const item = map.items.find((i) => i.id === call.id) ?? null
        // Only the details the plan named (the same form's others, with their own keys, when they're named too).
        // (A first or last name is the saved full name's part: allowed where the full name is — the director's real-site run
        // on 10eed066: «First name» and «名» refused as «doesn't fit» on two booking forms.)
        const allowed = (k: string) => !!perm.keys?.includes(k) || ((k === "name.given" || k === "name.family") && !!perm.keys?.includes("name.full"))
        const fill = fillLines(call, item, entries, map.lang || state.lang, map).filter((l) => allowed(l.key) && (!perm.ids || perm.ids.includes(l.id)) && own(l.key, l.value))
        if (!fill.length) {
          state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "failed: that detail doesn't fit this field" })
          continue
        }
        for (const l of fill) await perform(state, io, { tool: "fill", id: l.id, key: l.key, why: l.id === call.id ? call.why : "" }, verdict, l.id === call.id ? target : `field "${l.label}"`, l.value, true)
      } else await perform(state, io, call, verdict, target, undefined, true, standsFor)
      await io.save(state)
      continue
    }
    if (verdict.cls === "confirm") {
      // The person already said no to this very press in this task: not asked again (124, a restaurant calendar: the same
      // «Do it?» came back right after «No»); the model hears it and asks or finishes instead.
      if (target && call.tool !== "fill" && state.log.some((l) => l.result === "the person said no" && l.target === target && l.call.tool === call.tool)) {
        const why = `the person said no to ${target} already: don't propose it again. Ask them how to go on (ask_user with what the page shows) or call done saying what you found`
        rule(state, "said_no")
        state.log.push({ call, target, result: `refused: ${why}` })
        state.refused = why
        continue
      }
      // The plan allowed this button, but the price on the page isn't the one it saw: the card says so.
      const item = map.items.find((i) => i.id === call.id) ?? null
      const price = state.plan?.approved && (verdict.reason === "cart" || verdict.reason === "submit") ? priceChanged(state.plan, map, item?.label ?? "") : null
      if (call.tool === "fill") {
        // (The same form's other fields: never one the request gives.)
        const fill = fillLines(call, item, entries, map.lang || state.lang, map).filter((l) => own(l.key, l.value))
        if (!fill.length) {
          state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "failed: that detail doesn't fit this field" })
          continue
        }
        state.status = "fill"
        state.pending = { call, verdict, target, fill, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}) }
      } else {
        state.status = "confirm"
        // (A booking's last press: what it books goes with the question.)
        const recap = verdict.reason === "submit" && state.plan?.booking ? recapOf(state, map, true) : null
        state.pending = { call, verdict, target, ...(reply.offRequest ? { offRequest: reply.offRequest } : {}), ...(price ? { price } : {}), ...(recap ? { recap: { ...recap, press: true } } : {}) }
      }
      break
    }
    if (call.tool === "read_page" && (call.part ?? 1) > 1) {
      // With the outline a read opens a part and it stays open while the page is the same (a read adds, never replaces);
      // without one, the map's next part for one step, as before.
      if (map.outline) {
        const page = pageLink(map.url)
        const parts = state.openParts?.page === page ? state.openParts.parts.filter((p) => p !== call.part) : []
        state.openParts = { page, parts: [...parts, Math.round(call.part!)].slice(-4) }
      } else state.readPart = Math.min(Math.round(call.part!), map.parts)
    }
    await perform(state, io, call, verdict, target)
    state.lastWasRead = READS.has(call.tool)
    if (call.tool === "click" && call.also?.length && state.status === "running") await pressAlso(state, io, call.also)
    await io.save(state)
  }
  await io.save(state)
  return state
}

const READS = new Set(["read_page", "extract", "scroll", "reminders", "calendar"])

/** Every time the page shows (its controls' words and its text), as HH:MM. */
function pageTimes(map: PageMap): Set<string> {
  return new Set([...map.items.flatMap((i) => timesIn(i.label)), ...timesIn(map.text)])
}

/**
 * The model's further presses on the same page (a service, «any» specialist, a date): each on the page as it is now,
 * still there, and a free step by the device's own class; the first that isn't stops the rest (they come back as
 * calls of their own). A time slot is checked against the Calendar as any press is.
 */
async function pressAlso(state: AgentState, io: RunnerIO, also: NonNullable<ToolCall["also"]>): Promise<void> {
  for (const a of also) {
    const map = await io.map()
    const item = map?.items.find((i) => i.id === a.id)
    if (!map || !item) return
    const call: ToolCall = { tool: "click", id: a.id, why: a.why ?? "", expect: { label: item.label, role: item.role, ...(item.lock ? { lock: item.lock } : {}) } }
    const v = classify(call, { map, startHost: state.startHost, request: words(state), confirmedHere: confirmedOn(state, hostOf(map.url)), policy: io.policy })
    if (v.cls !== "free" || looksLikeSlot(item.label)) return
    // A menu the press before opened isn't pressed again in the batch (it would close: 126 stand, a colour list opened
    // and shut by the same batch, four steps in a row).
    const last = state.log[state.log.length - 1]?.call
    if (item.state?.includes("expanded") && last?.tool === "click" && last.id === a.id) return
    // A day in a batch goes through the same date checks as one pressed alone.
    if (state.plan?.booking && isDateLabel(item.label)) {
      const why = dateStep(state, map, item, call)
      if (why) {
        rule(state, "date_step")
        state.log.push({ call, target: `${item.role} "${item.label}"`, result: `refused: ${why}` })
        return
      }
    }
    await perform(state, io, call, v, `${item.role} "${item.label}"`)
    if (state.log[state.log.length - 1]?.result.startsWith("failed")) return
  }
}

/**
 * A booking «done» says what was booked (date, time, place): the device puts it in the Calendar when the plan's
 * permission for that stayed ticked (with the booking page's link, without its query), and keeps how the site's booking
 * went for next time. Nothing booked (stopped at a sign-in, a payment): neither.
 */
async function afterBooking(state: AgentState, io: RunnerIO, call: ToolCall, here: { reminders: string; calendar: string } | null, map?: PageMap): Promise<void> {
  const plan = state.plan
  if (!plan?.booking) return
  // Nothing was booked when the booking's press never went (the director on 11f0c58b: «I pressed Reserve… check your
  // booking» on a page where no booking press had gone): not «done», no booked day, no event, no steps kept for the
  // site; the end says it in the device's words (nothingBooked).
  if (!state.bookPress) {
    // …unless there's a sign of a booking all the same (the director on ffb2b665: a final button the classifier didn't
    // call submit, a site that books on a slot's tap): the model's done carries the day the site confirmed, or the last
    // page shows a confirmation. Then nothing is asserted either way — the model's summary stands, no booked day or event
    // is added — and the end event counts it (book_unseen: how often a booking press went unrecorded).
    if (/^\d{4}-\d{2}-\d{2}$/.test(call.date ?? "") || (map && confirmedOnPage(map))) {
      state.bookUnseen = true
      rule(state, "book_unseen")
      return
    }
    state.error = state.error || "unbooked"
    return
  }
  // (A «done» without its date after the booking's last press went, 128: «Not finished» over «Your stay is booked» —
  // the day is the one the page showed at that press.)
  // (The day the page showed at the press goes first: the person's own choice when they took another, 128.)
  const date = state.bookedDays?.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(call.date ?? "") ? call.date! : "")
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(call.time ?? "") ? call.time! : state.bookedDays ? state.picked?.time ?? "" : ""
  const site = siteOfHost(state.host || state.startHost)
  if (site && io.playbook) {
    const steps = playbookOf(state.log)
    if (steps.length) await io.playbook.put(site, steps).catch(() => undefined)
  }
  // A booking task that ends without a booking (it stopped at a sign-in, it gave up): not «done» on its line. (A stay or a
  // rental has a day and no time slot.)
  if (!date || (!time && !DAY_KINDS.has(plan.booking.kind))) {
    state.error = state.error || "unbooked"
    return
  }
  state.booked = { date, time, ...(call.place ? { place: call.place.slice(0, 120) } : {}) }
  // (By days: no Calendar event, which holds a timed stretch of up to a day.)
  if (!time) return
  const perm = plan.perms.find((p) => p.kind === "apple" && p.reason === "event_add")
  const added = state.log.some((e) => e.call?.tool === "event_add" && !/^(failed|refused)/.test(e.result))
  if (!perm || perm.on === false || added || here?.calendar !== "yes" || !io.apple) return
  const what = plan.label ? plan.label.charAt(0).toLocaleUpperCase() + plan.label.slice(1) : site
  const event: ToolCall = { tool: "event_add", text: `${what}${call.place ? ` — ${call.place.slice(0, 80)}` : site ? ` — ${site}` : ""}`, date, time, minutes: plan.booking.minutes, place: call.place?.slice(0, 200) ?? "", link: pageLink(state.url), why: "" }
  const r = await io.apple(event).catch(() => null)
  state.log.push({ call: { ...event, link: undefined }, result: r?.ok ? "added to the calendar" : `failed: ${r?.note ?? "it couldn't be added"}` })
  state.lines.push(line(event, { cls: "confirm", reason: "event_add" }, null, !!r?.ok, event.text, true))
}

/** A page's link for a Calendar event: without its query and fragment (they can carry an e-mail or a booking's token). */
function pageLink(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return ""
  }
}

/** set_dates: the plan's day (the model's own only inside the window), set by the device; one step, the person's Stop heard
 *  between presses, each press classed here and done only when free. */
async function datesStep(state: AgentState, io: RunnerIO, map: PageMap, call: ToolCall, auto = false): Promise<DatesResult | null> {
  const b = state.plan?.booking
  if (!b) {
    state.log.push({ call, result: "set_dates is for a booking's days: there's no booking in this task" })
    return null
  }
  const page = pageKey(map.url)
  if (state.datesNone?.includes(page)) {
    const why = "set_dates found no date control on this page before: set the day with the page's own controls (its date button or field, its calendar and «next month» arrow, a date strip), or open the place's own booking page first"
    if (!auto) {
      rule(state, "dates_none")
      state.log.push({ call, result: `refused: ${why}` })
    }
    return { line: why, full: [], presses: 0, fallback: true }
  }
  const last = b.dayLast && b.dayLast > b.date ? b.dayLast : b.date
  // (Only the request and the person's answers set the days: a day the model names counts only inside the window.)
  const from = call.date && call.date >= b.date && call.date <= last ? call.date : b.date
  // A stay's nights: from the plan's check-out, else the request's own «2 nights» (a window's plan has no check-out).
  const nights = b.dateEnd ? Math.max(1, Math.round((Date.parse(b.dateEnd) - Date.parse(b.date)) / 86_400_000)) : DAY_KINDS.has(b.kind) ? nightsIn(state.request) : 0
  let current = map
  const ctx = (m: PageMap) => ({ map: m, startHost: state.startHost, request: state.request, confirmedHere: confirmedOn(state, hostOf(m.url)), policy: io.policy })
  const dio: DatesIO = {
    map: async () => {
      const m = await io.map({}).catch(() => null)
      if (m) current = m
      return m
    },
    press: async (item) => {
      const c: ToolCall = { tool: "click", id: item.id, why: "", expect: { label: item.label, role: item.role } }
      if (classify(c, ctx(current)).cls !== "free") return "not free"
      const r = await io.act(c).catch(() => null)
      return r?.ok ? "done" : "failed"
    },
    type: async (item, text) => {
      const c: ToolCall = { tool: "type", id: item.id, text, mode: "replace", why: "", expect: { label: item.label, role: item.role } }
      if (classify(c, ctx(current)).cls !== "free") return "not free"
      const r = await io.act(c).catch(() => null)
      return r?.ok ? "done" : "failed"
    },
    stopped: async () => !!(await io.isStopped?.().catch(() => false))
  }
  const r = await setDates({ date: from, end: nights ? addDays(from, nights) : undefined, last, from: b.from, until: b.until, byDays: DAY_KINDS.has(b.kind) }, dio)
  if (r.fallback) state.datesNone = [...(state.datesNone ?? []), page].slice(-12)
  if (r.landed) {
    state.sawDate = true
    state.picked = { date: r.landed }
    if (DAY_KINDS.has(b.kind)) state.stay = { in: r.landed, ...(nights ? { out: addDays(r.landed, nights) } : {}) }
  }
  // The person sees the day it landed on, in their words, when it moved off the request's first day.
  const moved = r.landed && r.landed !== b.date ? `${dayWords(r.landed)}: ${dayWords(b.date)}${r.full.length > 1 ? ` – ${dayWords(r.full[r.full.length - 1])}` : ""} ${r.full.length > 1 ? "were" : "was"} full` : ""
  state.log.push({ call: { ...call, date: from }, result: `${auto ? "the device went to the day itself: " : ""}${r.line}` })
  state.lines.push(line({ ...call, date: r.landed ?? from }, { cls: "free", reason: "dates" }, null, !r.fallback && !r.stopped, moved || undefined))
  if (r.stopped) state.status = "stopped"
  return r
}

/** The page as set_dates remembers it: origin and path. */
function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

/** A stay's nights as the request says them, in the panel's 15 languages: a number in digits (Arabic-Indic too), in
 *  words up to seven, or in CJK numerals, before the language's word for nights («2 nights», «zwei Nächte», «две ночи»,
 *  «2박», «二泊», «两晚», «ليلتين», «hai đêm»); 0 when it says none. */
export function nightsIn(request: string): number {
  const t = request.normalize("NFKC").toLocaleLowerCase().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
  if (/ليلتين|ليلتان/u.test(t)) return 2
  if (/ليلة واحدة|ليلة$|^ليلة/u.test(t) && !/\d/.test(t)) return 1
  const m = NIGHTS.exec(t)
  if (!m) return 0
  const raw = m[1]
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0
  return n >= 1 && n <= 30 ? n : 0
}

// Number words up to seven in the 15 languages, and CJK numerals (两/兩 is «two» in Chinese).
const NUMBER_WORDS: Record<string, number> = Object.fromEntries(
  [
    ["one a an", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7],
    ["одну одна одни", 1], ["две два двое", 2], ["три трое", 3], ["четыре", 4], ["пять", 5], ["шесть", 6], ["семь", 7],
    ["одну одна", 1], ["дві два двоє", 2], ["три", 3], ["чотири", 4], ["п'ять п’ять", 5], ["шість", 6], ["сім", 7],
    ["eine ein einer", 1], ["zwei", 2], ["drei", 3], ["vier", 4], ["fünf", 5], ["sechs", 6], ["sieben", 7],
    ["une un", 1], ["deux", 2], ["trois", 3], ["quatre", 4], ["cinq", 5], ["six", 6], ["sept", 7],
    ["una uno", 1], ["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5], ["seis", 6], ["siete", 7],
    ["una", 1], ["due", 2], ["tre", 3], ["quattro", 4], ["cinque", 5], ["sei", 6], ["sette", 7],
    ["uma um", 1], ["duas dois", 2], ["três", 3], ["quatro", 4], ["cinco", 5], ["seis", 6], ["sete", 7],
    ["bir", 1], ["iki", 2], ["üç", 3], ["dört", 4], ["beş", 5], ["altı", 6], ["yedi", 7],
    ["một", 1], ["hai", 2], ["ba", 3], ["bốn", 4], ["năm", 5], ["sáu", 6], ["bảy", 7],
    ["一", 1], ["二 两 兩 两个 兩個", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["七", 7],
    ["한", 1], ["두", 2], ["세", 3], ["네", 4],
    ["ثلاث ثلاثة", 3], ["أربع أربعة", 4], ["خمس خمسة", 5], ["ست ستة", 6], ["سبع سبعة", 7]
  ].flatMap(([w, n]) => String(w).split(" ").map((x) => [x, n as number]))
)
const NUMBER = `\\d{1,2}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}`
// The word for nights after the number (Latin and Cyrillic words end at a non-letter; CJK and Korean attach).
const NIGHT_WORDS = "nights?|noches?|nuits?|nächte|nächten|nacht|notti|notte|noites?|ноч(?:и|ей|ь|ей)|суток|сутки|ніч|ночі|ночей|діб|доби|gece|đêm|ليال[ٍي]?|ليلة"
const NIGHTS = new RegExp(`(?<![\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Arabic}\\d])(${NUMBER})\\s*(?:-\\s*)?(?:(?:${NIGHT_WORDS})(?!\\p{L})|(?:个|個)?(?:晚上?|夜|泊)|박)`, "iu")

/** The request's own words for the map (a site menu's link with one of them stays in the outline): letters only, 4 or more. */
export function requestWords(request: string): string[] {
  return [...new Set((request.match(/[\p{L}]{4,}/gu) ?? []).map((w) => w.toLocaleLowerCase()))].slice(0, 16)
}

// A question about the booking's day: its choices are days, or it asks the date or the check-in, in the panel's languages.
const DAY_ASK = /(?<!\p{L})(date|day|check-?in|arrival|fecha|día|llegada|date d|jour|arrivée|datum|tag|anreise|data|giorno|arrivo|dia|chegada|дат|день|заезд|tarih|gün|giriş|日付|日にち|チェックイン|날짜|체크인|日期|哪天|入住|التاريخ|اليوم|الوصول|ngày|nhận phòng)/iu
function dayQuestion(q: { q: string; options: string[]; fact?: string }): boolean {
  if (q.fact && /^(venue|pref:)/.test(q.fact)) return false
  const opts = q.options.filter(Boolean)
  return (opts.length > 0 && opts.every((o) => isDateLabel(o) || /^\d{4}-\d{2}-\d{2}/.test(o))) || DAY_ASK.test(q.q)
}

/** The page as far as progress goes: its address, its controls and their states, how much text (not where it's scrolled). */
function pageSig(map: PageMap): string {
  const items = map.items.slice(0, 80).map((i) => `${i.role}:${i.label}:${i.value ?? ""}:${(i.state ?? []).join(",")}`).join("|")
  return `${map.url}#${map.part}#${map.items.length}#${map.text.length}#${items.length}#${hashOf(items)}`
}

function hashOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** What the task got to, in its own last words (for a task that stopped short with no summary of its own). */
function lastWords(state: AgentState): string {
  const last = [...state.lines].reverse().find((l) => l.text || l.target)
  return last?.text || (last?.target ? /"(.*)"$/.exec(last.target)?.[1] ?? last.target : "")
}

export interface PlanApproval {
  // The questions' answers, in order ("" for one left blank).
  answers: string[]
  // The permissions the person unticked.
  off: string[]
}

/** «Начать» on the plan card: the answers and the ticks kept, then the task goes on alone. */
/** The place answered on the card (picked by the rules, or another): the booking goes there, nothing chosen on the way. */
/** The card's own options as the model reads them. */
function tokenWords(answer: string): string {
  return answer === "@any" ? "any specialist" : answer === "@auto" ? "chosen by the rules" : answer === "@page" ? "chosen on the place's own page: once it shows its specialists, ask the person once (ask_user) with their names, «any» first" : answer
}

/** Whether a place's name is in the person's words (its distinctive words, half of them at least). */
export function namedIn(name: string, words: string): boolean {
  const said = fold2(words)
  const parts = fold2(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4)
  if (!parts.length) return said.includes(fold2(name))
  return parts.filter((w) => said.includes(w)).length * 2 >= parts.length
}
const fold2 = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")

function placeFromAnswers(state: AgentState, plan: TaskPlan, answers: string[]): void {
  const where = plan.questions.findIndex((q) => q.kind === "venue" || q.fact === "venue" || q.place)
  const place = where >= 0 ? (answers[where] ?? "").trim() : ""
  // (The rules' own pick left as it was stays the rules': when it has no fitting slot, the next place is tried; «pick for
  // me» leaves it to the rules; a place of the page's, last time's or the person's own words is that place.)
  // Theirs to choose and not asked on the card (no list there): the agent asks once a list is open.
  // (So is any place when the person's rules say not to choose one for them: 126, a clinic task with that rule off opened
  // the first doctor — nothing was noted or held back.)
  if ((plan.booking?.personal || state.chooseVenue === false) && plan.booking && !plan.booking.venue && where < 0) plan.askPlace = true
  if (plan.booking && place && place !== "@auto" && place !== plan.questions[where].pick) {
    plan.booking.venue = place
    state.chooseVenue = false
  }
  // A place the person named on the card: theirs, asked once (the director on d05b60bb, run 4: «Which stay should I
  // book…» again after the card, other options and prices). The rules' own pick shown on the card and left as it was
  // isn't the person's choice (round 141, the director's 8b: a table site — the picked place couldn't be opened and the next one
  // was refused as «the person already chose»): it locks nothing, and the next fitting place may be tried.
  if (plan.booking && place && !place.startsWith("@") && place !== plan.questions[where]?.pick) state.cardPlace = place
}

export async function approvePlan(state: AgentState, io: RunnerIO, a: PlanApproval): Promise<AgentState> {
  if (state.status !== "plan" || !state.plan) return state
  const plan = state.plan
  plan.answers = plan.questions.map((q, i) => ({ q: q.q || (q.kind === "venue" ? "Where to book" : q.kind === "specialist" ? "Which specialist" : q.kind === "service" ? "Which service" : q.key ?? ""), a: tokenWords(a.answers[i] ?? "").slice(0, 200), ...(q.kind === "contact" ? { contact: true } : {}) }))
  // «I'll choose on the place's page»: the one question with the page's names is allowed there.
  if (plan.questions.some((q, i) => q.kind === "specialist" && a.answers[i] === "@page")) state.askSpecialist = true
  // A contact detail given on the card: filled by its key in this task (kept in «Мои данные» too when ticked there).
  state.oneTime = plan.questions.flatMap((q, i) => (q.kind === "contact" && q.key && (a.answers[i] ?? "").trim() ? [{ key: q.key, value: a.answers[i].trim().slice(0, 120) }] : []))
  // …and goes in by the plan's contact fill, like a saved one (no second question at the form).
  const once = state.oneTime.map((o) => o.key)
  if (once.length) {
    const fill = plan.perms.find((p) => p.reason === "contact")
    if (fill) fill.keys = [...new Set([...(fill.keys ?? []), ...once])]
    else plan.perms.push({ id: "pcontact", kind: "fill", reason: "contact", label: "", keys: once, host: plan.perms[0]?.host ?? state.host ?? "", on: true })
  }
  plan.perms = plan.perms.map((p) => ({ ...p, on: !a.off.includes(p.id) }))
  placeFromAnswers(state, plan, a.answers)
  plan.approved = true
  state.status = "running"
  await io.save(state)
  return drive(state, io)
}

export type Answer = "yes" | "no" | "did" | "notnow" | "stop" | "reply"

/**
 * Which question an answer is for: the step it stopped at, the tool and the control. The panel sends it with the answer
 * and the background refuses one for another question (a second tap must never approve the next, unseen step).
 */
export function pendingKey(state: Pick<AgentState, "step" | "pending" | "status">): string {
  const p = state.pending
  if (state.status === "asked") return `asked:${state.step}`
  return p ? `${state.status}:${state.step}:${p.call.tool}:${p.call.id ?? ""}:${p.call.key ?? ""}` : ""
}

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
  // The person's answer to the agent's question: it goes on with it (their words count as theirs).
  if (a === "reply" && state.status === "asked") {
    const text = (chosen?.[0] ?? "").trim().slice(0, 300)
    if (!text) return state
    state.log.push({ call: { tool: "ask_user", question: state.summary ?? "" }, result: `the person answered: "${text}"` })
    state.replies = [...(state.replies ?? []), text]
    // A contact detail the person just gave (their name, asked mid-task) goes in by the plan's contact fill, like the
    // card's: no second question for it (127: «Fill in from My details?» warned the plan didn't cover the name given
    // seconds before).
    const asked = state.askKey
    if (asked && state.plan) {
      state.oneTime = [...(state.oneTime ?? []).filter((o) => o.key !== asked), { key: asked, value: text.slice(0, 120) }]
      const fill = state.plan.perms.find((p) => p.reason === "contact")
      if (fill) fill.keys = [...new Set([...(fill.keys ?? []), asked])]
      else state.plan.perms.push({ id: "pcontact", kind: "fill", reason: "contact", label: "", keys: [asked], host: state.plan.perms[0]?.host ?? state.host ?? "", on: true })
    }
    state.summary = undefined
    state.choices = undefined
    state.askKey = undefined
    state.status = "running"
    state.stillReads = 0
    // The answer sets the way on (a salon booking site, 124: «Понедельник, 28 декабря» was refused as a third date step): the date
    // steps count again from it.
    state.dateSteps = 0
    state.lastDate = undefined
    // The place the person picked from the agent's question (askPlace): theirs — no switching to another one.
    const picked = state.plan?.askPlace && state.placeAsked ? state.venues?.list.find((v) => namedIn(v.name, text)) : undefined
    if (picked && state.plan?.booking) {
      state.plan.booking.venue = picked.name
      state.chooseVenue = false
    }
    // Answered: the plan no longer says to ask (a «choose by my rules» answer leaves it to the rules).
    if (state.plan?.askPlace && state.placeAsked) state.plan.askPlace = false
    // Days the person gives in their answer («1 night, 2026-11-27 to 2026-11-28», the director's real-site run on
    // 10eed066: the rule then refused the new day as «not a day of this stay»): the booking's days from now on.
    const b = state.plan?.booking
    const given = b ? daysInText(text, b.date).sort() : []
    if (b && given.length) {
      const nights = b.dateEnd ? Math.round((Date.parse(b.dateEnd) - Date.parse(b.date)) / 86_400_000) : 0
      b.date = given[0]
      // (A stay's or a rental's last day: the answer's last, or as many nights on as before.)
      if (DAY_KINDS.has(b.kind)) {
        if (given.length > 1) b.dateEnd = given[given.length - 1]
        else if (nights > 0) b.dateEnd = new Date(Date.parse(`${b.date}T12:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10)
      }
      state.picked = undefined
      state.sawDate = false
      state.pressedTarget = false
    }
    // A time the person agreed to in their answer («Am 2026-12-01 um 10:30 buchen», report-137: the window rule then
    // refused 10:30 four times): the booking's time from now on, as for days. (Dates are taken out first: «2026.12.01»
    // isn't 12:01.)
    const agreed = b && !DAY_KINDS.has(b.kind) ? [...new Set(timesIn(text.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, " ")))] : []
    if (b && agreed.length === 1) {
      b.at = agreed[0]
      b.from = agreed[0]
      b.until = agreed[0]
      state.picked = undefined
      state.nearSaid = undefined
    }
    // A place the person chose in their answer, whatever the question was (the director on 11f0c58b: «Book The Palm
    // Suites instead», then «Do it?» with «not what you asked: you asked to book Pefkos City Hotel»): the booking's place
    // from now on — the plan's answer the server's check reads, the card's place, the venue.
    if (state.plan?.booking) {
      const map = await io.map().catch(() => null)
      const chosen = map ? placeInReply(text, state, map) : ""
      if (chosen) choosePlace(state, chosen)
    }
    await io.save(state)
    return drive(state, io)
  }
  if (!pending) return state
  state.pending = undefined
  state.status = "running"
  const { call, verdict, target } = pending
  if (a === "yes" && verdict.cls === "confirm") {
    confirmHere(state)
    if (call.tool === "fill") {
      // Each line by its field and entry together (an entry id alone could tick it for another field).
      const lines = (pending.fill ?? []).filter((l) => !chosen || chosen.includes(`${l.id}:${l.entryId}`))
      if (!lines.length) state.log.push({ call: { tool: "fill", id: call.id, key: call.key, why: call.why }, target: target ?? undefined, result: "the person chose not to fill it" })
      for (const l of lines) await perform(state, io, { tool: "fill", id: l.id, key: l.key, why: l.id === call.id ? call.why : "" }, verdict, l.id === call.id ? target : `field "${l.label}"`, l.value)
    } else {
      // (Yes to the booking's recap — the last «Do it?» saying what it books: that is the booking's press.)
      await perform(state, io, call, verdict, target, undefined, undefined, !!pending.recap && verdict.reason === "submit")
    }
  } else if (verdict.cls === "self") {
    const did = a === "did" || a === "yes"
    const access = verdict.reason.startsWith("access_")
    state.log.push({ call, target: target ?? undefined, result: access ? (did ? "the person was asked to allow it in ContextFlow: call the tool again" : "the person didn't allow it now: go on without it") : did ? "the person did this step themselves" : "the person didn't do this step now (it's left for them)" })
    // (Access given: no line of its own; the tool's own step, called again, writes one.)
    if (!access) state.lines.push(line(call, verdict, target, did))
    if (did) confirmHere(state)
    // (The person pressed the booking's own last button themselves, a payment or the submit: that is the booking's press.)
    if (did && state.plan?.booking && (verdict.reason === "pay" || verdict.reason === "submit")) state.bookPress = { target: target ?? call.id ?? "", at: state.log.length, yes: true }
  } else {
    state.log.push({ call, target: target ?? undefined, result: "the person said no" })
    state.lines.push(line(call, verdict, target, false))
  }
  await io.save(state)
  return drive(state, io)
}

/** Whether the task is waiting for the person or still working (the panel's strip shows then). */
export function active(state: AgentState | null | undefined): boolean {
  return !!state && (state.status === "plan" || state.status === "running" || state.status === "confirm" || state.status === "fill" || state.status === "self" || state.status === "asked")
}

export { sameSite }
