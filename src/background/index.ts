import { mediaKinds, type MediaKind } from "../shared/attachments"
import { API_BASE, LINKS, PRODUCTS, TARGET, VERSION } from "../shared/config"
import { consentStatus } from "../shared/consent"
import { urlKey } from "../shared/conversation"
import { uiLanguage } from "../shared/i18n"
import { keyProvider, OWN_KEY_PATTERN } from "../shared/models"
import {
  DEFAULT_SETTINGS,
  STORAGE,
  type AskPayload,
  type BackgroundRequest,
  type ErrorCode,
  type FindReply,
  type Plan,
  type Platform,
  type ProOffer,
  type Settings,
  type StatusInfo,
  type StreamEvent,
  type UpsellWhere,
  type Usage
} from "../shared/types"
import { askServer, askWithOwnKey, reportOwnKeyUsage } from "./chat"
import { callNative, type NativeEntitlement } from "./native"
import { isPdfUrl } from "../shared/pdf"
import { daysLeft, type RenewalReason } from "../shared/renewal"
import { isPdfTab, markPdfTab, openPdfPopup, pdfFromBytes, pdfText } from "./pdf"
import { countValueMoment, mirrorOnStart, mirrorThreads, syncSettings, syncThreads, watchSettings, watchThreads } from "./sync"
import { startInsert } from "./insert"
import { organizeChat, reportOrganize } from "./organize"
import { organizeConfig } from "../shared/organize"

// ---------------------------------------------------------------- identity

async function installId(): Promise<string> {
  const stored = (await chrome.storage.local.get(STORAGE.installId))[STORAGE.installId] as string | undefined
  if (stored) return stored
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ [STORAGE.installId]: id })
  return id
}

async function platform(): Promise<Platform> {
  const stored = (await chrome.storage.local.get(STORAGE.platform))[STORAGE.platform] as Platform | undefined
  if (stored) return stored
  return TARGET === "chrome" ? "chrome" : "other"
}

async function settings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] as Partial<Settings> | undefined
  return { ...DEFAULT_SETTINGS, ...stored }
}

async function ownKey(): Promise<string> {
  return ((await chrome.storage.local.get(STORAGE.ownKey))[STORAGE.ownKey] as string | undefined) ?? ""
}

// The app's build number from the native side: the server answers with Claude only for builds
// whose consent screen names Anthropic (67 and later). Asked once per worker; Chrome has none.
let buildAsk: Promise<string> | null = null

function appBuild(): Promise<string> {
  if (TARGET !== "safari") return Promise.resolve("")
  buildAsk ??= callNative<{ build?: string }>("ping", {}, 1500).then((data) => {
    if (!data?.build) buildAsk = null
    return data?.build ?? ""
  })
  return buildAsk
}

async function clientInfo() {
  const [build, os] = await Promise.all([appBuild(), platform()])
  return { version: VERSION, ...(build ? { build } : {}), platform: os, locale: uiLanguage() }
}

// ---------------------------------------------------- App Store subscription

let entitlementCache: { at: number; value: NativeEntitlement | null } | null = null

async function entitlement(force = false): Promise<NativeEntitlement | null> {
  if (TARGET !== "safari") return null
  if (!force && entitlementCache && Date.now() - entitlementCache.at < 60_000) return entitlementCache.value
  // The install id lets the app link a purchase to this install (StoreKit appAccountToken) and tells it
  // the panel is in use, so it stops showing the setup guide.
  const value = await callNative<NativeEntitlement>("getEntitlement", { installId: await installId() }, 6000)
  entitlementCache = { at: Date.now(), value }
  return value
}

function planFromProduct(productId: string | null | undefined): Plan {
  if (!productId) return "free"
  if ((PRODUCTS.pro as readonly string[]).includes(productId)) return "pro"
  if ((PRODUCTS.byok as readonly string[]).includes(productId)) return "byok"
  return "free"
}

// ------------------------------------------------------------------ status

let statusCache: { at: number; value: StatusInfo } | null = null

