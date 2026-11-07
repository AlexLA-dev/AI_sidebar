import { timingSafeEqual } from "node:crypto"

import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { buildGrounding, type GoogleStats } from "../shared/google.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson, corsHeaders } from "../shared/http.mts"
import { resolveAccess, type Access } from "../shared/plan.mts"
import { readPrice } from "../shared/pagecheck.mts"
import { MAX_CONDITION, MAX_PAGE_TEXT, runEngineA, similarEvalToken, type EngineStats, type SimilarInput, type SourceFacts } from "../shared/similar.mts"
import { googleCost, startEngineB } from "../shared/similar-google.mts"

/**
 * POST /api/v2/similar — "Find similar" (2.6, Ultra): real alternatives to what the page is about, for any
 * page, with an optional condition in the person's words. Two engines, chosen per request:
 * - "a": ours. Claude Haiku plans the searches, Anthropic's web search finds candidates, our server opens and
 *   checks every page (dead links, soft-404s, the wrong item, price/stock/date against the condition), Claude
 *   Sonnet writes the list from the checked pages only, with our links.
 * - "b": Google. Gemini with Grounding with Google Search, streamed as Gemini wrote it, with its sources and
 *   Google's Search Suggestions (Google's terms: unedited, unmixed, unchecked by us, in its own block).
 *
 * Body: { installId, client: {version, platform, locale, build, audience?}, entitlement, engine: "a" | "b",
 *         page: {title, url, text, facts?: {price?, currency?, stock?, published?, duration?, lang?}}, condition }
 * Response (SSE): {type:"progress", step, …} … then
 *   "a": {type:"result", engine:"a", intro, items:[{name, why, fit, met, url, host, title, source, checked, price?, stock?, date?}], note, condition}
 *   "b": {type:"delta", text} … {type:"grounding", text, grounding:{sources, suggestions, queries}}
 *   and {type:"done", ms, usd} — or {type:"error", code}. Before the stream: {code} with UNAVAILABLE (404: the
 *   engine is off), PRO_ONLY (403), BUSY (503), BAD_REQUEST (400).
 * Production reaches only the engines in SIMILAR_ENGINES (none by default). Off production, the evaluation
 * script (tools/similar/eval.mts) reaches both with its token (see `evaluation`): no plan, no counters,
 * nothing logged, and the run's details (search results, every page's verdict, spend) come with "done".
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)

  const body = await readJson(req, 120_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const evaluating = evaluation(req, context)
  const engine = body.engine === "b" ? "b" : body.engine === "a" ? "a" : null
  if (!engine) return json({ code: "BAD_REQUEST", message: "engine a or b" }, 400)
  if (!evaluating && !settings.similar.engines.includes(engine)) return json({ code: "UNAVAILABLE", engine }, 404)
  if (engine === "a" && !settings.anthropicKey) return json({ code: "UNAVAILABLE", message: "no Anthropic key" }, 503)
  if (engine === "b" && !settings.geminiKey) return json({ code: "UNAVAILABLE", message: "no Gemini key" }, 503)

  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  // The panel's session fields come with the panel's UI (after the owner's choice); test traffic is marked.
  const step = client.audience === "test" ? { audience: "test" } : {}

  const input = readInput(body, locale)
  if (!input) return json({ code: "BAD_REQUEST", message: "page required" }, 400)

  let access: Access | null = null
  let counters: Counter[] = []
  if (!evaluating) {
    access = await resolveAccess(body.entitlement, installId)
    if (!similarAllowed(access)) {
      context.waitUntil(logEvent("pro_only", installId, { feature: "similar", plan: access.plan, platform, version, ...step }))
      return json({ code: "PRO_ONLY", plan: access.plan, feature: "similar" }, 403)
    }
    counters = similarCounters(installId, ipSubject(context.ip))
    let allowed = true
    try {
      allowed = (await consume(counters)).allowed
    } catch (err) {
      console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    }
    if (!allowed) {
      context.waitUntil(logEvent("limit", installId, { reason: "busy", plan: access.plan, platform, version, mode: "similar", ...step }))
      return json({ code: "BUSY" }, 503)
    }
  }

  const started = Date.now()
  const encoder = new TextEncoder()
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
  const statsA: EngineStats = { ms: {}, spend: {}, usd: 0, searches: 0, candidates: 0, checked: 0, kept: 0 }
  const statsB: GoogleStats = { promptTokens: 0, completionTokens: 0, chars: 0, grounding: null }
  let ok = false
  let items = 0
  let model = ""
  let category = ""
  let condition = ""
  let failure = ""
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (engine === "a") {
          for await (const event of runEngineA(input, statsA, { signal: req.signal, debug: evaluating })) {
            if (event.type === "result") {
              items = event.items.length
              condition = event.condition
            }
            send(controller, event)
          }
          category = statsA.plan?.category ?? ""
          ok = true
          send(controller, { type: "done", ms: Date.now() - started, usd: statsA.usd, ...(evaluating ? { stats: statsA } : {}) })
        } else {
          send(controller, { type: "progress", step: "google" })
          const answer = await startEngineB(input, req.signal)
          model = answer.model
          let full = ""
          for await (const text of answer.text(statsB)) {
            full += text
            send(controller, { type: "delta", text })
          }
          ok = statsB.chars > 0
          const grounded = ok ? buildGrounding(full, statsB.grounding) : null
          if (grounded) send(controller, { type: "grounding", ...grounded })
          const usd = googleCost(statsB)
          send(controller, ok
            ? { type: "done", ms: Date.now() - started, usd, ...(evaluating ? { stats: { model, raw: full, promptTokens: statsB.promptTokens, completionTokens: statsB.completionTokens, cut: statsB.cut === true, grounding: statsB.grounding } } : {}) }
            : { type: "error", code: "EMPTY" })
        }
      } catch (err) {
        failure = err instanceof Error ? err.message.slice(0, 300) : "unknown"
        console.error(`[cf] similar ${engine} failed:`, failure)
        try {
          send(controller, { type: "error", code: "UPSTREAM", ...(evaluating ? { message: failure, stats: engine === "a" ? statsA : undefined } : {}) })
        } catch {
          // client already gone
        }
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
        finished()
      }
    }
  })

  if (!evaluating) {
    context.waitUntil(done.then(() => Promise.all([
      ...(ok ? [] : [refund(counters).catch(() => undefined)]),
      logEvent("similar", installId, {
        engine, ok, items, model: engine === "a" ? settings.similar.writeModel : model,
        ...(category ? { category } : {}), ...(condition ? { condition } : {}),
        ...(failure ? { message: failure } : {}),
        cost_usd: engine === "a" ? statsA.usd : googleCost(statsB),
        ...(engine === "a"
          ? { searches: statsA.searches, candidates: statsA.candidates, checked: statsA.checked, kept: statsA.kept, step_ms: statsA.ms }
          : { search_queries: statsB.grounding?.webSearchQueries?.length ?? 0, sources: statsB.grounding?.groundingChunks?.length ?? 0, prompt_tokens: statsB.promptTokens, completion_tokens: statsB.completionTokens }),
        ms: Date.now() - started, plan: access?.plan, platform, version, build, ...step
      }),
      touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
    ])))
  }

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" }
  })
}

function readInput(body: Record<string, unknown>, locale: string): SimilarInput | null {
  const p = (body.page ?? {}) as Record<string, unknown>
  const page = { title: clip(p.title, 300), url: clip(p.url, 2_000), text: clip(p.text, MAX_PAGE_TEXT) }
  if (!page.text.trim() && !page.title.trim()) return null
  const f = (p.facts ?? {}) as Record<string, unknown>
  const facts: SourceFacts = {}
  const price = typeof f.price === "number" ? { amount: f.price, currency: clip(f.currency, 3).toUpperCase() } : readPrice(clip(f.price, 40))
  if (price) facts.price = price
  if (f.stock === "in" || f.stock === "out") facts.stock = f.stock
  if (typeof f.published === "string" && Number.isFinite(Date.parse(f.published))) facts.published = new Date(Date.parse(f.published)).toISOString()
  if (typeof f.duration === "number" && f.duration > 0) facts.duration = f.duration
  if (typeof f.lang === "string") facts.lang = clip(f.lang, 12)
  return { page, facts, condition: clip(body.condition, MAX_CONDITION), locale }
}

/**
 * Who may find similar things. Ultra in 2.6: this switches to the Ultra check the ultra-26 branch adds to
 * plan.mts once it lands; until then, with SIMILAR_ENGINES empty in production, nobody reaches it there.
 */
