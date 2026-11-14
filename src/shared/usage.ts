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
  /** Extra named values; "int" is a whole number 0–9999, "code" 2–3 capital letters (a currency, a country). */
  fields?: Record<string, readonly string[] | "int" | "code">
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
  // Build 94: "link", a chat opened from a link to it in an answer.
  ask_chats: { since: "2.4", tracked: "2.4", actions: ["open", "chip", "answer", "error", "link"] },
  consent: {
    since: "2.0", actions: ["shown", "accepted", "declined"],
    via: ["ask", "find", "ask_chats", "qi", "organize"], fields: { step: "int" }
  },
  note: { since: "2.3", actions: ["saved"], via: ["composer", "limit", "selection", "app"] },
  // 2.6: "action" by a chip in the field (via "chip", what: the action) on iPhone and iPad.
  bubble: {
    since: "2.0", on: "ext", actions: ["shown", "ask", "action", "question", "note", "template", "remind"], via: ["chip", "button"],
    fields: { what: ["sel_summarize", "sel_translate", "sel_explain", "sel_improve", "sel_reply", "sel_similar"] }
  },
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
        "qi_sign", "key_model", "own_key", "show_tips", "delete_all", "spaces"],
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
  // The app's notifications screen before the system's question (2.6): why it came up, and what was answered.
  notify: { since: "2.6", tracked: "2.6", on: "app", actions: ["shown", "on", "later"], fields: { why: ["launch", "ultra", "listen"], status: ["denied", "not_asked"] } },
  paywall: {
    since: "2.0", on: "app", actions: ["shown", "plan", "buy_ok", "buy_cancel", "buy_pending", "buy_fail", "restore", "manage"],
    via: ["tab", "home", "deeplink", "ai_lock", "ask_chats", "limit", "offer", "organize", "tips", "whatsnew"],
    fields: { plan: ["monthly", "yearly", "own_key", "promo"] }
  },
  renewal: { since: "2.4", tracked: "2.4", actions: ["shown", "answer"] },
  // 2.6: the guided first request (src/content/Guide.tsx) reports these; "what" is the step it was on (or, for "exit",
  // why it ended there), "via" how it started: the first open or the "…" menu.
  tour: {
    since: "2.3", tracked: "2.6", actions: ["start", "step", "done", "skip", "exit"], via: ["first", "menu", "plan", "plan_menu"],
    fields: {
      step: "int",
      what: ["summarize", "consent", "answer", "select", "pick", "ask", "askSel", "answer2", "chats", "chatList", "menu", "pro_media", "pro_chats", "pro_chatList", "pro_sort", "pro_templates", "pro_watch", "ultra_listen", "ultra_similar", "ultra_watch", "declined", "limit", "error", "closed"]
    }
  },
  hint: { since: "2.3", actions: ["shown", "done"], fields: { what: ["chats", "video", "pdf", "note", "bubble", "qi", "app_chats"] } },
  tab: { since: "2.0", on: "app", actions: ["open"], fields: { what: ["start", "chats", "templates", "tips", "pro", "settings"] } },
  tips: {
    since: "2.0", on: "app", actions: ["open", "play"],
    fields: { what: ["summary", "translate", "selection", "note", "video", "pdf", "chats", "search", "tags", "ai_search", "ask_chats", "quick_insert", "templates", "copied", "organize"] }
  },
  setup: { since: "2.4", on: "app", actions: ["open_settings", "open_safari", "mac_settings", "notif_granted", "notif_denied", "banner_tap"] },
  // "similar": Find similar's "found" notification (the search ended after the person left Safari); "panel": the page
  // its tap opened showed the panel on that chat (the chat named in the page's address, the panel's step).
  notif: { since: "2.4", on: "app", actions: ["tap", "panel"], fields: { what: ["remind", "remind_page", "setup", "watch", "similar"] } },
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
  // Build 94: the chats list has its "…" too ("via": over a chat or over the list), with Recently Deleted ("trash").
  menu: { since: "2.5", on: "ext", actions: ["open", "pick"], via: ["chat", "list"], fields: { what: ["later", "reminders", "watching", "watch_page", "settings", "tips", "intro", "listen", "similar", "plan_tour", "name_chat", "trash", "rate"] } },
  // 2.6: read aloud (Ultra) started from an answer or the page, handed to the app (iPhone, iPad), or refused (not
  // Ultra: the plans sheet; the week's minutes used up). The parts themselves are logged by the server ("speak").
  // Build 90 (the app): Apple's voice read a text the server couldn't start ("apple"), a text stopped short after
  // ours had played ("interrupted"), "Try again" ("retry").
  // "heard" (build 92): when a text stops or ends, the seconds heard and where its audio came from (this device's copy,
  // iCloud, the server) and what the server charged up front, so minutes charged can be set against minutes heard.
  // Build 93: the app sent the person back to Safari once notifications were on ("back_safari"), and the panel then
  // played the text ("back_play").
  // Build 94: what plays tapped in the panel's bar, back to its chat ("go"); a text heard to its end, now marked
  // "already voiced" by Listen ("voiced").
  // Build 95: a text whose audio played out but isn't marked ("unvoiced"), and why: skipped ahead here, skipped in Safari
  // before it was carried on ("before"), or the end not reached by `gap_s` seconds ("short").
  listen: {
    since: "2.6", tracked: "2.6", actions: ["start", "app", "ultra", "limit", "error", "apple", "interrupted", "retry", "heard", "notify", "notify_on", "notify_later", "carried_on", "back_safari", "back_play", "go", "voiced", "unvoiced"],
    fields: { what: ["answer", "page"], heard_s: "int", cache_s: "int", icloud_s: "int", server_s: "int", charged_s: "int", why: ["skipped", "before", "short"], gap_s: "int" }
  },
  // 2.6: the plans sheet (Own key, Pro, Ultra): opened from where, and the plan and period chosen (to the app).
  plans: {
    since: "2.6", tracked: "2.6", on: "ext", actions: ["open", "choose", "yearly"],
    via: ["listen", "settings", "watch", "limit", "similar", "spaces"],
    // Build 93: the currency of the prices shown and the App Store country they came from (none: no prices came).
    fields: { plan: ["byok", "pro", "ultra"], period: ["monthly", "yearly"], cur: "code", sf: "code" }
  },
  // Build 91: the plans message in the chat — out of answers ("limit"), the chat's memory ("memory": the switch, or a
  // free chat past its last messages), a Pro or Ultra feature refused; shown, and what was tapped: a plan and period
  // (to the app), the discount, a note, the own key, Retry.
  chat_plans: {
    since: "2.6", tracked: "2.6", on: "ext", actions: ["shown", "choose", "discount", "note", "own_key", "retry", "close"],
    via: ["limit", "memory", "pro_only", "ultra_only"],
    fields: { plan: ["pro", "ultra"], period: ["monthly", "yearly"] }
  },
  later: { since: "2.5", actions: ["open", "list"], via: ["menu", "link", "tab", "bubble", "panel"], fields: { reminders: "int", watches: "int" } },
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
  // 2.6 (100), the owner: «никому не предлагалось оценить приложение … Оно вообще работает?». "due": a milestone of
  // good answers reached (3, 10, 30, 100, 300), in Safari ("ext_moment", sent by the extension, s "panel") or in the
  // app's own chats ("app_answer"); "ask": the app asked Apple for its rating sheet (ReviewAsk.swift), and at what
  // moment. Apple doesn't say whether the sheet showed (at most 3 times in 365 days, never in TestFlight): "ask" is our
  // request, not a sheet seen. "link": the App Store's "Write a Review" tapped (Settings, the footer, the panel's "…").
  rate: {
    since: "2.2", tracked: "2.6", actions: ["due", "ask", "link"],
    via: ["app_answer", "ext_moment", "tour", "purchase", "similar", "listen", "whatsnew", "organize", "settings", "footer", "menu"],
    fields: { moment: "int" }
  },
  // 2.6 (97): the bar of a chat's open suggestions at its top: shown (once per set of suggestions in a chat), tapped.
  org: {
    since: "2.6", tracked: "2.6", actions: ["bar_shown", "bar_tap", "scan"],
    // 2.6 (98) "scan": what one organizing run compared and why nothing fired (src/shared/organize.ts organizeScan):
    // counts, a match %, the first rule the best candidates stopped at, the engine's version and the thresholds' key.
    fields: {
      chats: "int", msgs: "int", vec: "int", kb: "int", mg: "int", mga: "int", mv: "int", ev: "int", tv: "int",
      mgw: ["none", "page", "notes", "settled", "refused", "answers", "match", "open"],
      mvw: ["none", "window", "weak", "settled", "topic", "fit", "margin", "mix", "open"],
      res: ["off", "none", "merge", "page", "site", "topic", "apart"]
    }
  },

  // 2.7: Spaces (src/shared/spaces.ts), counts only: never a space's name or colour, nor a site. "switch": how (the
  // header's list, the app's list, a bound site, a chat opened from another space, a search hit); "bind" and "toggle":
  // on or off (Settings' switch); "limit": Free asked for one more than it has; "spaces": how many there are then.
  space: {
    since: "2.7", tracked: "2.7", actions: ["create", "switch", "move", "bind", "toggle", "edit", "delete", "limit"],
    via: ["header", "app", "site", "chat", "list", "settings"],
    fields: { val: ["on", "off"], spaces: "int" }
  },

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
    const ok = allowed === "int" ? whole(value, 9999) : allowed === "code" ? typeof value === "string" && /^[A-Z]{2,3}$/.test(value) : has(allowed, value)
    if (ok) out[name] = value
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
