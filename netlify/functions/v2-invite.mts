import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent } from "../shared/db.mts"
import { deviceCheckConfigured, deviceStatus, markDevice } from "../shared/devicecheck.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { codeFor, idsOf, linkInstall, readState, redeem, stateOf, takeAnswers, type RedeemResult } from "../shared/invite.mts"
import { resolveAccess } from "../shared/plan.mts"
import { parseInviteCode, type InviteFailure } from "../../src/shared/invite.ts"

/**
 * POST /api/v2/invite — invite a friend (2.7, plan section 5; src/shared/invite.ts). No account and nothing personal:
 * the install's random id, its code, and which code a new install came with.
 * Body: { op, installId: <the extension's install id, or the app's own id before the extension ran>, appId?: <the
 *   app's id, from the app>, client: {version, platform, locale}, entitlement?: <StoreKit JWS> } and
 *   op "state", create?: true — the install's code (made on the first ask), its friends and its reward (InviteState);
 *   op "redeem", code, deviceToken?: <DCDevice token, base64> — a friend's code entered on a new install;
 *   op "link" (the extension, with the appId the app kept) — a code entered in the app now counts for this install;
 *   op "answers" — the inviter takes extra answers for an active friend (only with INVITE_INVITER_ANSWERS=on).
 * Failures: { ok: false, code: InviteFailure } (403 for a code that can't be taken, 429, 503 UNAVAILABLE).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)
  const fail = (code: InviteFailure, status: number) => json({ ok: false, code }, status)
  if (!settings.invite.enabled) return fail("UNAVAILABLE", 404)

  const body = await readJson(req, 50_000)
  if (!body || !isUuid(body.installId)) return fail("BAD_REQUEST", 400)
  const installId = body.installId.toLowerCase()
  const ids = idsOf(installId, typeof body.appId === "string" ? body.appId.toLowerCase() : body.appId, isUuid)
  const client = (body.client ?? {}) as Record<string, unknown>
  const where = { platform: clip(client.platform, 20), version: clip(client.version, 20), s: body.appId ? "app" : "panel" }
  const ip = ipSubject(context.ip)

  try {
    switch (body.op) {
      case "state": {
        const quota = await consume([{ subject: `invstate:${installId}`, period: "day", limit: settings.invite.stateDaily }])
        if (!quota.allowed) return fail("LIMIT_REACHED", 429)
        const made = body.create === true ? await codeFor(ids) : null
        const row = await readState(ids)
        if (body.create === true && !made) return fail("UNAVAILABLE", 503)
        if (row.new_active > 0) context.waitUntil(logEvent("invite_active", installId, { n: row.new_active, ...where }))
        const access = await resolveAccess(body.entitlement, installId)
        const state = stateOf(row, access.plan === "free" || access.plan === "byok" ? settings.proOfferCode : "", settings.proOfferDiscount)
        // A subscriber already has Pro: only Ultra's discount (an upgrade), and none on Ultra.
        if (state.reward && access.plan !== "free" && access.plan !== "byok") {
          if (access.plan === "ultra") state.reward.ultra = null
          if (!state.reward.pro && !state.reward.ultra && !state.reward.answers) state.reward = null
        }
        return json(state)
      }

      case "redeem": {
        const code = parseInviteCode(body.code)
        const quota = await consume([
          { subject: `invtry:${installId}`, period: "day", limit: settings.invite.triesDaily },
          { subject: `invtry:${ip}`, period: "day", limit: settings.invite.triesDaily * 3 }
        ])
        if (!quota.allowed) return fail("LIMIT_REACHED", 429)
        if (!code) return fail("CODE_UNKNOWN", 403)
        // One friend's bonus per device (Apple DeviceCheck), once the key is set; before that, the limits above.
        const token = typeof body.deviceToken === "string" && body.deviceToken.length > 20 && body.deviceToken.length < 10_000 ? body.deviceToken : ""
        let device: Awaited<ReturnType<typeof deviceStatus>> | null = null
        if (deviceCheckConfigured()) {
          if (!token) return fail("DEVICE_CHECK", 403)
          device = await deviceStatus(token)
          if (device.answer === "used") return refused("DEVICE_USED")
          if (device.answer !== "new") return refused("DEVICE_CHECK", device.answer === "error" ? 503 : 403)
        }
        const daily = await consume([{ subject: `invcode:${code}`, period: "day", limit: settings.invite.codeDaily }])
        if (!daily.allowed) return refused("CODE_FULL")
        const until = new Date(Date.now() + settings.invite.friendDays * 86_400_000)
        // From the app before the extension ran, the friend is the app's id; the extension's install is linked later.
        const friend = ids[ids.length - 1]
        const extension = ids.length > 1 ? installId : body.appId ? null : installId
        const result = await redeem(friend, extension, code, device ? "checked" : "unchecked", until)
        context.waitUntil(logEvent("invite_redeem", installId, { result, device: device ? "checked" : "unchecked", ...where }))
        if (result !== "ok") return refused(REDEEM_FAILURE[result])
        if (device?.host) context.waitUntil(markDevice(token, device.host).then((ok) => ok ? undefined : console.error("[cf] devicecheck update failed")))
        return json({ ok: true, until: until.toISOString(), friendDaily: settings.invite.friendDaily, friendDays: settings.invite.friendDays })
      }

      case "link": {
        if (!isUuid(body.appId) || body.appId.toLowerCase() === installId) return fail("BAD_REQUEST", 400)
        const linked = await linkInstall(body.appId.toLowerCase(), installId)
        return json({ ok: true, linked: linked === true })
      }

      case "answers": {
        if (!settings.invite.inviterAnswers) return fail("UNAVAILABLE", 404)
        const taken = await takeAnswers(ids)
        if (taken !== true) return fail("BAD_REQUEST", 409)
        context.waitUntil(logEvent("invite_answers", installId, where))
        const row = await readState(ids)
        return json(stateOf(row, settings.proOfferCode, settings.proOfferDiscount))
      }

      default:
        return fail("BAD_REQUEST", 400)
    }
  } catch (err) {
    // Before the migration (or with the database down): nothing to show, nothing taken.
    console.error("[cf] invite failed:", err instanceof Error ? err.message : err)
    return fail("UNAVAILABLE", 503)
  }

  function refused(code: InviteFailure, status = 403): Response {
    context.waitUntil(logEvent("invite_refused", installId, { code, ...where }))
    return fail(code, status)
  }
}

const REDEEM_FAILURE: Record<Exclude<RedeemResult, "ok">, InviteFailure> = {
  unknown: "CODE_UNKNOWN",
  own: "OWN_CODE",
  already: "ALREADY",
  old: "TOO_LATE",
  full: "CODE_FULL"
}

export const config: Config = { path: "/api/v2/invite" }
