// Whole pages (2.5, the owner's decision): a question goes with all of its page's text, not its first 24 000
// characters. The text is cut only where the hosting or the model leave no choice, at a paragraph, with GAP
// at the end (and the system prompt then tells the model not to talk about it):
// - the request: a Netlify function takes a body of at most 6 MB (buffered, not configurable), so the panel
//   sends at most MAX_PAGE_BODY_BYTES of page text, leaving room for the history, other pages, a video's
//   transcript and PDFs;
// - the model: Claude Sonnet 5.5 reads 1M tokens; the page gets PAGE_TOKENS of them, after the rules, the
//   history, other pages and the answer. GPT (answers when Claude can't, and the user's own OpenAI key) gets
//   OPENAI_PAGE_TOKENS.

/** What's put where page text was cut. */
export const GAP = "[…]"
export const MAX_PAGE_BODY_BYTES = 4_000_000
export const PAGE_TOKENS = 850_000
export const OPENAI_PAGE_TOKENS = 200_000

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/

/**
 * Tokens a text takes, on the high side (there's no tokenizer here): about 3.3 characters a token in Latin
 * script, 2 in Cyrillic and other alphabets, under one in Chinese, Japanese and Korean.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else if (CJK.test(ch)) cjk++
    else other++
  }
  return Math.ceil(ascii * 0.3 + other * 0.5 + cjk * 1.2)
}

/** The text cut to `chars` at the last paragraph (or line, or sentence) before it, with GAP after. */
function cutAt(text: string, chars: number): string {
  const head = text.slice(0, Math.max(0, chars))
  const at = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(". ")].find((i) => i > chars * 0.8) ?? head.length
  return `${head.slice(0, at).trimEnd()}\n${GAP}`
}

/** The page's text within `maxTokens` (see estimateTokens); `cut`: something was left out. */
export function fitTokens(text: string, maxTokens: number): { text: string; cut: boolean } {
  const tokens = estimateTokens(text)
  if (tokens <= maxTokens) return { text, cut: false }
  // Proportionally, then shorter until it fits (a text's script can change along the way).
  let chars = Math.floor((text.length * maxTokens) / tokens)
  let out = cutAt(text, chars)
  while (estimateTokens(out) > maxTokens && chars > 0) {
    chars = Math.floor(chars * 0.95)
    out = cutAt(text, chars)
  }
  return { text: out, cut: true }
}

/** The page's text within `maxBytes` as it goes in a request (JSON, UTF-8): the panel's part of the body limit. */
export function fitBodyBytes(text: string, maxBytes = MAX_PAGE_BODY_BYTES): string {
  const bytes = (s: string) => new TextEncoder().encode(JSON.stringify(s)).length
  const size = bytes(text)
  if (size <= maxBytes) return text
  let chars = Math.floor((text.length * maxBytes) / size)
  let out = cutAt(text, chars)
  while (bytes(out) > maxBytes && chars > 0) {
    chars = Math.floor(chars * 0.95)
    out = cutAt(text, chars)
  }
  return out
}

/**
 * How many answers a question counts as (the owner's rule, 2.5): one for every WEIGHT_CHARS characters the model
 * gets about the page (with its PDFs and video transcript), at least one. The server decides (weight.mts); the
 * panel shows the same number by its field before the question is sent.
 */
export const WEIGHT_CHARS = 200_000

export function answerWeight(chars: number): number {
  return Math.max(1, Math.ceil(chars / WEIGHT_CHARS))
}