// refresh: also re-read the App Store subscription; fresh: skip the 30 s cache (the server counts
// answers from all the user's devices, so the panel asks again whenever it opens).
async function status(refresh = false, fresh = false): Promise<StatusInfo> {
  if (!refresh && !fresh && statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value
  const [id, ent, key, client, local] = await Promise.all([
    installId(), entitlement(refresh), ownKey(), clientInfo(),
    chrome.storage.local.get([STORAGE.byokRefused, STORAGE.byokOfferShown])
  ])
  // The Own key marks: the app's (through the native side) and this device's own, for the same period.
  const period = ent?.period ?? null
  const refused = local[STORAGE.byokRefused] as { period?: string; at?: number } | undefined
  const refusedHere = period && refused?.period === period && typeof refused.at === "number" ? refused.at : null
  const refusedAt = [ent?.byokRefusedAt ?? null, refusedHere].filter((v): v is number => typeof v === "number")
  const store = ent
    ? {
        active: ent.active, productId: ent.productId, expiresAt: ent.expiresAt,
        autoRenew: typeof ent.autoRenew === "boolean" ? ent.autoRenew : null, period, renewalAsked: ent.renewalAsked === true,
        byokRefusedAt: refusedAt.length ? Math.min(...refusedAt) : null,
        byokOfferShown: ent.byokOfferShown === true || (period !== null && local[STORAGE.byokOfferShown] === period)
      }
    : null

  let value: StatusInfo
  try {
    const res = await fetch(`${API_BASE}/api/v2/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: id, client, entitlement: ent?.active ? ent.jws : null })
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = (await res.json()) as {
      plan: Plan; usage: Usage | null; limitedBefore?: boolean; offer?: ProOffer | null; upgradeOffer?: { discount: number } | null
      limits?: { searchFreeDaily?: number; searchProWeekly?: number }
      organize?: { on?: unknown; space?: unknown; config?: unknown }
    }
    value = {
      plan: body.plan, usage: body.usage, limitedBefore: body.limitedBefore === true, offer: body.offer ?? null,
      upgradeOffer: body.upgradeOffer ?? null,
      searchLimits: { freeDaily: body.limits?.searchFreeDaily ?? SEARCH_LIMITS.freeDaily, proWeekly: body.limits?.searchProWeekly ?? SEARCH_LIMITS.proWeekly },
      store, hasOwnKey: Boolean(key), ownKeyProvider: key ? keyProvider(key) : null, offline: false,
      organize: body.organize && typeof body.organize.space === "string"
        ? { on: body.organize.on === true, space: body.organize.space, config: organizeConfig(body.organize.config) }
        : null
    }
  } catch {
    value = {
      plan: ent?.active ? planFromProduct(ent.productId) : "free", usage: null, limitedBefore: false, offer: null,
      upgradeOffer: null, searchLimits: SEARCH_LIMITS,
      store, hasOwnKey: Boolean(key), ownKeyProvider: key ? keyProvider(key) : null, offline: true, organize: null
    }
  }
  statusCache = { at: Date.now(), value }
  return value
}

// ------------------------------------------------------------------ funnel

/** Tells the server once that this install's extension ran, i.e. was switched on in Safari. */
async function reportSwitchedOn(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE.extOnPending)
  if (stored[STORAGE.extOnPending] !== false) return
  const [id, client] = await Promise.all([installId(), clientInfo()])
  const res = await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "ext_on", installId: id, client })
  })
  if (res.ok || res.status === 400) await chrome.storage.local.remove(STORAGE.extOnPending)
}

/** The skipped-video/PDF line: how often free answers meet one, and how often it leads to Pro. */
async function reportMediaNotice(action: "shown" | "pro", media: MediaKind[]): Promise<void> {
  const [id, client] = await Promise.all([installId(), clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: action === "pro" ? "media_notice_pro" : "media_notice", installId: id, client, media: mediaKinds(media.map((kind) => ({ kind }))).join(",") })
  }).catch(() => undefined)
}

// Google search allowances when the server can't be asked (free a day, Pro a week).
const SEARCH_LIMITS = { freeDaily: 3, proWeekly: 50 }

/**
 * An Own key subscriber and Pro. "refused": the first refusal of the period starts the day after which Pro at a
 * discount is offered (kept here and in the app, which offers it too); "shown": the discount card was shown, not
 * again this period; "tap": Upgrade was tapped. The server gets "shown" and "tap" (refusals it logs itself).
 */
async function reportUpsell(action: "refused" | "shown" | "tap", where: UpsellWhere, period: string | null, discount: boolean): Promise<void> {
  if (action === "refused") {
    if (!period) return
    const stored = (await chrome.storage.local.get(STORAGE.byokRefused))[STORAGE.byokRefused] as { period?: string } | undefined
    if (stored?.period === period) return
    const at = Date.now()
    await chrome.storage.local.set({ [STORAGE.byokRefused]: { period, at } })
    await callNative("byokRefused", { period, at })
    statusCache = null
    return
  }
  if (action === "shown" && period) {
    await chrome.storage.local.set({ [STORAGE.byokOfferShown]: period })
    await callNative("byokOfferShown", { period })
    statusCache = null
  }
  const [id, client] = await Promise.all([installId(), clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "byok_upsell", installId: id, client, action, where, from: "panel", ...(discount ? { discount: true } : {}) })
  }).catch(() => undefined)
}

/**
 * The answer to "what was missing" (a Pro user turned auto-renew off): the app marks the period as asked
 * (it won't ask there either), and the answer goes to the server. Nothing is offered.
 */
async function reportRenewal(reason: RenewalReason, period: string, productId: string | null, expiresAt: string | null): Promise<void> {
  await chrome.storage.local.set({ [STORAGE.renewalAsked]: period })
  await callNative("renewalAsked", { period })
  entitlementCache = null
  statusCache = null
  const [id, client] = await Promise.all([installId(), clientInfo()])
  const days = daysLeft(expiresAt)
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "renewal_off", installId: id, client, reason, product: productId ?? "", ...(days === null ? {} : { days_left: days }), from: "panel" })
  }).catch(() => undefined)
}

// -------------------------------------------------------------------- chat

/** Nothing goes to the AI without consent to the current text (the panel asks for it first). */
async function consented(): Promise<boolean> {
  return consentStatus((await chrome.storage.local.get(STORAGE.consent))[STORAGE.consent]) === "ok"
}

async function runChat(payload: AskPayload, emit: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
  if (!(await consented())) return emit({ type: "error", code: "CONSENT" })
  const [id, ent, key, prefs, client] = await Promise.all([installId(), entitlement(), ownKey(), settings(), clientInfo()])
  const storePlan = ent?.active ? planFromProduct(ent.productId) : "free"
  // The own-key mode is part of the Pro and "Own key" plans (on Chrome there are no plans).
  const ownKeyAllowed = TARGET === "chrome" || storePlan !== "free"

  // Google answers need Google Search grounding, and "Ask your chats" is a Pro feature of our server.
  if (key && ownKeyAllowed && payload.mode !== "google" && payload.context !== "history") {
    const started = Date.now()
    const usage = await askWithOwnKey(key, payload, prefs.aboutMe, client.locale, prefs.ownKeyModel, emit, signal)
    reportOwnKeyUsage({ ...usage, ms: Date.now() - started, tier: prefs.ownKeyModel, action: payload.action }, id, client)
    return
  }
  await askServer(
    { installId: id, client, entitlement: ent?.active ? ent.jws : null, profile: prefs.aboutMe, payload },
    (event) => {
      if (event.type === "done" || (event.type === "error" && event.usage)) statusCache = null
      emit(event)
    },
    signal
  )
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return
  const controller = new AbortController()
  port.onDisconnect.addListener(() => controller.abort())
  // One question per port: Safari delivers a popup's message twice (two answers, two used from the allowance).
  let asked = false
  let seq = 0
  port.onMessage.addListener((message: { type: "ask"; payload: AskPayload }) => {
    if (message?.type !== "ask" || asked) return
    asked = true
    const emit = (event: StreamEvent) => {
      if (event.type === "done") void countValueMoment().catch(() => undefined)
      try {
        // Numbered, so a page that gets a message twice can drop the copy.
        port.postMessage({ ...event, seq: ++seq })
      } catch {
        controller.abort()
      }
    }
    runChat(message.payload, emit, controller.signal)
      .catch(() => emit({ type: "error", code: "STREAM" }))
      .finally(() => {
        try {
          port.disconnect()
        } catch {
          // already closed
        }
      })
  })
})

// --------------------------------------------------------------- AI search

/** AI search over the chats (Pro, /api/v2/find): the server checks the plan and charges one answer. */
async function findChats(query: string, chats: unknown[]): Promise<FindReply> {
  if (!(await consented())) return { ok: false, code: "CONSENT" }
  const [id, ent, client] = await Promise.all([installId(), entitlement(), clientInfo()])
  try {
    const res = await fetch(`${API_BASE}/api/v2/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: id, client, entitlement: ent?.active ? ent.jws : null, query, chats }),
      signal: AbortSignal.timeout(45_000)
    })
    const body = (await res.json().catch(() => ({}))) as { results?: Array<{ id: string; why: string }>; usage?: Usage | null; code?: string; offer?: ProOffer | null }
    statusCache = null
    if (res.ok && Array.isArray(body.results)) return { ok: true, results: body.results, usage: body.usage ?? null }
    // An old server doesn't know the endpoint: the feature isn't there yet.
    const code = (body.code ?? (res.status === 404 ? "UNAVAILABLE" : res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST")) as ErrorCode
    return { ok: false, code, usage: body.usage ?? null, offer: body.offer ?? null }
  } catch {
    return { ok: false, code: "NETWORK" }
  }
}

