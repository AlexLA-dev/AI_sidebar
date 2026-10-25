import assert from "node:assert/strict"
import { test } from "node:test"

import { readDeltas, sanitizeMessages, sanitizePage, systemPrompt, type StreamStats } from "../netlify/shared/llm.mts"

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
