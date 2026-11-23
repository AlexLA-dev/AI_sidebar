// The task's plan (2.7.1, the owner: «крайне не хотелось бы, чтобы агент на каждом шаге спрашивал решение… заранее
// спрашивая список вопросов с вариантами ответов»). Before the first step the model reads the page and says what it will
// do, what it must know, and which steps that change something it foresees. Code turns those into the plan card:
// permissions (ticked, untickable) for the «Сделать?» steps, «you'll do it» lines for the person's own ones. After
// «Начать» a step a permission covers goes without a question; anything not foreseen still stops.
// - Classes stay code's (classify.ts); the model only foresees. The device builds the permissions on its own map.
// - Never a permission: paying, buying, sending a message, signing in, a file, a secret field, Amazon.

import { classify, itemById, type StepContext } from "./classify.ts"
import { normalize, wordKind } from "./match.ts"
import { amountOf, amounts } from "./money.ts"
import { hostOf, sameSite, siteOfHost } from "./sites.ts"
import type { MapItem, PageMap, StepVerdict, ToolCall } from "./types.ts"

// The terms box as a plan permission: the owner's decision (2.7.1, his «1»): the agent ticks a site's terms box itself
// when that permission is ticked on the plan card; it can be unticked before «Начать». (design.md had it as the
// person's own.) Off: the box stays the person's step, as before.
export const CONSENT_IN_PLAN = true

export interface PlanQuestion {
  q: string
  options: string[]
  // A question about the person themselves (gender, age, a size, a name): a short name for the fact ("Пол", "Размер
  // обуви"). The card pre-fills it from «Мои данные» and offers to remember the answer there (2.7.1, the owner on 117).
  fact?: string
}

export type PermKind = "press" | "personal" | "fill" | "consent" | "apple"

export interface Perm {
  // Stable within the plan ("p0", "p1"…), what the card's ticks name.
  id: string
  kind: PermKind
  // The step class's reason it covers: cart, submit, personal, fill, consent, reminder_add, event_add, reminder_done.
  reason: string
  // What the card says: the button's words, the fields' names, the reminder's title.
  label: string
  // fill: the saved details' keys it may put in; personal: the fields' labels.
  keys?: string[]
  fields?: string[]
  // The controls it was seen on at plan time (a terms box, the fields a saved detail goes into), and the page's path
  // (a button seen on the page): it covers those, not any control on the site with similar words.
  ids?: string[]
  path?: string
  host: string
  on: boolean
}

export interface PlanSelf {
  reason: string
  label: string
  // The plan's own line that names this step (the model wrote it as its own: «Нажимаю «Купить сейчас»»), shown as the
  // person's instead.
  step?: number
}

export interface TaskPlan {
  // A few words naming the task with nothing personal in them («бронирование столика»): what notifications say.
  label?: string
  steps: string[]
  questions: PlanQuestion[]
  perms: Perm[]
  self: PlanSelf[]
  // The prices of what will be ordered, as the page wrote them at plan time (the model's pick, for the card's words).
  prices: string[]
  // Every amount the device saw on the page at plan time (the model once picked another item's price, and the real one
  // then read as «changed»): a price is changed only when the page shows none of them.
  seen?: number[]
  // The person's answers to the questions, after «Начать».
  answers?: Array<{ q: string; a: string }>
  approved?: boolean
  // The site it was planned on (remembered choices are this site's), and the time it books, when it does.
  site?: string
  booking?: PlanBooking
  // Started without the card: every answer was known and nothing paid (the strip says so, with Stop).
  auto?: boolean
  // How a booking will be chosen, for the card: the place's rating floor (0: the person names it), the Calendar.
  how?: { rating: number; calendar: boolean }
}

export interface RawRisky {
  tool: string
  id: string
  text: string
  key: string
}

export interface RawPlan {
  label: string
  steps: string[]
  questions: PlanQuestion[]
  risky: RawRisky[]
  prices: string[]
  booking?: PlanBooking
}

/** A task that books a time (2.7.1, the owner: the agent looks at the Calendar's free time for it): what, which day,
 *  the window the request and the rules allow, how long it takes. */
