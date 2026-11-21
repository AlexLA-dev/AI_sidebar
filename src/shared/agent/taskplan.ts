// The task's plan (2.7.1, the owner: «крайне не хотелось бы, чтобы агент на каждом шаге спрашивал решение… заранее
// спрашивая список вопросов с вариантами ответов»). Before the first step the model reads the page and says what it will
// do, what it must know, and which steps that change something it foresees. Code turns those into the plan card:
// permissions (ticked, untickable) for the «Сделать?» steps, «you'll do it» lines for the person's own ones. After
// «Начать» a step a permission covers goes without a question; anything not foreseen still stops.
// - Classes stay code's (classify.ts); the model only foresees. The device builds the permissions on its own map.
// - Never a permission: paying, buying, sending a message, signing in, a file, a secret field, Amazon.

import { classify, itemById, type StepContext } from "./classify.ts"
import { normalize, wordKind } from "./match.ts"
import { hostOf, sameSite } from "./sites.ts"
import type { MapItem, PageMap, StepVerdict, ToolCall } from "./types.ts"

// The terms box as a plan permission (the director's 2.7.1 note lists «Отметить согласие с условиями сайта»; design.md
// had it as the person's own). Off: the box stays the person's step, as before.
export const CONSENT_IN_PLAN = true

export interface PlanQuestion {
  q: string
  options: string[]
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
  host: string
  on: boolean
}

export interface PlanSelf {
  reason: string
  label: string
}

export interface TaskPlan {
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
}

export interface RawRisky {
  tool: string
  id: string
  text: string
  key: string
}

export interface RawPlan {
  steps: string[]
  questions: PlanQuestion[]
  risky: RawRisky[]
  prices: string[]
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { q: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        required: ["q", "options"],
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
    prices: { type: "array", items: { type: "string" } }
  },
  required: ["steps", "questions", "risky", "prices"],
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
    return text ? [{ q: text, options }] : []
  }).slice(0, 3)
  const risky = arr(r.risky).flatMap((x) => {
    const k = x as Record<string, unknown>
    const tool = s(k?.tool, 20)
    return tool ? [{ tool, id: s(k.id, 20), text: s(k.text, 200), key: s(k.key, 80) }] : []
  }).slice(0, 20)
  const prices = arr(r.prices).map((x) => s(x, 40)).filter((p) => /\d/.test(p)).slice(0, 4)
  return { steps, questions, risky, prices }
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
      } else if (v.reason === "cart" || v.reason === "submit") add({ kind: "press", reason: v.reason, label })
      // Another site, text from the page, an unknown button: not foreseeable as a permission; it asks when it comes.
    } else if (v.cls === "self") {
      if (v.reason === "consent" && CONSENT_IN_PLAN) add({ kind: "consent", reason: "consent", label })
      else if (v.reason !== "cookies_accept") addSelf(v.reason, label)
    }
  }
  if (personal.length) add({ kind: "personal", reason: "personal", label: [...new Set(personal)].join(", "), fields: [...new Set(personal)] })
  if (fillKeys.length) add({ kind: "fill", reason: "fill", label: [...new Set(fillFields)].join(", "), keys: fillKeys })
  const seen = [...new Set([...amounts(ctx.map.text), ...ctx.map.items.flatMap((i) => (i.role === "button" ? amounts(i.label) : []))])].slice(0, 40)
  return { steps: raw.steps, questions: raw.questions.filter((q) => q.options.length || q.q), perms, self, prices: raw.prices, seen }
}

/** Whether the plan needs the person at all: questions, permissions or their own steps. */
export function planNeedsPerson(plan: TaskPlan): boolean {
  return plan.questions.length > 0 || plan.perms.length > 0 || plan.self.length > 0
}

/** The person's own words for the task: the request and the plan's answers (what they gave is theirs to type). */
export function personWords(request: string, plan?: TaskPlan | null): string {
  const answers = plan?.answers?.filter((a) => a.a.trim()) ?? []
  return answers.length ? `${request}\n${answers.map((a) => `${a.q} — ${a.a}`).join("\n")}` : request
}

const squash = (t: string) => normalize(t).replace(/[\s-]+/g, "")

// ------------------------------------------------------------ prices

