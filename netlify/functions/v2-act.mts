import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import type { Config, Context } from "@netlify/functions"

import { clientBuild } from "../shared/answer.mts"
import { ActError, cost, MAX_DATA_CHARS, MAX_REQUEST_CHARS, needsStrong, nextStep, planTask, sanitizeLog, sanitizeMap, type Usage } from "../shared/act.mts"
import { config as settings } from "../shared/config.mts"
import { consume, logEvent, refund, touchInstall, type Counter } from "../shared/db.mts"
import { clip, ipSubject, isUuid, json, preflight, readJson } from "../shared/http.mts"
import { agentDaily, evalAccess, hasPro, resolveAccess, stepCap, type Access } from "../shared/plan.mts"
import { requestLanguage } from "../../src/shared/agent/lang.ts"
import { hostOf } from "../../src/shared/agent/sites.ts"

/**
 * POST /api/v2/act — the agent's next step (2.7.1, «Сделай на этой странице»; Pro and Ultra). The device sends the
 * person's request, the page map and the log; the answer is one checked tool call and its class. Nothing sent here is
 * kept, the logs get counts (no addresses, no page words).
 *
 * Body: { installId, client, entitlement, task: { id, request, lang, startHost, step, confirmedHere, token?, phase?, plan? },
 *         map, log, refused?, data? (what the last extract read), keys? (saved details' names, never values) }
 * → { ok, call, verdict: {cls, reason}, target, offRequest?, token (step 0), left (tasks left today), stepsLeft }
 * task.phase "plan" (step 0 only): → { ok, plan: { steps, questions, risky, prices }, token, left } — the plan card's
 * makings (the device classes the foreseen steps itself). task.plan: the approved plan's lines, for the model and the check.
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
  // The task's step cap: the configured one; a measuring request (the same gate as the named driver below) may ask for
  // up to 60, to measure whether the cap is the limit. Only the step count reads it.
  const maxSteps = stepCap(measuring, body.maxSteps, a.maxSteps)
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
    { subject: `agentstep:${taskId}`, period: "day", limit: maxSteps },
    { subject: "global:agentstep", period: "day", limit: a.globalDailySteps }
  )
  let quota
  try {
    quota = await consume(counters)
  } catch (err) {
    // The counters can't be read: the agent waits rather than acting uncounted (2.7.1, the security review: it went on
    // unlimited before). The panel says it's busy; the person tries again.
    console.error("[cf] consume failed:", err instanceof Error ? err.message : err)
    return json({ code: "BUSY" }, 503)
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
    if (blocked.startsWith("agentstep:")) return json({ code: "STEP_LIMIT", limit: maxSteps }, 409)
    return json({ code: "BUSY" }, 503)
  }

  // A step the driver failed twice goes to the stronger model, a few times a task at most.
  const strongUsed = Math.max(0, Number(task.strongUsed) || 0)
  const strong = needsStrong(log) && strongUsed < a.strongSteps
  // Measuring on a deploy preview (signed requests only): the driver may be named, to compare the models.
  const named = measuring && typeof body.model === "string" && (body.model === a.model || body.model === a.strongModel) ? body.model : null
  const model = named ?? (strong ? a.strongModel : a.model)
  const started = Date.now()
  const lang = requestLanguage(request, clip(task.lang, 12) || "en")
  const planning = task.phase === "plan" && step === 0
  const input = { request, lang, map, log, refused: clip(body.refused, 300) || undefined, data: clip(body.data, MAX_DATA_CHARS) || undefined, keys: savedKeys(body.keys), now: clip(task.now, 60) || undefined, device: deviceLine(task.device), plan: clip(task.plan, 2000) || undefined, rules: clip(task.rules, 600) || undefined, calendar: calendarLine(task.calendar), playbook: clip(task.playbook, 900) || undefined, venues: clip(task.venues, 1200) || undefined, subject: clip(task.subject, 200) || undefined, ...(task.phase === "plan" && step === 0 ? { chat: clip(task.chat, 2400) || undefined } : {}) }
  let out
  try {
    if (planning) {
      const p = await planTask(input, { model: named ?? a.planModel, signal: req.signal })
      const spent = p.usage.reduce((n, u: Usage) => n + cost(u), 0)
      context.waitUntil(Promise.all([
        logEvent("agent_step", installId, {
          task: taskId, plan: access.plan, step, tool: "plan", cls: "free", reason: "plan", strong: false, retries: 0, off_request: false, items: map.items.length,
          questions: p.plan.questions.length, risky: p.plan.risky.length, chat_chars: input.chat?.length ?? 0, prompt_tokens: p.usage.reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0),
          completion_tokens: p.usage.reduce((n, u) => n + u.output, 0), cost_usd: Math.round(spent * 1e6) / 1e6, ms: Date.now() - started, platform, version, build
        }),
        touchInstall(installId, platform, version, locale, 0).catch(() => undefined)
      ]))
      return json({ ok: true, plan: p.plan, token, left, stepsLeft: Math.max(0, maxSteps - stepsUsed), ...(measuring ? { model: named ?? a.planModel, cost: Math.round(spent * 1e6) / 1e6, output: p.usage.reduce((n, u) => n + u.output, 0) } : {}) })
    }
    out = await nextStep(input, { model, startHost, confirmedHere: task.confirmedHere === true, signal: req.signal, fallback: a.strongModel })
  } catch (err) {
    const reason = err instanceof ActError ? err.reason : "error"
    console.error("[cf] act failed:", err instanceof Error ? err.message : err)
    // A task whose first two steps failed on our side (the model or its provider) isn't charged: the day's task comes
    // back (the server knows the failure itself; a device can't claim it).
    const taskBack: Counter[] = step === 0 ? counters : step === 1 ? [{ subject: `agent:tx:${otid}`, period: "day", limit: agentDaily(access.plan, a) }] : []
    context.waitUntil(Promise.all([
      taskBack.length ? refund(taskBack).catch(() => undefined) : Promise.resolve(),
      logEvent("upstream_error", installId, { message: err instanceof Error ? err.message.slice(0, 300) : "unknown", reason, mode: "agent", provider: "anthropic", platform, version })
    ]))
    // (A measuring request on a deploy preview also gets the reason and, for a cut answer, what came before the cut —
    // round 141: the plan call cut on Korean and Japanese pages. Never in production: `measuring` is false there.)
    const cut = measuring && err instanceof ActError && err.reason === "cut" ? { reason, partial: (err.partial ?? "").slice(0, 12_000), output: err.output, blocks: err.blocks } : measuring ? { reason } : {}
    return json({ code: reason === "rate_limit" ? "BUSY" : "UPSTREAM", ...cut }, reason === "rate_limit" ? 503 : 502)
  }

  const spent = out.usage.reduce((n, u: Usage) => n + cost(u), 0)
  const tokens = out.usage.reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
  context.waitUntil(Promise.all([
    logEvent("agent_step", installId, {
      task: taskId, plan: access.plan, step, tool: out.call.tool, cls: out.verdict.cls, reason: out.verdict.reason, strong, retries: out.retries,
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
    stepsLeft: Math.max(0, maxSteps - stepsUsed),
    // Measuring only: what the step cost and which model drove it.
    ...(measuring ? { model, cost: Math.round(spent * 1e6) / 1e6, tokens } : {})
  })
}

/** The person's saved details by key (names only: "email", "fact:Размер обуви"), at most 40. */
function savedKeys(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === "string" && /^[a-zA-Z.]{2,20}$|^fact:.{1,60}$/u.test(k)).slice(0, 40)
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

/** What the device says of Calendar and Reminders: two words, nothing else from it reaches the prompt. */
function deviceLine(v: unknown): string {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>
  const one = (x: unknown) => (x === "yes" || x === "none" || x === "denied" ? x : "unavailable")
  return `reminders=${one(d.reminders)} calendar=${one(d.calendar)}`
}

/** The Calendar's free times for a booking as the device worked them out: times only ("2026-11-24 17:00–19:30; …", or
 *  "none"); anything else from it doesn't reach the prompt. */
function calendarLine(v: unknown): string | undefined {
  const t = clip(v, 400)
  if (t === "none") return t
  const parts = t.split(";").map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2}$/.test(x))
  return parts.length ? parts.join("; ") : undefined
}