export interface PlanBooking {
  kind: "table" | "appointment"
  date: string
  from: string
  until: string
  minutes: number
  // The place's time zone (IANA), when it isn't the person's: slots are in it, the Calendar in the device's.
  tz?: string
  // The place the request names; none: the agent chooses it by the rules (and tries the next before asking).
  venue?: string
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { q: { type: "string" }, options: { type: "array", items: { type: "string" } }, fact: { type: "string" } },
        required: ["q", "options", "fact"],
        additionalProperties: false
      }
    },
    risky: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["click", "type", "fill", "select", "reminder_add", "reminder_done", "event_add"] },
          id: { type: "string" },
          text: { type: "string" },
          key: { type: "string" }
        },
        required: ["tool", "id", "text", "key"],
        additionalProperties: false
      }
    },
    prices: { type: "array", items: { type: "string" } },
    booking: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["none", "table", "appointment"] },
        date: { type: "string" },
        from: { type: "string" },
        until: { type: "string" },
        minutes: { type: "number" },
        tz: { type: "string" },
        venue: { type: "string" }
      },
      required: ["kind", "date", "from", "until", "minutes", "tz", "venue"],
      additionalProperties: false
    }
  },
  required: ["label", "steps", "questions", "risky", "prices", "booking"],
  additionalProperties: false
}

const s = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

/** The model's plan, cut to size: up to 5 lines, 3 questions with 2–4 options, 20 foreseen steps, 4 prices. */
export function checkPlan(raw: unknown): RawPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? v : [])
  const steps = arr(r.steps).map((x) => s(x, 160)).filter(Boolean).slice(0, 5)
  const questions = arr(r.questions).flatMap((x) => {
    const q = x as Record<string, unknown>
    const text = s(q?.q, 200)
    const options = [...new Set(arr(q?.options).map((o) => s(o, 60)).filter(Boolean))].slice(0, 4)
    const fact = s(q?.fact, 40).replace(/^fact:/i, "").replace(/^pref:\s*/i, "pref:").trim()
    return text ? [{ q: text, options, ...(fact ? { fact } : {}) }] : []
  }).slice(0, 3)
  const risky = arr(r.risky).flatMap((x) => {
    const k = x as Record<string, unknown>
    const tool = s(k?.tool, 20)
    return tool ? [{ tool, id: s(k.id, 20), text: s(k.text, 200), key: s(k.key, 80) }] : []
  }).slice(0, 20)
  const prices = arr(r.prices).map((x) => s(x, 40)).filter((p) => /\d/.test(p)).slice(0, 4)
  return { label: safeLabel(s(r.label, 60)), steps, questions, risky, prices, ...(bookingOf(r.booking) ? { booking: bookingOf(r.booking)! } : {}) }
}

function bookingOf(v: unknown): PlanBooking | null {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>
  const kind = b.kind === "table" || b.kind === "appointment" ? b.kind : null
  const date = s(b.date, 10)
  const time = (t: unknown) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(s(t, 5)) ? s(t, 5) : "")
  if (!kind || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const minutes = typeof b.minutes === "number" && Number.isFinite(b.minutes) ? Math.min(600, Math.max(15, Math.round(b.minutes))) : 60
  const tz = s(b.tz, 60)
  const venue = s(b.venue, 120)
  return { kind, date, from: time(b.from) || "08:00", until: time(b.until) || "21:00", minutes, ...(tz && validZone(tz) ? { tz } : {}), ...(venue ? { venue } : {}) }
}

/**
 * The task's name as notifications show it (on a lock screen): a few words, nothing personal. One with digits (a phone,
 * a date, a card), an @, a link or quotes, or more than six words, isn't used at all.
 */
export function safeLabel(label: string): string {
  const t = label.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "")
  if (!t || /[\d@«»"“”„]|https?:|www\./i.test(t) || t.split(" ").length > 6) return ""
  // A capitalised word after the first is likely a name (a person's, a restaurant's): the site alone then.
  if (t.split(" ").slice(1).some((w) => /^\p{Lu}/u.test(w))) return ""
  return t
}

/** A deferred task's page and the page its mark was found on: the same host and path (the query and fragment may differ). */
export function sameTaskPage(taskUrl: string, here: string): boolean {
  try {
    const a = new URL(taskUrl)
    const b = new URL(here)
    return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "")
  } catch {
    return false
  }
}

