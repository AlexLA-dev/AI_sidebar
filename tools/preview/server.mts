// Local preview of the whole product without external services:
// serves sample pages and runs the real Netlify handlers with an in-memory
// database and a scripted "model". Used for UI checks and App Store screenshots.
//
//   node --experimental-strip-types tools/preview/server.mts   (port 8787)
//   CF_API_BASE=http://localhost:8787 npm run build:chrome      (extension pointing at it)
//   LIMITED_BEFORE=1 …                                         (every install ran out of free answers before:
//                                                              the panel offers the Pro code)
//   PREVIEW_PLAN=byok …                                        (the same with the Own key plan)
//   PREVIEW_PROMO=1 …                                          (Own key → Pro at a discount is set up, with a
//                                                              throwaway key: /api/v2/promo signs)
//   PREVIEW_PLAN=pro …                                         (every request comes as Pro: a test-signed
//                                                              subscription is added on the server side)
//   PREVIEW_CLAUDE=credits|overloaded|refusal|off …            (answers come from a scripted Claude; these make
//                                                              it fail that way, so OpenAI answers; off: no key)

import { createServer } from "node:http"
import { readFileSync } from "node:fs"

process.env.SUPABASE_URL = "https://db.local"
process.env.SUPABASE_SERVICE_ROLE_KEY = "local"
process.env.OPENAI_API_KEY = "local"
if (process.env.PREVIEW_CLAUDE !== "off") process.env.ANTHROPIC_API_KEY = "local"
// The extension in Chromium has no app build to send; CLAUDE_MIN_BUILD=67 tries the old-build path.
process.env.CLAUDE_MIN_BUILD = process.env.CLAUDE_MIN_BUILD ?? "0"
process.env.GEMINI_API_KEY = "local"
process.env.FREE_DAILY_LIMIT = process.env.FREE_DAILY_LIMIT ?? "5"

const counters = new Map<string, number>()
const aiRequests: string[] = []
// The panel's funnel events since /reset ("media_notice:video"…), to check what it reports.
const panelEvents: string[] = []
// The last /api/v2/chat request body, for e2e checks of what the extension sends (GET /last-request).
let lastChatRequest: unknown = null
// The last answer's analytics event: provider, fallback reason, tokens, cost (GET /last-answer).
let lastAnswerEvent: unknown = null
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
  cf_log: ({ p_kind, p_data }) => {
    if (p_kind === "chat") lastAnswerEvent = p_data
    return null
  },
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

function findAnswer(system: string, query: string): string {
  // Long words of the description (their stem: the first 5 letters); chats with most of them first,
  // each "why" taken from the chat's first answer.
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 6).map((w) => w.slice(0, 5))
  const scored: Array<{ id: string; why: string; n: number }> = []
  for (const m of system.matchAll(/<<<CHAT \d+ id=(\S+)\nTitle: ([^\n]*)\n[\s\S]*?CHAT>>>/g)) {
    const text = m[0].toLowerCase()
    const n = words.filter((w) => text.includes(w)).length
    const answer = /\nA: ([^\n]*)/.exec(m[0])?.[1]?.replace(/[*_]/g, "") ?? m[2]
    if (n) scored.push({ id: m[1], why: answer.length > 90 ? `${answer.slice(0, 89)}…` : answer, n })
  }
  return JSON.stringify({ results: scored.sort((a, b) => b.n - a.n).slice(0, 5).map(({ id, why }) => ({ id, why })) })
}

