import type { Config, Context } from "@netlify/functions"

import { checkItems, validZone } from "../../src/shared/appleItems.ts"
import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { askHaiku, InsertAiError, insertCost, type AiCall } from "../shared/insert.mts"
import { ITEM_TASK, itemMessage, MAX_ITEM_TEXT_CHARS, MAX_ITEM_WORDS_CHARS } from "../shared/items.mts"

/**
 * POST /api/v2/item — Calendar and Reminders (2.7): a reminder or an event read out of a text (Claude Haiku). The
 * device shows a card and writes what the person confirms (EventKit); nothing sent here is stored, the logs get counts.
 *
 * Body: { installId, client: {version, platform, locale, build}, text (an answer or a selection), words (the person's
 *   own request), kind? ("reminder" | "event"), now ("2026-11-14T13:05", the device's wall clock), weekday, tz (IANA),
 *   title (the page's) } → { ok, items: [{kind, title, date?, time?, endDate?, endTime?, tz?, location?, notes?, confidence}] }
 * Free and not counted against answers; a daily safety cap per install stops runaway clients.
 * Errors: {code} with BAD_REQUEST (400), BUSY (503), UPSTREAM (502).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 40_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)

  const text = typeof body.text === "string" ? body.text.slice(0, MAX_ITEM_TEXT_CHARS) : ""
  const words = typeof body.words === "string" ? body.words.slice(0, MAX_ITEM_WORDS_CHARS) : ""
  if (!text.trim() && !words.trim()) return json({ code: "BAD_REQUEST", message: "text or words required" }, 400)
  const kind = body.kind === "event" || body.kind === "reminder" ? body.kind : null
  const now = typeof body.now === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.now) ? body.now : null
  if (!now) return json({ code: "BAD_REQUEST", message: "now required" }, 400)
  const weekday = clip(body.weekday, 12)
  const tz = validZone(body.tz) ? body.tz : "UTC"

  const counters = itemCounters(installId, ipSubject(context.ip))
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  if (!quota.allowed) {
    context.waitUntil(logEvent("limit", installId, { reason: "busy", platform, version, mode: "item" }))
    return json({ code: "BUSY" }, 503)
  }

  const started = Date.now()
  let call: AiCall
  try {
    call = await askHaiku(ITEM_TASK, itemMessage({ text, words, kind, now, weekday, tz, locale, title: clip(body.title, 300) }), req.signal)
  } catch (err) {
    const reason = err instanceof InsertAiError ? err.reason : "error"
    console.error("[cf] item failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: "item", provider: "anthropic", platform, version })
    ]))
    return json({ code: reason === "rate_limit" ? "BUSY" : "UPSTREAM" }, reason === "rate_limit" ? 503 : 502)
  }

  const items = checkItems(call.data, kind ?? undefined)
  context.waitUntil(Promise.all([
    // Counts only: how many of each kind, whether a zone or a guess came with them. Never the text or the titles.
    logEvent("item_ai", installId, {
      asked: kind ?? "any", words: words.trim() ? 1 : 0, items: items.length,
      reminders: items.filter((i) => i.kind === "reminder").length, events: items.filter((i) => i.kind === "event").length,
      zoned: items.filter((i) => i.tz).length, guessed: items.filter((i) => i.confidence === "guess").length,
      model: call.model, prompt_tokens: call.promptTokens, completion_tokens: call.completionTokens, cost_usd: insertCost(call),
      ms: Date.now() - started, platform, version, build
    }),
    touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
  ]))
  return json({ ok: true, items })
}

/** Safety caps only: a day per install, per address and for everyone. */
export function itemCounters(installId: string, ip: string): Counter[] {
  return [
    { subject: `item:${installId}`, period: "day", limit: settings.items.installDaily },
    { subject: `item:${ip}`, period: "day", limit: settings.items.ipDaily },
    { subject: "global:item", period: "day", limit: settings.items.globalDaily }
  ]
}

export const config: Config = { path: "/api/v2/item" }