/** What a notification says about a task: its plan's name and the site, or the site alone — never the request. */
export function noticeLabel(plan: TaskPlan | null | undefined, host: string): string {
  const site = host.replace(/^www\./, "")
  const label = plan?.label ? safeLabel(plan.label) : ""
  return label ? `${label} · ${site}` : site
}

const CART = /cart|basket|bag|trolley|корзин|кошик|warenkorb|panier|carrito|cesta|carrello|carrinho|sacola|sepet|السلة|カート|장바구니|购物车|購物車|giỏ/i
const SELF_WORD_KINDS = new Set(["pay", "post", "rate", "account", "auth", "send"])
const APPLE = new Set(["reminder_add", "reminder_done", "event_add"])

/** A foreseen step whose control isn't on this page yet: its class by its words alone. */
function byWords(text: string): StepVerdict | null {
  const hit = wordKind(text)
  if (!hit) return null
  if (hit.kind === "submit") return { cls: "confirm", reason: CART.test(hit.word) ? "cart" : "submit" }
  if (hit.kind === "consent") return { cls: "self", reason: "consent" }
  if (SELF_WORD_KINDS.has(hit.kind)) return { cls: "self", reason: hit.kind === "send" ? "send" : hit.kind }
  return null
}

/**
 * The plan card's permissions and «you'll do it» lines, from what the model foresaw, each classed by code on the map
 * (the device's own, on the device). Personal fields typed from the request: one permission; saved details: one.
 */
export function buildPlan(raw: RawPlan, ctx: StepContext): TaskPlan {
  const host = hostOf(ctx.map.url)
  const perms: Perm[] = []
  const self: PlanSelf[] = []
  const personal: string[] = []
  const fillKeys: string[] = []
  const fillFields: string[] = []
  const fillIds: string[] = []
  const path = pathOf(ctx.map.url)
  const add = (p: Omit<Perm, "id" | "on" | "host">) => {
    if (perms.some((x) => x.kind === p.kind && x.reason === p.reason && normalize(x.label) === normalize(p.label))) return
    perms.push({ ...p, id: `p${perms.length}`, host, on: true })
  }
  const addSelf = (reason: string, label: string) => {
    if (!self.some((x) => x.reason === reason && normalize(x.label) === normalize(label))) self.push({ reason, label })
  }
  for (const r of raw.risky) {
    if (APPLE.has(r.tool)) {
      if (r.text) add({ kind: "apple", reason: r.tool, label: r.text })
      continue
    }
    const item: MapItem | null = itemById(ctx.map, r.id)
    let v: StepVerdict | null
    if (item) {
      const call: ToolCall = { tool: r.tool as ToolCall["tool"], id: r.id, ...(r.text ? { text: r.text, option: r.text } : {}), ...(r.key ? { key: r.key } : {}) }
      v = classify(call, ctx)
    } else v = r.text ? byWords(r.text) : null
    if (!v) continue
    const label = (item?.label || r.text).slice(0, 80)
    if (v.cls === "confirm") {
      if (v.reason === "personal") personal.push(label)
      else if (v.reason === "fill") {
        if (r.key && !fillKeys.includes(r.key)) fillKeys.push(r.key)
        fillFields.push(label)
        if (item) fillIds.push(item.id)
      } else if (v.reason === "cart" || v.reason === "submit") add({ kind: "press", reason: v.reason, label, ...(item ? { ids: [item.id], path } : {}) })
      // Another site, text from the page, an unknown button: not foreseeable as a permission; it asks when it comes.
    } else if (v.cls === "self") {
      // The terms box: that box on this page only (a toggle the plan saw), never any «accept» on the site.
      if (v.reason === "consent" && CONSENT_IN_PLAN && item && TOGGLES.has(item.role)) add({ kind: "consent", reason: "consent", label, ids: [item.id], path })
      else if (v.reason === "consent" && CONSENT_IN_PLAN) addSelf("consent", label)
      else if (v.reason !== "cookies_accept") addSelf(v.reason, label)
    }
  }
  if (personal.length) add({ kind: "personal", reason: "personal", label: [...new Set(personal)].join(", "), fields: [...new Set(personal)] })
  // A field the request's own words go into isn't a saved detail's too (the card said the phone twice).
  const fillOnly = [...new Set(fillFields)].filter((f) => !personal.includes(f))
  if (fillKeys.length && fillOnly.length && fillIds.length) add({ kind: "fill", reason: "fill", label: fillOnly.join(", "), keys: fillKeys, ids: [...new Set(fillIds)], path })
  // A line of the plan that names a step the person does («2. Нажимаю «Купить сейчас»») is theirs, not the agent's: the
  // card shows it so (the director: the list said the agent would press it, the card under it said «Это сделаете вы»).
  for (const x of self) {
    const name = normalize(x.label)
    if (name.length < 3) continue
    const i = raw.steps.findIndex((l) => normalize(l).includes(name))
    if (i >= 0) x.step = i
  }
  const seen = [...new Set([...(ctx.map.money ?? []), ...amounts(ctx.map.text), ...ctx.map.items.flatMap((i) => (i.role === "button" ? amounts(i.label) : []))])].slice(0, 120)
  return { ...(raw.label ? { label: raw.label } : {}), steps: raw.steps, questions: raw.questions.filter((q) => q.options.length || q.q), perms, self, prices: raw.prices, seen, site: siteOfHost(host), ...(raw.booking ? { booking: raw.booking } : {}) }
}

