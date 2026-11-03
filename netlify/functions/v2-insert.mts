import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import {
  askClaude, checkFill, checkFind, checkMark, fillMessage, findMessage, InsertAiError, insertCost, markMessage,
  MAX_BLANKS, MAX_FIND_TEMPLATES, MAX_MARK_CHARS, MAX_PAGE_CHARS, type AiCall, type InsertAction
} from "../shared/insert.mts"
import { resolveAccess, type Access } from "../shared/plan.mts"

/**
 * POST /api/v2/insert — quick insert's AI (Claude Haiku 5.5). Nothing sent here is stored; the logs get counts.
 *
 * Body: { action, installId, client: {version, platform, locale, build}, entitlement: <StoreKit JWS> | null, … }
 * - "mark" { text }: the blanks of a new template, a title and words to find it by →
 *   { ok, title, keywords, blanks: [{label, value}] } (each value is in the text exactly).
 * - "fill" { text, blanks, page: {title, url, text}, field }: the blanks from the open page, only when the user
 *   asks → { ok, values: {label: value | null}, left } (null: not sure; left: fills left today on Free).
 * - "find" { query, templates: [{id, title, keywords}] }: templates by meaning → { ok, ids }.
 * Errors: {code} with BAD_REQUEST (400), UNAVAILABLE (400: an old build), FILL_LIMIT (402, Free's daily fills),
 * BUSY (503), UPSTREAM (502).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 300_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const action = body.action as InsertAction
  if (action !== "mark" && action !== "fill" && action !== "find") return json({ code: "BAD_REQUEST", message: "unknown action" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  // Claude answers only builds whose consent screen names it (as for answers).
  if (settings.claudeMinBuild > 0 && !(Number(build) >= settings.claudeMinBuild)) return json({ code: "UNAVAILABLE", message: "update the app" }, 400)

  // Everything is checked before anything is charged.
  let content: string
  let blanks: string[] = []
  let ids = new Set<string>()
  let markText = ""
  if (action === "mark") {
    markText = typeof body.text === "string" ? body.text.slice(0, MAX_MARK_CHARS) : ""
    if (!markText.trim()) return json({ code: "BAD_REQUEST", message: "text required" }, 400)
    content = markMessage({ text: markText, locale })
  } else if (action === "fill") {
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_MARK_CHARS) : ""
    blanks = (Array.isArray(body.blanks) ? body.blanks : []).map((b) => clip(b, 40).trim()).filter(Boolean).slice(0, MAX_BLANKS)
    const page = (body.page ?? {}) as Record<string, unknown>
    const pageText = typeof page.text === "string" ? page.text.slice(0, MAX_PAGE_CHARS) : ""
    if (!text.trim() || !blanks.length || !pageText.trim()) return json({ code: "BAD_REQUEST", message: "text, blanks and page required" }, 400)
    content = fillMessage({
      text, blanks, locale, field: clip(body.field, 200),
      page: { title: clip(page.title, 300), url: clip(page.url, 2000), text: pageText },
      today: new Date().toISOString().slice(0, 10)
    })
  } else {
    const query = clip(body.query, 300).trim()
    const templates = (Array.isArray(body.templates) ? body.templates : []).slice(0, MAX_FIND_TEMPLATES).map((t) => {
      const r = (t ?? {}) as Record<string, unknown>
      return { id: clip(r.id, 64), title: clip(r.title, 80), keywords: (Array.isArray(r.keywords) ? r.keywords : []).map((k) => clip(k, 30)).slice(0, 6) }
    }).filter((t) => t.id && t.title)
    if (!query || !templates.length) return json({ code: "BAD_REQUEST", message: "query and templates required" }, 400)
    ids = new Set(templates.map((t) => t.id))
    content = findMessage({ query, templates, locale })
  }

  const access = await resolveAccess(body.entitlement, installId)
  const counters = insertCounters(action, access, installId, ipSubject(context.ip))
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  const own = quota.counters.find((c) => c.subject === counters[0].subject)
  const left = action === "fill" && access.plan === "free" ? Math.max(0, settings.insert.fillFreeDaily - (own?.n ?? 0)) : null
  if (!quota.allowed) {
    const busy = quota.blocked?.startsWith("global:") || quota.blocked?.startsWith("ip:")
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason: busy ? "busy" : "fill", platform, version, mode: `insert_${action}` }))
    if (!busy && action === "fill" && access.plan === "free") return json({ code: "FILL_LIMIT", plan: access.plan, left: 0 }, 402)
    return json({ code: "BUSY" }, 503)
  }

  const started = Date.now()
  let call: AiCall
  try {
    call = await askClaude(action, content, req.signal)
  } catch (err) {
    const reason = err instanceof InsertAiError ? err.reason : "error"
    console.error(`[cf] insert ${action} failed:`, err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: `insert_${action}`, provider: "anthropic", platform, version })
    ]))
    return json({ code: reason === "rate_limit" ? "BUSY" : "UPSTREAM" }, reason === "rate_limit" ? 503 : 502)
  }

  let reply: Record<string, unknown>
  let counts: Record<string, number>
  if (action === "mark") {
    const marked = checkMark(call.data, markText)
    reply = { ok: true, ...marked }
    counts = { blanks: marked.blanks.length }
  } else if (action === "fill") {
    const values = checkFill(call.data, blanks)
    reply = { ok: true, values, left }
    counts = { blanks: blanks.length, found: Object.values(values).filter((v) => v !== null).length }
  } else {
    const found = checkFind(call.data, ids)
    reply = { ok: true, ids: found }
    counts = { templates: ids.size, found: found.length }
  }

  context.waitUntil(Promise.all([
    logEvent("insert_ai", installId, {
      action, plan: access.plan, model: call.model, ...counts,
      prompt_tokens: call.promptTokens, completion_tokens: call.completionTokens, cost_usd: insertCost(call),
      ms: Date.now() - started, platform, version, build
    }),
    touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
  ]))
  return json(reply)
}

/**
 * What a request is charged against. Free fills: the owner's daily allowance, kept apart from the answers.
 * Paid fills, marks and searches: only the safety caps. The first counter is the caller's own.
 */
export function insertCounters(action: InsertAction, access: Access, installId: string, ip: string): Counter[] {
  const paid = access.entitlement && access.plan !== "free" ? `tx:${access.entitlement.originalTransactionId}` : null
  const own: Counter = action !== "fill"
    ? { subject: `insert:install:${installId}`, period: "day", limit: settings.insert.markDaily }
    : paid
      ? { subject: `fill:${paid}`, period: "day", limit: settings.insert.fillPaidDaily }
      : { subject: `fill:install:${installId}`, period: "day", limit: settings.insert.fillFreeDaily }
  return [
    own,
    { subject: `insert:${ip}`, period: "day", limit: settings.insert.ipDaily },
    { subject: "global:insert", period: "day", limit: settings.insert.globalDaily }
  ]
}

export const config: Config = { path: "/api/v2/insert" }
