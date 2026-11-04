// Page watch in the background (2.5): the checks run here, on the person's device, while Safari runs.
// What the tech check found and this follows (page-watch-safari-check.md):
// - the background lives about 30 s after whatever woke it, even mid-fetch: a round stops at 22 s and saves
//   after every page;
// - alarms fire about once a minute while Safari is open, never while it's closed, and don't survive Safari
//   quitting: the alarm is set again on every start, and a start checks what's due right away;
// - its fetch carries none of the site's cookies (with Safari's default "Prevent cross-site tracking"), so
//   a page that won't show its value to it is checked when the person opens it (the live path).
// The AI is asked once to plan a watch, and after that only when a value changed and the person's words
// need reading. The notification is a local one, through the app's extension handler (like reminders).

import { API_BASE, TARGET } from "../shared/config"
import { urlKey } from "../shared/conversation"
import { t } from "../shared/i18n"
import { fallbackRule, sameValue, verdict } from "../shared/watch/compare"
import { readPage, readValue } from "../shared/watch/extract"
import { siteOf, type WatchDraft, type WatchEvent, type WatchPrepared, type WatchRequest, type WatchSpec } from "../shared/watch/messages"
import {
  WATCH_EVERY_MS, WATCH_FAILS_TO_LIVE, WATCH_MAX, WATCH_ROUND_MS, WATCH_STORAGE, type Watch, type WatchKind
} from "../shared/watch/types"
import { callNative } from "./native"

export interface WatchDeps {
  installId: () => Promise<string>
  clientInfo: () => Promise<Record<string, unknown>>
  // The AI only with the person's consent (the same as for answers); without it, the device's own rules.
  consented: () => Promise<boolean>
}

let deps: WatchDeps

const ALARM = "cf-watch"
const FETCH_MS = 12_000
const TEXT_MAX = 20_000

// ------------------------------------------------------------ storage (one writer at a time)

let chain: Promise<unknown> = Promise.resolve()

async function load(): Promise<Watch[]> {
  return ((await chrome.storage.local.get(WATCH_STORAGE.watches))[WATCH_STORAGE.watches] as Watch[] | undefined) ?? []
}

/** Read, change and write the watches; changes queue so a check and a tap in the panel don't undo each other. */
function update<T>(change: (list: Watch[]) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const list = await load()
    const result = await change(list)
    await chrome.storage.local.set({ [WATCH_STORAGE.watches]: list })
    return result
  })
  chain = run.catch(() => undefined)
  return run
}

async function texts(): Promise<Record<string, string>> {
  return ((await chrome.storage.local.get(WATCH_STORAGE.texts))[WATCH_STORAGE.texts] as Record<string, string> | undefined) ?? {}
}

async function keepText(id: string, text: string | null): Promise<void> {
  const all = await texts()
  if (text === null) delete all[id]
  else all[id] = text.slice(0, TEXT_MAX)
  await chrome.storage.local.set({ [WATCH_STORAGE.texts]: all })
}

// ------------------------------------------------------------ the server's AI