/** Whether the plan needs the person at all: questions, permissions or their own steps. */
export function planNeedsPerson(plan: TaskPlan): boolean {
  return plan.questions.length > 0 || plan.perms.length > 0 || plan.self.length > 0
}

/** The request as the model hears it: with each plan question and the person's answer (the question gives it sense). */
export function requestWithAnswers(request: string, plan?: TaskPlan | null): string {
  const answers = plan?.answers?.filter((a) => a.a.trim()) ?? []
  return answers.length ? `${request}\n${answers.map((a) => `${a.q} — ${a.a}`).join("\n")}` : request
}

/** The person's own words for the task: the request and the plan's answers (what they gave is theirs to type). */
export function personWords(request: string, plan?: TaskPlan | null): string {
  const answers = plan?.answers?.filter((a) => a.a.trim()) ?? []
  // Only the person's answers count as their words (the model's question text could carry an address or a contact).
  return answers.length ? `${request}\n${answers.map((a) => a.a).join("\n")}` : request
}

export const squash = (t: string) => normalize(t).replace(/[\s-]+/g, "")

const TOGGLES = new Set(["checkbox", "switch", "radio"])

/** A page's path, for binding a permission to the page it was seen on. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/"
  } catch {
    return ""
  }
}

/**
 * Whether the person's own words hold this value as a whole (the security review: «42» matched inside a phone number).
 * Normalized words with their boundaries; a long value (a phone written with other separators) by its letters and digits.
 */
export function saidInWords(words: string, value: string): boolean {
  const v = normalize(value)
  if (!v) return false
  if (` ${normalize(words)} `.includes(` ${v} `)) return true
  const sv = squash(value)
  return sv.length >= 7 && squash(words).includes(sv)
}

// ------------------------------------------------------------ prices

export { amountOf, amounts } from "./money.ts"

/**
 * The price changed since the plan: the plan saw prices, the page now shows amounts, and none of them is one the plan
 * saw (nor the plan's price times a small quantity, as a cart total is). No amounts on the page: nothing to compare.
 */
