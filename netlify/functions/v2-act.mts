import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { ActError, cost, MAX_DATA_CHARS, MAX_REQUEST_CHARS, needsStrong, nextStep, sanitizeLog, sanitizeMap, type Usage } from "../shared/act.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { agentDaily, evalAccess, hasPro, resolveAccess, type Access } from "../shared/plan.mts"
import { hostOf } from "../../src/shared/agent/sites.ts"

/**
 * POST /api/v2/act — the agent's next step (2.8, «Сделай на этой странице»; Pro and Ultra). The device sends the
 * person's request, the page map and the log; the answer is one checked tool call and its class. Nothing sent here is
 * kept, the logs get counts (no addresses, no page words).
 *
 * Body: { installId, client, entitlement, task: { id, request, lang, startHost, step, confirmedHere, token? },
 *         map, log, refused?, data? (what the last extract read) }
 * → { ok, call, verdict: {cls, reason}, target, offRequest?, token (step 0), left (tasks left today), stepsLeft }
 * Errors: {code} with BAD_REQUEST (400), UNAVAILABLE (400: an old build), OFF (503: AGENT=off), PRO_ONLY (402),
 * AGENT_LIMIT (402: the day's tasks), STEP_LIMIT (409: the task's steps), TOKEN (403), BUSY (503), UPSTREAM (502).
 */
