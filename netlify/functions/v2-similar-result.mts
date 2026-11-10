import type { Config } from "@netlify/functions"

import { corsHeaders, isUuid, json, preflight } from "../shared/http.mts"
import { JOB_ID, jobKey, jobStore, waitForJob, type StoredJob } from "../shared/jobs.mts"

/**
 * GET or POST /api/v2/similar-result — build 94: the answer of a Find similar that went on without its request (the
 * person left Safari; netlify/shared/jobs.mts).
 * Query or body: install (the install id), job (the question's id), wait (seconds, at most 55: holds the request until
 * the job ends), take (1: the answer was written into the chat, so it goes from here).
 * Answer (JSON; while it waits, spaces keep the connection alive and JSON ignores them):
 *   {state: "running"} · {state: "done", result: {intro, items, note, condition}} · {state: "failed", code} ·
 *   {state: "unknown"} (never asked with this id, or taken already).
 * The iPhone app's background download asks it with GET (a background download can't send a body).
 */
export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight()
  if (req.method !== "GET" && req.method !== "POST") return json({ code: "METHOD" }, 405)
  const query = new URL(req.url).searchParams
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
  const field = (name: string) => String(body[name] ?? query.get(name) ?? "")
  const install = field("install")
  const job = field("job")
  if (!isUuid(install) || !JOB_ID.test(job)) return json({ code: "BAD_REQUEST" }, 400)
  const waitMs = Math.min(55, Math.max(0, Number(field("wait")) || 0)) * 1_000
  const take = field("take") === "1" || body.take === true
  let store: ReturnType<typeof jobStore>
  try {
    store = jobStore()
  } catch {
    // No store here (a local run without Netlify Blobs): nothing is ever kept.
    return json({ state: "unknown" })
  }
  const key = jobKey(install, job)

  const answer = async (found: StoredJob | null): Promise<string> => {
    if (!found) return JSON.stringify({ state: "unknown" })
    if (found.state === "running") return JSON.stringify({ state: "running" })
    if (take) await store.delete(key).catch(() => undefined)
    return JSON.stringify(found.state === "done" ? { state: "done", result: found.result } : { state: "failed", code: found.code ?? "UPSTREAM" })
  }
  const headers = { ...corsHeaders, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" }
  if (!waitMs) return new Response(await answer(await waitForJob(store, key, 0).catch(() => null)), { headers })

  // Held open while it waits: a space every 5 s (proxies cut a quiet connection), then the JSON.
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "))
        } catch {
          clearInterval(ping)
        }
      }, 5_000)
      try {
        controller.enqueue(encoder.encode(await answer(await waitForJob(store, key, waitMs, req.signal).catch(() => null))))
      } catch {
        // the asker went away
      } finally {
        clearInterval(ping)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    }
  })
  return new Response(stream, { headers })
}

export const config: Config = { path: "/api/v2/similar-result" }
