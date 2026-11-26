// The agent (2.7.1, «Сделай на этой странице»): what the page map, the model's calls and a step's result look like.
// Shared by the content script (it builds the map and acts), the background (it runs the task) and the server
// (/api/v2/act asks the model and checks its call). Plain data only, so the tests load it as it is.

/** What a control on the page is, as the model sees it. */
export type Role =
  | "button" | "link" | "textbox" | "textarea" | "editor" | "select" | "combobox" | "listbox" | "option"
  | "checkbox" | "radio" | "switch" | "tab" | "menuitem" | "slider" | "file" | "summary" | "other"

/**
 * A field whose value the model never sees: "secret" (password, card, code, document number: the agent never
 * types into it either) or "personal" (name, e-mail, phone, address, birth date: shown as filled or empty).
 */
export type Lock = "secret" | "personal"

export interface MapItem {
  // The number the model calls it by: "12", or "f1:12" in a frame. Lives as long as the element does.
  id: string
  role: Role
  // Its name as a person reads it: aria-label, <label>, text, placeholder, title, alt (≤ 120 chars).
  label: string
  // An input's value, a select's chosen option, a checkbox's nothing (see state). Never for a locked field.
  value?: string
  // checked, selected, expanded, collapsed, disabled, required, invalid, readonly, pressed, current.
  state?: string[]
  // An input's type when it isn't plain text ("email", "number", "date", "search", "submit"…).
  type?: string
  // An autocomplete token the page gave the field ("email", "given-name", "postal-code").
  auto?: string
  lock?: Lock
  // dialog: in something drawn over the page; below/above: outside the screen now.
  where?: "dialog" | "below" | "above"
  // Which form it belongs to (forms numbered on the page), when it's in one.
  form?: number
  // A link's address: a path on this site, or "other-site.com/path" for another site.
  href?: string
  // A control with no words: what its picture or the page's code calls it («close», «calendar-next»). Shown to the
  // model in brackets; never read by a guard (its class comes from its words only).
  hint?: string
  // A select's options (the first 30), or a listbox's.
  options?: string[]
  // A link with no rating of its own: the text of the card it heads (its rating, reviews, cuisine, area beside it), so
  // the device can read the place. Kept on the device (never sent to the model).
  card?: string
}

export interface PageForm {
  n: number
  // The form sends to another site (its action's host), or holds a password or card field.
  otherSite?: string
  secret?: boolean
  // It has fields a person fills in (not only a search box).
  fillable?: boolean
}

export interface PageMap {
  url: string
  title: string
  // The page's language (html lang) when it says.
  lang: string
  items: MapItem[]
  forms: PageForm[]
  // Controls left out of this part (the model asks for the next one with read_page).
  more: number
  part: number
  parts: number
  // Headings, messages (alerts, errors) and the text around the visible part (≤ ~3000 chars). The guards' words: what
  // the device's rules read (a booking confirmed, an account made, a cookie layer), never the outline.
  text: string
  // The page in reading order for the model: words and controls together («[#12 button "See availability"]»), the
  // screen in full, the rest in parts (§2…) it opens with read_page (round 139). Never read by a guard.
  outline?: string
  // How many parts after the screen the outline has (read_page(n) opens §n, 2 ≤ n ≤ sections + 1).
  sections?: number
  // An overlay of the page is open (a dialog, a cookie banner): its controls come first.
  overlay?: boolean
  // The overlay's own words, when it's about cookies or consent.
  consent?: boolean
  // A layer over the page that isn't the task (rewards, a newsletter, the site's app, notifications, location) and its
  // control that closes it without agreeing to anything: the device presses it as a free step.
  promo?: { id: string; label: string }
  // The page takes payment: card fields, a payment provider's frame (Stripe, Adyen, Braintree, PayPal, Apple Pay…) or
  // a checkout / payment address. Every press that sends something here is the person's own.
  pay?: boolean
  // The page mentions a deposit, a prepayment or a no-show fee (read with the page's amounts): its committing press pays.
  deposit?: boolean
  // Another site's frames big enough to be a form (a restaurant's booking widget from a provider): the map can't read
  // inside them. Their title (title, aria-label or name) when they have one.
  frames?: Array<{ src: string; host: string; w: number; h: number; title?: string }>
  // Every amount of money on the whole page (the device's price check against the plan; never sent to the model).
  money?: number[]
}

export type ToolName =
  | "read_page" | "click" | "type" | "fill" | "select" | "scroll" | "go" | "back" | "extract" | "ask_user" | "done"
  // The person's Calendar and Reminders on the device (2.7.1, AgentApple.swift): no page in it.
  | "reminders" | "reminder_add" | "reminder_done" | "calendar" | "event_add"

/** One call of the model: one tool and its arguments (the ones the tool doesn't use are left out). */
export interface ToolCall {
  tool: ToolName
  id?: string
  text?: string
  mode?: "replace" | "append"
  // fill: which of the person's saved details («Мои данные») goes in ("email", "fact:Размер обуви"); the device puts
  // the value in, the model never sees it.
  key?: string
  option?: string
  to?: "up" | "down"
  part?: number
  question?: string
  // ask_user: the answers offered as buttons (the person can also write their own).
  choices?: string[]
  summary?: string
  // Calendar and Reminders: a reminder's ref (from «reminders»), a list's name, a day ("2026-12-05"), a time ("19:30"),
  // the latest time ("21:00"), a length in minutes, how many days to look at, an event's place.
  ref?: string
  list?: string
  date?: string
  time?: string
  until?: string
  minutes?: number
  days?: number
  place?: string
  // What the model says the step is for, in the person's language (shown in the log).
  why?: string
  // The control as it was when the step was classed (set by the device, never by the model): the hands refuse the step
  // if the live control isn't that one any more («Continue» relabelled «Pay now» while the server answered).
  expect?: { label: string; role: Role; lock?: Lock }
  // Set by the device only (never the model's): an event's link (the booking page without its query).
  link?: string
  // More presses on the same page after this one (each checked and classed on the device first).
  also?: Array<{ id: string; why?: string }>
}

/**
 * What a step may do, decided by code (classify.ts), never by the model:
 * - free: the agent does it;
 * - confirm: the «Сделать?» card first;
 * - self: the agent never does it; it shows the control and the person does it (pay, send, sign in…);
 * - blocked: not at all (a secret field, a site the agent doesn't act on).
 */
export type StepClass = "free" | "confirm" | "self" | "blocked"

export interface StepVerdict {
  cls: StepClass
  // Why, as a short code the panel turns into words ("pay", "send", "submit", "other_site", "secret"…).
  reason: string
}

export interface StepResult {
  ok: boolean
  // What happened, for the model and the log ("typed", "no such element", "the page didn't change"…).
  note?: string
  // The page went to another address (the next map comes from there).
  navigated?: boolean
  // Something on the page changed after the step.
  changed?: boolean
  // extract: the page's text (or the elements' values) for the model to answer from.
  data?: string
  // What the step changed, to put back with «Отменить» (a field's or a checkbox's earlier value).
  undo?: { id: string; kind: "value" | "checked" | "select"; before: string | boolean }
  // The tap's page asked to open this address in a new tab (its window.open, caught during the tap: 128).
  opened?: string
  // The tap changed nothing and the page's own world couldn't be watched (a strict content policy): it may have tried
  // to open a new tab, which Safari blocks for the agent's tap.
  tabBlocked?: boolean
}

/** One line of the task's log, as the server gets it back with each step. */
export interface LogEntry {
  call: ToolCall
  // The control's label and role when the call named one.
  target?: string
  result: string
}
