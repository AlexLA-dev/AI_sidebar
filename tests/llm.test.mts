import assert from "node:assert/strict"
import { test } from "node:test"

import { readDeltas, sanitizeMessages, sanitizeOtherPages, sanitizePage, systemPrompt, type StreamStats } from "../netlify/shared/llm.mts"

test("sanitizeMessages keeps the last turns and requires a final user message", () => {
  assert.equal(sanitizeMessages([]), null)
  assert.equal(sanitizeMessages([{ role: "assistant", content: "hi" }]), null)
  assert.equal(sanitizeMessages([{ role: "system", content: "x" }, { role: "user", content: "q" }]), null)
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }))
  many.push({ role: "user", content: "last" })
  const out = sanitizeMessages(many)
  assert.equal(out?.length, 12)
  assert.equal(out?.at(-1)?.content, "last")
})

test("sanitizePage ignores empty pages and clips text", () => {
  assert.equal(sanitizePage({ text: "   " }), null)
  const page = sanitizePage({ kind: "selection", title: "T", url: "https://x", text: "a".repeat(100_000) })
  assert.equal(page?.kind, "selection")
  assert.ok((page?.text.length ?? 0) <= 24_001)
})

test("systemPrompt fences page content and truncates selections", () => {
  const prompt = systemPrompt({ kind: "selection", title: "T", url: "u", text: "b".repeat(20_000) }, "I am a designer", "ru-RU")
  assert.match(prompt, /<<<PAGE/)
  assert.match(prompt, /content truncated/)
  assert.match(prompt, /I am a designer/)
  assert.match(prompt, /untrusted data/)
  assert.match(systemPrompt(null, "", "en"), /No page content/)
})

test("readDeltas parses OpenAI SSE including split chunks and usage", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"lo"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n"
  ]
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f))
      c.close()
    }
  })
  const stats: StreamStats = { promptTokens: 0, completionTokens: 0, chars: 0 }
  let text = ""
  for await (const d of readDeltas(body, stats)) text += d
  assert.equal(text, "Hello")
  assert.deepEqual(stats, { promptTokens: 11, completionTokens: 2, chars: 5 })
})

test("the prompt says when the page changed and how multi-page conversations look", () => {
  const changed = sanitizePage({ kind: "page", title: "T", url: "https://x", text: "New text", changed: true })
  assert.equal(changed?.changed, true)
  assert.equal(sanitizePage({ kind: "page", title: "T", url: "https://x", text: "t", changed: "yes" })?.changed, false)
  const prompt = systemPrompt(changed, "", "en")
  assert.match(prompt, /it has changed since the earlier messages/)
  assert.match(prompt, /Asked on another page/)
  assert.doesNotMatch(systemPrompt(sanitizePage({ kind: "page", title: "T", url: "u", text: "t" }), "", "en"), /has changed/)
})

test("a whole-chat request keeps the long history within a budget and the chat's other pages", () => {
  const turns = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i} ` + "y".repeat(2_000) }))
  assert.equal(sanitizeMessages(turns)?.length, 12)
  const whole = sanitizeMessages(turns, true)!
  assert.ok(whole.length > 12 && whole.length <= 41)
  assert.ok(whole.reduce((n, m) => n + m.content.length, 0) <= 60_000)
  assert.ok(whole[whole.length - 1].content.startsWith("m40 "))

  const pages = sanitizeOtherPages([
    { title: "One", url: "https://1.example", text: "first page ".repeat(2_000) },
    { title: "Empty", url: "https://e.example", text: "  " },
    { title: "Two", url: "https://2.example", text: "second" },
    { title: "Three", url: "https://3.example", text: "third" },
    { title: "Four", url: "https://4.example", text: "fourth" }
  ])
  assert.deepEqual(pages.map((p) => p.title), ["One", "Two", "Three"])
  assert.ok(pages[0].text.length <= 8_001)
  const prompt = systemPrompt({ kind: "page", title: "Now", url: "https://now.example", text: "current" }, "", "en", pages)
  assert.match(prompt, /Other pages from this conversation/)
  assert.match(prompt, /Title: Two\nURL: https:\/\/2\.example\n<<<PAGE\nsecond\nPAGE>>>/)
  assert.match(prompt, /\[Note the user wrote …\] is a note/)
  assert.doesNotMatch(systemPrompt(null, "", "en"), /Other pages/)
})