export function priceChanged(plan: TaskPlan, map: PageMap, near = ""): string | null {
  const picked = plan.prices.flatMap((p) => amounts(p).length ? amounts(p) : [amountOf(p.replace(/[^\d.,\s]/g, "").trim())].filter((x): x is number => x !== null))
  if (!picked.length) return null
  const seen = [...picked, ...(plan.seen ?? [])]
  const fit = (v: number) => seen.some((p) => [1, 2, 3, 4, 5, 6].some((q) => Math.abs(v - p * q) < 0.011))
  // The whole page's amounts when the device has them: changed when one is new (not at plan time, nor a few of one).
  if (map.money) {
    const fresh = map.money.filter((v) => !fit(v))
    return fresh.length ? plan.prices[0] : null
  }
  const now = amounts(`${near}\n${map.text}`)
  if (!now.length) return null
  return now.some(fit) ? null : plan.prices[0]
}

// ------------------------------------------------------------ coverage

/**
 * Whether an approved permission covers this step (it goes without a question): the same kind of step on the same
 * site — a typed personal value from the person's own words, a saved detail by key, the same button's words, the terms
 * box, the same Calendar or Reminders write. A price changed since the plan, or a step the check found off the
 * request, is never covered.
 */
export function covered(plan: TaskPlan | null | undefined, call: ToolCall, verdict: StepVerdict, map: PageMap, words: string, offRequest?: string): Perm | null {
  if (!plan?.approved || offRequest) return null
  const host = hostOf(map.url)
  const on = plan.perms.filter((p) => p.on && (p.kind === "apple" || sameSite(p.host, host)))
  const item = itemById(map, call.id)
  if (verdict.cls === "confirm") {
    switch (verdict.reason) {
      case "personal": {
        const typed = call.tool === "select" ? call.option ?? "" : call.text ?? ""
        if (!typed || !saidInWords(words, typed)) return null
        // The person's own words into a field the plan meant to fill from «Мои данные» (the model typed the request's
        // value instead): the same field, the same consent (the cookie session, «ru book»: 3 extra cards).
        return on.find((p) => p.kind === "personal") ?? on.find((p) => p.kind === "fill" && !!call.id && !!p.ids?.includes(call.id) && (!p.path || p.path === pathOf(map.url))) ?? null
      }
      case "fill":
        // The saved detail into the fields the plan saw it going into (same page), not any field with that key.
        return on.find((p) => p.kind === "fill" && !!call.key && !!p.keys?.includes(call.key) && !!call.id && !!p.ids?.includes(call.id) && (!p.path || p.path === pathOf(map.url))) ?? null
      case "cart":
      case "submit": {
        // The same words exactly («Подтвердить» never covers «Подтвердить удаление аккаунта»), on the page the plan saw
        // it on (a button the plan foresaw on a later page: by its words on the site).
        const label = squash(item?.label ?? "")
        if (!label) return null
        const p = on.find((x) => x.kind === "press" && x.reason === verdict.reason && squash(x.label) === label && (!x.path || x.path === pathOf(map.url)))
        if (!p) return null
        return priceChanged(plan, map, item?.label ?? "") ? null : p
      }
      case "reminder_add":
      case "reminder_done":
      case "event_add":
        return on.find((p) => p.kind === "apple" && p.reason === verdict.reason) ?? null
      default:
        return null
    }
  }
  // The terms box the plan saw: that toggle (by its id, or its exact words on the same page), nothing else.
  if (verdict.cls === "self" && verdict.reason === "consent" && CONSENT_IN_PLAN && item && TOGGLES.has(item.role) && call.tool === "click") {
    return on.find((p) => p.kind === "consent" && (!p.path || p.path === pathOf(map.url)) && (!!p.ids?.includes(item.id) || squash(p.label) === squash(item.label))) ?? null
  }
  return null
}

/**
 * A press the approved plan lists as the agent's own that hasn't happened yet (the stand: the model said «done» on a
 * Japanese cart before pressing カートに入れる). By the log: a click on a control with the permission's exact words that
 * didn't fail. Null when every one happened, or the plan has none.
 */
export function missingPress(plan: TaskPlan | null | undefined, log: Array<{ call: { tool: string }; target?: string; result: string }>): Perm | null {
  if (!plan?.approved) return null
  const done = log.filter((e) => e.call.tool === "click" && !/^(failed|refused|the person said no)/.test(e.result)).map((e) => squash(/"(.*)"$/.exec(e.target ?? "")?.[1] ?? e.target ?? ""))
  return plan.perms.find((p) => p.on && p.kind === "press" && !done.includes(squash(p.label))) ?? null
}

