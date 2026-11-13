// X App Conversion API: tells X that something happened in the app (an install, the first answer, the first time out
// of free answers, a subscription), so X can credit its ads.
// POST https://ads-api.x.com/12/accounts/<ads account>/measurement/app_conversions, token in X-App-Conversion-Token.
//
// Every conversion needs an identifier X can match with its ad clicks. Apple counts that matching as tracking:
// the app may hand over its IDFA only after the person allowed tracking (ATT), and a device may never be
// recognised by its IP address and user agent ("fingerprinting"), with or without permission. So the server
// sends conversions only with the IDFA of someone who allowed tracking, and never the IP or user agent.
// https://developer.apple.com/app-store/user-privacy-and-data-use/
//
// Only the app can read the IDFA, while the answers and limits happen in the Safari extension and subscriptions
// reach us from Apple. So the server never keeps the IDFA: when the app checks in with it ("app_open", "ads_sync"
// in /api/v2/event), the server looks up in its own records which of that app's conversions X hasn't had yet
// (cf_x_due: the app's own id and its extension's install id), sends them with that IDFA at the times they
// happened, and records only that each was sent ("x_conversion" events, no IDFA), so each goes once.

import { createHash } from "node:crypto"

import { config } from "./config.mts"
import { logEvent, xDue } from "./db.mts"

/** ContextFlow on the App Store. */
export const X_APP_ID = "6759115793"
const X_ADS_ACCOUNT = "18ce55yj09v"
const ENDPOINT = `https://ads-api.x.com/12/accounts/${X_ADS_ACCOUNT}/measurement/app_conversions`
/** X takes up to 500 conversions in one request. */
export const MAX_PER_REQUEST = 500

/**
 * Our name for each conversion (as cf_x_due and the "x_conversion" events name it) and its event in X. INSTALL is
 * X's own; the others are events made in X Events Manager with exactly these names.
 */
export const X_EVENTS = {
  install: "INSTALL",
  first_answer: "FIRST_ANSWER",
  limit: "LIMIT_REACHED",
  subscribe: "SUBSCRIBE"
} as const
export type XEventKey = keyof typeof X_EVENTS

/** How far back a conversion still goes to X: allowing tracking later doesn't send someone's old history. */
export const LOOKBACK_DAYS = 30

export type XIdentifier =
  | { device_id: string }
  | { hashed_email: string }
  | { hashed_phone_number: string }
  | { ip_address: string }
  | { user_agent: string }

export interface XConversion {
  app_id: string
  os_type: "IOS" | "ANDROID"
  event_name: string
  /** Unix time in milliseconds. */
  conversion_timestamp: number
  identifiers: XIdentifier[]
  limit_ad_tracking?: boolean
}

export interface XSendResult {
  /** "conversions_processed" summed over the requests X accepted. */
  processed: number
  /** Conversions in requests X refused or that didn't reach it. */
  failed: number
  /** Why nothing was sent at all. */
  skipped?: "no_token" | "empty"
}

/** The app's ATT answers (ATTrackingManager.AuthorizationStatus), as the app names them. */
export const ATT_STATUSES = new Set(["authorized", "denied", "restricted", "not_determined"])

const IDFA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZERO_IDFA = "00000000-0000-0000-0000-000000000000"

