import { config, type Plan } from "./config.mts"
import { newestGptModel, type ModelTier } from "../../src/shared/models.ts"

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
  const wanted = plan === "pro" ? config.proModel : config.freeModel
  const auto = /^auto:(fast|smart)$/.exec(wanted)
  let first: string | null = wanted
  if (auto) {
    const ids = await modelIds()
    first = ids ? newestGptModel(ids, auto[1] as ModelTier) : null
  }
  return [...new Set([first, ...config.fallbackModels].filter((m): m is string => Boolean(m)))]
}

export function resetModelListForTests(): void {
  list = null
  failedAt = 0
}