export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "POST") return json({ code: "METHOD" }, 405)
  const a = settings.agent
  if (!a.enabled) return json({ code: "OFF" }, 503)

  const body = await readJson(req, 400_000)
  if (!body) return json({ code: "BAD_REQUEST", message: "Invalid JSON" }, 400)
  const installId = body.installId
  if (!isUuid(installId)) return json({ code: "BAD_REQUEST", message: "installId required" }, 400)
  const client = (body.client ?? {}) as Record<string, unknown>
  const platform = clip(client.platform, 20)
  const version = clip(client.version, 20)
  const locale = clip(client.locale, 12)
  const build = clientBuild(client)
  if (settings.claudeMinBuild > 0 && !(Number(build) >= settings.claudeMinBuild)) return json({ code: "UNAVAILABLE", message: "update the app" }, 400)

  const task = (body.task ?? {}) as Record<string, unknown>
  const taskId = task.id
  if (!isUuid(taskId)) return json({ code: "BAD_REQUEST", message: "task.id required" }, 400)
  const request = clip(task.request, MAX_REQUEST_CHARS).trim()
  const step = typeof task.step === "number" && task.step >= 0 ? Math.floor(task.step) : 0
  const map = sanitizeMap(body.map)
  if (!request || !map) return json({ code: "BAD_REQUEST", message: "task.request and map required" }, 400)
  const log = sanitizeLog(body.log)
  const startHost = clip(task.startHost, 200).toLowerCase() || hostOf(map.url)

  // Pro and Ultra only (deploy previews: a request signed with the measuring key counts as Ultra).
  const measuring = evalAccess(req, installId, context)
  const access = measuring ?? (await resolveAccess(body.entitlement, installId))
  if (!hasPro(access.plan)) return json({ code: "PRO_ONLY", plan: access.plan }, 402)
  const otid = access.entitlement!.originalTransactionId

  // Step 0 counts the task against the day's allowance and gives the task a token; later steps show it.
  const token = taskToken(taskId, installId)
  let counters: Counter[] = []
  let left: number | null = null
  if (step === 0) {
    const daily = agentDaily(access.plan, a)
    counters = [{ subject: `agent:tx:${otid}`, period: "day", limit: daily }]
    // The address cap guards real installs; a measuring run (signed, deploy previews only) runs many installs from one Mac.
    if (!measuring) counters.push({ subject: `agent:${ipSubject(context.ip)}`, period: "day", limit: a.ipDaily })
  } else if (!sameToken(clip(task.token, 100), token)) {
    return json({ code: "TOKEN" }, 403)
  }
  counters.push(
    { subject: `agentstep:${taskId}`, period: "day", limit: a.maxSteps },
    { subject: "global:agentstep", period: "day", limit: a.globalDailySteps }
  )
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    quota = { allowed: true, blocked: null, counters: counters.map((c) => ({ ...c, n: 0 })) }
  }
  if (step === 0) {
    const own = quota.counters.find((c) => c.subject === counters[0].subject)
    left = Math.max(0, (counters[0].limit ?? 0) - (own?.n ?? 0))
  }
  const stepsUsed = quota.counters.find((c) => c.subject === `agentstep:${taskId}`)?.n ?? 0
  if (!quota.allowed) {
    const blocked = quota.blocked ?? ""
    context.waitUntil(logEvent("limit", installId, { plan: access.plan, reason: blocked.split(":")[0], platform, version, mode: "agent" }))
    if (blocked.startsWith("agent:tx:")) return json({ code: "AGENT_LIMIT", plan: access.plan, left: 0, limit: counters[0].limit }, 402)
    if (blocked.startsWith("agentstep:")) return json({ code: "STEP_LIMIT", limit: a.maxSteps }, 409)
    return json({ code: "BUSY" }, 503)
  }

  // A step the driver failed twice goes to the stronger model, a few times a task at most.
  const strongUsed = Math.max(0, Number(task.strongUsed) || 0)
  const strong = needsStrong(log) && strongUsed < a.strongSteps
  // Measuring on a deploy preview (signed requests only): the driver may be named, to compare the models.
  const named = measuring && typeof body.model === "string" && (body.model === a.model || body.model === a.strongModel) ? body.model : null
  const model = named ?? (strong ? a.strongModel : a.model)
  const started = Date.now()
  let out
  try {
    out = await nextStep({ request, lang: clip(task.lang, 12), map, log, refused: clip(body.refused, 300) || undefined, data: clip(body.data, MAX_DATA_CHARS) || undefined }, {
      model, startHost, confirmedHere: task.confirmedHere === true, signal: req.signal
    })
  } catch (err) {
    const reason = err instanceof ActError ? err.reason : "error"
    console.error("[cf] act failed:", err instanceof Error ? err.message : err)
    context.waitUntil(Promise.all([
      // A task that never got its first step isn't charged.
      step === 0 ? refund(counters).catch(() => undefined) : Promise.resolve(),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: "agent", provider: "anthropic", platform, version })
    ]))
    return json({ code: reason === "rate_limit" ? "BUSY" : "UPSTREAM" }, reason === "rate_limit" ? 503 : 502)
  }

  const spent = out.usage.reduce((n, u: Usage) => n + cost(u), 0)
  const tokens = out.usage.reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
  context.waitUntil(Promise.all([
    logEvent("agent_step", installId, {
      plan: access.plan, step, tool: out.call.tool, cls: out.verdict.cls, reason: out.verdict.reason, strong, retries: out.retries,
      off_request: !!out.offRequest, items: map.items.length, prompt_tokens: tokens,
      completion_tokens: out.usage.reduce((n, u) => n + u.output, 0), cost_usd: Math.round(spent * 1e6) / 1e6,
      ms: Date.now() - started, platform, version, build
    }),
    touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
  ]))
  return json({
    ok: true,
    call: out.call,
    verdict: out.verdict,
    target: out.target,
    ...(out.offRequest ? { offRequest: out.offRequest } : {}),
    ...(step === 0 ? { token, left } : {}),
    strong,
    stepsLeft: Math.max(0, a.maxSteps - stepsUsed),
    // Measuring only: what the step cost and which model drove it.
    ...(measuring ? { model, cost: Math.round(spent * 1e6) / 1e6, tokens } : {})
  })
}

/** The task's token: proof that its first step was counted (an HMAC of the task and the install). */
export function taskToken(taskId: string, installId: string): string {
  const secret = settings.agent.taskSecret || createHash("sha256").update(`agent-task|${settings.supabaseServiceKey}`).digest("hex")
  return createHmac("sha256", secret).update(`${taskId}|${installId}`).digest("base64url").slice(0, 32)
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export type { Access }

export const config: Config = { path: "/api/v2/act" }
