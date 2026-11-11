import { tipClip } from "./tipClips"
import { mediaKinds, type MediaKind } from "../shared/attachments"
import { API_BASE, LINKS, TARGET, VERSION } from "../shared/config"
import { appLink, planOfProduct, ULTRA_DEFAULTS, WATCH_LIMITS, type PaidPlan, type Period } from "../shared/plan"
import { consentStatus } from "../shared/consent"
import { urlKey } from "../shared/conversation"
import { LINK_OPEN_KEY, linkOpen } from "../shared/linkOpen"
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
  type PlanFacts,
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
import { startWatch } from "./watch"
import { nameChatNow, organizeChat, organizeCounts, reportOrganize } from "./organize"
import { organizeConfig } from "../shared/organize"
import { askSimilar, keptSimilar } from "./similar"
import type { SimilarPayload, SimilarStreamEvent } from "../shared/similar"
import { base64 as speechBase64, clearSpeech, serveSpeak, textPartKeys, textVoicedId } from "./speak"
import { withVoiced } from "../shared/voiced"
import { activeLive, follow, jobsOnStart, jobsReady, liveJobIds, markSeen, onJobEnd, setPoller, startJob, stopJob, type JobSpec } from "./jobs"
import { t } from "../shared/i18n"
import type { Job } from "../shared/jobs"

// ---------------------------------------------------------------- identity

async function installId(): Promise<string> {
  const stored = (await chrome.storage.local.get(STORAGE.installId))[STORAGE.installId] as string | undefined
  if (stored) return stored
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ [STORAGE.installId]: id })
  return id
}

let platformKept: Platform | null = null

async function platform(): Promise<Platform> {
  if (platformKept) return platformKept
  const stored = (await chrome.storage.local.get(STORAGE.platform))[STORAGE.platform] as Platform | undefined
  if (stored) return (platformKept = stored)
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

// Read aloud's calls to the app's side (iCloud), one at a time (build 92): if Safari hands native calls over one by
// one, the plan's waits behind at most one short speech call, never a queue of them.
let speechLane: Promise<unknown> = Promise.resolve()
function inSpeechLane<T>(job: () => Promise<T>): Promise<T> {
  const run = speechLane.then(job, job)
  speechLane = run.catch(() => undefined)
  return run
}

// Build 92 (the owner: the panel showed Free and no prices after coming back from the app, until Safari restarted):
// an answer that doesn't come, or comes late, never turns a subscriber into Free. The last good one (kept in the
// extension's storage too, so a fresh background has it at once) stands until it expires while the app's side is
// asked; a failure is asked again in 5 s, not cached for a minute; a re-read waits at most 1.5 s when one is in hand.
let entitlementAsking: Promise<NativeEntitlement | null> | null = null

function askEntitlement(): Promise<NativeEntitlement | null> {
  entitlementAsking ??= (async () => {
    // The install id lets the app link a purchase to this install (StoreKit appAccountToken) and tells it
    // the panel is in use, so it stops showing the setup guide.
    const value = await callNative<NativeEntitlement>("getEntitlement", { installId: await installId() }, 6000)
    // What the app heard to its end on this device (build 94): kept with the panel's own, not with the entitlement.
    if (value && "voiced" in value) {
      const voiced = Array.isArray(value.voiced) ? value.voiced.filter((id): id is string => typeof id === "string") : []
      delete value.voiced
      void keepVoiced(voiced, false)
    }
    if (value) {
      entitlementCache = { at: Date.now(), value }
      void keepEntitlement(value)
      void keepPrices(value.prices)
      return value
    }
    const kept = entitlementCache?.value?.active ? entitlementCache.value : await lastEntitlement()
    entitlementCache = { at: kept ? Date.now() - 55_000 : Date.now(), value: kept }
    return kept
  })().finally(() => {
    entitlementAsking = null
  })
  return entitlementAsking
}

async function entitlement(force = false): Promise<NativeEntitlement | null> {
  if (TARGET !== "safari") return null
  const fresh = entitlementCache && Date.now() - entitlementCache.at < (entitlementCache.value ? 60_000 : 5_000)
  if (fresh && !force) return entitlementCache!.value
  const asking = askEntitlement()
  // A fresh background (Safari started, or its worker woke): the kept one now, the app's answer for the next time.
  if (!entitlementCache) {
    const kept = await lastEntitlement()
    if (kept) return kept
    return asking
  }
  // A re-read with one in hand: the app's answer if it comes within 1.5 s, else the one in hand.
  const inHand = entitlementCache.value
  if (!inHand) return asking
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))
  return (await Promise.race([asking, late])) ?? inHand
}

