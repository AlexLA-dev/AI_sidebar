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
import { hostOf, sameSite, siteOfHost, type SitePolicy } from "./sites.ts"
import { pageSubject, subjectLine } from "./subject.ts"
import { cardsOf, onVenue, rankVenues, venueOf, venuesOn, type Venue } from "./venues.ts"
import { freeLineIn, looksLikeSlot, pageChoices, readRules, rulesLine, shiftZone, timesIn } from "./rules.ts"
import { addContactFill, buildPlan, checkPlan, contactAsked, covered, fieldKind, keyKind, factKey, factLabel, missingPress, personWords, requestWithAnswers, planLine, planNeedsPerson, priceChanged, saidInWords, savedAnswers, type Perm, type PlanBooking, type TaskPlan } from "./taskplan.ts"
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
  pending?: { call: ToolCall; verdict: StepVerdict; target: string | null; offRequest?: string; fill?: FillLine[]; price?: string }
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
  slotRefusals?: number
  // The rules let the agent choose the place; how many times a question was sent back to try the next one.
  chooseVenue?: boolean
  venueNudges?: number
  minRating?: number
  // The places that fit (ranked on the device from a results list), and the ones already tried.
  venues?: { list: Venue[]; tried: string[] }
  booked?: { date: string; time: string; place?: string }
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
  map(opts?: { money?: boolean }): Promise<PageMap | null>
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
    if (result.data) {
      state.data = result.data
      state.readDevice = true
    }
    state.log.push({ call, result: noteOf(result) })
    state.lines.push(line(call, verdict, target, result.ok, undefined, byPlan))
    return
  }
  state.inflight = { step: state.step, call: call.tool === "fill" ? { tool: "fill", id: call.id, key: call.key } : call, at: Date.now() }
  await (io.mark ?? io.save)(state)
  let result = await io.act(doing)
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
  state.lines.push(line(call, verdict, target, result.ok, undefined, byPlan))
}