async function ask(action: "plan" | "judge", body: Record<string, unknown>): Promise<Record<string, any> | null> {
  if (!(await deps.consented())) return null
  const [installId, client] = await Promise.all([deps.installId(), deps.clientInfo()])
  try {
    const res = await fetch(`${API_BASE}/api/v2/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, installId, client, ...body }),
      signal: AbortSignal.timeout(15_000)
    })
    const data = (await res.json().catch(() => null)) as Record<string, any> | null
    return res.ok && data?.ok ? data : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------ reading a page from here

/** The page as this device's background sees it (no cookies with Safari's defaults); null if it won't load. */
async function fetchPage(url: string): Promise<ReturnType<typeof readPage> | null> {
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) })
    if (!res.ok) return null
    return readPage(await res.text())
  } catch {
    return null
  }
}

// ------------------------------------------------------------ making a watch

/** The plan (the AI, or the device's rules) and a first read by the background: can it check this page? */
async function prepare(draft: WatchDraft): Promise<WatchPrepared & { value: string | null }> {
  const host = hostOf(draft.url)
  const candidates = Object.fromEntries(Object.entries({
    "ld-price": draft.candidates.ldPrice, "ld-stock": draft.candidates.ldStock,
    "meta-price": draft.candidates.metaPrice, "meta-stock": draft.candidates.metaStock
  }).filter(([, v]) => v))
  const [planned, page] = await Promise.all([
    ask("plan", { condition: draft.condition, selection: draft.selection, around: draft.around, title: draft.title, host, candidates }),
    fetchPage(draft.url)
  ])
  const what = (planned?.what ?? draft.what) as WatchKind
  const source = planned?.source ?? (draft.selection ? localSource(draft) : "page")
  const rule = planned?.rule ?? fallbackRule(what, draft.value, draft.condition)
  const value = page ? readValue(page, { source, what, before: draft.before, after: draft.after }) : null
  // A page that answers with a check or an empty shell is "not readable", even with a 200.
  const readable = value !== null && (what !== "page" || (page?.text.length ?? 0) > 200)
  if (!readable) void report({ action: "unreadable", what, site: planned?.site ?? siteOf(host) })
  return {
    ok: true, what, source, rule, label: planned?.label || labelOf(draft), site: planned?.site ?? siteOf(host),
    readable, local: !planned, value: readable ? value : null
  }
}

function localSource(draft: WatchDraft): Watch["source"] {
  const c = draft.candidates
  if (draft.what === "stock" && c.ldStock) return "ld-stock"
  if (draft.what === "stock" && c.metaStock) return "meta-stock"
  return "text"
}

function labelOf(draft: WatchDraft): string {
  const s = draft.selection.replace(/\s+/g, " ").trim()
  return s.length > 40 ? `${s.slice(0, 39)}…` : s || draft.title.slice(0, 40)
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

async function save(draft: WatchDraft, prepared: WatchPrepared & { value?: string | null }, how: "bubble" | "later"): Promise<{ ok: boolean; id?: string; full?: boolean; notify?: string }> {
  const now = Date.now()
  const w: Watch = {
    id: crypto.randomUUID(),
    url: draft.url,
    host: hostOf(draft.url),
    title: draft.title.slice(0, 200),
    what: prepared.what,
    label: prepared.label,
    condition: draft.condition.slice(0, 300),
    source: prepared.source,
    ...(draft.before ? { before: draft.before } : {}),
    ...(draft.after ? { after: draft.after } : {}),
    // What the background read when it could (the next read compares like with like), else the live value.
    value: prepared.value ?? draft.value,
    rule: prepared.rule,
    mode: prepared.readable ? "bg" : "live",
    site: prepared.site,
    createdAt: now,
    checkedAt: now,
    checks: 0,
    failures: 0
  }
  const added = await update((list) => {
    if (list.filter((x) => !x.metAt).length >= WATCH_MAX) return false
    list.push(w)
    return true
  })
  if (!added) return { ok: false, full: true }
  if (w.what === "page" && draft.text) await keepText(w.id, draft.text)
  void report({ action: "set", what: w.what, how, site: w.site, via: w.mode })
  await ensureAlarm()
  void syncApp()
  // Whether "Changed: …" can show here: only the app can ask about notifications the first time.
  const allowed = TARGET === "safari" ? (await callNative<{ outcome?: string }>("watch_permission", {}, 4_000))?.outcome : "ok"
  return { ok: true, id: w.id, notify: allowed ?? "ok" }
}

async function cancel(id: string): Promise<void> {
  const gone = await update((list) => {
    const i = list.findIndex((w) => w.id === id)
    return i >= 0 ? list.splice(i, 1)[0] : null
  })
  if (!gone) return
  await keepText(id, null)
  void report({ action: "cancelled", what: gone.what, site: gone.site })
  void syncApp()
}

// ------------------------------------------------------------ checking

/** One round: the pages that are due, oldest check first, until the round's time is up. */
async function round(): Promise<void> {
  const started = Date.now()
  const due = (await load())
    .filter((w) => !w.metAt && w.mode === "bg" && started - w.checkedAt >= WATCH_EVERY_MS)
    .sort((a, b) => a.checkedAt - b.checkedAt)
  for (const w of due) {
    if (Date.now() - started > WATCH_ROUND_MS) break
    const page = await fetchPage(w.url)
    const value = page ? readValue(page, w) : null
    await settle(w.id, value, "bg", w.what === "page" ? page?.text ?? null : null)
  }
  await dailyCount()
  if (due.length) void syncApp()
}

/** A value just read (by the background or the open page): same, changed, met, or not found. */
async function settle(id: string, value: string | null, via: "bg" | "live", text: string | null): Promise<void> {
  const list = await load()
  const w = list.find((x) => x.id === id)
  if (!w || w.metAt) return
  await tally(via)
  if (value === null) {
    await update((all) => {
      const x = all.find((y) => y.id === id)
      if (!x) return
      x.checkedAt = Date.now()
      x.checks++
      if (via === "bg") x.failures++
      // The background keeps finding nothing: the page is checked when the person opens it.
      if (x.failures >= WATCH_FAILS_TO_LIVE && x.mode === "bg") {
        x.mode = "live"
        void report({ action: "failed", what: x.what, site: x.site, via })
      }
    })
    return
  }
  if (sameValue(w.what, w.value, value)) {
    await update((all) => {
      const x = all.find((y) => y.id === id)
      if (!x) return
      x.checkedAt = Date.now()
      x.checks++
      x.failures = 0
    })
    return
  }
  // Changed. Is it what they asked for?
  void report({ action: "changed", what: w.what, site: w.site, via })
  let before = w.value
  let now = value
  if (w.what === "page" && text !== null) {
    const old = (await texts())[id] ?? ""
    ;({ before, now } = changedText(old, text))
    await keepText(id, text)
  }
  let met = false
  let line = ""
  const decided = verdict(w.rule, w.what, w.value, value)
  if (decided === "ask") {
    const judged = await ask("judge", { condition: w.condition, label: w.label, what: w.what, before, now, title: w.title, host: w.host })
    // No answer (offline, a cap): the old value stays, so the next check asks again.
    if (!judged) {
      await update((all) => {
        const x = all.find((y) => y.id === id)
        if (x) x.checkedAt = Date.now()
      })
      return
    }
    met = judged.met === true
    line = typeof judged.line === "string" ? judged.line : ""
  } else {
    met = decided === "met"
  }
  await update((all) => {
    const x = all.find((y) => y.id === id)
    if (!x) return
    x.value = value
    x.checkedAt = Date.now()
    x.checks++
    x.failures = 0
    if (met) {
      x.metAt = Date.now()
      x.metValue = value
    }
  })
  if (met) await notify(w, value, line)
}

/** For a whole page: the sentences that left and the ones that came (what the AI reads). */
export function changedText(before: string, now: string): { before: string; now: string } {
  const split = (s: string) => s.split(/(?<=[.!?。！？])\s+|\s{2,}|\s[|·•]\s/).map((x) => x.trim()).filter((x) => x.length > 2)
  const a = new Set(split(before))
  const b = new Set(split(now))
  const gone = [...a].filter((x) => !b.has(x)).join(" ")
  const came = [...b].filter((x) => !a.has(x)).join(" ")
  return { before: gone.slice(0, 3000), now: (came || now).slice(0, 3000) }
}

async function notify(w: Watch, value: string, line: string): Promise<void> {
  const label = w.label || w.title || w.host
  void report({ action: "met", what: w.what, site: w.site, via: w.mode })
  if (TARGET !== "safari") return
  await callNative("watch_notify", {
    id: w.id,
    title: t("watchChanged", label),
    body: line || t("watchChangedBody", w.what === "page" ? w.title : value),
    url: w.url
  }, 10_000)
  void syncApp()
}

// ------------------------------------------------------------ the page the person opened

async function forUrl(url: string): Promise<WatchSpec[]> {
  const key = urlKey(url)
  return (await load())
    .filter((w) => !w.metAt && urlKey(w.url) === key)
    .map(({ id, what, source, before, after }) => ({ id, what, source, before, after }))
}

async function live(url: string, values: Record<string, string | null>, text: string | undefined): Promise<void> {
  const key = urlKey(url)
  for (const w of await load()) {
    if (w.metAt || urlKey(w.url) !== key || !(w.id in values)) continue
    await settle(w.id, values[w.id], "live", w.what === "page" ? text ?? null : null)
  }
}

// ------------------------------------------------------------ the list in the app, the counters

/** The app's list ("Reminders") gets this device's watches; a watch stopped in the app comes back here. */
async function syncApp(): Promise<void> {
  if (TARGET !== "safari") return
  const list = await load()
  const reply = await callNative<{ cancelled?: string[] }>("watch_sync", {
    watches: list.map((w) => ({
      id: w.id, title: w.title, url: w.url, label: w.label, condition: w.condition, what: w.what,
      mode: w.mode, checkedAt: w.checkedAt, ...(w.metAt ? { metAt: w.metAt, metValue: w.metValue ?? "" } : {})
    }))
  }, 6_000)
  for (const id of reply?.cancelled ?? []) await cancel(id)
}

async function report(event: WatchEvent): Promise<void> {
  const [installId, client] = await Promise.all([deps.installId(), deps.clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "ux_watch", installId, client, surface: "panel", ...event })
  }).catch(() => undefined)
}

interface Tally { day: string; bg: number; live: number }

async function tally(via: "bg" | "live"): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const cur = ((await chrome.storage.local.get(WATCH_STORAGE.tally))[WATCH_STORAGE.tally] as Tally | undefined) ?? { day, bg: 0, live: 0 }
  cur[via]++
  await chrome.storage.local.set({ [WATCH_STORAGE.tally]: cur })
}

/** Yesterday's checks, once: how many, by the background and by open pages. */
async function dailyCount(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const cur = (await chrome.storage.local.get(WATCH_STORAGE.tally))[WATCH_STORAGE.tally] as Tally | undefined
  if (!cur || cur.day === day) return
  await chrome.storage.local.set({ [WATCH_STORAGE.tally]: { day, bg: 0, live: 0 } })
  if (cur.bg) void report({ action: "checked", via: "bg", n: cur.bg })
  if (cur.live) void report({ action: "checked", via: "live", n: cur.live })
}

// ------------------------------------------------------------ wiring

async function ensureAlarm(): Promise<void> {
  if (!chrome.alarms) return
  const any = (await load()).some((w) => !w.metAt && w.mode === "bg")
  if (!any) {
    await chrome.alarms.clear(ALARM)
    return
  }
  if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: 5 })
}

export function startWatch(d: WatchDeps): void {
  deps = d

  chrome.runtime.onMessage.addListener((message: WatchRequest, _sender, sendResponse) => {
    switch (message?.type) {
      case "watchPrepare":
        prepare(message.draft).then(sendResponse, () => sendResponse({ ok: false }))
        return true
      case "watchSave":
        save(message.draft, message.prepared, message.how).then(sendResponse, () => sendResponse({ ok: false }))
        return true
      case "watchList":
        load().then(sendResponse, () => sendResponse([]))
        return true
      case "watchCancel":
        cancel(message.id).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
        return true
      case "watchForUrl":
        forUrl(message.url).then(sendResponse, () => sendResponse([]))
        return true
      case "watchLive":
        live(message.url, message.values, message.text).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
        return true
      case "watchEvent":
        void report(message.event)
        sendResponse({ ok: true })
        return false
      default:
        return false
    }
  })

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void round().catch(() => undefined)
  })
  // Safari forgets alarms when it quits: set it again on every start, and check what's due now. The app may
  // have stopped some watches meanwhile: its list first.
  chrome.runtime.onStartup?.addListener(() => {
    void syncApp().then(ensureAlarm).then(round).catch(() => undefined)
  })
  chrome.runtime.onInstalled?.addListener(() => void ensureAlarm().catch(() => undefined))
}
