// Which features people use, and in what order: the registry behind /api/v2/event's "use" kind and the
// session fields every client event may carry (sid, n, prev, dt, s, psid). Counts and named values only —
// never a page address, title, text, question, tag, template name or site. The server keeps a value only
// if it is listed here; the app's copy (Usage.swift) is checked against this file.

/** Where a step happened: the panel, the page (✦, selection buttons, quick insert), the PDF popup, the app,
 * a notification. */
export const SURFACES = ["panel", "page", "popup", "app", "notif"] as const

interface Feature {
  /** First version that has it: people on older versions aren't counted in its share. */
  since: string
  /** First version that reports it, when not 2.5 (the first to send "use" steps): answers and limits are logged
   * by the server for every version. */
  tracked?: string
  /** Only in the app, or only in Safari (the extension); both when left out. */
  on?: "app" | "ext"
  actions: readonly string[]
  /** How people got to it. */
  via?: readonly string[]
  /** Extra named values; "int" is a whole number 0–9999. */
  fields?: Record<string, readonly string[] | "int">
  /** Sent as its own event kind (or logged by the server), never as "use": named here for prev and reports. */
  own?: true
}

const ENTRIES = ["list", "search", "ai_search", "move_bar", "reminder", "deeplink"] as const

export const FEATURES: Record<string, Feature> = {
  panel: {
    since: "2.0", on: "ext", actions: ["open", "close"],
    via: ["toolbar", "shortcut", "fab", "bubble", "note_open", "qi", "app"],
    fields: { lay: ["side", "sheet", "popup"] }
  },
  // Answers are logged by the server (/api/v2/chat with "ui"); the panel sends the rest.
  ask: {
    since: "2.0", tracked: "2.0", actions: ["answer", "error", "stop", "retry", "google_on", "google_off", "whole_on", "whole_off", "source"],
    via: ["composer", "chip", "followup", "newpage", "bubble", "qi_adapt", "retry", "app_chat"]
  },
  ai_search: { since: "2.4", tracked: "2.4", actions: ["on", "answer", "error", "open"], fields: { hits: ["0", "1-5", "6+"] } },
  ask_chats: { since: "2.4", tracked: "2.4", actions: ["open", "chip", "answer", "error"] },
  consent: {
    since: "2.0", actions: ["shown", "accepted", "declined"],
    via: ["ask", "find", "ask_chats", "qi", "organize"], fields: { step: "int" }
  },
  note: { since: "2.3", actions: ["saved"], via: ["composer", "limit", "selection", "app"] },
  bubble: { since: "2.0", on: "ext", actions: ["shown", "ask", "action", "question", "note", "template", "remind"] },
  fab: { since: "2.0", on: "ext", actions: ["tap", "drag", "hide_site"] },
  msg: { since: "2.0", actions: ["copy", "share"], fields: { what: ["answer", "note", "ask_chats"] } },
  share_chat: { since: "2.3", actions: ["open", "copy", "share"], fields: { picked: "int" } },
  page_open: { since: "2.3", actions: ["tap"], via: ["divider", "chat_pages", "note_link", "source", "reminder", "watch"] },
  chats: { since: "2.3", actions: ["open"], via: ["header", "tab", "deeplink"] },
  chat: { since: "2.3", actions: ["open", "new", "rename", "pin", "unpin", "continue"], via: ENTRIES },
  search: { since: "2.4", actions: ["run"], fields: { hits: ["0", "1-5", "6+"] } },
  tags: { since: "2.4", actions: ["add", "remove", "filter", "folders_on", "folders_off"], fields: { what: ["chat", "answer", "note"] } },
  settings: {
    since: "2.0", actions: ["open", "change"],
    fields: {
      key: ["theme", "text_size", "fab", "bubble", "share_marks", "about_me", "icloud", "organize", "copied", "qi_button",
        "qi_sign", "key_model", "own_key", "show_tips", "delete_all"],
      val: ["on", "off", "set", "clear"]
    }
  },
  upsell: {
    since: "2.0", actions: ["shown", "tap", "blocked"],
    via: ["usage_line", "limit", "offer_card", "pro_card", "pro_only", "media", "settings", "inchat_mess", "third_tag",
      "first_win", "whatsnew", "tip", "qi_fill", "byok_offer", "pro_screen"],
    fields: { feature: ["ai", "organize", "media", "limit", "qi", "google"] }
  },
  offer: { since: "2.4", actions: ["shown", "redeem", "later"] },
  paywall: {
    since: "2.0", on: "app", actions: ["shown", "plan", "buy_ok", "buy_cancel", "buy_pending", "buy_fail", "restore", "manage"],
    via: ["tab", "home", "deeplink", "ai_lock", "ask_chats", "limit", "offer", "organize", "tips", "whatsnew"],
    fields: { plan: ["monthly", "yearly", "own_key", "promo"] }
  },
  renewal: { since: "2.4", tracked: "2.4", actions: ["shown", "answer"] },
  tour: { since: "2.3", actions: ["start", "step", "done", "skip"], fields: { step: "int" } },
  hint: { since: "2.3", actions: ["shown", "done"], fields: { what: ["chats", "video", "pdf", "note", "bubble", "qi", "app_chats"] } },
  tab: { since: "2.0", on: "app", actions: ["open"], fields: { what: ["start", "chats", "templates", "tips", "pro", "settings"] } },
  tips: {
    since: "2.0", on: "app", actions: ["open", "play"],
    fields: { what: ["summary", "translate", "selection", "note", "video", "pdf", "chats", "search", "tags", "ai_search", "ask_chats", "quick_insert", "templates", "copied", "organize"] }
  },
  setup: { since: "2.4", on: "app", actions: ["open_settings", "open_safari", "mac_settings", "notif_granted", "notif_denied", "banner_tap"] },
  notif: { since: "2.4", on: "app", actions: ["tap"], fields: { what: ["remind", "remind_page", "setup", "watch"] } },
  app: {
    since: "2.4", tracked: "2.4", on: "app", actions: ["open"], via: ["icon", "deeplink", "notif"],
    fields: { what: ["subscribe", "manage", "tips", "chats", "chat", "templates", "open"] }
  },
  open_app: { since: "2.0", on: "ext", actions: ["tap"], fields: { what: ["subscribe", "manage", "open"] } },
  qi_list: { since: "2.5", on: "ext", actions: ["open"], via: ["button", "shortcut", "slash"] },
  templates: { since: "2.5", actions: ["view", "edit", "delete", "copy"] },
  // The panel header's "…" (opened, an item picked) and "Come back later": its window in the panel ("open"),
  // the "Reminders" list in the panel ("list": from the menu or the window's "All reminders" link) and in the
  // app ("open" from its tab), with how many reminders and watches the list held.
  menu: { since: "2.5", on: "ext", actions: ["open", "pick"], fields: { what: ["later", "reminders", "settings"] } },
  later: { since: "2.5", actions: ["open", "list"], via: ["menu", "link", "tab"], fields: { reminders: "int", watches: "int" } },
  watch: {
    since: "2.5", actions: ["create", "alert", "stop", "error", "daily"],
    via: ["bubble", "later", "panel", "app", "notif", "list", "auto"],
    fields: {
      what: ["price", "stock", "date", "status", "page"],
      site: ["shop", "jobs", "news", "gov", "tickets", "other"],
      mode: ["bg", "live"],
      reason: ["blocked", "login", "gone"],
      checks: "int",
      active: "int"
    }
  },
  rate: { since: "2.2", on: "app", actions: ["asked", "link"], via: ["moment", "app_answers", "purchase"] },

  // Their own kinds (2.4 and 2.5) and server rows, under the names reports and prev use.
  ext: { since: "2.4", tracked: "2.4", on: "ext", actions: ["on"], own: true },
  limit: { since: "2.0", tracked: "2.0", actions: ["hit"], own: true },
  social: { since: "2.5", actions: ["open"], own: true },
  insert: {
    since: "2.5", on: "ext", own: true,
    actions: ["copied", "template", "answer", "tpl_new", "fill", "fill_edit", "manual", "ai_mark", "ai_fill", "ai_find"]
  },
  mark: { since: "2.5", actions: ["added", "removed", "copied", "shared"], own: true },
  pin: { since: "2.5", actions: ["pinned", "unpinned", "unpinned_all", "bar_tap"], own: true },
  delete: { since: "2.5", actions: ["deleted", "undone"], own: true },
  remind: { since: "2.5", actions: ["set", "cancelled", "denied", "unavailable", "opened"], own: true },
  organize: {
    since: "2.5", own: true,
    actions: ["shown", "accepted", "dismissed", "undone", "optin_accepted", "optin_declined", "api_embed", "api_tags"]
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const has = (list: readonly string[] | undefined, value: unknown): value is string =>
  typeof value === "string" && !!list?.includes(value)
const whole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
// The app sends its event fields as strings ("3").
const count = (value: unknown): unknown => typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : value

/** "chat.open" when both halves are in the registry. */
export function isStep(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 33) return false
  const [f, a, rest] = value.split(".")
  return rest === undefined && has(FEATURES[f]?.actions, a)
}

/** The session fields, kept on any client event and on AI requests ("ui"): a random id per short session of
 * use (a new one after 30 minutes without a step), the step's number in it, the step before, seconds since
 * it (at most an hour), where it happened, and the session on another surface it came from. */
export function sessionFields(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) return {}
  const { sid, n, prev, dt, s, psid } = body
  return {
    ...(typeof sid === "string" && UUID.test(sid) ? { sid: sid.toLowerCase() } : {}),
    ...(whole(n, 9999) && n > 0 ? { n } : {}),
    ...(isStep(prev) ? { prev } : {}),
    ...(typeof dt === "number" && Number.isFinite(dt) && dt >= 0 ? { dt: Math.min(3600, Math.round(dt)) } : {}),
    ...(has(SURFACES, s) ? { s } : {}),
    ...(typeof psid === "string" && UUID.test(psid) ? { psid: psid.toLowerCase() } : {})
  }
}

