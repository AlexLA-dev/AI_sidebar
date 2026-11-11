import { config, type Plan } from "./config.mts"
import { hasPro } from "../../src/shared/plan.ts"
import { newestGeminiFlash, newestGeminiTts, newestGptModel, type ModelTier } from "../../src/shared/models.ts"

// OpenAI's model list, cached per function instance.
const LIST_TTL_MS = 6 * 3600_000
const RETRY_AFTER_MS = 5 * 60_000

let list: { ids: string[]; at: number } | null = null
let failedAt = 0

async function modelIds(): Promise<string[] | null> {
  const now = Date.now()
  if (list && now - list.at < LIST_TTL_MS) return list.ids
  if (now - failedAt < RETRY_AFTER_MS) return list?.ids ?? null
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      signal: AbortSignal.timeout(3_000)
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = (await res.json()) as { data?: { id?: unknown }[] }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string")
    list = { ids, at: now }
    return ids
  } catch (err) {
    failedAt = now
    console.warn("[cf] model list unavailable:", err instanceof Error ? err.message : err)
    return list?.ids ?? null
  }
}

/** Models to try for a plan, best first: the plan's model (newest of its tier unless pinned), then the fallbacks. */
export async function modelsFor(plan: Plan): Promise<string[]> {
  const wanted = hasPro(plan) ? config.proModel : config.freeModel
  const auto = /^auto:(fast|smart)$/.exec(wanted)
  let first: string | null = wanted
  if (auto) {
    const ids = await modelIds()
    first = ids ? newestGptModel(ids, auto[1] as ModelTier) : null
  }
  return [...new Set([first, ...config.fallbackModels].filter((m): m is string => Boolean(m)))]
}

// Gemini's model list (for Google answers and read aloud), cached the same way. `all` keeps the models that don't
// take generateContent too (TTS models may answer the Interactions API only).
let geminiList: { ids: string[]; all: string[]; at: number } | null = null
let geminiFailedAt = 0

async function geminiIds(all = false): Promise<string[] | null> {
  const now = Date.now()
  if (geminiList && now - geminiList.at < LIST_TTL_MS) return all ? geminiList.all : geminiList.ids
  if (now - geminiFailedAt < RETRY_AFTER_MS) return (all ? geminiList?.all : geminiList?.ids) ?? null
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": config.geminiKey },
      signal: AbortSignal.timeout(3_000)
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = (await res.json()) as { models?: { name?: unknown; supportedGenerationMethods?: unknown }[] }
    const name = (m: { name?: unknown }) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : "")
    const ids = (body.models ?? [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map(name)
      .filter(Boolean)
    geminiList = { ids, all: (body.models ?? []).map(name).filter(Boolean), at: now }
    return all ? geminiList.all : ids
  } catch (err) {
    geminiFailedAt = now
    console.warn("[cf] gemini model list unavailable:", err instanceof Error ? err.message : err)
    return (all ? geminiList?.all : geminiList?.ids) ?? null
  }
}

/** Gemini models to try for Google answers, best first. */
export async function geminiModels(): Promise<string[]> {
  let first: string | null = config.geminiModel
  if (first === "auto") {
    const ids = await geminiIds()
    first = ids ? newestGeminiFlash(ids) : null
  }
  return [...new Set([first, ...config.geminiFallbackModels].filter((m): m is string => Boolean(m)))]
}

/** TTS models to try for read aloud, best first: Flash-Lite, or the full Flash for the languages Lite lacks. */
export async function ttsModels(kind: "lite" | "full"): Promise<string[]> {
  let first: string | null = kind === "lite" ? config.speak.liteModel : config.speak.fullModel
  if (first === "auto") {
    const ids = await geminiIds(true)
    first = ids ? newestGeminiTts(ids, kind) : null
  }
  return [...new Set([first, ...(kind === "lite" ? config.speak.liteFallback : config.speak.fullFallback)].filter((m): m is string => Boolean(m)))]
}

export function resetModelListForTests(): void {
  list = null
  failedAt = 0
  geminiList = null
  geminiFailedAt = 0
}
