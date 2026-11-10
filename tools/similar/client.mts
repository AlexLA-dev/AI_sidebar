// The evaluation's client for /api/v2/similar (never shipped). Runs under `netlify dev:exec`, which hands it
// the site's environment: the token is an HMAC of the service key (the same derivation as the server), so no
// secret is configured, copied or printed. Test traffic says so: audience "test", version "dev-check".
import { createHmac, randomUUID } from "node:crypto"

export const EVAL_INSTALL = "5e1f0c2a-6b1d-4c3e-9a7f-2d6c0e8b4a10"

export function evalToken(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  if (!key) throw new Error("run under `netlify dev:exec` (SUPABASE_SERVICE_ROLE_KEY not in the environment)")
  return createHmac("sha256", key).update("contextflow-similar-eval-v1").digest("hex")
}

export interface SimilarCall {
  engine: "a" | "b"
  ok: boolean
  status: number
  ms: number
  // Client-side: until the first item can be shown (engine A: the first streamed item, else the result; B: the first text).
  firstMs: number | null
  events: Array<Record<string, unknown>>
  error?: string
}

export interface PageInput {
  title: string
  url: string
  text: string
  facts?: Record<string, unknown>
}

export async function callSimilar(base: string, engine: "a" | "b", page: PageInput, condition: string, locale: string, options: Record<string, string> = {}, timeoutMs = 75_000): Promise<SimilarCall> {
  const started = Date.now()
  let firstMs: number | null = null
  const events: Array<Record<string, unknown>> = []
  let res: Response
  try {
    res = await fetch(`${base}/api/v2/similar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${evalToken()}` },
      body: JSON.stringify({
        installId: EVAL_INSTALL,
        client: { version: "dev-check", platform: "eval", locale, build: "999", audience: "test", run: randomUUID().slice(0, 8) },
        engine,
        page,
        condition,
        // Build 93: where to look and the country are the request's own fields, not engine options.
        ...(options.region ? { region: options.region } : {}),
        ...(options.country ? { country: options.country } : {}),
        ...(Object.keys(options).length ? { options } : {})
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    return { engine, ok: false, status: 0, ms: Date.now() - started, firstMs, events, error: err instanceof Error ? err.message : String(err) }
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    return { engine, ok: false, status: res.status, ms: Date.now() - started, firstMs, events, error: text.slice(0, 300) }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at: number
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue
          try {
            const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
            event.t = Date.now() - started
            // The first item a person can see: a streamed item (engine A since the speed-up), the whole list, or B's text.
            if (firstMs === null && (event.type === "item" || event.type === "result" || event.type === "delta")) firstMs = event.t as number
            events.push(event)
          } catch {
            // a broken line
          }
        }
      }
    }
  } catch (err) {
    return { engine, ok: false, status: res.status, ms: Date.now() - started, firstMs, events, error: err instanceof Error ? err.message : String(err) }
  }
  const last = events[events.length - 1]
  return { engine, ok: last?.type === "done", status: res.status, ms: Date.now() - started, firstMs, events, ...(last?.type === "error" ? { error: String(last.message ?? last.code) } : {}) }
}
