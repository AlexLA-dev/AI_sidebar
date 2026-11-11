import type { Config, Context } from "@netlify/functions"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, type Counter } from "../shared/db.mts"
import { clip, corsHeaders, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { evalCheck, isUltra, resolveAccess, type Access } from "../shared/plan.mts"
import { scriptCost, speakScript, type ScriptStats } from "../shared/speakscript.mts"

/**
 * POST /api/v2/speak-script — read aloud (2.6, Ultra): the text written for the ear (tables, lists, headings, code,
 * symbols and links said the way a person would say them), streamed as plain text so the device can speak the first
 * sentence while the rest is being written. The device cuts it into parts for /api/v2/speak and keeps it.
 *
 * Body: { installId, client, entitlement, text (Markdown for an answer, plain for a page; at most SPEAK_SCRIPT_MAX_CHARS),
 *         what: "answer" | "page", lang?, part?, parts? }
 * Response 200: text/plain, streamed. Errors (JSON {code}): ULTRA_ONLY 403, OFF 503 (the device's rules then), BUSY 503,
 * UPSTREAM 502 (nothing came: the device's rules then), BAD_REQUEST 400. Nothing is kept here; it doesn't count against
 * the minutes (only the speech does).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 80_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const text = (typeof body.text === "string" ? body.text : "").trim()
  if (!text) return json({ code: "BAD_REQUEST", message: "text required" }, 400)
  const what = body.what === "page" ? "page" : "answer"
  const lang = clip(body.lang, 16)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  // Every refusal leaves a line too (build 91: no speak_script events at all, and nothing to tell why).
  const refused = (code: string, status: number, extra: Record<string, unknown> = {}) => {
    context.waitUntil(logEvent("speak_script", installId, { ok: false, error: code, what, chars_in: text.length, platform, version }).catch(() => undefined))
    return json({ code, ...extra }, status)
  }
  if (text.length > settings.speak.scriptMaxChars) return refused("BAD_REQUEST", 400, { message: "text too long", max: settings.speak.scriptMaxChars })

  const check = evalCheck(req, installId, context)
  const access: Access = check.access ?? (await resolveAccess(body.entitlement, installId))
  if (!isUltra(access.plan)) return refused("ULTRA_ONLY", 403, { plan: access.plan, feature: "speak", ...(check.refused ? { eval: check.refused } : {}) })
  if (!settings.speak.scriptEnabled || !settings.anthropicKey) return refused("OFF", 503)

  const counters: Counter[] = [
    { subject: `script:tx:${access.entitlement?.originalTransactionId ?? installId}`, period: "day", limit: settings.speak.scriptDaily },
    { subject: "global:script", period: "day", limit: settings.speak.scriptGlobalDaily }
  ]
  const quota = await consume(counters).catch(() => ({ allowed: true, blocked: null }))
  if (!quota.allowed) return refused("BUSY", 503)

  const started = Date.now()
  const stats: ScriptStats = { model: settings.speak.scriptModel, promptTokens: 0, completionTokens: 0, firstMs: null, chars: 0 }
  const pieces = speakScript(text, what, lang, stats, req.signal)
  let first: IteratorResult<string>
  try {
    first = await pieces.next()
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "unknown"
    console.error("[cf] speak script failed:", message)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message, mode: "speak_script", provider: "anthropic", platform, version })
    ]))
    return json({ code: "UPSTREAM" }, 502)
  }

  let failure: string | null = null
  let finished: () => void = () => undefined
  const done = new Promise<void>((resolve) => (finished = resolve))
  const encoder = new TextEncoder()
  let pending: string | null = first.done ? null : first.value
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pending !== null) {
          controller.enqueue(encoder.encode(pending))
          pending = null
          return
        }
        const next = await pieces.next()
        if (next.done) {
          controller.close()
          finished()
        } else controller.enqueue(encoder.encode(next.value))
      } catch (err) {
        failure = err instanceof Error ? err.message.slice(0, 300) : "stream"
        controller.error(err)
        finished()
      }
    },
    async cancel() {
      failure = failure ?? "cancelled"
      await pieces.return(undefined).catch(() => undefined)
      finished()
    }
  })
  if (first.done) finished()

  context.waitUntil(done.then(() => logEvent("speak_script", installId, {
    ok: failure === null,
    ...(failure ? { error: failure } : {}),
    plan: access.plan,
    provider: "anthropic",
    model: stats.model,
    what,
    part: Number.isInteger(body.part) ? body.part : 0,
    parts: Number.isInteger(body.parts) ? body.parts : 1,
    lang: lang.toLowerCase().split(/[-_]/)[0].slice(0, 8),
    chars_in: text.length,
    chars_out: stats.chars,
    first_ms: stats.firstMs,
    ms: Date.now() - started,
    prompt_tokens: stats.promptTokens,
    completion_tokens: stats.completionTokens,
    cost_usd: scriptCost(stats),
    platform,
    version,
    // Debug and TestFlight builds mark their traffic, which /analytics leaves out.
    ...(client.audience === "test" ? { audience: "test" } : {})
  })))

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  })
}

export const config: Config = { path: "/api/v2/speak-script" }