// "Ask your chats": a short overview built from the chats the request carried.
function historyAnswer(system: string, question: string): string {
  const chats = [...system.matchAll(/<<<CHAT \d+ id=\S+\nTitle: ([^\n]*)\nDate: ([^\n]*)\n(?:Pages: ([^\n(]*))?/g)]
  const ru = /[а-яё]/i.test(question)
  const head = ru ? `**По вашим чатам (${chats.length}):**` : `**From your chats (${chats.length}):**`
  const lines = chats.slice(0, 5).map((m) => `- **${m[1]}** — ${(m[3] ?? "").trim() || (ru ? "без страницы" : "no page")} *(${m[2].slice(0, 10)})*`)
  const tail = ru ? "\n\nСпросите подробнее про любой из них — я отвечу по тому, что вы читали и записали." : "\n\nAsk about any of them for details: I answer from what you read and noted."
  return [head, ...lines].join("\n") + tail
}

/** The scripted answer to the last question, whichever model is asked. */
function scripted(system: string, last: string): string {
  // AI search: the chats that share a word (4+ letters) with the description, as JSON.
  if (system.startsWith("You find chats")) return findAnswer(system, last)
  if (system.includes("asking about their own earlier ContextFlow chats")) return historyAnswer(system, last)
  return answers.find(([re]) => re.test(last))?.[1] ?? answers[answers.length - 1][1]
}

// What the server last asked Claude (model, effort, max_tokens), for checks (GET /last-claude).
let lastClaudeRequest: unknown = null
// Quick insert's scripted Haiku: marks what looks like it changes (a name after a greeting, dates, times,
// long numbers), fills blanks from the page the same way, finds templates sharing a word's start.
const MONTHS = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|January|February|March|April|May|June|July|August|September|October|November|December"
const DAYS = "понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
function scriptedInsert(system: string, content: string): unknown {
  const between = (tag: string) => content.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? ""
  const found = (text: string) => ({
    name: text.match(/(?:Здравствуйте|Привет|Добрый день|Hi|Hello|Dear),?\s+([A-ZА-ЯЁ][a-zа-яё]+)/)?.[1] ?? text.match(/^([A-ZА-ЯЁ][a-zа-яё]+)(?:\s+[A-ZА-ЯЁ][a-zа-яё]+)?:/m)?.[1] ?? "",
    date: text.match(new RegExp(`\\d{1,2}\\s+(?:${MONTHS})`))?.[0] ?? "",
    day: text.match(new RegExp(`(?:${DAYS})`, "i"))?.[0] ?? "",
    time: text.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? "",
    number: text.match(/\b\d{4,}[\w-]*/)?.[0] ?? ""
  })
  if (system.startsWith("You turn a message")) {
    const text = between("message")
    const f = found(text)
    const blanks = [["Имя", f.name], ["дата", f.date], ["день", f.day], ["время", f.time], ["номер", f.number]].filter(([, v]) => v).map(([label, value]) => ({ label, value }))
    const words = text.replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 4)
    return { title: words.slice(0, 3).join(" ") || "Шаблон", keywords: words.slice(3, 5).map((w) => w.toLowerCase()), blanks }
  }
  if (system.startsWith("You fill the blanks")) {
    const page = between("page")
    const f = found(page)
    const labels = [...content.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    const pick = (label: string) => /им|name/i.test(label) ? f.name : /дат|date/i.test(label) ? f.date : /ден|day/i.test(label) ? f.day : /врем|time/i.test(label) ? f.time : /номер|код|number|code|order/i.test(label) ? f.number : ""
    return { values: labels.map((label) => ({ label, value: pick(label) })) }
  }
  const query = (content.match(/looking for: (.*)/)?.[1] ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2).map((w) => w.slice(0, 4))
  const ids = [...content.matchAll(/^(\S+) \| (.*)$/gm)].filter((m) => query.some((q) => m[2].toLowerCase().includes(q))).map((m) => m[1])
  return { ids }
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
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    const body = JSON.parse(String(init?.body))
    lastClaudeRequest = { model: body.model, max_tokens: body.max_tokens, output_config: body.output_config, thinking: body.thinking ?? null, fallbacks: body.fallbacks }
    // Quick insert (JSON answers, not streamed): a scripted Haiku that marks, fills and finds.
    if (body.output_config?.format) {
      const answer = scriptedInsert(String(body.system), String(body.messages[0].content))
      return new Response(JSON.stringify({
        id: "msg_local", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 2400, output_tokens: 90 }
      }), { headers: { "Content-Type": "application/json" } })
    }
    const fail = process.env.PREVIEW_CLAUDE
    if (fail === "credits") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 })
    if (fail === "overloaded") return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 })
    const ev = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const words = fail === "refusal" ? [] : scripted(body.system, body.messages[body.messages.length - 1].content).match(/\S+\s*|\s+/g) ?? []
    const stream = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        c.enqueue(enc.encode(ev("message_start", { message: { id: "msg_local", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } })))
        if (words.length) c.enqueue(enc.encode(ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })))
        for (const w of words) {
          c.enqueue(enc.encode(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: w } })))
          await new Promise((r) => setTimeout(r, STREAM_DELAY_MS))
        }
        if (words.length) c.enqueue(enc.encode(ev("content_block_stop", { index: 0 })))
        c.enqueue(enc.encode(ev("message_delta", { delta: { stop_reason: words.length ? "end_turn" : "refusal", stop_sequence: null }, usage: { output_tokens: 200 } }) + ev("message_stop")))
        c.close()
      }
    })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(String(init?.body))
    const last = body.messages[body.messages.length - 1].content as string
    const system = body.messages[0].content as string
    const words = scripted(system, last).match(/\S+\s*|\s+/g) ?? []
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