/** A real IDFA: the all-zero one is what iOS hands out when tracking isn't allowed. */
export function isIdfa(value: unknown): value is string {
  return typeof value === "string" && IDFA.test(value) && value !== ZERO_IDFA
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/** SHA-256 of the trimmed, lowercased address; null when it isn't one. */
export function hashEmail(email: string): string | null {
  const clean = email.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? sha256Hex(clean) : null
}

/** "+15551234567" from "+1 (555) 123-4567" or "001 555 123 4567"; null without a country code or with too few digits. */
export function toE164(phone: string): string | null {
  const compact = phone.trim().replace(/[\s().\-]/g, "").replace(/^00/, "+")
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null
}

/** SHA-256 of the number in E.164; null when it can't be put in E.164. */
export function hashPhone(phone: string): string | null {
  const e164 = toE164(phone)
  return e164 ? sha256Hex(e164) : null
}

/**
 * An iOS conversion for X (`name`: one of X_EVENTS), or null when there's nothing X may match it with: only someone
 * who allowed tracking (att "authorized") has an IDFA the app may send.
 */
export function iosEvent(name: string, at: Date, idfa: unknown, att: unknown): XConversion | null {
  if (att !== "authorized" || !isIdfa(idfa)) return null
  return {
    app_id: X_APP_ID,
    os_type: "IOS",
    event_name: name,
    conversion_timestamp: at.getTime(),
    identifiers: [{ device_id: idfa }],
    limit_ad_tracking: false
  }
}

const IOS_PLATFORMS = new Set(["ios", "ipados"])

export interface XCheckIn {
  /** The app's random id, and its extension's install id once the app knows it. */
  app: string
  install: string | null
  /** As the app sent them: its ATT answer and, after "authorized", its IDFA. */
  att: unknown
  idfa: unknown
  platform: string
  /** Debug and TestFlight builds, deploy previews, our own scripts: never sent to X. */
  test: boolean
}

/**
 * At an app's check-in: sends X the app's conversions it hasn't had yet (its install, its first answer, its first
 * time out of free answers, its first subscription), each at the time it happened, with the IDFA the app just sent,
 * and records each as sent (without the IDFA). Nothing for macOS, test traffic, someone who didn't allow tracking,
 * or without the token. The events it sent, by our names.
 */
export async function sendDueConversions(checkIn: XCheckIn, token = config.xAppConversionToken): Promise<XEventKey[]> {
  const { app, install, att, idfa } = checkIn
  if (checkIn.test || !IOS_PLATFORMS.has(checkIn.platform) || att !== "authorized" || !isIdfa(idfa) || !token) return []
  const due = await xDue(app, install, LOOKBACK_DAYS).catch((err: unknown) => {
    console.error("[cf] X conversions due:", err instanceof Error ? err.message : err)
    return []
  })
  const ready = (Array.isArray(due) ? due : [])
    .filter((d): d is { event: XEventKey; at: string } => Object.hasOwn(X_EVENTS, d?.event) && Number.isFinite(Date.parse(d?.at)))
    .map((d) => ({ key: d.event, at: d.at, conversion: iosEvent(X_EVENTS[d.event], new Date(d.at), idfa, att)! }))
  if (!ready.length) return []
  const result = await sendXConversions(ready.map((r) => r.conversion), token)
  // Recorded only when X took the request, so a refused one goes again at the next check-in.
  if (result.failed || result.skipped) return []
  await Promise.all(ready.map((r) => logEvent("x_conversion", install, { app, event: r.key, at: r.at, platform: checkIn.platform })))
  return ready.map((r) => r.key)
}

/** Sends conversions to X, at most 500 per request. Without the token nothing is sent. */
export async function sendXConversions(conversions: XConversion[], token = config.xAppConversionToken): Promise<XSendResult> {
  if (!token) return { processed: 0, failed: 0, skipped: "no_token" }
  if (!conversions.length) return { processed: 0, failed: 0, skipped: "empty" }
  let processed = 0
  let failed = 0
  for (let i = 0; i < conversions.length; i += MAX_PER_REQUEST) {
    const chunk = conversions.slice(i, i + MAX_PER_REQUEST)
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "X-App-Conversion-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ conversions: chunk }),
      signal: AbortSignal.timeout(8000)
    }).catch((err: unknown) => {
      console.error("[cf] X conversions unreachable:", err instanceof Error ? err.message : err)
      return null
    })
    if (!res) {
      failed += chunk.length
      continue
    }
    const body = (await res.json().catch(() => null)) as { data?: { conversions_processed?: number; debug_id?: string } } | null
    if (!res.ok) {
      console.error("[cf] X conversions refused:", res.status, JSON.stringify(body)?.slice(0, 300))
      failed += chunk.length
      continue
    }
    processed += Number(body?.data?.conversions_processed ?? 0)
  }
  return { processed, failed }
}
