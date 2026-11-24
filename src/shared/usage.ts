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
    via: ["ask", "find", "ask_chats", "qi", "organize", "translate"], fields: { step: "int" }
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
      what: ["summarize", "consent", "answer", "select", "pick", "ask", "askSel", "answer2", "swipe", "chats", "chatList", "menu", "pro_media", "pro_chats", "pro_chatList", "pro_sort", "pro_templates", "pro_watch", "ultra_listen", "ultra_similar", "ultra_watch", "declined", "limit", "error", "closed"]
    }
  },
  hint: { since: "2.3", actions: ["shown", "done"], fields: { what: ["chats", "video", "pdf", "note", "bubble", "qi", "app_chats", "side"] } },
  // 2.7 (plan section 6): page hints in the first days — the line by the circle shown, tapped, ✕ (and two in a row
  // turning them off), the feature used after it; the Settings switch. what: which hint (src/content/pagehints).
  page_hint: {
    since: "2.7", tracked: "2.7", on: "ext", actions: ["shown", "tap", "dismiss", "off", "used", "switch_on", "switch_off"],
    fields: { what: ["similar", "watch", "summary", "listen", "video", "templates", "remind", "calendar"] }
  },
  // 2.7 (plan section 9): the circle dragged to the other edge, the panel dragged by its header (iPad, Mac), the side
  // picked in Settings; what: the side it went to.
  side: { since: "2.7", tracked: "2.7", on: "ext", actions: ["drag_fab", "drag_panel", "setting"], fields: { what: ["left", "right"] } },
  // 2.7 (plan section 5): invite a friend — the group or screen opened, the code shared or copied, a friend's code
  // entered (taken or refused), the reward shown (the card when a friend became active) and taken (Pro's or Ultra's
  // offer code, or extra answers). Codes entered, friends active and purchases are counted by the server.
  invite: {
    since: "2.7", tracked: "2.7", actions: ["open", "share", "copy", "code_ok", "code_bad", "reward_shown", "reward_pro", "reward_ultra", "reward_answers"],
    via: ["settings", "card", "app", "first_screen"]
  },
  tab: { since: "2.0", on: "app", actions: ["open"], fields: { what: ["start", "chats", "templates", "tips", "pro", "settings"] } },
  tips: {
    since: "2.0", on: "app", actions: ["open", "play"],
    fields: { what: ["summary", "translate", "selection", "note", "video", "pdf", "chats", "search", "tags", "ai_search", "ask_chats", "quick_insert", "templates", "copied", "organize"] }
  },
  setup: { since: "2.4", on: "app", actions: ["open_settings", "open_safari", "mac_settings", "notif_granted", "notif_denied", "banner_tap"] },
  // 2.7 (plan section 8, «Активация»): the way from the app to ContextFlow switched on, counted, never what's on screen.
  // "video": the guide started floating over Settings (iPhone, iPad); "settings": Settings opened from the app (the
  // home card, or on a Mac the chats' empty state too); "back": the app in front again after that trip; "enabled": the
  // app saw ContextFlow switched on (once an install). "linked": once, the extension's own side, when the panel first
  // gives it the install id, sends it with the app's id (both random), so the steps in the app join the ones Safari's
  // side logs: switched on there (ext_on) and the first answer. 2.7.1: sent by the extension's background instead, until
  // the server confirms it, and again when the app's id changes (src/background/link.ts); still both ids only.
  activation: {
    since: "2.7", tracked: "2.7", on: "app", actions: ["video", "settings", "back", "enabled", "linked"], via: ["card", "chats"]
  },
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
    via: ["listen", "settings", "watch", "limit", "similar", "translate", "spaces", "collections"],
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
  // 2.7: the page translated in place (src/content/translate): the pill by the circle shown on a page in another
  // language, tapped, the consent asked from it, the translation shown, "Original", × (hidden on that site), the
  // answers used up (and Pro tapped there), a failure. The server logs each request ("translate") and the limit.
  translate_page: {
    since: "2.7", tracked: "2.7", on: "ext",
    // build 107: "entry" the entry by the circle opened the pill, "lang" another language picked.
    // build 109: the whole site: asked ("site_ask"), yes, no, turned off, and a page that started by itself ("auto").
    actions: ["shown", "tap", "consent", "done", "original", "dismiss", "limit", "plans", "error", "entry", "lang", "site_ask", "site_on", "site_no", "site_off", "auto"]
  },
  later: { since: "2.5", actions: ["open", "list"], via: ["menu", "link", "tab", "bubble", "panel"], fields: { reminders: "int", watches: "int" } },
  // 2.7: Find similar — Ultra's full search, the light one for Own key and Pro (`what`). The panel: its card opened
  // ("pick"), a search asked ("find"), the light search's week or Pro's answers used ("limit"); the panel and the app: an
  // item opened ("open"). Each search itself, its plan and cost, is logged by the server ("similar", with `mode`).
  similar: { since: "2.6", tracked: "2.7", actions: ["pick", "find", "limit", "open"], fields: { what: ["light", "full"] } },
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

  // 2.7, Calendar and Reminders (appleItems.ts). The AI's card: opened by the chat's marker ("chat"), the message's "…"
  // ("menu") or the chip under an answer ("chip"); what it found ("shown", "nothing"); each Add tapped in it ("card"):
  // written on the device ("added"), handed to the app ("app"), no access ("denied"), "failed", "unavailable",
  // "not_asked". «Также в Напоминания» ("remind"): turned on or off, and each reminder it put in Reminders. The app's
  // side of a handed-over item ("app"): "added", "denied", "failed", the event editor closed ("dismissed").
  // Counts only: never a title, a date or a list.
  apple: {
    since: "2.7", tracked: "2.7",
    actions: ["open", "shown", "nothing", "added", "app", "denied", "failed", "unavailable", "not_asked", "dismissed", "also_on", "also_off"],
    via: ["chat", "menu", "chip", "card", "remind", "app"],
    fields: { what: ["reminder", "event"] }
  },

  // 2.7: «Проверить» и «Переписать» by a field (src/content/insert/Write.tsx), counts only: never the text, the page or the
  // site. "menu": the Mac's circle opened its menu; "check" and "rewrite": asked for (what: the rewrite's tone); "shown":
  // changes or a rewrite to look at; "clean": nothing to fix; "applied", "failed" (some didn't go in), "manual" (none
  // did: copied to paste); "undone", "undo_failed"; "changed" (typed on before applying); "too_long", "limit", "plans"
  // (Pro tapped there), "consent", "error"; "slow" (no answer within the deadline), "updated" (a tab left open across an
  // update: the old page script gets no answers, the page has to be reloaded). The server logs each request ("write") and the limit.
  write: {
    since: "2.7", tracked: "2.7", on: "ext",
    actions: [
      "menu", "check", "rewrite", "shown", "clean", "applied", "failed", "manual", "undone", "undo_failed", "changed", "too_long", "limit", "plans", "consent", "error", "slow", "updated",
      // Live underlines (Pro and Ultra): a fix shown (hover or tap), made, set aside, not taken by the field; the hidden cap reached.
      "live_shown", "live_fixed", "live_ignored", "live_failed", "live_cap"
    ],
    via: ["circle", "list", "underline", "panel"],
    fields: { what: ["check", "short", "warm", "formal", "confident"] }
  },

  // 2.7 (after build 107), the quiet panel (src/content/quiet): a chip of the page's tapped ("chip", what: which one);
  // «+» by the field opened ("plus") and what was picked there ("plus_pick"); what was picked in a message's «…» that
  // the row has no room for ("more_pick"). lay: the chat's density then. 109: an answer or a note moved to another chat
  // from its «…» ("moved": to a chat of this space, another space's, or a new one) and taken back ("move_undone"). 110:
  // the count opened to what the answers went on ("spent", via where).
  quiet: {
    since: "2.7", tracked: "2.7", on: "ext",
    actions: ["chip", "plus", "plus_pick", "more_pick", "moved", "move_undone", "spent"],
    fields: {
      what: ["check", "rewrite", "templates", "translate_page", "watch", "similar", "summarize", "key_points", "explain", "translate", "google", "note", "shot", "whole", "tag", "collect", "move"],
      lay: ["compact", "roomy"],
      to: ["chat", "space", "new"],
      // 110: the count opened to what the answers went on: in «+», from the number by the field, in Settings.
      via: ["plus", "number", "settings"]
    }
  },

  // 2.7: «Снимок страницы в заметке» (src/shared/shots.ts), counts only: never the page, the picture or its size beyond
  // screens. "on"/"off": the switch over the note field; "visible"/"full": what it takes; "taken" (what, and a whole
  // page's screens), "failed" (why: unavailable, failed, keep); "open", "crop", "uncrop" in the chat; "plans": Free
  // tapped the whole page's Pro.
  shot: {
    since: "2.7", tracked: "2.7", on: "ext",
    actions: ["on", "off", "visible", "full", "taken", "failed", "open", "crop", "uncrop", "plans"],
    fields: { what: ["visible", "full"], why: ["unavailable", "failed", "keep"], screens: "int" }
  },

  // 2.7: Spaces (src/shared/spaces.ts), counts only: never a space's name or colour, nor a site. "switch": how (the
  // header's list, the app's list, a bound site, a chat opened from another space, a search hit, the matching chat in
  // another space (107), its line's way back); "bind" and "toggle":
  // on or off (Settings' switch); "limit": Free asked for one more than it has; "spaces": how many there are then.
  space: {
    since: "2.7", tracked: "2.7", actions: ["create", "switch", "move", "bind", "toggle", "edit", "delete", "limit"],
    via: ["header", "app", "site", "chat", "list", "settings", "match", "match_back"],
    fields: { val: ["on", "off"], spaces: "int" }
  },

  // 2.7: «Подходящий чат при открытии панели» (src/shared/match.ts). "shown": the panel opened on a chat that fits the
  // page, and why (its page, its topic by words or by meaning, its site) with the topic's match %; "new": none fitted,
  // a new chat; "where": in the space the panel was in, or another (107: it went there). Then whether the person left it
  // at once: "line_new" (the line's «Новый чат»), "line_back" (its «← space», back where the panel was; 107–109), "toast_back" (110: the same from the line over the
  // header, the chat's bar keeps the name), "other"
  // (another chat opened within two minutes). Counts only.
  match: {
    since: "2.7", tracked: "2.7", on: "ext", actions: ["shown", "new", "line_new", "line_back", "toast_back", "other"],
    fields: { why: ["page", "topic", "meaning", "site"], match: "int", where: ["here", "other"] }
  },

  // 2.7: Подборки (src/shared/collections.ts), counts only: never a name, a gist, a site. "add": a card put in (via the
  // panel, the app, the suggestion taken or another place picked); "limit": Free asked for more than one collection or
  // ten cards; "layout", "compare", "summary": the AI's (Pro); "pdf": exported; "open": the collections window or screen.
  collect: {
    since: "2.7", tracked: "2.7", actions: ["create", "add", "move", "section_add", "section_rename", "section_delete", "delete", "layout", "compare", "summary", "pdf", "open", "limit"],
    via: ["panel", "app", "suggested", "picked", "header", "list", "sidebar", "chats", "mark"],
    fields: { cards: "int", what: ["collection", "card"] }
  },

  // 2.7.1, the cookie closer (src/content/cookies): a day's counts, sent once the next day — banners answered with
  // «only necessary» by each consent platform's rule, the generic closer or a TCF page ("closed", what, count), and
  // banners left to the person and why ("left": only «Accept» offered, no button we know, pressed but it stayed, a
  // «pay or accept» wall).
  // Settings: the switch and the per-site exception. Never a site or an address.
  cookies: {
    since: "2.7.1", tracked: "2.7.1", on: "ext",
    // 121, the owner: "accepted" — no way to refuse, «Если отказаться нельзя — принимать» on ("accept_on"/"accept_off").
    actions: ["closed", "accepted", "left", "switch_on", "switch_off", "site_off", "site_on", "accept_on", "accept_off"],
    fields: {
      what: [
        "onetrust", "cookiebot", "didomi", "quantcast", "trustarc", "usercentrics", "sourcepoint", "cookieyes", "complianz",
        "iubenda", "osano", "termly", "klaro", "consentmanager", "axeptio", "funding_choices", "cookie_notice", "cookieconsent",
        "borlabs", "shopify", "evidon", "just_eat", "tcf", "generic"
      ],
      why: ["only_accept", "none", "stuck", "wall"],
      count: "int"
    }
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

// 2.8 (growth plan, ~/ContextFlow-work/director/growth-plan/events-2.8.md): the test arms an install is in, from its
// first event on: "<test>=<arm>", at most three joined by commas. Names only, never an id.
const VARIANT = /^[a-z0-9_]{1,16}=[a-z0-9_]{1,16}(?:,[a-z0-9_]{1,16}=[a-z0-9_]{1,16}){0,2}$/

/** The client's test variant (client.variant) as an event field, or nothing when it isn't one. */
export function variantFields(client: Record<string, unknown> | null | undefined): { variant?: string } {
  const value = client?.variant
  return typeof value === "string" && VARIANT.test(value) ? { variant: value } : {}
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