function similarAllowed(access: Access): boolean {
  return access.plan === "pro"
}

/** Safety caps only (the Ultra allowance is counted with the Ultra plan): per install a day, and for everyone. */
function similarCounters(installId: string, ip: string): Counter[] {
  return [
    { subject: `similar:${installId}`, period: "day", limit: settings.similar.installDaily },
    { subject: `similar:${ip}`, period: "day", limit: settings.similar.installDaily * 3 },
    { subject: "global:similar", period: "day", limit: settings.similar.globalDaily }
  ]
}

/**
 * The evaluation script off production. It runs under `netlify dev:exec`, which hands it the site's
 * environment without showing it: the token is an HMAC of the service key, so nothing new is configured and
 * no secret travels or is printed. Never in production.
 */
function evaluation(req: Request, context: Context): boolean {
  const deploy = (context as { deploy?: { context?: string } }).deploy?.context ?? process.env.CONTEXT
  if (!settings.supabaseServiceKey || !deploy || deploy === "production") return false
  const sent = Buffer.from(req.headers.get("authorization") ?? "")
  const wanted = Buffer.from(`Bearer ${similarEvalToken(settings.supabaseServiceKey)}`)
  return sent.length === wanted.length && timingSafeEqual(sent, wanted)
}

export const config: Config = { path: "/api/v2/similar" }