/** What the server and the check model hear of an approved plan: its lines, what may go without a question, prices. */
export function planLine(plan: TaskPlan | null | undefined): string {
  if (!plan?.approved) return ""
  const allowed = plan.perms.filter((p) => p.on).map((p) => `${p.kind === "press" ? `press "${p.label}"` : p.kind === "personal" ? `type the person's details (${p.label})` : p.kind === "fill" ? `fill saved details (${p.keys?.join(", ")})` : p.kind === "consent" ? `tick the terms box "${p.label}"` : `${p.reason} "${p.label}"`}`)
  const refused = plan.perms.filter((p) => !p.on).map((p) => p.label)
  return [
    plan.steps.length ? `steps: ${plan.steps.map((l, i) => (plan.self.some((x) => x.step === i) ? `${l} (the person's own step: not yours to press)` : l)).join("; ")}` : "",
    allowed.length ? `allowed without asking: ${allowed.join("; ")}` : "",
    // Unticked: still the task's steps, asked at the time (TheFork, 118: the model read «unticked» as «don't», and stopped
    // before even opening the restaurant).
    refused.length ? `ask the person first (they unticked it: go on, and the device asks them at that step): ${refused.join("; ")}` : "",
    plan.prices.length ? `prices seen: ${plan.prices.join(", ")}` : ""
  ].filter(Boolean).join("\n")
}

/** A fact's name as compared with what «Мои данные» holds ("Размер обуви" = "размер  обуви"). */
export function factKey(label: string): string {
  return normalize(label)
}

/**
 * The name a plan's fact is kept under in «Мои данные»: a fact about the person as it is («Пол»); a choice on a site
 * («pref:Мастер») with the site's name first («fresha.com · Мастер»), so it's used on that site only.
 */
export function factLabel(fact: string, site?: string): string {
  const pref = /^pref:\s*(.+)$/i.exec(fact)
  if (!pref) return fact
  return site ? `${site} · ${pref[1].trim()}`.slice(0, 60) : ""
}

/** The plan's questions pre-filled from the person's saved facts and this site's remembered choices: the value, or "". */
export function savedAnswers(plan: TaskPlan, saved: Record<string, string>): string[] {
  return plan.questions.map((q) => {
    const label = q.fact ? factLabel(q.fact, plan.site) : ""
    return label ? optionFor(q.options, saved[factKey(label)] ?? "") : ""
  })
}

/**
 * The plan's own option for a remembered answer worded another way («Мужской» → «Мужчина», «Female» → «female»): the
 * same word, or the one option that starts the same (three letters or more); else the answer as it was saved.
 */
export function optionFor(options: string[], value: string): string {
  const v = value.trim()
  if (!v) return ""
  const norm = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
  const nv = norm(v)
  const same = options.find((o) => norm(o) === nv)
  if (same) return same
  const common = (a: string, b: string) => {
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }
  const close = options.filter((o) => {
    const no = norm(o)
    return no.length >= 4 && nv.length >= 4 && common(no, nv) >= 3
  })
  return close.length === 1 ? close[0] : v
}

// «Отмена», «Cancel», «Stop» as one of the model's choices (ask_user): the card has its own Cancel, so it isn't shown twice
// (the owner on 118). The languages the panel speaks.
const CANCEL_CHOICE = /^(cancel|stop|abort|never ?mind|отмена|отменить|отмените|стоп|не надо|скасувати|відміна|відмінити|стоп|abbrechen|stopp|annuler|arrêter|cancelar|parar|detener|annulla|annullare|interrompi|iptal|vazgeç|durdur|キャンセル|中止|やめる|취소|중지|取消|停止|إلغاء|توقف|hủy|dừng)$/iu

export function isCancelChoice(choice: string): boolean {
  return CANCEL_CHOICE.test(choice.trim().replace(/[.!…]+$/u, ""))
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return /\//.test(tz)
  } catch {
    return false
  }
}
