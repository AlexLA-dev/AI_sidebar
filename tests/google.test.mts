import assert from "node:assert/strict"
import { test } from "node:test"

import { buildGrounding, googlePrompt, readGoogle, type GoogleStats } from "../netlify/shared/google.mts"

const SRC = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`
const bytes = (s: string) => Buffer.byteLength(s, "utf8")

test("buildGrounding links each supported passage to its sources, numbered by first citation", () => {
  const text = "Paris is the capital of France. It has about 2 million residents."
  const out = buildGrounding(text, {
    webSearchQueries: ["capital of France", ""],
    searchEntryPoint: { renderedContent: "<div class=\"chip\">capital of France</div>" },
    groundingChunks: [{ web: { uri: SRC("a"), title: "wikipedia.org" } }, { web: { uri: SRC("b"), title: "britannica.com" } }, { web: { uri: "http://insecure.example", title: "x" } }],
    groundingSupports: [
      { segment: { startIndex: 0, endIndex: 31, text: "Paris is the capital of France." }, groundingChunkIndices: [1, 0, 2] },
      { segment: { startIndex: 32, endIndex: 65, text: "It has about 2 million residents." }, groundingChunkIndices: [1] }
    ]
  })
  assert.ok(out)
  assert.equal(out.text, `Paris is the capital of France.[1](${SRC("b")})[2](${SRC("a")}) It has about 2 million residents.[1](${SRC("b")})`)
  assert.deepEqual(out.grounding.sources, [{ title: "britannica.com", url: SRC("b") }, { title: "wikipedia.org", url: SRC("a") }])
  assert.deepEqual(out.grounding.queries, ["capital of France"])
  assert.match(out.grounding.suggestions, /chip/)
})

test("buildGrounding maps UTF-8 byte offsets in non-Latin text and steps over closing Markdown", () => {
  const first = "Столица — **Москва"
  const text = `${first}**. Население около 13 млн человек.`
  const second = "Население около 13 млн человек."
  const start2 = bytes(`${first}**. `)
  const out = buildGrounding(text, {
    groundingChunks: [{ web: { uri: SRC("ru"), title: "" } }],
    groundingSupports: [
      { segment: { startIndex: 0, endIndex: bytes(first), text: first }, groundingChunkIndices: [0] },
      { segment: { startIndex: start2, endIndex: start2 + bytes(second), text: second }, groundingChunkIndices: [0] }
    ]
  })
  assert.equal(out?.text, `Столица — **Москва**[1](${SRC("ru")}). Население около 13 млн человек.[1](${SRC("ru")})`)
  // No title: the source is named after its host.
  assert.equal(out?.grounding.sources[0].title, "vertexaisearch.cloud.google.com")
})

test("buildGrounding falls back to finding the passage when offsets don't match", () => {
  const text = "Intro line.\n\nThe Eiffel Tower is 330 m tall."
  const out = buildGrounding(text, {
    groundingChunks: [{ web: { uri: SRC("e"), title: "toureiffel.paris" } }],
    groundingSupports: [{ segment: { startIndex: 3, endIndex: 9, text: "The Eiffel Tower is 330 m tall." }, groundingChunkIndices: [0] }]
  })
  assert.equal(out?.text, `Intro line.\n\nThe Eiffel Tower is 330 m tall.[1](${SRC("e")})`)
  assert.equal(buildGrounding("plain", null), null)
  assert.equal(buildGrounding("plain", { groundingChunks: [] }), null)
})

test("readGoogle yields answer text, skips thoughts and collects grounding and usage", async () => {
  const frames = [
    { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "Hello " }] } }] },
    { candidates: [{ content: { parts: [{ text: "world" }] }, groundingMetadata: { webSearchQueries: ["hello"] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 } }
  ]
  const body = new Response(frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("")).body as ReadableStream<Uint8Array>
  const stats: GoogleStats = { promptTokens: 0, completionTokens: 0, chars: 0, grounding: null }
  let text = ""
  for await (const t of readGoogle(body, stats)) text += t
  assert.equal(text, "Hello world")
  assert.deepEqual(stats.grounding?.webSearchQueries, ["hello"])
  assert.deepEqual([stats.promptTokens, stats.completionTokens, stats.chars], [50, 10, 11])
})

test("googlePrompt asks for an AI Mode style answer and fences page context", () => {
  const prompt = googlePrompt({ kind: "selection", title: "T", url: "https://x", text: "quantum dot" }, "", "ru-RU")
  assert.match(prompt, /AI Mode/)
  assert.match(prompt, /selected this text/)
  assert.match(prompt, /<<<PAGE\nquantum dot\nPAGE>>>/)
  assert.match(prompt, /untrusted data/)
})