const CUR = "[€$£¥₽₴₺₹₫₩₪]|руб\\.?|грн\\.?|zł|kr|chf|eur|usd|gbp|rub|uah|try|jpy|aed|sar|inr|vnd|r\\$|円|元|đ|درهم|ريال|ر\\.س|د\\.إ"
const NUM = "\\d{1,3}(?:[ \\u00a0\\u202f.,']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?"
const MONEY = new RegExp(`(?:(?:${CUR})\\s?(${NUM}))|(?:(${NUM})\\s?(?:${CUR}))`, "giu")

/** An amount's value: "1 299,90" and "1,299.90" are 1299.9; "129" is 129. */
export function amountOf(raw: string): number | null {
  const t = raw.replace(/[\s  ']/g, "")
  const m = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(t)
  if (!m) return null
  const whole = m[1].replace(/[.,]/g, "")
  if (!/^\d+$/.test(whole)) return null
  return Number(whole) + (m[2] ? Number(m[2].padEnd(2, "0")) / 100 : 0)
}

/** The money amounts written in a text. A plain space may group thousands («1 299 ₽») or end a name («Air 2 129.00 €»):
 *  both readings count. */
export function amounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(MONEY)) {
    const raw = m[1] ?? m[2] ?? ""
    for (const r of / /.test(raw) ? [raw, raw.slice(raw.indexOf(" ") + 1)] : [raw]) {
      const v = amountOf(r)
      if (v !== null && v > 0 && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/**
 * The price changed since the plan: the plan saw prices, the page now shows amounts, and none of them is one the plan
 * saw (nor the plan's price times a small quantity, as a cart total is). No amounts on the page: nothing to compare.
 */
export function priceChanged(plan: TaskPlan, map: PageMap, near = ""): string | null {
  const picked = plan.prices.flatMap((p) => amounts(p).length ? amounts(p) : [amountOf(p.replace(/[^\d.,\s]/g, "").trim())].filter((x): x is number => x !== null))
  if (!picked.length) return null
  const seen = [...picked, ...(plan.seen ?? [])]
  const now = amounts(`${near}\n${map.text}`)
  if (!now.length) return null
  const fits = now.some((v) => seen.some((p) => [1, 2, 3, 4, 5, 6].some((q) => Math.abs(v - p * q) < 0.011)))
  return fits ? null : plan.prices[0]
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
        const typed = squash(call.tool === "select" ? call.option ?? "" : call.text ?? "")
        return typed && squash(words).includes(typed) ? on.find((p) => p.kind === "personal") ?? null : null
      }
      case "fill":
        return on.find((p) => p.kind === "fill" && !!call.key && !!p.keys?.includes(call.key)) ?? null
      case "cart":
      case "submit": {
        const label = squash(item?.label ?? "")
        if (!label) return null
        const p = on.find((x) => x.kind === "press" && x.reason === verdict.reason && (squash(x.label) === label || (label.length >= 3 && squash(x.label).includes(label)) || (squash(x.label).length >= 3 && label.includes(squash(x.label)))))
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
  if (verdict.cls === "self" && verdict.reason === "consent" && CONSENT_IN_PLAN) return on.find((p) => p.kind === "consent") ?? null
  return null
}

/** What the server and the check model hear of an approved plan: its lines, what may go without a question, prices. */
export function planLine(plan: TaskPlan | null | undefined): string {
  if (!plan?.approved) return ""
  const allowed = plan.perms.filter((p) => p.on).map((p) => `${p.kind === "press" ? `press "${p.label}"` : p.kind === "personal" ? `type the person's details (${p.label})` : p.kind === "fill" ? `fill saved details (${p.keys?.join(", ")})` : p.kind === "consent" ? `tick the terms box "${p.label}"` : `${p.reason} "${p.label}"`}`)
  const refused = plan.perms.filter((p) => !p.on).map((p) => p.label)
  return [
    plan.steps.length ? `steps: ${plan.steps.join("; ")}` : "",
    allowed.length ? `allowed without asking: ${allowed.join("; ")}` : "",
    refused.length ? `the person unticked: ${refused.join("; ")}` : "",
    plan.prices.length ? `prices seen: ${plan.prices.join(", ")}` : ""
  ].filter(Boolean).join("\n")
}
