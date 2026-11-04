import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { askHaiku, InsertAiError, insertCost, type AiCall } from "../shared/insert.mts"
import {
  checkJudge, checkPlan, judgeMessage, MAX_AROUND_CHARS, MAX_CHANGE_CHARS, MAX_CONDITION_CHARS, MAX_SELECTION_CHARS,
  MAX_VALUE_CHARS, planMessage, WATCH_TASKS, type WatchAction
} from "../shared/watch.mts"

/**
 * POST /api/v2/watch — page watch's AI (Claude Haiku 5.5), 2.5. Nothing sent here is stored; the logs get counts.
 * The device checks pages itself; this only plans a watch once and, after a change, reads the person's words.
 *
 * Body: { action, installId, client: {version, platform, locale, build}, … }
 * - "plan" { condition, selection, around, title, host, candidates: {source: value} } →
 *   { ok, what, source, rule: {kind, n?, words?}, label, site }
 * - "judge" { condition, label, what, before, now, title, host } → { ok, met, line }
 * Not counted against answers (the owner's choice); a daily safety cap per install stops runaway clients.
 * Errors: {code} with BAD_REQUEST (400), UNAVAILABLE (400: an old build), BUSY (503), UPSTREAM (502).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 40_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const action = body.action as WatchAction
  if (action !== "plan" && action !== "judge") return json({ code: "BAD_REQUEST", message: "unknown action" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  if (settings.claudeMinBuild > 0 && !(Number(build) >= settings.claudeMinBuild)) return json({ code: "UNAVAILABLE", message: "update the app" }, 400)

  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
  const title = clip(body.title, 300)
  const host = clip(body.host, 200)
  const condition = text(body.condition, MAX_CONDITION_CHARS)
  let content: string
  let candidates: Record<string, string> = {}
  let selected = false
  if (action === "plan") {
    const selection = text(body.selection, MAX_SELECTION_CHARS)
    const around = text(body.around, MAX_AROUND_CHARS)
    selected = !!selection.trim()
    const raw = (body.candidates ?? {}) as Record<string, unknown>
    for (const k of ["ld-price", "ld-stock", "meta-price", "meta-stock"]) {
      const v = clip(raw[k], 120)
      if (v) candidates[k] = v
    }
    if (!selected && !condition.trim()) return json({ code: "BAD_REQUEST", message: "selection or condition required" }, 400)
    content = planMessage({ condition, selection, around, title, host, candidates, locale })
  } else {
    // A value is short; a whole page sends what changed in its text.
    const what = clip(body.what, 10)
    const max = what === "page" ? MAX_CHANGE_CHARS : MAX_VALUE_CHARS
    const before = text(body.before, max)
    const now = text(body.now, max)
    if (!now.trim()) return json({ code: "BAD_REQUEST", message: "now required" }, 400)
    content = judgeMessage({ condition, label: clip(body.label, 60), what, before, now, title, host, locale })
  }

  const counters = watchCounters(action, installId, ipSubject(context.ip))
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  if (!quota.allowed) {
    context.waitUntil(logEvent("limit", installId, { reason: "busy", platform, version, mode: `watch_${action}` }))
    return json({ code: "BUSY" }, 503)
  }

  const started = Date.now()
  let call: AiCall
  try {
    call = await askHaiku(WATCH_TASKS[action], content, req.signal)
  } catch (err) {
    const reason = err instanceof InsertAiError ? err.reason : "error"
    console.error(`[cf] watch ${action} failed:`, err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: `watch_${action}`, provider: "anthropic", platform, version })
    ]))
    return json({ code: reason === "rate_limit" ? "BUSY" : "UPSTREAM" }, reason === "rate_limit" ? 503 : 502)
  }

  let reply: Record<string, unknown>
  let counts: Record<string, unknown>
  if (action === "plan") {
    const plan = checkPlan(call.data, candidates, selected)
    reply = { ok: true, ...plan }
    counts = { what: plan.what, source: plan.source, rule: plan.rule.kind, site: plan.site }
  } else {
    const judged = checkJudge(call.data)
    reply = { ok: true, ...judged }
    counts = { met: judged.met }
  }

  context.waitUntil(Promise.all([
    logEvent("watch_ai", installId, {
      action, model: call.model, ...counts,
      prompt_tokens: call.promptTokens, completion_tokens: call.completionTokens, cost_usd: insertCost(call),
      ms: Date.now() - started, platform, version, build
    }),
    touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
  ]))
  return json(reply)
}

/** Safety caps only: plans and judges a day per install, per address and for everyone. */
export function watchCounters(action: WatchAction, installId: string, ip: string): Counter[] {
  return [
    action === "plan"
      ? { subject: `watch:plan:${installId}`, period: "day", limit: settings.watch.planDaily }
      : { subject: `watch:judge:${installId}`, period: "day", limit: settings.watch.judgeDaily },
    { subject: `watch:${ip}`, period: "day", limit: settings.watch.ipDaily },
    { subject: "global:watch", period: "day", limit: settings.watch.globalDaily }
  ]
}

export const config: Config = { path: "/api/v2/watch" }