/** The map as it goes to the server: the page's amounts stay on the device (they're for its own price check). */
function sent(map: PageMap): PageMap {
  // The amounts and other sites' frame addresses stay on the device (the device acts on those itself).
  const { money: _money, frames: _frames, ...rest } = map
  return rest
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
  // The chat went with the plan only (what it resolved is the plan's fromChat): not kept with the task.
  state.chat = undefined
  // A server without plans answered with a step: none, every «Сделать?» asks (it's asked again as step 1).
  const plan = reply.plan ? buildPlan(checkPlan(reply.plan), { map, startHost: state.startHost, request: state.request, confirmedHere: false, policy: io.policy }) : null
  if (!plan) return "go"
  state.plan = plan
  // On one place's page, a booking that names no other is there: no choosing, no «I'll pick the place».
  if (subject?.kind === "place" && plan.booking && !plan.booking.venue) plan.booking.venue = subject.name
  if (subject && plan.booking?.venue) state.chooseVenue = false
  if (plan.booking && calendarOn) {
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
  if (plan.booking && plan.how && rules.calendar && (here?.calendar === "none" || here?.calendar === "denied")) {
    plan.how.ask = here.calendar
    state.calSkipped = true
  }
  // The booking's contact form (a later page): the saved name, e-mail and phone go in as the plan's fill.
  addContactFill(plan, liveEntries(entries).map((e) => e.key), hostOf(map.url))
  // Nothing left to ask (every answer known from «Мои данные», this site's remembered choices or the rules; nothing paid;
  // a site booked on before): no card, the task starts with its answers in one line and Stop.
  const pre = savedAnswers(plan, savedFacts(entries))
  if (rules.auto && plan.booking && !!book?.length && pre.every((a) => !!a.trim()) && goesAlone(plan, map)) {
    plan.answers = plan.questions.map((q, i) => ({ q: q.q, a: pre[i] }))
    plan.perms = plan.perms.map((p) => ({ ...p, on: true }))
    plan.approved = true
    plan.auto = true
    return "go"
  }
  if (planNeedsPerson(plan)) {
    state.status = "plan"
    return "card"
  }
  plan.approved = true
  return "go"
}

// Booking providers whose forms restaurants and salons embed in a frame (they work on their own pages too).
const BOOKING_PROVIDER = /(^|\.)(sevenrooms\.com|opentable\.[a-z.]+|resy\.com|quandoo\.[a-z.]+|zenchef\.com|formitable\.com|tablein\.com|bookatable\.[a-z.]+|designmynight\.com|collinsbookings\.com|resdiary\.com|thefork\.[a-z.]+|lafourchette\.com|fresha\.com|treatwell\.[a-z.]+|booksy\.com|setmore\.com|simplybook\.[a-z.]+|vagaro\.com|mindbodyonline\.com|squareup\.com|square\.site|timely\.com|gettimely\.com|phorest\.com|shedul\.com|planity\.com|doctolib\.[a-z.]+|calendly\.com|acuityscheduling\.com)$/i

const SEARCH_BOX = /search|find|treatment|salon|cuisine|restaurant|location|where|what are you looking|поиск|найти|искать|suche|recherch|buscar|cerca|pesquis|検索|검색|搜索|搜尋|بحث|tìm/i

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
  if (!b || b.venue || !state.chooseVenue || !state.plan?.approved) return
  if (!state.venues) {
    const list = venuesOn(map)
    if (list.length) {
      const ranked = rankVenues(list, cardsOf(map), b.match ?? [], state.minRating ?? 4.5).slice(0, 8)
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

/**
 * A time slot pressed in a booking that looks at the Calendar: the model says its date and time, and the device checks
 * them against the person's events (with the buffers). A busy one is refused, whatever the model thought; a refusal's
 * reason goes back to it. (null: the step goes on.)
 */
async function slotRefusal(state: AgentState, io: RunnerIO, call: ToolCall, label: string): Promise<string | null> {
  const b = state.plan?.booking
  if (!b || !state.calendar || !io.slotFree || (call.tool !== "click" && call.tool !== "select")) return null
  if (!looksLikeSlot(label)) return null
  const date = /^\d{4}-\d{2}-\d{2}$/.test(call.date ?? "") ? call.date! : ""
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(call.time ?? "") ? call.time! : ""
  if (!date || !time) return "a time slot: say its date (YYYY-MM-DD) and time (HH:MM) in date and time when you press it, so the device can check the person's calendar"
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
    let map = await io.map({ money })
    if (!map) {
      await io.waitPage()
      map = await io.map({ money })
    }
    if (!map) {
      state.status = "error"
      state.error = "page"
      break
    }
    state.host = hostOf(map.url)
    noteVenues(state, map)
    // A booking whose form is a booking provider's frame on this page (Dishoom's SevenRooms, 121 sweep: «I've tried "Book a
    // table" five times»): the device opens that form on its own page, once; the provider counts as this task's site.
    const widget = state.plan?.approved && state.plan.booking && !state.widgetOpened ? map.frames?.find((f) => BOOKING_PROVIDER.test(f.host)) : undefined
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
    const entries = await io.entries().catch(() => [] as FormEntry[])
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
      task: { id: state.id, request: requestWithAnswers(state.request, state.plan), lang: state.lang, startHost: state.startHost, step: state.step, confirmedHere: confirmedOn(state, hostOf(map.url)), token: state.token, strongUsed: state.strongUsed, now: nowLine(), ...(here ? { device: here } : {}), ...(plan ? { plan } : {}), ...(state.rules ? { rules: state.rules } : {}), ...(state.calendar ? { calendar: state.calendar } : {}), ...(state.playbook ? { playbook: state.playbook } : {}), ...(state.venues ? { venues: venuesLine(state.venues) } : {}), ...(state.subject ? { subject: state.subject } : {}) },
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
    if (call.tool === "done") {
      // A press the plan lists as the agent's own hasn't happened: one more step for it, or «done» again with the
      // reason in the summary (the stand: a cart «done» before its «Add to cart»).
      const missing = missingPress(state.plan, state.log)
      if (missing && !state.doneNudged) {
        state.doneNudged = true
        state.log.push({ call: { tool: "done" }, result: `refused: the plan's press "${missing.label}" hasn't happened yet — do it now, or call done again and say in the summary why it is left` })
        await io.save(state)
        continue
      }
      state.status = "done"
      state.summary = call.summary ?? ""
      await afterBooking(state, io, call, here)
      break
    }
    // The model's answer failed the code's check twice: the task ends with an error, not an empty question.
    if (reply.verdict.reason === "bad_call") {
      state.status = "error"
      state.error = "bad_call"
      break
    }
    // A booking whose place the agent chose (the request named none): before a question, the next place or two by the
    // rules (fresha, 120: it asked about the first barbershop's slots instead of trying the next).
    // A form asking for the person's details is the booking going on, not the place failing (the director on 23e9:
    // Borgo Paris was left for a required e-mail): no next place for it.
    const details = detailsForm(map)
    if (call.tool === "ask_user" && !details && state.plan?.booking && !state.plan.booking.venue && state.chooseVenue && (state.venueNudges ?? 0) < 2 && (await openNext(state, io, call.question ?? ""))) {
      state.venueNudges = (state.venueNudges ?? 0) + 1
      continue
    }
    if (call.tool === "ask_user" && !details && state.plan?.booking && !state.plan.booking.venue && state.chooseVenue && (state.venueNudges ?? 0) < 2 && !state.venues) {
      state.venueNudges = (state.venueNudges ?? 0) + 1
      // No list was ever seen (a home page, an error page with a search box, one featured place): the site's own search
      // finds the places, never «back» to a list that isn't there (Treatwell, 121 sweep: it went back to nothing and
      // then said it had checked several places).
      const box = map.items.find((i) => (i.role === "textbox" || i.role === "combobox") && !i.lock && (i.type === "search" || SEARCH_BOX.test(i.label)))
      state.log.push({ call: { tool: "ask_user", question: call.question ?? "" }, result: box ? `refused: the request names no place, so it's yours to find: type what the request asks (the service or cuisine, and the area) into the site's search box #${box.id} "${box.label.slice(0, 60)}", search, then choose from the list by the rules` : "refused: the request names no place, so it's yours to find: open the site's own search or the category that fits (its search box, «Barbers», «Restaurants»), then choose from the list by the rules; ask only after two places didn't fit, with their real slots" })
      continue
    }
    if (call.tool === "ask_user") {
      // The person answers (a button or their own words) and the task goes on (TestFlight 118: «На завтра мест нет…
      // Записать на 24-е? [Да] [Другой день] [Отмена]»).
      state.status = "asked"
      state.summary = call.question ?? ""
      // Times the page doesn't show (taken from the Calendar alone, fresha 2) aren't offered.
      state.choices = pageChoices(call.choices ?? [], pageTimes(map))
      // A contact detail «Мои данные» hasn't got (asked once): the answer may be kept there.
      const key = details ? contactAsked(call.question ?? "") : null
      state.askKey = key && !liveEntries(entries).some((e) => e.key === key) ? key : undefined
      break
    }
    // The device's own check, on its own map: never milder than the server's.
    // The control as classed now goes with the step: the hands check it's still that one before they act.
    const seenItem = call.id ? map.items.find((i) => i.id === call.id) : undefined
    // A saved detail into a field that asks for another kind (TheFork: the full name into «email»): refused, and the
    // model hears which detail the field wants and whether «Мои данные» has it (else: ask the person once).
    const wants = call.tool === "fill" && call.key && seenItem ? fieldKind(seenItem, keyOfAutocomplete(seenItem.auto)?.key ?? null) : null
    if (wants && call.key && wants !== keyKind(call.key)) {
      const has = liveEntries(entries).some((e) => keyKind(modelKey(e)) === wants)
      const why = `the field "${seenItem!.label}" asks for the ${wants}, not ${call.key}${has ? `: fill it with the saved ${wants}` : `; <saved> has no ${wants}: ask the person for it once (ask_user naming it)`}`
      state.log.push({ call, target: target ?? undefined, result: `refused: ${why}` })
      state.refused = why
      continue
    }
    // A place that doesn't fit the request or the rules (a French restaurant for «Italian») isn't opened.
    const place = seenItem && (call.tool === "click" || call.tool === "go") ? venueOf(seenItem, map.url) : null
    if (place && state.venues && !state.venues.list.some((v) => v.url === place.url)) {
      const fit = state.venues.list.filter((v) => !state.venues!.tried.includes(v.url)).map((v) => `«${v.name}»`).slice(0, 4).join(", ")
      state.log.push({ call, target: target ?? undefined, result: `refused: «${place.name}» doesn't fit the request or the rules${fit ? `; the ones that do: ${fit}` : ""}` })
      state.refused = "choose a place from <venues>"
      continue
    }
    if (seenItem) call.expect = { label: seenItem.label, role: seenItem.role, ...(seenItem.lock ? { lock: seenItem.lock } : {}) }
    const device = classify(call, { map, startHost: state.startHost, request: words(state), confirmedHere: confirmedOn(state, hostOf(map.url)), policy: io.policy })
    let verdict = stricter(reply.verdict, device)
    if (state.readDevice && call.tool === "type" && verdict.cls === "free" && !saidInWords(words(state), call.text ?? "")) verdict = { cls: "confirm", reason: "device_data" }
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
    // A time slot that clashes with the person's Calendar is never pressed (checked on the device).
    if (verdict.cls !== "blocked") {
      const busy = await slotRefusal(state, io, call, call.tool === "select" ? call.option ?? "" : seenItem?.label ?? "")
      if (busy) {
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
      confirmHere(state)
      if (call.tool === "fill") {
        const item = map.items.find((i) => i.id === call.id) ?? null
        // Only the details the plan named (the same form's others, with their own keys, when they're named too).
        const fill = fillLines(call, item, entries, map.lang || state.lang, map).filter((l) => perm.keys?.includes(l.key) && (!perm.ids || perm.ids.includes(l.id)))
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
    state.lastWasRead = READS.has(call.tool)
    if (call.tool === "click" && call.also?.length) await pressAlso(state, io, call.also)
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
    await perform(state, io, call, v, `${item.role} "${item.label}"`)
    if (state.log[state.log.length - 1]?.result.startsWith("failed")) return
  }
}

/**
 * A booking «done» says what was booked (date, time, place): the device puts it in the Calendar when the plan's
 * permission for that stayed ticked (with the booking page's link, without its query), and keeps how the site's booking
 * went for next time. Nothing booked (stopped at a sign-in, a payment): neither.
 */
async function afterBooking(state: AgentState, io: RunnerIO, call: ToolCall, here: { reminders: string; calendar: string } | null): Promise<void> {
  const plan = state.plan
  if (!plan?.booking) return
  const date = /^\d{4}-\d{2}-\d{2}$/.test(call.date ?? "") ? call.date! : ""
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(call.time ?? "") ? call.time! : ""
  const site = siteOfHost(state.host || state.startHost)
  if (site && io.playbook) {
    const steps = playbookOf(state.log)
    if (steps.length) await io.playbook.put(site, steps).catch(() => undefined)
  }
  // A booking task that ends without a booking (it stopped at a sign-in, it gave up): not «done» on its line.
  if (!date || !time) {
    state.error = state.error || "unbooked"
    return
  }
  state.booked = { date, time, ...(call.place ? { place: call.place.slice(0, 120) } : {}) }
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

/** The page as far as progress goes: its address, its controls and their states, how much text (not where it's scrolled). */
function pageSig(map: PageMap): string {
  const items = map.items.slice(0, 80).map((i) => `${i.role}:${i.label}:${i.value ?? ""}:${(i.state ?? []).join(",")}`).join("|")
  return `${map.url}#${map.items.length}#${map.text.length}#${items.length}#${hashOf(items)}`
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
    state.summary = undefined
    state.choices = undefined
    state.askKey = undefined
    state.status = "running"
    state.stillReads = 0
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
      await perform(state, io, call, verdict, target)
    }
  } else if (verdict.cls === "self") {
    const did = a === "did" || a === "yes"
    const access = verdict.reason.startsWith("access_")
    state.log.push({ call, target: target ?? undefined, result: access ? (did ? "the person was asked to allow it in ContextFlow: call the tool again" : "the person didn't allow it now: go on without it") : did ? "the person did this step themselves" : "the person didn't do this step now (it's left for them)" })
    // (Access given: no line of its own; the tool's own step, called again, writes one.)
    if (!access) state.lines.push(line(call, verdict, target, did))
    if (did) confirmHere(state)
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
