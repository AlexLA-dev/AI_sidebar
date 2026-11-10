// "Find similar" (2.6, Ultra) from the panel: our backend's /api/v2/similar, streamed. Always engine A (ours, every
// link opened and checked on our server): the panel has no way to ask for engine B (Google).

import { API_BASE } from "../shared/config"
import { sseData } from "../shared/sse"
import { cleanItem, type SimilarPayload, type SimilarStreamEvent } from "../shared/similar"
import type { Plan, Usage } from "../shared/types"
import type { Kept } from "./jobs"

const FIRST_BYTE_TIMEOUT_MS = 30_000

export interface SimilarRequest {
  installId: string
  client: Record<string, unknown>
  entitlement: string | null
  payload: SimilarPayload
  // Build 94: the question's id: our server finishes the search without the request and keeps its answer.
  job?: string
}

/** Streams an answer from /api/v2/similar as the panel's events ("kept": our server took it as a job it finishes). */
export async function askSimilar(req: SimilarRequest, emit: (e: SimilarStreamEvent | { type: "kept" }) => void, signal: AbortSignal): Promise<void> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), FIRST_BYTE_TIMEOUT_MS)
  signal.addEventListener("abort", () => timeout.abort())
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/v2/similar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: req.installId,
        client: req.client,
        entitlement: req.entitlement,
        engine: "a",
        page: req.payload.page,
        condition: req.payload.condition,
        ...(req.payload.selection ? { selection: req.payload.selection } : {}),
        ...(req.payload.region ? { region: req.payload.region } : {}),
        ...(req.payload.country ? { country: req.payload.country } : {}),
        ...(req.job ? { job: req.job } : {})
      }),
      signal: timeout.signal
    })
  } catch {
    clearTimeout(timer)
    if (!signal.aborted) emit({ type: "error", code: timeout.signal.aborted ? "UPSTREAM" : "NETWORK" })
    return
  }
  clearTimeout(timer)
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; plan?: Plan; usage?: Usage | null }
    emit({ type: "error", code: body.code ?? (res.status >= 500 ? "UPSTREAM" : "BAD_REQUEST"), ...(body.plan ? { plan: body.plan } : {}), ...(body.usage ? { usage: body.usage } : {}) })
    return
  }
  let finished = false
  if (req.job) emit({ type: "kept" })
  try {
    for await (const data of sseData(res.body)) {
      let e: Record<string, unknown>
      try {
        e = JSON.parse(data)
      } catch {
        continue
      }
      if (e.type === "progress" && typeof e.step === "string" && ["plan", "search", "check", "write"].includes(e.step)) {
        emit({ type: "progress", step: e.step as "plan", ...(typeof e.pages === "number" ? { pages: e.pages } : {}) })
      } else if (e.type === "item") {
        const item = cleanItem(e.item)
        if (item) emit({ type: "item", item })
      } else if (e.type === "result") {
        const items = (Array.isArray(e.items) ? e.items : []).map(cleanItem).filter((i): i is NonNullable<typeof i> => i !== null)
        const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
        emit({ type: "result", answer: { intro: s(e.intro, 300), items, note: s(e.note, 300), condition: s(e.condition, 20) } })
      } else if (e.type === "done") {
        finished = true
        emit({ type: "done" })
      } else if (e.type === "error") {
        finished = true
        emit({ type: "error", code: typeof e.code === "string" ? e.code : "STREAM" })
      }
    }
  } catch {
    // connection dropped mid-answer
  }
  if (!finished && !signal.aborted) emit({ type: "error", code: "STREAM" })
}

/**
 * A Find similar's answer as our server kept it (build 94: its request was cut); `waitSeconds` holds the request until
 * the search ends there. Null: the server couldn't be asked (offline, the background suspended mid-ask).
 */
export async function keptSimilar(installId: string, job: string, waitSeconds: number, signal: AbortSignal, take = false): Promise<Kept | null> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/v2/similar-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ install: installId, job, wait: waitSeconds, ...(take ? { take: true } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 15) * 1_000)])
    })
  } catch {
    return null
  }
  // An older server without kept answers: nothing to wait for.
  if (res.status === 404) return { state: "unknown" }
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return null
  if (body.state === "running") return { state: "running" }
  if (body.state === "failed") return { state: "failed", code: typeof body.code === "string" ? body.code.slice(0, 20) : "UPSTREAM" }
  if (body.state !== "done") return { state: "unknown" }
  const r = (body.result ?? {}) as Record<string, unknown>
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
  const items = (Array.isArray(r.items) ? r.items : []).map(cleanItem).filter((i): i is NonNullable<typeof i> => i !== null)
  return { state: "done", result: { intro: s(r.intro, 300), items, note: s(r.note, 300), condition: s(r.condition, 20) } }
}