// --------------------------------------------------------------- open app

async function openApp(target: "subscribe" | "manage" | "home", feature?: "ai" | "organize"): Promise<{ opened: boolean; url: string }> {
  if (TARGET !== "safari") {
    await chrome.tabs.create({ url: LINKS.appStore })
    return { opened: true, url: LINKS.appStore }
  }
  const url = target === "subscribe" ? `contextflow://subscribe?plan=pro${feature ? `&feature=${feature}` : ""}` : target === "manage" ? "contextflow://manage" : "contextflow://open"
  // macOS can launch the app from the extension; on iOS the page has to follow the link.
  const result = await callNative<{ opened?: boolean }>("openApp", { url })
  entitlementCache = null
  statusCache = null
  return { opened: Boolean(result?.opened), url }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  switch (message?.type) {
    case "status":
      // The panel just opened: pick up settings changed in the ContextFlow app (never delays the status).
      void syncSettings().catch(() => undefined)
      ;(message.platform ? chrome.storage.local.set({ [STORAGE.platform]: message.platform }) : Promise.resolve())
        .then(() => status(Boolean(message.refresh), Boolean(message.fresh)))
        .then(sendResponse, () => sendResponse(null))
      return true
    case "openApp":
      openApp(message.target, message.feature).then(sendResponse, () => sendResponse({ opened: false, url: "" }))
      return true
    case "mediaNotice":
      void reportMediaNotice(message.action, message.media)
      sendResponse({ ok: true })
      return false
    case "byokUpsell":
      reportUpsell(message.action, message.where, message.period, message.discount === true).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
      return true
    case "renewalAnswer":
      reportRenewal(message.reason, message.period, message.productId, message.expiresAt).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
      return true
    case "setOwnKey": {
      const key = message.key.trim()
      const op = key ? chrome.storage.local.set({ [STORAGE.ownKey]: key }) : chrome.storage.local.remove(STORAGE.ownKey)
      // A different key may see different models.
      op.then(() => chrome.storage.local.remove(STORAGE.ownKeyModels)).then(() => {
        statusCache = null
        sendResponse({ ok: true })
      })
      return true
    }
    case "openUrl":
      if (/^https:\/\//.test(message.url)) chrome.tabs.create({ url: message.url })
      sendResponse({ ok: true })
      return false
    case "openPage":
      openPage(message.url).finally(() => sendResponse({ ok: true }))
      return true
    case "find":
      findChats(message.query, message.chats).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
      return true
    case "organize":
      Promise.all([status(), installId(), entitlement(), clientInfo(), settings()])
        .then(([now, id, ent, client, prefs]) => organizeChat(message.chat, { status: now, installId: id, jws: ent?.active ? ent.jws : null, client, on: prefs.organize }))
        .then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
      return true
    case "organizeEvent":
      Promise.all([installId(), clientInfo()]).then(([id, client]) => reportOrganize(message.event, id, client)).catch(() => undefined)
      sendResponse({ ok: true })
      return false
    case "pdfText":
      pdfText(message.url).then(sendResponse, () => sendResponse({ ok: false, reason: "failed", error: "background" }))
      return true
    case "pdfBytes":
      pdfFromBytes(message.url, message.data).then(sendResponse, () => sendResponse({ ok: false, reason: "failed", error: "background" }))
      return true
    case "syncThreads":
      if (TARGET !== "safari") {
        sendResponse({ changed: false })
        return false
      }
      // The app's changes and its "continue this chat" first, then iCloud.
      mirrorThreads(true)
        .catch(() => null)
        .then(async (open) => ({ open, changed: await syncThreads().catch(() => false) }))
        .then(({ open, changed }) => sendResponse({ changed: changed || Boolean(open), open }), () => sendResponse({ changed: false }))
      return true
    default:
      return false
  }
})

