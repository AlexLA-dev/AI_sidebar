import { API_BASE, LINKS, PRODUCTS, TARGET, VERSION } from "../shared/config"
import { urlKey } from "../shared/conversation"
import { uiLanguage } from "../shared/i18n"
import { keyProvider, OWN_KEY_PATTERN } from "../shared/models"
import {
  DEFAULT_SETTINGS,
  STORAGE,
  type AskPayload,
  type BackgroundRequest,
  type Plan,
  type Platform,
  type ProOffer,
  type Settings,
  type StatusInfo,
  type StreamEvent,
  type Usage
} from "../shared/types"
import { askServer, askWithOwnKey, reportOwnKeyUsage } from "./chat"
import { callNative, type NativeEntitlement } from "./native"
import { countValueMoment, syncSettings, syncThreads, watchSettings, watchThreads } from "./sync"

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

async function clientInfo() {
  return { version: VERSION, platform: await platform(), locale: uiLanguage() }
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
  const [id, ent, key, client] = await Promise.all([installId(), entitlement(refresh), ownKey(), clientInfo()])
  const store = ent ? { active: ent.active, productId: ent.productId, expiresAt: ent.expiresAt } : null

  let value: StatusInfo
  try {
    const res = await fetch(`${API_BASE}/api/v2/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: id, client, entitlement: ent?.active ? ent.jws : null })
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = (await res.json()) as { plan: Plan; usage: Usage | null; limitedBefore?: boolean; offer?: ProOffer | null }
    value = {
      plan: body.plan, usage: body.usage, limitedBefore: body.limitedBefore === true, offer: body.offer ?? null,
      store, hasOwnKey: Boolean(key), ownKeyProvider: key ? keyProvider(key) : null, offline: false
    }
  } catch {
    value = {
      plan: ent?.active ? planFromProduct(ent.productId) : "free", usage: null, limitedBefore: false, offer: null,
      store, hasOwnKey: Boolean(key), ownKeyProvider: key ? keyProvider(key) : null, offline: true
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

// -------------------------------------------------------------------- chat

async function runChat(payload: AskPayload, emit: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
  const [id, ent, key, prefs, client] = await Promise.all([installId(), entitlement(), ownKey(), settings(), clientInfo()])
  const storePlan = ent?.active ? planFromProduct(ent.productId) : "free"
  // The own-key mode is part of the Pro and "Own key" plans (on Chrome there are no plans).
  const ownKeyAllowed = TARGET === "chrome" || storePlan !== "free"

  // Google answers need Google Search grounding, which only our server has.
  if (key && ownKeyAllowed && payload.mode !== "google") {
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
  port.onMessage.addListener((message: { type: "ask"; payload: AskPayload }) => {
    if (message?.type !== "ask") return
    const emit = (event: StreamEvent) => {
      if (event.type === "done") void countValueMoment().catch(() => undefined)
      try {
        port.postMessage(event)
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

// --------------------------------------------------------------- open app

async function openApp(target: "subscribe" | "manage" | "home"): Promise<{ opened: boolean; url: string }> {
  if (TARGET !== "safari") {
    await chrome.tabs.create({ url: LINKS.appStore })
    return { opened: true, url: LINKS.appStore }
  }
  const url = target === "subscribe" ? "contextflow://subscribe?plan=pro" : target === "manage" ? "contextflow://manage" : "contextflow://open"
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
      openApp(message.target).then(sendResponse, () => sendResponse({ opened: false, url: "" }))
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
    case "syncThreads":
      if (TARGET !== "safari") {
        sendResponse({ changed: false })
        return false
      }
      syncThreads().then((changed) => sendResponse({ changed }), () => sendResponse({ changed: false }))
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

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" })
    return
  } catch {
    // No content script yet (tab opened before the extension was allowed on this site).
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] })
    await chrome.tabs.sendMessage(tab.id, { type: "open" })
  } catch {
    // Browser pages, the start page, App Store pages… cannot be scripted.
    await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?restricted=1") })
  }
}

chrome.action.onClicked.addListener((tab) => {
  void toggle(tab)
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
// Chats follow the user to their other Apple devices through iCloud.
if (TARGET === "safari") watchThreads()
