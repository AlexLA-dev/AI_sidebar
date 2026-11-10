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
//   PREVIEW_PLAN=ultra …                                       (the same as Ultra, 2.6: read aloud speaks a tone
//                                                              as long as the text would take)
//   SPEAK_PROXY=https://deploy-preview-57--aisidebar.netlify.app SPEAK_EVAL_KEY=<private key .pem> …
//                                                              (read aloud with the real voices: /api/v2/speak goes
//                                                              to that deploy preview, each request signed with the
//                                                              measuring key, see netlify/shared/plan.mts evalCheck)
//   ORGANIZE_PROXY=https://<deploy preview> SPEAK_EVAL_KEY=<private key .pem> …
//                                                              (organizing with the real vectors, tag checks and chat
//                                                              names: /api/v2/organize goes to that deploy preview,
//                                                              signed the same way)
//   PREVIEW_SPEAK_USED=1700 …                                  (Ultra: that many of the week's read-aloud seconds used)
//   SPEAK_FAIL_FROM_PART=1 …                                   (read aloud: every part from that one on fails with
//                                                              502, as a connection lost mid-text)
//   PREVIEW_CLAUDE=credits|overloaded|refusal|off …            (answers come from a scripted Claude; these make
//                                                              it fail that way, so OpenAI answers; off: no key)
//   STATUS_DELAY_MS=800 …                                      (/api/v2/status answers that late, as over a phone's
//                                                              network: what waiting for the plan costs)
//   FIRST_WORD_DELAY_MS=4000 …                                 (an answer's first word comes that late: time to
//                                                              stop the question before any of its answer)

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
// PREVIEW_SPEAK_USED=1700: the Ultra subscriber has used that many of the week's read-aloud seconds (the few-minutes-left note).
if (process.env.PREVIEW_SPEAK_USED) counters.set("speak:tx:2000000888", Number(process.env.PREVIEW_SPEAK_USED))
// The guided first request's free answers per install, ever (2.6: cf_tour_take in the 2.6 migration).
const tours = new Map<string, number>()
const aiRequests: string[] = []
// The panel's funnel events since /reset ("media_notice:video"…), to check what it reports.
const panelEvents: string[] = []
// The last /api/v2/similar request body (GET /last-similar): the engine and the page the panel sent.
let lastSimilarRequest: unknown = null
// The last /api/v2/chat request body, for e2e checks of what the extension sends (GET /last-request).
let lastChatRequest: unknown = null
// The last answer's analytics event: provider, fallback reason, tokens, cost (GET /last-answer).
let lastAnswerEvent: unknown = null
type Item = { subject: string; limit: number | null; amount?: number }
const rpc: Record<string, (a: any) => unknown> = {
  cf_consume: ({ p_items }) => {
    const items = p_items as Item[]
    // As cf_consume: an item counts as its amount (a long page), allowed only when all of it fits.
    const blocked = items.find((i) => i.limit !== null && (counters.get(i.subject) ?? 0) + (i.amount ?? 1) > i.limit)
    if (!blocked) items.forEach((i) => counters.set(i.subject, (counters.get(i.subject) ?? 0) + (i.amount ?? 1)))
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
  cf_limited_before: () => process.env.LIMITED_BEFORE === "1",
  cf_tour_take: ({ p_install, p_max }) => {
    const n = tours.get(p_install) ?? 0
    if (n >= p_max) return false
    tours.set(p_install, n + 1)
    return true
  },
  cf_tour_give_back: ({ p_install }) => {
    tours.set(p_install, Math.max(0, (tours.get(p_install) ?? 0) - 1))
    return null
  }
}

// Delay between streamed words; the App Store preview video slows it down to a readable pace.
const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 8)
// Before an answer's first word (0 by default): time to stop a question before any of its answer comes.
const FIRST_WORD_DELAY_MS = Number(process.env.FIRST_WORD_DELAY_MS ?? 0)

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
  const chats = [...system.matchAll(/<<<CHAT \d+ id=(\S+)\nTitle: ([^\n]*)\nDate: ([^\n]*)\n(?:Pages: ([^\n(]*))?/g)]
  const ru = /[а-яё]/i.test(question)
  // Build 94: a client that opens chats from the answer gets them as [name](chat:<id>), as the prompt asks.
  const links = system.includes("[Title](chat:<id>)")
  const head = ru ? `**По вашим чатам (${chats.length}):**` : `**From your chats (${chats.length}):**`
  const lines = chats.slice(0, 5).map((m) => `- **${links ? `[${m[2]}](chat:${m[1]})` : m[2]}** — ${(m[4] ?? "").trim() || (ru ? "без страницы" : "no page")} *(${m[3].slice(0, 10)})*`)
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
    // A conversation's title first (quick insert sends the one around the field: "Conversation: Maria Keller").
    name: text.match(/^Conversation: ([A-ZА-ЯЁ][a-zа-яё]+)/m)?.[1] ?? text.match(/(?:Здравствуйте|Привет|Добрый день|Hi|Hello|Dear),?\s+([A-ZА-ЯЁ][a-zа-яё]+)/)?.[1] ?? text.match(/^([A-ZА-ЯЁ][a-zа-яё]+)(?:\s+[A-ZА-ЯЁ][a-zа-яё]+)?:/m)?.[1] ?? "",
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

// Page watch's scripted Haiku: the price from the page's markup when it's there, a threshold when the words
// have a number ("below 40"), any change otherwise; after a change, met unless the words say a number it isn't under.
function scriptedWatch(system: string, content: string): unknown {
  const words = content.match(/in their words: (.*)/)?.[1] ?? ""
  const between = (tag: string) => content.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? ""
  if (system.startsWith("Someone on a web page")) {
    const selection = between("selection")
    const price = /\d/.test(selection) && /[€$£¥₽]/.test(selection)
    const n = Number(words.match(/(\d+(?:[.,]\d+)?)/)?.[1]?.replace(",", "."))
    return {
      what: !selection ? "page" : price ? "price" : /stock|sold|налич/i.test(selection) ? "stock" : "status",
      source: !selection ? "page" : price && content.includes("- ld-price:") ? "ld-price" : "text",
      rule: price && n && /below|under|ниже|меньше|дешевле/i.test(words) ? { kind: "below", n } : { kind: "change" },
      label: !selection ? "The page" : price ? "Price" : /stock|sold|налич/i.test(selection) ? "Availability" : "Status",
      site: /shop|localhost/.test(content) ? "shop" : "other"
    }
  }
  const now = between("now")
  return { met: true, line: `Now: ${now}` }
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://db.local/rest/v1/rpc/")) {
    const fn = url.split("/rpc/")[1].split("?")[0]
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return new Response(JSON.stringify(rpc[fn]?.(body) ?? null), { headers: { "Content-Type": "application/json" } })
  }
  // Read aloud (2.6): a tone as long as the text takes to say (about 14 characters a second), in three pieces.
  if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
    const body = JSON.parse(String(init?.body))
    const text = String(body.input?.[0]?.content?.[0]?.text ?? "")
    const samples = Math.max(2400, Math.round((text.length / 14) * 24_000))
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i / 24_000) * 2 * Math.PI * 330) * 6000 * Math.min(1, (samples - i) / 2400)), i * 2)
    const third = Math.ceil(pcm.length / 6) * 2
    const frames = [0, 1, 2].map((k) => pcm.subarray(k * third, (k + 1) * third)).filter((b) => b.length).map((b) =>
      `event: step.delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "audio", data: b.toString("base64") }, event_type: "step.delta" })}\n\n`)
    frames.push(`event: interaction.completed\ndata: ${JSON.stringify({ interaction: { status: "completed", usage: { total_input_tokens: Math.ceil(text.length / 4), total_output_tokens: Math.round((samples / 24_000) * 25) } }, event_type: "interaction.completed" })}\n\n`)
    return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } })
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
    if (!url.includes(":streamGenerateContent")) return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }))
    const body = JSON.parse(String(init?.body))
    return geminiStream(body.contents[body.contents.length - 1].parts[0].text)
  }
  // Organizing (2.5): vectors from the words of a text (texts sharing words are alike), so the stand's chats get
  // suggestions without OpenAI; the tag check says yes to every candidate.
  if (url === "https://api.openai.com/v1/embeddings") {
    const body = JSON.parse(String(init?.body))
    const data = (body.input as string[]).map((text, index) => ({ index, embedding: wordVector(text, body.dimensions) }))
    return new Response(JSON.stringify({ data, usage: { total_tokens: data.length * 40 } }), { headers: { "Content-Type": "application/json" } })
  }
  // Organizing's tag check: not streamed; it asks for a JSON format too (netlify/shared/organize.mts TAG_SCHEMA),
  // so it is told from quick insert's and page watch's by its system prompt.
  const judging = (b: { stream?: boolean; system?: unknown; output_config?: { format?: unknown } }) =>
    !b.stream && (!b.output_config?.format || String(b.system).startsWith("You help a person keep their own tags"))
  // Organizing's chat name (2.6): the first question's first words, and a name never "fits" (so the stand renames).
  if (url.startsWith("https://api.anthropic.com/v1/messages") && String(JSON.parse(String(init?.body)).system).startsWith("You name a person's chat")) {
    const body = JSON.parse(String(init?.body))
    const question = /(?:Question|Note): (.+)/.exec(String(body.messages[0].content))?.[1] ?? "Chat"
    const title = question.split(/\s+/).slice(0, 4).join(" ").replace(/[?.!,]+$/, "")
    return new Response(JSON.stringify({ id: "msg_name", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ fits: false, title: `Topic: ${title}` }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 20 } }), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages") && judging(JSON.parse(String(init?.body)))) {
    const body = JSON.parse(String(init?.body))
    const tags = [...String(body.messages[0].content).matchAll(/<examples tag="([^"]+)">/g)].map((m) => ({ tag: m[1], fits: true, confidence: 0.9 }))
    return new Response(JSON.stringify({ id: "msg_judge", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ tags }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1600, output_tokens: 40 } }), { headers: { "Content-Type": "application/json" } })
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    const body = JSON.parse(String(init?.body))
    lastClaudeRequest = { model: body.model, max_tokens: body.max_tokens, output_config: body.output_config, thinking: body.thinking ?? null, fallbacks: body.fallbacks }
    // Quick insert and page watch (JSON answers, not streamed): a scripted Haiku.
    if (body.output_config?.format) {
      const system = String(body.system)
      const answer = system.startsWith("Someone on a web page") || system.startsWith("A value someone watches")
        ? scriptedWatch(system, String(body.messages[0].content))
        : scriptedInsert(system, String(body.messages[0].content))
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
        if (FIRST_WORD_DELAY_MS) await new Promise((r) => setTimeout(r, FIRST_WORD_DELAY_MS))
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
        if (FIRST_WORD_DELAY_MS) await new Promise((r) => setTimeout(r, FIRST_WORD_DELAY_MS))
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

/** A stand-in embedding: each word (its first 5 letters, lower case) adds to a few of `dims` numbers. */
function wordVector(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    let hash = 2166136261
    for (const ch of word.slice(0, 5)) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0
    v[hash % dims] += 1
    v[(hash >>> 8) % dims] += 0.5
  }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

// PREVIEW_PLAN=pro (or byok): requests carry a subscription signed with the test chain (trusted here only).
let proJws: string | null = null
if (process.env.PREVIEW_PROMO === "1") {
  const { generateKeyPairSync } = await import("node:crypto")
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  process.env.PROMO_OFFER_ID = "byok_upgrade"
  process.env.PROMO_KEY_ID = "STANDKEY01"
  process.env.PROMO_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
}
if (process.env.PREVIEW_PLAN === "pro" || process.env.PREVIEW_PLAN === "byok" || process.env.PREVIEW_PLAN === "ultra") {
  const { signJws, transaction, TEST_ROOT_FINGERPRINT } = await import("../../tests/helpers.mts")
  // The test chain is only accepted in tests: this local stand counts as one.
  process.env.NODE_ENV = "test"
  ;(await import("../../netlify/shared/apple.mts")).setTrustedRootFingerprintForTests(TEST_ROOT_FINGERPRINT)
  proJws = signJws(transaction(process.env.PREVIEW_PLAN === "byok"
    ? { productId: "com.contextflow.byok.monthly", originalTransactionId: "2000000777", expiresDate: Date.now() + 30 * 86_400_000 }
    : process.env.PREVIEW_PLAN === "ultra"
      ? { productId: "com.contextflow.ultra.monthly", originalTransactionId: "2000000888", expiresDate: Date.now() + 30 * 86_400_000 }
      : { expiresDate: Date.now() + 30 * 86_400_000 }))
}

const chat = (await import("../../netlify/functions/v2-chat.mts")).default
const status = (await import("../../netlify/functions/v2-status.mts")).default
const event = (await import("../../netlify/functions/v2-event.mts")).default
const find = (await import("../../netlify/functions/v2-find.mts")).default
const promo = (await import("../../netlify/functions/v2-promo.mts")).default
const insert = (await import("../../netlify/functions/v2-insert.mts")).default
const organize = (await import("../../netlify/functions/v2-organize.mts")).default
const watch = (await import("../../netlify/functions/v2-watch.mts")).default
const localSpeak = (await import("../../netlify/functions/v2-speak.mts")).default
const localScript = (await import("../../netlify/functions/v2-speak-script.mts")).default
const speakHeard = (await import("../../netlify/functions/v2-speak-heard.mts")).default
// Read aloud with the real voices (and the real text for listening): the deploy preview answers, this stand signs each
// request as Ultra for it.
const proxied = async (path: string, base = process.env.SPEAK_PROXY): Promise<typeof chat | null> => {
  if (!base || !process.env.SPEAK_EVAL_KEY) return null
  const { createPrivateKey, sign } = await import("node:crypto")
  const key = createPrivateKey(readFileSync(process.env.SPEAK_EVAL_KEY))
  return (async (req: Request) => {
    const text = await req.text()
    const installId = String(JSON.parse(text).installId ?? "")
    const at = Date.now()
    const signature = sign(null, Buffer.from(`${installId}.${at}`), key).toString("base64url")
    // A dropped connection to the preview is the device's network trouble, not the stand's end.
    const res = await realFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-cf-eval": `${at}.${signature}` }, body: text })
      .catch(() => Response.json({ code: "UPSTREAM" }, { status: 502 }))
    // fetch has already unpacked a compressed body: passing Netlify's Content-Encoding on would break it in the browser.
    const headers = new Headers(res.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(res.body, { status: res.status, headers })
  }) as typeof chat
}
const speakAny: typeof chat = (await proxied("/api/v2/speak")) ?? localSpeak
const organizeAny: typeof chat = (await proxied("/api/v2/organize", process.env.ORGANIZE_PROXY)) ?? organize
// SPEAK_FAIL_FROM_PART=1: every part from that one on fails (502), as a lost connection mid-text would (build 90: the
// device must stop in the same voice and offer "Try again", never hand the rest to another voice).
const speak: typeof chat = (async (req: Request, context: Parameters<typeof chat>[1]) => {
  const failFrom = Number(process.env.SPEAK_FAIL_FROM_PART ?? NaN)
  if (!Number.isFinite(failFrom)) return speakAny(req, context)
  const text = await req.text()
  const part = Number(JSON.parse(text || "{}").part ?? 0)
  if (part >= failFrom) return Response.json({ code: "UPSTREAM", message: "Read aloud is busy. Please try again in a moment." }, { status: 502 })
  return speakAny(new Request(req.url, { method: req.method, headers: req.headers, body: text }), context)
}) as typeof chat
const speakScript: typeof chat = (await proxied("/api/v2/speak-script")) ?? localScript
const STATUS_DELAY_MS = Number(process.env.STATUS_DELAY_MS ?? 0)
const statusLate: typeof chat = (async (req: Request, context: Parameters<typeof chat>[1]) => {
  if (STATUS_DELAY_MS) await new Promise((r) => setTimeout(r, STATUS_DELAY_MS))
  return status(req, context)
}) as typeof chat
const handlers: Record<string, typeof chat> = { "/api/v2/speak": speak, "/api/v2/speak-script": speakScript, "/api/v2/speak-heard": speakHeard, "/api/v2/chat": chat, "/api/v2/status": statusLate, "/api/v2/event": event, "/api/v2/find": find, "/api/v2/promo": promo, "/api/v2/insert": insert, "/api/v2/organize": organizeAny, "/api/v2/watch": watch }

// Page watch's test shop (2.5): /shop shows a mug whose price and stock /shop-set changes
// (/shop-set?price=39&stock=OutOfStock), /shop-js draws the price with a script (the background sees none, the
// open page does), /shop-blocked answers 403 like a bot check. ?sel=1 selects the price, as a finger would.
const shop = { price: "49.85", stock: "InStock" }
const shopPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mug · Test shop</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Mug", offers: { "@type": "Offer", price: shop.price, priceCurrency: "EUR", availability: `https://schema.org/${shop.stock}` } })}</script>
<style>body{font:18px -apple-system,sans-serif;margin:24px;line-height:1.5}b{font-size:28px}</style></head>
<body><h1>Handmade mug</h1><p>A blue ceramic mug, 350 ml.</p><p>Price <b>${shop.price.replace(".", ",")} €</b></p>
<p>${shop.stock === "InStock" ? "In stock" : "Sold out"}</p><p>Free delivery over 50 €.</p>
<script>if (location.search.includes("sel=1")) setTimeout(() => getSelection().selectAllChildren(document.querySelector("b")), 600)</script></body></html>`

const pages: Record<string, string> = {
  "/": "article.html",
  "/article": "article.html",
  "/article-ru": "article-ru.html",
  "/article-2": "article-2.html",
  "/article-2-ru": "article-2-ru.html",
  "/pdf-embed": "pdf-embed.html",
  "/pdf-link": "pdf-link.html",
  "/lecture": "lecture.html",
  "/lecture-ru": "lecture-ru.html",
  // The Tips takes of 2.5 (tools/store/tips-record.mjs): a message to answer, an order with a number to copy, a price.
  "/inbox": "inbox.html",
  "/inbox-ru": "inbox-ru.html",
  "/order": "order.html",
  "/order-ru": "order-ru.html",
  "/product": "product.html",
  "/product-ru": "product-ru.html",
  // An investor page with its quarterly report as a PDF (store-pages: the screens about PDFs).
  "/report": "report.html",
  "/report-ru": "report-ru.html",
  // Quick insert's fields inside open shadow roots, and the same editor outside them (the owner, 2.5 (77): LinkedIn).
  "/shadow-fields": "shadow-fields.html",
  // The reply box of private messages (the owner, 2.5 (77): "it was in chats"): ?layout=page|overlay.
  "/messaging": "messaging.html",
  // A site that switches sections without loading a page (the owner, 2.5 (78): LinkedIn's feed → post → messages).
  "/spa/messaging": "spa.html",
  "/spa/feed": "spa.html",
  // The article under a strict Content-Security-Policy for media and images, like GitHub's or LinkedIn's: the Tips
  // sheet's clips are the extension's own files and must still play (2.5 (81)).
  "/strict": "article.html",
  "/strict-ru": "article-ru.html",
  // A window shown over everything: a modal <dialog>, one in a shadow root, a popover (the owner, 2.5 (81)).
  "/modal": "modal.html"
}

// Pages served with a strict policy for media and images (nothing from another origin, not even blob: or data:).
const strict = new Set(["/strict", "/strict-ru"])
const STRICT_CSP = "media-src 'self'; img-src 'self'"

// PDFs for the PDF checks. private.pdf only with the cookie pdf-link.html sets, like a PDF behind a sign-in.
const pdfs: Record<string, string> = {
  "/files/report.pdf": "files/report.pdf",
  "/files/scan.pdf": "files/scan.pdf",
  "/files/private.pdf": "files/report.pdf",
  "/files/q3-report.pdf": "files/q3-report.pdf",
  "/files/q3-report-ru.pdf": "files/q3-report-ru.pdf"
}

// Find similar (2.6): a scripted answer in /api/v2/similar's own events (the real engine needs the web and our keys,
// tools/similar/eval.mts runs it on a deploy preview). Find similar is Ultra's: without PREVIEW_PLAN=ultra, PRO_ONLY.
const SIMILAR_STEP_MS = Number(process.env.SIMILAR_STEP_MS ?? 700)
function similarItems(condition: string, ru = false) {
  const cond = Boolean(condition.trim())
  // A Russian page (/product-ru) gets the same list written in Russian, its prices against the page's 12 990 ₽ (the
  // Tips clip in Russian; the real engine answers in the person's language).
  if (ru) return [
    { name: "Soundcore Space One", why: "Накладные, с адаптивным шумоподавлением и LDAC, как Aero 2, но с более мягким и лёгким оголовьем.", fit: cond ? "Дешевле: 9 990 ₽ против 12 990 ₽, в наличии." : "", met: cond ? "yes" : "n/a", url: "https://www.soundcore.com/products/space-one-a3035011", host: "soundcore.com", title: "Space One", source: "item", checked: true, price: "9990 RUB", stock: "in", watch: { source: "ld-price", value: "9990 RUB" } },
    { name: "Sony WH-CH720N", why: "Лёгкие наушники с шумоподавлением и похожей батареей на 35 часов; кодеков меньше.", fit: cond ? "Дешевле: 8 990 ₽ против 12 990 ₽, в наличии." : "", met: cond ? "yes" : "n/a", url: "https://electronics.sony.com/audio/headphones/all-headphones/p/whch720n-b", host: "electronics.sony.com", title: "WH-CH720N", source: "item", checked: true, price: "8990 RUB", stock: "in", date: "2026-08-14", watch: { source: "ld-price", value: "8990 RUB" } },
    { name: "JLab JBuds Lux ANC", why: "Недорогой вариант с активным шумоподавлением и эквалайзером в приложении, из свежей подборки.", fit: cond ? "На странице нет цены, так что «дешевле» не подтверждено." : "", met: cond ? "unknown" : "n/a", url: "https://www.soundguys.com/best-budget-noise-cancelling-headphones-7142/", host: "soundguys.com", title: "Лучшие недорогие наушники с шумоподавлением", source: "list", checked: true, date: "2026-10-02" },
    { name: "EarFun Wave Pro", why: "LDAC и мультипойнт, как у Aero 2, и батарея держит дольше.", fit: cond ? "Магазин не пускает серверы на страницу, так что цена и наличие не подтверждены." : "", met: cond ? "unknown" : "n/a", url: "https://www.amazon.com/dp/B0CSKDX2SQ", host: "amazon.com", title: "EarFun Wave Pro", source: "item", checked: false }
  ]
  return [
    { name: "Soundcore Space One", why: "Over-ear, adaptive noise cancelling and LDAC like the Aero 2, with a softer, lighter headband.", fit: cond ? "Cheaper: $99.99 against $129, in stock." : "", met: cond ? "yes" : "n/a", url: "https://www.soundcore.com/products/space-one-a3035011", host: "soundcore.com", title: "Space One", source: "item", checked: true, price: "99.99 USD", stock: "in", watch: { source: "ld-price", value: "99.99 USD" } },
    { name: "Sony WH-CH720N", why: "Light noise-cancelling headphones with a similar 35-hour battery; fewer codecs.", fit: cond ? "Cheaper: $89.99 against $129, in stock." : "", met: cond ? "yes" : "n/a", url: "https://electronics.sony.com/audio/headphones/all-headphones/p/whch720n-b", host: "electronics.sony.com", title: "WH-CH720N", source: "item", checked: true, price: "89.99 USD", stock: "in", date: "2026-08-14", watch: { source: "ld-price", value: "89.99 USD" } },
    { name: "JLab JBuds Lux ANC", why: "A budget pick with active noise cancelling and app EQ, named in a recent round-up.", fit: cond ? "The page shows no price, so cheaper isn't confirmed." : "", met: cond ? "unknown" : "n/a", url: "https://www.soundguys.com/best-budget-noise-cancelling-headphones-7142/", host: "soundguys.com", title: "Best budget noise-cancelling headphones", source: "list", checked: true, date: "2026-10-02" },
    { name: "EarFun Wave Pro", why: "LDAC and multipoint like the Aero 2, with a longer battery.", fit: cond ? "The shop doesn't let servers open the page, so price and stock aren't confirmed." : "", met: cond ? "unknown" : "n/a", url: "https://www.amazon.com/dp/B0CSKDX2SQ", host: "amazon.com", title: "EarFun Wave Pro", source: "item", checked: false }
  ]
}
async function similarStub(body: Record<string, unknown>, res: import("node:http").ServerResponse) {
  if (process.env.PREVIEW_PLAN !== "ultra") {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: "PRO_ONLY", plan: "free", feature: "similar" }))
    return
  }
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" })
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`)
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const condition = typeof body.condition === "string" ? body.condition : ""
  const ru = /[а-яё]/i.test(`${condition} ${typeof body.selection === "string" ? body.selection : ""} ${JSON.stringify(body.page ?? "").slice(0, 400)}`)
  send({ type: "progress", step: "plan" })
  await wait(SIMILAR_STEP_MS)
  send({ type: "progress", step: "search", queries: [ru ? "беспроводные наушники с шумоподавлением как Aero 2" : "wireless noise cancelling headphones like Aero 2"] })
  await wait(SIMILAR_STEP_MS * 2)
  send({ type: "progress", step: "check", pages: 12 })
  await wait(SIMILAR_STEP_MS)
  send({ type: "progress", step: "write", verified: 9 })
  const items = similarItems(condition, ru)
  for (const [i, item] of items.entries()) {
    await wait(SIMILAR_STEP_MS * 0.7)
    send({ type: "item", engine: "a", index: i, item })
  }
  await wait(200)
  const intro = ru ? "Беспроводные наушники с шумоподавлением, похожие на Aero 2; каждую страницу мы только что открыли и проверили." : "Wireless noise-cancelling headphones like the Aero 2, each page opened and checked just now."
  send({ type: "result", engine: "a", intro, items, note: "", condition: condition ? "cheaper" : "none" })
  send({ type: "done", ms: 9000, usd: 0 })
  res.end()
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/api/v2/similar" && req.method === "POST") {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { /* not JSON */ }
    aiRequests.push(url.pathname)
    lastSimilarRequest = body
    await similarStub(body, res)
    return
  }
  if (url.pathname === "/last-similar") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastSimilarRequest))
    return
  }
  const handler = handlers[url.pathname] ?? null
  if (handler) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    if (url.pathname === "/api/v2/chat" || url.pathname === "/api/v2/find") aiRequests.push(url.pathname)
    if (url.pathname === "/api/v2/event") {
      try {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        // A feature step: "use:tour.step:pick" (f.a and what).
        const what = sent.kind === "use" ? `${sent.f}.${sent.a}` : sent.media ?? sent.where ?? sent.reason ?? sent.action ?? ""
        panelEvents.push(`${sent.kind}:${what}${sent.what ? `:${sent.what}` : ""}`)
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
    const t0 = Date.now()
    const response = await handler(request, { ip: "127.0.0.1", waitUntil: () => undefined } as any)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    let bytes = 0
    // Read aloud's minutes as the server counts them (build 92: what's heard), for the stand's log.
    const heardReply: Buffer[] = []
    if (response.body) for await (const c of response.body as any) {
      bytes += c.length
      res.write(c)
      if (url.pathname === "/api/v2/speak-heard") heardReply.push(Buffer.from(c))
    }
    res.end()
    if (process.env.STAND_LOG === "1") {
      const usage = response.headers.get("X-CF-Usage") ?? (heardReply.length ? Buffer.concat(heardReply).toString() : "")
      console.log(`${new Date().toISOString().slice(11, 19)} ${url.pathname} ${response.status} ${bytes} B ${Date.now() - t0} ms${usage ? ` ${usage}` : ""}`)
    }
    return
  }
  // The audit's pages (2.5): fields whose site keeps its own buttons inside them (a search like Amazon's, a
  // comment's Send), and a news story with a publication date, a "shipped" in its text and an event's date.
  // ?sel=<id> selects that element, as a finger would.
  if (url.pathname === "/fields" || url.pathname === "/news" || url.pathname === "/prices") {
    const sel = `<script>const id = new URLSearchParams(location.search).get("sel"); if (id) setTimeout(() => getSelection().selectAllChildren(document.getElementById(id)), 600)</script>`
    const fields = `<h1>Fields</h1>
<form role="search" style="position:relative;margin:24px 0"><input id="search" name="q" placeholder="Search" style="width:100%;box-sizing:border-box;height:44px;font-size:17px;padding:0 56px 0 12px">
<button id="go" style="position:absolute;right:0;top:0;width:48px;height:44px;background:#f90;border:0">Go</button></form>
<p>Leave a comment</p>
<div style="position:relative"><textarea id="comment" rows="4" style="width:100%;box-sizing:border-box;font-size:17px;padding:10px 70px 10px 10px"></textarea>
<button id="send" style="position:absolute;right:8px;bottom:12px;height:32px">Send</button></div>
<p style="margin-top:40px">Your name</p><input id="name" type="text" style="width:100%;box-sizing:border-box;height:40px;font-size:17px">
<p>Email</p><input id="email" type="email" style="width:100%;box-sizing:border-box;height:40px;font-size:17px">`
    const news = `<p class="meta">By Anna Lee · <span id="pubdate">3 November 2026</span> · 4 min read</p>
<h1>The phone that started it all</h1>
<p>The company <span id="shipped">shipped</span> its first phone in 2007 and the line still sells for <span id="price">$1,299</span>.</p>
<p>Tickets go on sale <span id="sale">12 December</span> at 10:00 for the anniversary event.</p>
<p>Order #4471 · <span id="status">Shipped</span></p>`
    // Prices with a code instead of a symbol (the owner, build 75); "n1" is the number alone, as a tap selects it.
    const prices = `<h1>Prices</h1>
<p>Monthly plan. Price: USD <span id="n1">40</span> per month, billed yearly.</p>
<p id="eur">40 EUR</p>
<p id="rub">1 299 RUB</p>
<p id="chf">CHF 12.50</p>
<p>A paragraph to select for the bubble's place: the four-day week kept revenue flat in most trials while cutting burnout, and the teams that cut meetings first gained the most. <span id="long">Most teams halved their recurring meetings and kept them under thirty minutes.</span></p>`
    const page = url.pathname === "/fields" ? fields : url.pathname === "/news" ? news : prices
    const name = url.pathname === "/fields" ? "Fields" : url.pathname === "/news" ? "News" : "Prices"
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} · Test</title>
<style>body{font:18px -apple-system,sans-serif;margin:24px 16px;line-height:1.5}</style></head><body>${page}${sel}</body></html>`)
    return
  }
  if (url.pathname === "/shop-js") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lamp · Test shop</title>
<style>body{font:18px -apple-system,sans-serif;margin:24px;line-height:1.5}b{font-size:28px}</style></head>
<body><h1>Desk lamp</h1><p>A small brass lamp.</p><p id="p">…</p><p>Free delivery over 50 €.</p>
<script>setTimeout(() => { document.getElementById("p").innerHTML = "Price <b>${shop.price.replace(".", ",")} €</b>" }, 300)
if (location.search.includes("sel=1")) setTimeout(() => getSelection().selectAllChildren(document.querySelector("b")), 900)</script></body></html>`)
    return
  }
  if (url.pathname === "/shop" || url.pathname === "/shop-blocked") {
    res.writeHead(url.pathname === "/shop" ? 200 : 403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(url.pathname === "/shop" ? shopPage() : "<!doctype html><title>Access denied</title><h1>Access denied</h1>")
    return
  }
  if (url.pathname === "/shop-set") {
    shop.price = url.searchParams.get("price") ?? shop.price
    shop.stock = url.searchParams.get("stock") ?? shop.stock
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(shop))
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
    tours.clear()
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
  // The report's first page as a picture (report.html shows it, the PDF itself sits in an <embed>).
  if (/^\/files\/[\w-]+\.png$/.test(url.pathname)) {
    res.writeHead(200, { "Content-Type": "image/png" })
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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(strict.has(url.pathname) ? { "Content-Security-Policy": STRICT_CSP } : {}) })
  res.end(readFileSync(new URL(`./${file}`, import.meta.url)))
}).listen(Number(process.env.PORT ?? 8787), () => console.log("preview on http://localhost:" + (process.env.PORT ?? 8787)))