// Kept for at most a week, and only while the subscription it saw is still running.
const KEEP_ENTITLEMENT_MS = 7 * 86_400_000
let keptJson = ""

async function keepEntitlement(value: NativeEntitlement): Promise<void> {
  const json = JSON.stringify(value)
  // Written only when it changes: a write wakes every tab listening to storage.
  if (json === keptJson) return
  keptJson = json
  await chrome.storage.local.set({ [STORAGE.lastEntitlement]: { value, at: Date.now() } }).catch(() => undefined)
}

// The App Store's prices, kept for the plans sheet when no answer comes (build 92); written only when they change.
let keptPricesJson = ""

async function keepPrices(prices: unknown): Promise<void> {
  if (!prices || typeof prices !== "object" || !Object.keys(prices).length) return
  const json = JSON.stringify(prices)
  if (json === keptPricesJson) return
  keptPricesJson = json
  await chrome.storage.local.set({ [STORAGE.lastPrices]: prices }).catch(() => undefined)
}

// Build 94: the texts heard to their end on this device ("already voiced" by Listen). One writer, one change at a time;
// written only when something new comes. The app is told of the panel's (one native message per text heard to its end).
let voicedLane: Promise<unknown> = Promise.resolve()

function keepVoiced(ids: string[], tellApp: boolean): Promise<void> {
  const run = voicedLane.then(async () => {
    if (!ids.length) return
    const stored = (await chrome.storage.local.get(STORAGE.voiced).catch(() => ({} as Record<string, unknown>)))[STORAGE.voiced]
    const list = stored && typeof stored === "object" ? stored as Record<string, number> : {}
    // Only what's new is written, and told to the app (build 95: the server's answer can name a text marked already).
    const fresh = ids.filter((id) => !list[id])
    if (!fresh.length) return
    await chrome.storage.local.set({ [STORAGE.voiced]: withVoiced(list, fresh) }).catch(() => undefined)
    if (tellApp && TARGET === "safari") await callNative("voiced", { ids: fresh }, 3000)
  })
  voicedLane = run.catch(() => undefined)
  return run.catch(() => undefined)
}

// When each text was last asked about (build 95): a chat shown again soon after asks nothing; a text heard since is told
// of by the heard report itself.
const voicedAsked = new Map<string, number>()
const VOICED_ASK_MS = 10 * 60_000

/** Which of these texts are voiced, as the server counts them: by their parts' keys when they're known here (the same
 *  parts Listen would make), else by the text's id; the voiced ones go into this device's list (the app told). */
