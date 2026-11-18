import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type ConsumeResult, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { askHaiku, InsertAiError, insertCost, type AiCall } from "../shared/insert.mts"
import { blockReason, countersFor, evalAccess, hasPro, proOffer, resolveAccess, visibleUsage, type Access, type Usage } from "../shared/plan.mts"
import { inviteExtra } from "../shared/invite.mts"
import { checkWrite, readAsk, tooLong, writeMessage, writeTask } from "../shared/writing.mts"
import { clipPage, diffWords, LIVE } from "../../src/shared/writing.ts"
import { sessionFields } from "../../src/shared/usage.ts"

/**
 * POST /api/v2/write — «Проверить» и «Переписать» (2.7, Claude Haiku): the text being written in a field on a site,
 * checked or rewritten with the page in mind (the conversation around the field, or the page) and in the person's own
 * style («О себе», their templates, their earlier messages on that site, which stay on the device otherwise). Nothing
 * sent here is stored; the logs get counts.
 *
 * Body: { installId, client, entitlement, action: "check" | "rewrite", tone? ("short" | "warm" | "formal" |
 *   "confident", a rewrite's), text, page: {title, url, text, conversation}, field, style: {about?, samples, templates} }
 * → { ok, text, plan, usage } (a check's text is the whole corrected text; the device works out the changes).
 * A tap is one answer (the owner's rule): Free's 5 a day or the Pro and Ultra week; given back when nothing came.
 * live: true (a check of one paragraph after a pause in typing, for the underlines): Pro and Ultra only (PRO_ONLY 402
 * otherwise), not counted as an answer, under hidden caps (BUSY when one runs out: the underlines stop for the day).
 * Errors: {code} with LIMIT_REACHED (402, {usage, offer}), TOO_LONG (413), BAD_REQUEST (400), UNAVAILABLE (400: an old
 * build; 503: off), BUSY (503), UPSTREAM (502), SLOW (504: no answer within the device's deadline; the answer is given
 * back, as after any failure).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 120_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const live = body.live === true
  if (typeof body.text === "string" && (live ? body.text.length > LIVE.maxChars : tooLong(body.text))) return json({ code: "TOO_LONG" }, 413)
  const ask = readAsk(body)
  if (!ask || (live && ask.action !== "check")) return json({ code: "BAD_REQUEST", message: "action, text (and a rewrite's tone) required" }, 400)
  // Less of the page for a live check; of a conversation, its end (the message being answered), not its start.
  if (live) {
    ask.page.text = clipPage(ask.page.text, ask.page.conversation, LIVE.pageChars)
    if (ask.page.after) ask.page.after = ask.page.after.slice(0, LIVE.afterChars)
  }
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  const test = client.audience === "test" ? { audience: "test" } : {}
  // Claude answers only builds whose consent screen names it (as for answers).
  if (settings.claudeMinBuild > 0 && !(Number(build) >= settings.claudeMinBuild)) return json({ code: "UNAVAILABLE", message: "update the app" }, 400)
  if (!settings.write.enabled || !settings.anthropicKey) return json({ code: "UNAVAILABLE" }, 503)

  // Deploy previews only: a request signed with the measuring key counts as Ultra (plan.mts evalAccess), so Check and
  // its live underlines can be measured there across languages (2.7 (108), W4) without a purchase.
  const access = evalAccess(req, installId, context) ?? (await resolveAccess(body.entitlement, installId))
  if (live && !(hasPro(access.plan) && access.entitlement)) return json({ code: "PRO_ONLY", plan: access.plan }, 402)
  const counters = live ? liveCounters(access, ipSubject(context.ip)) : writeCounters(access, installId, ipSubject(context.ip), await inviteExtra(client, [installId], access.plan))
  const base = {
    action: ask.action, ...(ask.tone ? { tone: ask.tone } : {}), ...(live ? { live: true } : {}), plan: access.plan, chars_in: ask.text.length,
    page: ask.page.conversation ? "conversation" : ask.page.text.trim() ? "page" : "none", page_chars: ask.page.text.length,
    about: ask.style.about ? 1 : 0, samples: ask.style.samples.length, templates: ask.style.templates.length,
    platform, version, build, ...test, ...sessionFields(body.ui as Record<string, unknown>)
  }

  // One answer and the safety caps, together.
  let charged: Counter[] = []
  let usage: Usage | null = null
  try {
    const result: ConsumeResult = await consume([...counters.answer, ...counters.safety])
    if (!result.allowed) {
      const safety = counters.safety.some((c) => c.subject === result.blocked)
      const reason = safety ? "busy" : blockReason(result.blocked)
      context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason, mode: live ? "write_live" : "write", platform, version, ...test }))
      if (reason === "busy") return json({ code: "BUSY" }, 503)
      return json({ code: "LIMIT_REACHED", plan: access.plan, usage: visibleUsage(access, result.counters), offer: proOffer(access) }, 402)
    }
    charged = [...counters.answer, ...counters.safety]
    usage = visibleUsage(access, result.counters)
  } catch (err) {
    console.error("[cf] write consume failed:", err instanceof Error ? err.message : err)
    // As for answers: the free plan waits for the counters, a subscription isn't locked out by them.
    if (!hasPro(access.plan)) return json({ code: "UNAVAILABLE", message: "Service temporarily unavailable" }, 503)
  }

  const started = Date.now()
  let call: AiCall
  try {
    call = await askHaiku(writeTask(ask.action, ask.text.length, live), writeMessage(ask, locale), req.signal)
  } catch (err) {
    const reason = err instanceof InsertAiError ? err.reason : "error"
    console.error(`[cf] write ${ask.action} failed:`, err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(charged).catch(() => undefined),
      logEvent("write", installId, { ...base, ok: false, error: reason, ms: Date.now() - started }),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: "write", provider: "anthropic", platform, version })
    ]))
    // SLOW (2.7 (107)): the model didn't answer in the time the device waits; the device says so and offers to try again.
    return json({ code: reason === "rate_limit" ? "BUSY" : reason === "timeout" ? "SLOW" : "UPSTREAM" }, reason === "rate_limit" ? 503 : reason === "timeout" ? 504 : 502)
  }

  const text = checkWrite(call.data, ask.text, ask.action)
  if (text === null) {
    context.waitUntil(Promise.all([
      refund(charged).catch(() => undefined),
      logEvent("write", installId, { ...base, ok: false, error: "bad_text", model: call.model, ms: Date.now() - started, prompt_tokens: call.promptTokens, completion_tokens: call.completionTokens, cost_usd: insertCost(call) })
    ]))
    return json({ code: "UPSTREAM" }, 502)
  }

  context.waitUntil(Promise.all([
    logEvent("write", installId, {
      ...base,
      ok: true,
      charged: !live && charged.length > 0,
      chars_out: text.length,
      // A check's changes, counted (never what they are).
      ...(ask.action === "check" ? { edits: diffWords(ask.text, text).length } : {}),
      model: call.model,
      ms: Date.now() - started,
      prompt_tokens: call.promptTokens,
      completion_tokens: call.completionTokens,
      cost_usd: insertCost(call),
      // The subscription that paid for it, as answers carry it.
      ...(access.entitlement ? { otid: access.entitlement.originalTransactionId } : {})
    }),
    // A tap is a request like an answer (the install's last use, its language).
    touchInstall(installId, platform, version, locale, !live && charged.length > 0 ? 1 : 0).catch(() => undefined)
  ]))
  // The plan too (2.7): the card's «left today» is Free's only, and the page can't always tell the plan yet.
  return json({ ok: true, text, plan: access.plan, usage: live ? null : usage })
}

/** Live underlines: no answer, only the hidden caps (the subscription's day, the address's, everyone's). */
export function liveCounters(access: Access, ip: string): { answer: Counter[]; safety: Counter[] } {
  return {
    answer: [],
    safety: [
      { subject: `wlive:tx:${access.entitlement?.originalTransactionId ?? "none"}`, period: "day", limit: settings.write.liveDaily },
      { subject: `wlive${ip}`, period: "day", limit: settings.write.liveIpDaily },
      { subject: "global:wlive", period: "day", limit: settings.write.liveGlobalDaily }
    ]
  }
}

/** One answer (Free's day, or the Pro and Ultra week), and the hidden caps: per owner a day, per address, for everyone. */
export function writeCounters(access: Access, installId: string, ip: string, extra = 0): { answer: Counter[]; safety: Counter[] } {
  const owner = hasPro(access.plan) && access.entitlement ? `tx:${access.entitlement.originalTransactionId}` : `install:${installId}`
  return {
    answer: countersFor(access, installId, ip, extra),
    safety: [
      { subject: `write:${owner}`, period: "day", limit: settings.write.tapDaily },
      { subject: `write${ip}`, period: "day", limit: settings.write.ipDaily },
      { subject: "global:write", period: "day", limit: settings.write.globalDaily }
    ]
  }
}

export const config: Config = { path: "/api/v2/write" }
