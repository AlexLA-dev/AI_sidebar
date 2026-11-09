import type { Config, Context } from "@netlify/functions"
import { createHash } from "node:crypto"

import { config as settings } from "../shared/config.mts"
import { consume, logEvent, peek, refund, touchInstall, type Counter } from "../shared/db.mts"
import { applyHeard, recordPartMade } from "../shared/heard.mts"
import { clip, corsHeaders, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { blockReason, evalCheck, isUltra, resolveAccess, speakCountersFor, speakMadeCountersFor, ultraUsage, type Access } from "../shared/plan.mts"
import { voiceGender, readSpeech, speechCost, startSpeech, type SpeechStats } from "../shared/speak.mts"
import { SPEECH_RATE, speechKind, speechSeconds } from "../../src/shared/speech.ts"

/**
 * POST /api/v2/speak — read aloud (2.6, Ultra): one part of a text, spoken by Gemini TTS, streamed back as it comes.
 *
 * Body: { installId, client: {version, platform, locale}, entitlement: <StoreKit JWS>, text, lang?, what?, part?, parts?,
 *   heard? } — heard: the device's reports of seconds heard, per part key, not yet sent (see /api/v2/speak-heard).
 * - text: plain text (src/shared/speech.ts speechText/speechParts made it), at most TTS_MAX_CHARS characters;
 * - lang: the text's language as the device knows it (the page's, or the answer's), to pick the model;
 * - what: "answer" | "page" (analytics), part/parts: which part of how many.
 * Response 200: audio/L16 (24 kHz, mono, 16-bit little-endian, no header), streamed. Headers: X-CF-Usage (the week's
 * read-aloud seconds heard as JSON), X-CF-Charged (0: nothing is charged for making a part), X-CF-Model,
 * X-CF-Voice-Gender (the voice's, for the device's stand-in voice at a text's start).
 * Errors (JSON {code}): ULTRA_ONLY 403, LIMIT_REACHED 402 (with usage), BUSY 503, OFF 503, UPSTREAM 502, BAD_REQUEST 400.
 *
 * Build 92 (the owner: "30 s heard is 30 s off; the rest is our economy"): the week's minutes count what's heard, as
 * the devices report it (applyHeard, once a part per subscription). Making a part costs the user nothing; it's refused
 * only when the week's heard minutes are used up (with a text's finishing room), or when our own cap on audio made a
 * week per subscription (speakMadeCountersFor, above the allowance) or for the day is reached. That cap is charged before
 * speaking (estimated from the text) and set to the audio's real length when the part ends.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 60_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const text = (typeof body.text === "string" ? body.text : "").replace(/\s+/g, " ").trim()
  if (!text) return json({ code: "BAD_REQUEST", message: "text required" }, 400)
  if (text.length > settings.speak.maxChars) return json({ code: "BAD_REQUEST", message: "text too long", max: settings.speak.maxChars }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const lang = clip(body.lang, 16)
  const what = body.what === "page" ? "page" : body.what === "app" ? "app" : "answer"
  const part = Number.isInteger(body.part) ? Number(body.part) : 0
  const parts = Number.isInteger(body.parts) ? Number(body.parts) : 1

  const check = evalCheck(req, installId, context)
  const evaluated = check.access
  const access = evaluated ?? (await resolveAccess(body.entitlement, installId))
  if (!isUltra(access.plan)) {
    context.waitUntil(logEvent("pro_only", installId, { feature: "speak", plan: access.plan, platform, version }))
    return json({ code: "ULTRA_ONLY", plan: access.plan, feature: "speak", ...(check.refused ? { eval: check.refused } : {}) }, 403)
  }
  if (!settings.geminiKey) return json({ code: "OFF", message: "Read aloud is not available right now." }, 503)

  // Nothing a voice can say (a dash, an emoji, a line of symbols): no sound, no charge. An empty 200 is a part that
  // ends at once on every device (a 502 here made build 89's app hand the rest to Apple's voice).
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return new Response(null, { status: 200, headers: { ...corsHeaders, "Content-Type": `audio/L16; rate=${SPEECH_RATE}; channels=1`, "Cache-Control": "no-store" } })
  }

  // The part's key on the devices (sha256 of "v1|<language>|<text>" as sent): its heard seconds are reported by it.
  const partKey = createHash("sha256").update(`v1|${lang}|${typeof body.text === "string" ? body.text : ""}`).digest("hex")
  // The same part asked for again within the week (a download that broke off, the text heard again after the device's
  // copy went, another of the subscriber's devices): logged as a repeat (it's never the user's minutes either way).
  const otid = access.entitlement?.originalTransactionId ?? installId
  const repeatSubject = `speakrep:${createHash("sha256").update(`${otid}|${lang}|${text}`).digest("hex").slice(0, 32)}`
  let repeat = false
  try {
    repeat = !(await consume([{ subject: repeatSubject, period: "week", limit: 1 }])).allowed
  } catch {
    repeat = false
  }
  // What the device heard and hasn't reported yet (it comes with the next part): counted first, so the week's minutes
  // are up to date.
  if (body.heard) await applyHeard(access, body.heard).catch((err) => console.error("[cf] heard failed:", err instanceof Error ? err.message : err))
  // The week's minutes: what's been heard (read, not charged), with a text's finishing room for its later parts.
  const minutes = speakCountersFor(access, 0, part > 0).filter((c) => c.subject.startsWith("speak:"))
  let heardNow
  try {
    heardNow = await peek(minutes)
  } catch (err) {
    console.error("[cf] peek failed:", err instanceof Error ? err.message : err)
    heardNow = minutes.map((c) => ({ ...c, n: 0 }))
  }
  const usage = ultraUsage(heardNow, "speak:")
  const minutesLeft = (heardNow[0]?.limit ?? Infinity) - (heardNow[0]?.n ?? 0)
  if (minutesLeft <= 0) {
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason: "speak", platform, version, mode: "speak" }))
    return json({ code: "LIMIT_REACHED", plan: access.plan, usage }, 402)
  }
  // Our caps on audio made (the estimate now, the real length when the part ends).
  const charged = speechSeconds(text)
  const counters = speakMadeCountersFor(access, charged)
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: c.amount ?? 0 })) }
  }
  if (!quota.allowed) {
    const reason = blockReason(quota.blocked)
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason: reason === "busy" ? "busy" : "speak_made", platform, version, mode: "speak" }))
    return json({ code: reason === "busy" ? "BUSY" : "LIMIT_REACHED", plan: access.plan, usage }, reason === "busy" ? 503 : 402)
  }

  const kind = speechKind(text, lang || locale, settings.speak.fullLangs)
  const started = Date.now()
  let speech
  try {
    speech = await startSpeech(text, kind, req.signal, clip(body.model, 64))
  } catch (err) {
    console.error("[cf] speak failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      refund(counters).catch(() => undefined),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", mode: "speak", provider: "gemini", platform, version })
    ]))
    return json({ code: "UPSTREAM", message: "Read aloud is busy. Please try again in a moment." }, 502)
  }

  const stats: SpeechStats = { model: speech.model, kind: speech.kind, inputTokens: 0, outputTokens: 0, bytes: 0, firstAudioMs: null }
  let finished: () => void = () => undefined
  const done = new Promise<void>((resolve) => (finished = resolve))
  let failure: string | null = null
  const pieces = readSpeech(speech.body, stats, started)
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await pieces.next()
        if (next.done) {
          controller.close()
          finished()
        } else controller.enqueue(next.value)
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

  // Debug and TestFlight builds mark their traffic, which /analytics leaves out.
  const test = client.audience === "test"
  const info = { started, chars: text.length, lang: (lang || locale).toLowerCase().split(/[-_]/)[0].slice(0, 8), what, part, parts, platform, version, locale, repeat, test, access, partKey }

  // Measuring on a deploy preview (the eval token, report: true): the whole part, then what it took and cost.
  if (evaluated && body.report === true) {
    const reader = stream.getReader()
    let bytes = 0
    while (true) {
      const { done: end, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (end) break
      bytes += value?.length ?? 0
    }
    await settle(access.plan, installId, counters, charged, stats, failure, info)
    return json({ model: stats.model, kind: stats.kind, charged_s: 0, est_s: charged, audio_s: bytes / (SPEECH_RATE * 2), first_audio_ms: stats.firstAudioMs, ms: Date.now() - started, input_tokens: stats.inputTokens, output_tokens: stats.outputTokens, cost: speechCost(stats), failure })
  }

  context.waitUntil(done.then(() => settle(access.plan, installId, counters, charged, stats, failure, info)))

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Access-Control-Expose-Headers": "X-CF-Usage, X-CF-Charged, X-CF-Model, X-CF-Rate, X-CF-Voice-Gender, X-CF-Voice",
      "Content-Type": `audio/L16; rate=${SPEECH_RATE}; channels=1`,
      "Cache-Control": "no-store",
      "X-CF-Usage": JSON.stringify(usage),
      // Nothing of the user's minutes for making a part (build 92: they count what's heard).
      "X-CF-Charged": "0",
      "X-CF-Model": speech.model,
      ...(voiceGender() ? { "X-CF-Voice-Gender": voiceGender() as string } : {}),
      // The voice's name: part of the key a part is kept under on the user's devices and in their iCloud, so a new
      // voice never plays an old recording.
      "X-CF-Voice": settings.speak.voice,
      "X-CF-Rate": String(SPEECH_RATE)
    }
  })
}

/** After the part: the charge becomes the audio's real length (more or less than the estimate), and the log line. */
async function settle(
  plan: string, installId: string, counters: Counter[], charged: number, stats: SpeechStats, failure: string | null,
  info: { started: number; chars: number; lang: string; what: string; part: number; parts: number; platform: string; version: string; locale: string; test: boolean; repeat: boolean; access: Access; partKey: string }
): Promise<void> {
  const seconds = Math.ceil(stats.bytes / (SPEECH_RATE * 2))
  const diff = charged - seconds
  try {
    // Our cap on audio made holds what was really made.
    if (diff > 0) await refund(counters.map((c) => ({ ...c, amount: diff })))
    // Longer than estimated: the rest counts too, never refused halfway.
    else if (diff < 0) await consume(counters.map((c) => ({ ...c, amount: -diff, limit: null })))
    // How long the part is, so its heard seconds can't be reported higher (applyHeard).
    await recordPartMade(info.access, info.partKey, seconds)
  } catch (err) {
    console.error("[cf] speak settle failed:", err instanceof Error ? err.message : err)
  }
  const cost = speechCost(stats)
  await Promise.all([
    logEvent("speak", installId, {
      ok: failure === null,
      ...(failure ? { error: failure } : {}),
      plan,
      provider: "gemini",
      model: stats.model,
      kind: stats.kind,
      what: info.what,
      part: info.part,
      parts: info.parts,
      chars: info.chars,
      lang: info.lang,
      // The user's minutes aren't charged for making a part (build 92); est_s: the estimate our cap took first.
      charged_s: 0,
      est_s: charged,
      ...(info.repeat ? { repeat: true } : {}),
      audio_s: Math.round((stats.bytes / (SPEECH_RATE * 2)) * 10) / 10,
      first_audio_ms: stats.firstAudioMs,
      ms: Date.now() - info.started,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      cost_usd: cost.now,
      cost_usd_2027: cost.from2027,
      platform: info.platform,
      version: info.version,
      ...(info.test ? { audience: "test" } : {})
    }),
    touchInstall(installId, info.platform, info.version, info.locale).catch(() => undefined)
  ])
}

export const config: Config = { path: "/api/v2/speak" }