async function askVoiced(texts: Array<{ text: string; what: "answer" | "page"; lang: string }>): Promise<void> {
  const now = Date.now()
  const known = (await chrome.storage.local.get(STORAGE.voiced).catch(() => ({} as Record<string, unknown>)))[STORAGE.voiced] as Record<string, number> | undefined
  const asks: Array<{ id: string; keys: string[] }> = []
  for (const item of texts.slice(0, 40)) {
    if (typeof item?.text !== "string" || !item.text.trim()) continue
    const what = item.what === "page" ? "page" : "answer"
    const id = textVoicedId(what, item.text)
    if (known?.[id] || now - (voicedAsked.get(id) ?? 0) < VOICED_ASK_MS || asks.some((a) => a.id === id)) continue
    voicedAsked.set(id, now)
    asks.push({ id, keys: await textPartKeys(item.text, what, String(item.lang ?? "").slice(0, 16)).catch(() => []) })
  }
  if (!asks.length) return
  if (voicedAsked.size > 2000) for (const [id, at] of voicedAsked) if (now - at > VOICED_ASK_MS) voicedAsked.delete(id)
  try {
    const ent = await entitlement()
    if (!ent?.active) return
    const res = await fetch(`${API_BASE}/api/v2/speak-heard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: await installId(), client: await clientInfo(), entitlement: ent.jws, texts: asks })
    })
    if (!res.ok) return
    const body = (await res.json().catch(() => null)) as { voiced?: unknown } | null
    const voiced = Array.isArray(body?.voiced) ? body.voiced.filter((id): id is string => typeof id === "string") : []
    if (voiced.length) await keepVoiced(voiced, true)
  } catch {
    // Offline: asked again next time (after the wait).
  }
}

async function lastEntitlement(): Promise<NativeEntitlement | null> {
  const kept = (await chrome.storage.local.get(STORAGE.lastEntitlement).catch(() => ({} as Record<string, unknown>)))[STORAGE.lastEntitlement] as { value?: NativeEntitlement; at?: number } | undefined
  const value = kept?.value
  if (!value || typeof kept?.at !== "number" || Date.now() - kept.at > KEEP_ENTITLEMENT_MS) return null
  if (value.active && value.expiresAt && Date.parse(value.expiresAt) < Date.now()) return null
  return value
}

function planFromProduct(productId: string | null | undefined): Plan {
  return planOfProduct(productId)
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
        byokOfferShown: ent.byokOfferShown === true || (period !== null && local[STORAGE.byokOfferShown] === period),
        prices: ent.prices && typeof ent.prices === "object" ? ent.prices : {},
        planChange: ent.planChange && typeof ent.planChange.to === "string" && typeof ent.planChange.at === "number"
          ? { from: String(ent.planChange.from ?? "free"), to: ent.planChange.to, productId: String(ent.planChange.productId ?? ""), at: ent.planChange.at }
          : null
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
      limits?: { freeDaily?: number; proWeekly?: number; ultraWeekly?: number; searchFreeDaily?: number; searchProWeekly?: number; speakWeeklySeconds?: number; similarWeekly?: number; watch?: Record<Plan, number> }
      organize?: { on?: unknown; space?: unknown; config?: unknown }
      ultra?: { speak?: Usage | null; similar?: Usage | null } | null
      country?: string
    }
    value = {
      plan: body.plan,
      ...(typeof body.country === "string" && /^[A-Z]{2}$/.test(body.country) ? { country: body.country } : {}), usage: body.usage, limitedBefore: body.limitedBefore === true, offer: body.offer ?? null,
      upgradeOffer: body.upgradeOffer ?? null,
      ultra: body.ultra ? { speak: body.ultra.speak ?? null, similar: body.ultra.similar ?? null } : null,
      plans: planFacts(body.limits),
      searchLimits: { freeDaily: body.limits?.searchFreeDaily ?? SEARCH_LIMITS.freeDaily, proWeekly: body.limits?.searchProWeekly ?? SEARCH_LIMITS.proWeekly },
      store, hasOwnKey: Boolean(key), ownKeyProvider: key ? keyProvider(key) : null, offline: false,
      organize: body.organize && typeof body.organize.space === "string"
        ? { on: body.organize.on === true, space: body.organize.space, config: organizeConfig(body.organize.config) }
        : null
    }
  } catch {
    value = {
      plan: ent?.active ? planFromProduct(ent.productId) : "free", usage: null, limitedBefore: false, offer: null,
      upgradeOffer: null, searchLimits: SEARCH_LIMITS, ultra: null, plans: planFacts(undefined),
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

/** What the plans sheet says about each plan: the server's numbers, these when it can't be reached. */
function planFacts(limits: { freeDaily?: number; proWeekly?: number; ultraWeekly?: number; searchProWeekly?: number; speakWeeklySeconds?: number; similarWeekly?: number; watch?: Record<Plan, number> } | undefined): PlanFacts {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)
  return {
    freeDaily: n(limits?.freeDaily, 5),
    proWeekly: n(limits?.proWeekly, 375),
    ultraWeekly: n(limits?.ultraWeekly, n(limits?.proWeekly, 375)),
    searchProWeekly: n(limits?.searchProWeekly, SEARCH_LIMITS.proWeekly),
    speakWeeklySeconds: n(limits?.speakWeeklySeconds, ULTRA_DEFAULTS.speakWeeklySeconds),
    similarWeekly: n(limits?.similarWeekly, ULTRA_DEFAULTS.similarWeekly),
    watch: { ...WATCH_LIMITS, ...(limits?.watch ?? {}) }
  }
}

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
  if (port.name === "speak") {
    serveSpeak(port, {
      installId,
      client: clientInfo,
      jws: async () => {
        const ent = await entitlement()
        return ent?.active ? ent.jws : null
      },
      // Where a text's minutes went (build 92): heard, from this device, iCloud or the server, and charged up front.
      report: (counts) => void reportUse({ type: "useEvent", f: "listen", a: "heard", ...counts }),
      // Voiced now, as the server counts it (build 95): kept with this device's list, the app told.
      voiced: (ids) => void keepVoiced(ids, true),
      // The user's iCloud through the app's extension (Safari): parts and texts made on their other devices. In their own
      // lane, one at a time and each short (build 92): the plan and the status never wait behind more than one.
      sync: TARGET === "safari" ? {
        getPart: (key, wait) => inSpeechLane(async () => (await callNative<{ aac?: string }>("speechGet", { key, wait: Math.min(wait, 0.8) }, 2500))?.aac ?? null),
        putPart: async (key, pcm, cache) => {
          // In pieces (native messages stay small), each its own turn in the lane: the extension keeps it when the last
          // one is in and replies at once (iCloud comes after).
          const size = 256 * 1024
          for (let at = 0, index = 0; at < pcm.length; at += size, index++) {
            const last = at + size >= pcm.length
            const data = speechBase64(pcm.subarray(at, at + size))
            await inSpeechLane(() => callNative("speechPut", { key, index, last, data, ...(last && cache ? { cache } : {}) }, 5_000))
          }
        },
        getText: (key, wait) => inSpeechLane(async () => (await callNative<{ text?: string }>("speechTextGet", { key, wait: Math.min(wait, 0.8) }, 2500))?.text ?? null),
        putText: (key, text) => inSpeechLane(async () => void (await callNative("speechTextPut", { key, text }, 5_000)))
      } : undefined
    })
    return
  }
  if (port.name === "job") return serveJob(port)
  if (port.name !== "chat") return
  // One question per port: Safari delivers a popup's message twice (two answers, two used from the allowance).
  let asked = false
  port.onMessage.addListener((message: { type: "ask"; payload: AskPayload; job?: JobSpec }) => {
    if (message?.type !== "ask" || asked) return
    asked = true
    const run = (emit: (event: StreamEvent) => void, signal: AbortSignal) =>
      runChat(message.payload, (event) => {
        if (event.type === "done") void countValueMoment().catch(() => undefined)
        emit(event)
      }, signal)
    servePort(port, message.job ? { ...message.job, kind: "chat" } : null, run as Run)
  })
})

type Run = (emit: (event: StreamEvent | SimilarStreamEvent | { type: "kept" }) => void, signal: AbortSignal) => Promise<void>

/**
 * Answers a panel's question on its port. With a job (build 91), the question is the background's: it goes on when the
 * panel goes, and its answer is written into the chat (jobs.ts); the panel's "stop" stops it. Without (a page still
 * running an older panel), as before: the port closing stops it.
 */
function servePort(port: chrome.runtime.Port, spec: JobSpec | null, run: Run): void {
  let seq = 0
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      port.disconnect()
    } catch {
      // already closed
    }
  }
  // Numbered, so a page that gets a message twice can drop the copy.
  const send = (event: Record<string, unknown>) => {
    if (closed) return
    try {
      port.postMessage({ ...event, seq: ++seq })
    } catch {
      closed = true
    }
    if (event.type === "done" || event.type === "error") close()
  }
  if (spec) {
    const unfollow = startJob(spec, run, send)
    port.onDisconnect.addListener(() => {
      closed = true
      unfollow()
    })
    port.onMessage.addListener((message: { type?: string }) => {
      if (message?.type === "stop") {
        stopJob(spec.id)
        close()
      }
    })
    return
  }
  const controller = new AbortController()
  port.onDisconnect.addListener(() => {
    closed = true
    controller.abort()
  })
  run((event) => send(event as unknown as Record<string, unknown>), controller.signal)
    .catch(() => send({ type: "error", code: "STREAM" }))
    .finally(close)
}

/** A panel coming back to a running job ("attach"): what came so far, then the rest; "gone" when none runs here. */
function serveJob(port: chrome.runtime.Port): void {
  let seq = 0
  let unfollow: (() => void) | null = null
  let id = ""
  const send = (event: Record<string, unknown>) => {
    try {
      port.postMessage({ ...event, seq: ++seq })
    } catch {
      unfollow?.()
    }
    if (event.type === "done" || event.type === "error" || event.type === "gone") {
      try {
        port.disconnect()
      } catch {
        // already closed
      }
    }
  }
  port.onDisconnect.addListener(() => unfollow?.())
  port.onMessage.addListener((message: { type?: string; id?: string }) => {
    if (message?.type === "attach" && typeof message.id === "string" && !unfollow && !id) {
      id = message.id
      // After a restart, a Find similar waiting on our server is followed again first (build 94).
      void jobsReady().catch(() => undefined).then(() => {
        unfollow = follow(id, send)
        if (!unfollow) send({ type: "gone" })
      })
    } else if (message?.type === "stop" && id) stopJob(id)
  })
}

// ------------------------------------------------------------ find similar

// "Find similar" (2.6, Ultra): one request per port, like a question; the server checks the plan.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "similar") return
  let asked = false
  port.onMessage.addListener((message: { type: "similar"; payload: SimilarPayload; job?: JobSpec }) => {
    if (message?.type !== "similar" || asked) return
    asked = true
    const run = async (emit: (event: SimilarStreamEvent | { type: "kept" }) => void, signal: AbortSignal) => {
      if (!(await consented())) return emit({ type: "error", code: "CONSENT" })
      const [id, ent, client] = await Promise.all([installId(), entitlement(), clientInfo()])
      // Build 94: as a job of our server's too (the question's id), so it carries on if Safari suspends this background.
      await askSimilar({ installId: id, client, entitlement: ent?.active ? ent.jws : null, payload: message.payload, ...(message.job ? { job: message.job.id } : {}) }, emit, signal)
    }
    servePort(port, message.job ? { ...message.job, kind: "similar", asked: message.payload.condition ?? "", open: message.payload.page?.url ?? "" } : null, run as Run)
  })
})

// ------------------------------------------------- Find similar after leaving Safari (build 94)
// The owner: «Поиск прерывается, если выходишь из Safari, а надо, чтобы шел и приходила нотификация от приложения,
// когда найдено, с переходом прямо к вариантам». Our server finishes the search on its own and keeps the answer;
// this background picks it up when it runs again (jobs.ts). When the person leaves Safari mid-search, the app's
// extension starts a download of that answer which iOS carries on with Safari suspended, and wakes the ContextFlow app
// with it: the app says "found" in a notification, whose tap opens the page with the chat (SimilarAway.swift). Back in
// Safari first, the download is called off: no notification for someone who stayed.

setPoller({
  result: async (id, wait, signal) => keptSimilar(await installId(), id, wait, signal),
  take: async (id) => {
    await keptSimilar(await installId(), id, 0, AbortSignal.timeout(10_000), true)
  }
})

// The Find similar jobs the app watches (a download started for them), and whether Safari is left now.
const watched = new Set<string>()
let leftSafari = false

/** The notification's words, in the person's language: what was asked, and how it ended. */
function notifyTexts(job: Job): Record<string, string> {
  const asked = (job.asked ?? "").trim()
  const lead = asked ? `${asked.slice(0, 80)} — ` : ""
  return {
    title: t("similarNotifyTitle"),
    found: `${lead}${t("similarNotifyFound", "%d")}`,
    none: `${lead}${t("similarNotifyNone")}`,
    failed: `${lead}${t("similarNotifyFailed")}`
  }
}

/** A page went away: the app watches each Find similar still at work (iPhone and iPad; on a Mac nothing is suspended). */
async function similarAway(): Promise<void> {
  if (TARGET !== "safari") return
  leftSafari = true
  const jobs = activeLive().filter((j) => j.kind === "similar" && !watched.has(j.id))
  if (!jobs.length) return
  const install = await installId()
  for (const job of jobs) {
    watched.add(job.id)
    void callNative("similarAway", { job: job.id, thread: job.thread, install, base: API_BASE, open: job.open ?? "", at: job.at, ...notifyTexts(job) }, 3000)
  }
}

/** A page shows again: the app's downloads are called off; the chat a "found" notification asked to open, if any. */
async function similarBack(): Promise<string | null> {
  if (TARGET !== "safari") return null
  leftSafari = false
  const jobs = [...watched]
  watched.clear()
  const r = await callNative<{ open?: string }>("similarBack", { jobs }, 3000)
  return typeof r?.open === "string" && r.open ? r.open : null
}

// A watched job ended here, Safari still left (its background ran on a while): the notification goes now, and the
// app's download is called off. Stopped by the person: only called off.
onJobEnd((job, items) => {
  if (TARGET !== "safari" || job.kind !== "similar" || !watched.delete(job.id)) return
  const outcome = job.code === "STOPPED" ? "" : job.state === "done" ? (items ? "found" : "none") : "failed"
  void callNative("similarEnded", { job: job.id, thread: job.thread, open: job.open ?? "", notify: leftSafari && outcome !== "", outcome, items, ...notifyTexts(job) }, 3000)
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

async function openApp(
  target: "subscribe" | "manage" | "home", feature?: "ai" | "organize" | "listen" | "watch", plan: PaidPlan = "pro", period?: Period
): Promise<{ opened: boolean; url: string }> {
  if (TARGET !== "safari") {
    await chrome.tabs.create({ url: LINKS.appStore })
    return { opened: true, url: LINKS.appStore }
  }
  // 2.6: the plan and period chosen in the panel's plans sheet open preselected in the app.
  const url = appLink(target, feature, plan, period)
  // macOS can launch the app from the extension; on iOS the page has to follow the link.
  const result = await callNative<{ opened?: boolean }>("openApp", { url })
  entitlementCache = null
  statusCache = null
  return { opened: Boolean(result?.opened), url }
}

/**
 * Read aloud on iPhone and iPad (2.6): WebKit stops a page's audio when the screen locks, so the app plays it (with
 * the lock screen's controls). The parts go to the app through the App Group; the page then follows the link.
 */
async function listenInApp(message: Extract<BackgroundRequest, { type: "listenInApp" }>): Promise<{ url: string | null }> {
  if (TARGET !== "safari") return { url: null }
  const reply = await callNative<{ id?: string }>("listen", {
    id: /^[0-9a-f-]{8,64}$/i.test(message.id) ? message.id : "",
    parts: message.parts.slice(0, 80),
    text: message.text.slice(0, 24_000),
    script: message.script === true,
    lang: message.lang.slice(0, 16),
    what: message.what,
    title: message.title.slice(0, 200),
    url: /^https?:\/\//.test(message.url) ? message.url.slice(0, 2000) : ""
  })
  return { url: reply?.id ? `contextflow://listen?id=${encodeURIComponent(reply.id)}` : null }
}

// ---------------------------------------------------------------- reminders (2.5)

/** Sets or cancels a message's reminder on this device, through the app (Safari only). */
async function remind(message: Extract<BackgroundRequest, { type: "remind" }>): Promise<{ outcome: string }> {
  if (TARGET !== "safari") return { outcome: "unavailable" }
  if (message.at === null) {
    await callNative("unremind", { chat: message.chat, message: message.message })
    return { outcome: "cancelled" }
  }
  const reply = await callNative<{ outcome: string }>("remind", {
    chat: message.chat,
    message: message.message,
    at: message.at,
    title: message.title ?? "ContextFlow",
    body: message.body ?? "",
    ...(message.url && /^https?:\/\//.test(message.url) ? { url: message.url } : {}),
    ask: message.ask === true
    // The system may be asking about notifications meanwhile: wait for the answer.
  }, 90_000)
  return { outcome: reply?.outcome ?? "unavailable" }
}

/** A chat UX count (2.5): kind, action and a few words from fixed lists; never text or sites. */
async function reportUx(message: Extract<BackgroundRequest, { type: "uxEvent" }>): Promise<void> {
  const [id, client] = await Promise.all([installId(), clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: message.kind, installId: id, client, action: message.action, what: message.what, how: message.how, preset: message.preset, surface: "panel" })
  }).catch(() => undefined)
}

/** A step for the feature counters ("use", f and a, src/shared/usage.ts): the panel's, named values only. */
async function reportUse(message: Extract<BackgroundRequest, { type: "useEvent" }>): Promise<void> {
  const [id, client] = await Promise.all([installId(), clientInfo()])
  await fetch(`${API_BASE}/api/v2/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "use", installId: id, client, f: message.f, a: message.a, what: message.what, via: message.via, reminders: message.reminders,
      watches: message.watches, plan: message.plan, period: message.period,
      heard_s: message.heard_s, cache_s: message.cache_s, icloud_s: message.icloud_s, server_s: message.server_s, charged_s: message.charged_s,
      cur: message.cur, sf: message.sf,
      // Listen's "unvoiced" (build 95): why it wasn't marked, and how far from the end (build 98: they never left the panel).
      why: message.why, gap_s: message.gap_s, s: "panel"
    })
  }).catch(() => undefined)
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  switch (message?.type) {
    case "tipClip":
      void tipClip(message.name, message.lang).then(sendResponse, () => sendResponse({ ok: false }))
      return true
    case "liveJobs":
      // After a restart, the Find similar searches waiting on our server count once they're followed again (build 94).
      void jobsReady().catch(() => undefined).then(() => sendResponse({ ids: liveJobIds() }))
      return true
    case "similarAway":
      void similarAway().catch(() => undefined)
      sendResponse(true)
      return false
    case "similarBack":
      similarBack().then((open) => sendResponse({ open }), () => sendResponse({ open: null }))
      return true
    case "jobsSeen":
      void markSeen(message.thread).then(() => sendResponse(true), () => sendResponse(false))
      return true
    case "status":
      // The panel just opened: pick up settings changed in the ContextFlow app (never delays the status).
      void syncSettings().catch(() => undefined)
      // The platform only when it changes (build 92: written on every status, it woke every tab's storage listeners).
      ;(message.platform && message.platform !== platformKept ? chrome.storage.local.set({ [STORAGE.platform]: (platformKept = message.platform) }) : Promise.resolve())
        .then(() => status(Boolean(message.refresh), Boolean(message.fresh)))
        .then(sendResponse, () => sendResponse(null))
      return true
    case "openApp":
      openApp(message.target, message.feature, message.plan, message.period).then(sendResponse, () => sendResponse({ opened: false, url: "" }))
      return true
    case "listenInApp":
      listenInApp(message).then(sendResponse, () => sendResponse({ url: null }))
      return true
    case "notifStatus":
      if (TARGET !== "safari") {
        sendResponse({ status: "none" })
        return false
      }
      callNative<{ status?: string; later?: number }>("notifStatus", {}, 3000).then((r) => sendResponse({ status: r?.status ?? "unknown", ...(typeof r?.later === "number" && r.later > Date.now() ? { later: r.later } : {}) }), () => sendResponse({ status: "unknown" }))
      return true
    case "listenHandoff": {
      if (TARGET !== "safari" || !/^[0-9a-f-]{8,64}$/i.test(message.id)) {
        sendResponse({ ok: false })
        return false
      }
      const command = { state: "listenState", away: "listenAway", back: "listenBack", stop: "listenStop" }[message.op]
      callNative<{ taken?: boolean }>(command, {
        id: message.id,
        at: typeof message.at === "number" ? Math.max(0, message.at) : 0,
        ...(message.starts ? { starts: message.starts.slice(0, 80) } : {}),
        ...(message.parts ? { parts: message.parts.slice(0, 80).map((p) => p.slice(0, 4000)), complete: message.complete === true } : {}),
        ...(typeof message.speed === "number" ? { speed: message.speed } : {}),
        ...(message.title ? { title: message.title.slice(0, 200) } : {}),
        ...(message.body ? { body: message.body.slice(0, 200) } : {}),
        ...(message.skipped ? { skipped: true } : {})
      }, 4000).then((r) => sendResponse({ ok: r !== null, taken: r?.taken === true }), () => sendResponse({ ok: false }))
      return true
    }
    case "listenReturn":
      if (TARGET !== "safari" || !/^[0-9a-f-]{8,64}$/i.test(message.id)) {
        sendResponse({ back: false })
        return false
      }
      callNative<{ back?: boolean; play?: boolean; taken?: boolean }>("listenReturn", { id: message.id }, 3000)
        .then((r) => sendResponse({ back: r?.back === true, play: r?.play === true, taken: r?.taken === true }), () => sendResponse({ back: false }))
      return true
    case "voicedAsk":
      // Build 95: a chat's answers, asked about once in a while each (the server keeps a voiced text for good).
      if (TARGET !== "safari" || !Array.isArray(message.texts)) {
        sendResponse({ ok: false })
        return false
      }
      void askVoiced(message.texts)
      sendResponse({ ok: true })
      return false
    case "listenVoiced":
      if (!/^[0-9a-f]{16}$/.test(message.id)) {
        sendResponse({ ok: false })
        return false
      }
      void keepVoiced([message.id], true)
      sendResponse({ ok: true })
      return false
    case "speechClear":
      // "Delete all chats": what was read aloud goes from this device and, in Safari, from the user's iCloud (2.6).
      // The list of texts heard to their end goes with it (build 94; the app's side clears its copy on speechClear).
      if (TARGET === "safari") void callNative("speechClear", {}, 15_000)
      voicedLane = voicedLane.then(() => chrome.storage.local.remove(STORAGE.voiced)).catch(() => undefined)
      clearSpeech().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
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
      openPage(message.url, message.chat, message.at).finally(() => sendResponse({ ok: true }))
      return true
    case "find":
      findChats(message.query, message.chats).then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
      return true
    case "organize":
      // Suggestions send text to the AI: only with the one consent too (it lists them), not the switch alone.
      Promise.all([status(), installId(), entitlement(), clientInfo(), settings(), consented()])
        .then(([now, id, ent, client, prefs, agreed]) => organizeChat(message.chat, { status: now, installId: id, jws: ent?.active ? ent.jws : null, client, on: prefs.organize && agreed }))
        .then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
      return true
    case "organizeName":
      Promise.all([status(), installId(), entitlement(), clientInfo(), settings(), consented()])
        .then(([now, id, ent, client, prefs, agreed]) => nameChatNow(message.chat, { status: now, installId: id, jws: ent?.active ? ent.jws : null, client, on: prefs.organize && agreed }))
        .then(sendResponse, () => sendResponse({ ok: false, code: "NETWORK" }))
      return true
    case "organizeCounts":
      Promise.all([status(), installId(), entitlement(), clientInfo(), settings(), consented()])
        .then(([now, id, ent, client, prefs, agreed]) => organizeCounts({ status: now, installId: id, jws: ent?.active ? ent.jws : null, client, on: prefs.organize && agreed }))
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
    case "remind":
      remind(message).then(sendResponse, () => sendResponse({ outcome: "unavailable" }))
      return true
    case "uxEvent":
      void reportUx(message)
      sendResponse({ ok: true })
      return false
    case "useEvent":
      void reportUse(message)
      sendResponse({ ok: true })
      return false
    case "syncThreads":
      if (TARGET !== "safari") {
        sendResponse({ changed: false })
        return false
      }
      // The app's changes and its "continue this chat" first (not while the panel stays open), then iCloud.
      mirrorThreads(!message.quiet)
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
/**
 * Opens a chat's page: the tab that shows it, else a new one. 2.6 (98): with the chat (and message) the link was in, the
 * page opens with the panel there: a tab that shows it is told at once; a new one takes the note (src/shared/linkOpen.ts).
 */
async function openPage(url: string, chat?: string, at?: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  const key = urlKey(url)
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])
  const open = tabs.filter((t) => t.id !== undefined && t.url && urlKey(t.url) === key)
  const tab = open.find((t) => t.active && t.lastAccessed !== undefined) ?? open.find((t) => t.active) ?? open[0]
  if (!tab?.id) {
    const note = chat ? linkOpen(url, chat, at, Date.now()) : null
    if (note) await chrome.storage.local.set({ [LINK_OPEN_KEY]: note }).catch(() => undefined)
    await chrome.tabs.create({ url })
    return
  }
  await chrome.tabs.update(tab.id, { active: true })
  if (tab.windowId !== undefined) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => undefined)
  if (chat) await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "openChat", chat, ...(at ? { at } : {}) }), 1500).catch(() => undefined)
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
// Questions a previous background was answering were lost with it: their chats say "interrupted" (build 91).
void jobsOnStart().catch(() => undefined)
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
// Page watch (2.5): the checks run here while Safari runs; the AI plans a watch and reads a change.
startWatch({
  installId,
  clientInfo,
  consented,
  plan: async () => {
    const ent = await entitlement()
    return ent?.active ? planFromProduct(ent.productId) : "free"
  }
})
