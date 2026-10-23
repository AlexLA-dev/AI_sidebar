// Local preview of the whole product without external services:
// serves sample pages and runs the real Netlify handlers with an in-memory
// database and a scripted "model". Used for UI checks and App Store screenshots.
//
//   node --experimental-strip-types tools/preview/server.mts   (port 8787)
//   CF_API_BASE=http://localhost:8787 npm run build:chrome      (extension pointing at it)

import { createServer } from "node:http"
import { readFileSync } from "node:fs"

process.env.SUPABASE_URL = "https://db.local"
process.env.SUPABASE_SERVICE_ROLE_KEY = "local"
process.env.OPENAI_API_KEY = "local"
process.env.FREE_DAILY_LIMIT = process.env.FREE_DAILY_LIMIT ?? "5"

const counters = new Map<string, number>()
type Item = { subject: string; limit: number | null }
const rpc: Record<string, (a: any) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) >= i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + 1))
    return { allowed: !blocked, blocked: blocked?.subject ?? null, counters: items.map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })) }
  },
  cf_refund: () => null,
  cf_peek: ({ p_items }) => (p_items as Item[]).map((i) => ({ ...i, n: counters.get(i.subject) ?? 0 })),
  cf_touch_install: () => null,
  cf_log: () => null,
  cf_entitlement_upsert: ({ p }) => p,
  cf_entitlement_get: () => null,
  cf_entitlement_by_token: () => null
}

const answers: [RegExp, string][] = JSON.parse(readFileSync(new URL("./answers.json", import.meta.url), "utf8")).map(
  ([re, text]: [string, string]) => [new RegExp(re, "i"), text]
)

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://db.local/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return new Response(JSON.stringify(rpc[fn]?.(body) ?? null), { headers: { "Content-Type": "application/json" } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(String(init?.body))
    const last = body.messages[body.messages.length - 1].content as string
    const text = answers.find(([re]) => re.test(last))?.[1] ?? answers[answers.length - 1][1]
    const words = text.match(/\S+\s*|\s+/g) ?? []
    const stream = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        for (const w of words) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`))
          await new Promise((r) => setTimeout(r, 8))
        }
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 200 } })}\n\ndata: [DONE]\n\n`))
        c.close()
      }
    })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
  }
  return realFetch(input, init)
}) as typeof fetch

const chat = (await import("../../netlify/functions/v2-chat.mts")).default
const status = (await import("../../netlify/functions/v2-status.mts")).default

const pages: Record<string, string> = {
  "/": "article.html",
  "/article": "article.html"
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const handler = url.pathname === "/api/v2/chat" ? chat : url.pathname === "/api/v2/status" ? status : null
  if (handler) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const request = new Request(`http://localhost${url.pathname}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined
    })
    const response = await handler(request, { ip: "127.0.0.1", waitUntil: () => undefined } as any)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const c of response.body as any) res.write(c)
    res.end()
    return
  }
  if (url.pathname === "/reset") {
    counters.clear()
    res.end("ok")
    return
  }
  const file = pages[url.pathname]
  if (!file) {
    res.writeHead(404).end("not found")
    return
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(readFileSync(new URL(`./${file}`, import.meta.url)))
}).listen(Number(process.env.PORT ?? 8787), () => console.log("preview on http://localhost:" + (process.env.PORT ?? 8787)))