/** A "use" step's own fields, or null when the feature or the action isn't in the registry (or is sent as its
 * own kind). Unknown extra fields and values are left out. */
export function useFields(body: Record<string, unknown>): Record<string, unknown> | null {
  const f = typeof body.f === "string" ? body.f : ""
  const spec = FEATURES[f]
  if (!spec || spec.own || !has(spec.actions, body.a)) return null
  const out: Record<string, unknown> = { f, a: body.a }
  if (has(spec.via, body.via)) out.via = body.via
  for (const [name, allowed] of Object.entries(spec.fields ?? {})) {
    const value = allowed === "int" ? count(body[name]) : body[name]
    if (allowed === "int" ? whole(value, 9999) : has(allowed, value)) out[name] = value
  }
  return out
}

/** The entry point an AI request came through (ask, ai_search, ask_chats), for the server's own row. */
export function uiFields(ui: unknown, feature: "ask" | "ai_search" | "ask_chats"): Record<string, unknown> {
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return {}
  const body = ui as Record<string, unknown>
  return { ...sessionFields(body), ...(has(FEATURES[feature].via, body.via) ? { via: body.via } : {}) }
}

const later = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number))
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b
  return a
}

/** Who could have used each feature and been seen doing it (from the later of its first version and the first
 * version that reports it; in the app, Safari or both), for its share in /analytics. */
export const featureBase = (): Record<string, { since: string; on: "app" | "ext" | "both" }> =>
  Object.fromEntries(Object.entries(FEATURES).map(([f, spec]) =>
    [f, { since: later(spec.since, spec.tracked ?? "2.5"), on: spec.on ?? "both" }]))