// ------------------------------------------------------- toolbar / shortcut

/** A page of a chat: switches to its tab when it's open (this window first), else opens it in a new tab. */
async function openPage(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  const key = urlKey(url)
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])
  const open = tabs.filter((t) => t.id !== undefined && t.url && urlKey(t.url) === key)
  const tab = open.find((t) => t.active && t.lastAccessed !== undefined) ?? open.find((t) => t.active) ?? open[0]
  if (!tab?.id) {
    await chrome.tabs.create({ url })
    return
  }
  await chrome.tabs.update(tab.id, { active: true })
  if (tab.windowId !== undefined) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => undefined)
}

/** `work`, or a rejection after `ms` (Safari never answers a message sent to a tab showing a PDF). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
}

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return
  // Safari's PDF viewer takes no scripts: ContextFlow opens as a popup about the PDF instead.
  if (TARGET === "safari" && tab.url && isPdfUrl(tab.url)) {
    await openPdfPopup(tab.id)
    return
  }
  try {
    await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "toggle" }), 1500)
    return
  } catch {
    // No content script yet (tab opened before the extension was allowed on this site).
  }
  try {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] }), 3000)
    await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "open" }), 1500)
  } catch {
    // A PDF whose address doesn't say so (arXiv's /pdf/2401.12345).
    if (TARGET === "safari" && (await isPdfTab(tab.url))) {
      await openPdfPopup(tab.id)
      return
    }
    // Browser pages, the start page, App Store pages… cannot be scripted.
    await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restricted=1") })
  }
}

chrome.action.onClicked.addListener((tab) => {
  void toggle(tab)
})

// A tab that goes to a PDF gets the PDF popup on its toolbar button (and loses it when it leaves).
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url === undefined && info.status !== "loading") return
  void markPdfTab(tabId, info.url ?? tab.url)
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined)
})

// Version 1.x (Plasmo) kept Supabase sessions, trial counters and the user's
// OpenAI key under other names. Keep the key, drop everything else.
async function migrateFromV1(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const legacy = Object.keys(all).filter((k) => !k.startsWith("cf:"))
  if (legacy.length === 0) return
  const raw = all.user_api_key
  if (typeof raw === "string" && !all[STORAGE.ownKey]) {
    let key = raw
    try {
      key = JSON.parse(raw) as string
    } catch {
      // stored as a plain string
    }
    if (typeof key === "string" && OWN_KEY_PATTERN.test(key.trim())) {
      await chrome.storage.local.set({ [STORAGE.ownKey]: key.trim() })
    }
  }
  await chrome.storage.local.remove(legacy)
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void installId()
    void chrome.storage.local.set({ [STORAGE.extOnPending]: false }).then(reportSwitchedOn).catch(() => undefined)
    void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") })
  } else if (details.reason === "update") {
    void migrateFromV1().catch(() => undefined)
  }
})

watchSettings()
void syncSettings().catch(() => undefined)
// Offline at install time: try again whenever the background starts.
void reportSwitchedOn().catch(() => undefined)
// Chats follow the user to their other Apple devices through iCloud, and to the ContextFlow app.
if (TARGET === "safari") {
  watchThreads()
  setTimeout(() => void mirrorOnStart().catch(() => undefined), 1_500)
}
// Quick insert: templates with the app and iCloud, its AI and counters, the ⌃⇧V shortcut.
startInsert({
  installId,
  entitlementJws: async () => {
    const ent = await entitlement()
    return ent?.active ? ent.jws : null
  },
  clientInfo,
  consented,
  statusChanged: () => (statusCache = null)
})