// PREVIEW_PLAN=pro (or byok): requests carry a subscription signed with the test chain (trusted here only).
let proJws: string | null = null
if (process.env.PREVIEW_PROMO === "1") {
  const { generateKeyPairSync } = await import("node:crypto")
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  process.env.PROMO_OFFER_ID = "byok_upgrade"
  process.env.PROMO_KEY_ID = "STANDKEY01"
  process.env.PROMO_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
}
if (process.env.PREVIEW_PLAN === "pro" || process.env.PREVIEW_PLAN === "byok") {
  const { signJws, transaction, TEST_ROOT_FINGERPRINT } = await import("../../tests/helpers.mts")
  // The test chain is only accepted in tests: this local stand counts as one.
  process.env.NODE_ENV = "test"
  ;(await import("../../netlify/shared/apple.mts")).setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  proJws = signJws(transaction(process.env.PREVIEW_PLAN === "byok"
    ? { productId: "com.contextflow.byok.monthly", originalTransactionId: "2000000777", expiresDate: Date.now() + 30 * 86_400_000 }
    : { expiresDate: Date.now() + 30 * 86_400_000 }))
}

const chat = (await import("../../netlify/functions/v2-chat.mts")).default
const status = (await import("../../netlify/functions/v2-status.mts")).default
const event = (await import("../../netlify/functions/v2-event.mts")).default
const find = (await import("../../netlify/functions/v2-find.mts")).default
const promo = (await import("../../netlify/functions/v2-promo.mts")).default
const insert = (await import("../../netlify/functions/v2-insert.mts")).default
const handlers: Record<string, typeof chat> = { "/api/v2/chat": chat, "/api/v2/status": status, "/api/v2/event": event, "/api/v2/find": find, "/api/v2/promo": promo, "/api/v2/insert": insert }

const pages: Record<string, string> = {
  "/": "article.html",
  "/article": "article.html",
  "/article-ru": "article-ru.html",
  "/article-2": "article-2.html",
  "/article-2-ru": "article-2-ru.html",
  "/pdf-embed": "pdf-embed.html",
  "/pdf-link": "pdf-link.html",
  "/lecture": "lecture.html",
  "/lecture-ru": "lecture-ru.html"
}

// PDFs for the PDF checks. private.pdf only with the cookie pdf-link.html sets, like a PDF behind a sign-in.
const pdfs: Record<string, string> = {
  "/files/report.pdf": "files/report.pdf",
  "/files/scan.pdf": "files/scan.pdf",
  "/files/private.pdf": "files/report.pdf"
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const handler = handlers[url.pathname] ?? null
  if (handler) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    if (url.pathname === "/api/v2/chat" || url.pathname === "/api/v2/find") aiRequests.push(url.pathname)
    if (url.pathname === "/api/v2/event") {
      try {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        panelEvents.push(`${sent.kind}:${sent.media ?? sent.where ?? sent.reason ?? ""}`)
      } catch {
        // not JSON
      }
    }
    if (url.pathname === "/api/v2/chat") {
      try {
        lastChatRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        lastChatRequest = null
      }
    }
    let raw = Buffer.concat(chunks)
    if (proJws && req.method === "POST") {
      try {
        raw = Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString("utf8")), entitlement: proJws }))
      } catch {
        // not JSON: as it is
      }
    }
    const request = new Request(`http://localhost${url.pathname}`, {
      method: req.method,
      headers: { ...(req.headers as Record<string, string>), "content-length": String(raw.length) },
      body: req.method === "POST" ? raw : undefined
    })
    const response = await handler(request, { ip: "127.0.0.1", waitUntil: () => undefined } as any)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const c of response.body as any) res.write(c)
    res.end()
    return
  }
  if (url.pathname === "/last-answer") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastAnswerEvent))
    return
  }
  if (url.pathname === "/last-claude") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastClaudeRequest))
    return
  }
  if (url.pathname === "/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastChatRequest))
    return
  }
  // The AI requests since /reset (to check that nothing was sent without consent).
  if (url.pathname === "/requests") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(aiRequests))
    return
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(panelEvents))
    return
  }
  if (url.pathname === "/reset") {
    counters.clear()
    aiRequests.length = 0
    panelEvents.length = 0
    res.end("ok")
    return
  }
  // Captions of the lecture video (the video itself isn't needed: the panel reads the captions).
  if (/^\/files\/lecture(-ru)?\.vtt$/.test(url.pathname)) {
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" })
    res.end(readFileSync(new URL(`.${url.pathname}`, import.meta.url)))
    return
  }
  const pdf = pdfs[url.pathname]
  if (pdf) {
    if (url.pathname === "/files/private.pdf" && !/signed_in=1/.test(req.headers.cookie ?? "")) {
      res.writeHead(403, { "Content-Type": "text/html" }).end("<h1>Sign in</h1>")
      return
    }
    res.writeHead(200, { "Content-Type": "application/pdf" })
    res.end(readFileSync(new URL(`./${pdf}`, import.meta.url)))
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
