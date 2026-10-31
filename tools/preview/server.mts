// Local preview of the whole product without external services:
// serves sample pages and runs the real Netlify handlers with an in-memory
// database and a scripted "model". Used for UI checks and App Store screenshots.
//
//   node --experimental-strip-types tools/preview/server.mts   (port 8787)
//   CF_API_BASE=http://localhost:8787 npm run build:chrome      (extension pointing at it)
//   LIMITED_BEFORE=1 …                                         (every install ran out of free answers before:
//                                                              the panel offers the Pro code)

import { createServer } from "node:http"
import { readFileSync } from "node:fs"

process.env.SUPABASE_URL = "https://db.local"
process.env.SUPABASE_SERVICE_ROLE_KEY = "local"
process.env.OPENAI_API_KEY = "local"
process.env.GEMINI_API_KEY = "local"
process.env.FREE_DAILY_LIMIT = process.env.FREE_DAILY_LIMIT ?? "5"

const counters = new Map<string, number>()
// The last /api/v2/chat request body, for e2e checks of what the extension sends (GET /last-request).
let lastChatRequest: unknown = null
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
  cf_entitlement_by_token: () => null,
  cf_limited_before: () => process.env.LIMITED_BEFORE === "1"
}

// Delay between streamed words; the App Store preview video slows it down to a readable pace.
const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 8)

const answers: [RegExp, string][] = JSON.parse(readFileSync(new URL("./answers.json", import.meta.url), "utf8")).map(
  ([re, text]: [string, string]) => [new RegExp(re, "i"), text]
)

// Google mode: a grounded answer with sources and a Search Suggestions snippet shaped like Gemini's.
const GOOGLE_ANSWERS = {
  en: {
    query: "four-day work week results",
    parts: [
      "**Yes — most trials of a four-day week kept productivity steady while cutting burnout.**",
      "\n\n**What the largest trials found**\n- In the UK pilot, 56 of 61 companies kept the four-day week after six months.",
      "\n- Revenue stayed roughly flat, while sick days fell by about two thirds.",
      "\n\n**Where it struggles**\n- Shift-based and customer-facing teams need rotating days off to keep coverage."
    ],
    sources: [["autonomy.work", "a"], ["4dayweek.com", "b"], ["bbc.com", "c"]]
  },
  ru: {
    query: "результаты четырёхдневной рабочей недели",
    parts: [
      "**Да — в большинстве экспериментов четырёхдневка сохранила продуктивность и снизила выгорание.**",
      "\n\n**Что показали крупные эксперименты**\n- В британском пилоте 56 из 61 компании остались на четырёх днях через полгода.",
      "\n- Выручка почти не изменилась, а больничных стало примерно на две трети меньше.",
      "\n\n**Где сложнее**\n- Сменным командам и поддержке клиентов нужны скользящие выходные, чтобы не терять покрытие."
    ],
    sources: [["autonomy.work", "a"], ["rbc.ru", "b"], ["bbc.com", "c"]]
  }
}

function suggestionsHtml(query: string): string {
  const href = `https://www.google.com/search?q=${encodeURIComponent(query)}&client=app-vertex-grounding&safesearch=active`
  return `<style>.container{align-items:center;border-radius:8px;display:flex;font-family:Google Sans,Roboto,sans-serif;font-size:14px;line-height:20px;padding:8px 12px}.chip{display:inline-block;border:solid 1px;border-radius:16px;min-width:14px;padding:5px 16px;text-align:center;user-select:none;margin:0 8px;-webkit-tap-highlight-color:transparent}.carousel{overflow:auto;scrollbar-width:none;white-space:nowrap;margin-right:-12px}.headline{display:flex;margin-right:4px}@media (prefers-color-scheme:light){.container{background-color:#fafafa;box-shadow:0 0 0 1px #0000000f}.chip{background-color:#fff;border-color:#d2d2d2;color:#5e5e5e;text-decoration:none}}@media (prefers-color-scheme:dark){.container{background-color:#1f1f1f;box-shadow:0 0 0 1px #ffffff26}.chip{background-color:#2c2c2c;border-color:#3c4043;color:#fff;text-decoration:none}}</style><div class="container"><div class="headline"><svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#4285f4"/></svg></div><div class="carousel"><a class="chip" href="${href}">${query}</a></div></div>`
}

function geminiStream(lastQuestion: string): Response {
  const answer = /[а-яё]/i.test(lastQuestion) ? GOOGLE_ANSWERS.ru : GOOGLE_ANSWERS.en
  const text = answer.parts.join("")
  const supports = answer.parts.map((part, i) => {
    const segment = part.replace(/^\s+/, "").split("\n").pop() as string
    const before = answer.parts.slice(0, i).join("") + part.slice(0, part.length - segment.length)
    const startIndex = Buffer.byteLength(before)
    return { segment: { startIndex, endIndex: startIndex + Buffer.byteLength(segment), text: segment }, groundingChunkIndices: i === 1 ? [0, 1] : [i % 3] }
  })
  const grounding = {
    webSearchQueries: [answer.query],
    searchEntryPoint: { renderedContent: suggestionsHtml(answer.query) },
    groundingChunks: answer.sources.map(([title, id]) => ({ web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`, title } })),
    groundingSupports: supports
  }
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder()
      const words = text.match(/\S+\s*|\s+/g) ?? []
      await new Promise((r) => setTimeout(r, 600))
      for (const [i, w] of words.entries()) {
        const last = i === words.length - 1
        const frame = { candidates: [{ content: { role: "model", parts: [{ text: w }] }, ...(last ? { finishReason: "STOP", groundingMetadata: grounding } : {}) }] }
        c.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\r\n\r\n`))
        await new Promise((r) => setTimeout(r, STREAM_DELAY_MS))
      }
      c.close()
    }
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://db.local/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return new Response(JSON.stringify(rpc[fn]?.(body) ?? null), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
    if (!url.includes(":streamGenerateContent")) return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }))
    const body = JSON.parse(String(init?.body))
    return geminiStream(body.contents[body.contents.length - 1].parts[0].text)
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
          await new Promise((r) => setTimeout(r, STREAM_DELAY_MS))
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
const event = (await import("../../netlify/functions/v2-event.mts")).default
const handlers: Record<string, typeof chat> = { "/api/v2/chat": chat, "/api/v2/status": status, "/api/v2/event": event }

const pages: Record<string, string> = {
  "/": "article.html",
  "/article": "article.html",
  "/article-ru": "article-ru.html",
  "/article-2": "article-2.html",
  "/article-2-ru": "article-2-ru.html"
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const handler = handlers[url.pathname] ?? null
  if (handler) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    if (url.pathname === "/api/v2/chat") {
      try {
        lastChatRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        lastChatRequest = null
      }
    }
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
  if (url.pathname === "/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastChatRequest))
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
