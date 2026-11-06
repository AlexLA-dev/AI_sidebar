import { test } from "node:test"
import assert from "node:assert/strict"

import { estimateTokens, fitBodyBytes, fitTokens, GAP, PAGE_TOKENS } from "../src/shared/pagefit.ts"
import { CUT_RULE, MAX_PAGE_CHARS, systemPrompt, systemPromptParts } from "../src/shared/prompt.ts"
import { answerCost } from "../netlify/shared/answer.mts"

const para = (n: number, word = "procrastination") => Array.from({ length: n }, (_, i) => `Paragraph ${i}: people delay ${word} for many reasons, and the study lists them.`).join("\n\n")
const page = (text: string, kind: "page" | "selection" = "page") => ({ kind, title: "P", url: "https://example.com/p", text })

test("tokens are counted on the high side, more for Cyrillic and most for Chinese, Japanese and Korean", () => {
  assert.equal(estimateTokens("a".repeat(1_000)), 300)
  assert.equal(estimateTokens("ж".repeat(1_000)), 500)
  assert.equal(estimateTokens("拖".repeat(1_000)), 1_200)
})

test("a page within its tokens goes whole; past them it's cut at a paragraph, with […] after", () => {
  const short = para(50)
  assert.deepEqual(fitTokens(short, PAGE_TOKENS), { text: short, cut: false })
  const long = para(5_000)
  const fit = fitTokens(long, 20_000)
  assert.equal(fit.cut, true)
  assert.ok(estimateTokens(fit.text) <= 20_000)
  assert.ok(fit.text.endsWith(`them.\n${GAP}`), "cut after a whole paragraph")
  assert.ok(long.startsWith(fit.text.slice(0, -GAP.length - 1)))
})

test("the panel sends at most its share of the request's 6 MB, cut at a paragraph", () => {
  const short = para(100)
  assert.equal(fitBodyBytes(short), short)
  const russian = Array.from({ length: 40_000 }, (_, i) => `Абзац ${i}: люди откладывают дела по разным причинам, и исследование их перечисляет.`).join("\n\n")
  const sent = fitBodyBytes(russian, 1_000_000)
  assert.ok(new TextEncoder().encode(JSON.stringify(sent)).length <= 1_000_000)
  assert.ok(sent.endsWith(`перечисляет.\n${GAP}`))
})

test("the prompt: a long page whole and no word on cutting; a 2.3 / 2.4 page cut at 24 000, or one past the model's limit, gets […] and the rule", () => {
  const long = para(1_500)
  assert.ok(long.length > 100_000)
  const whole = systemPrompt(page(long), "", "en")
  assert.ok(whole.includes(long))
  assert.ok(!whole.includes(CUT_RULE) && !whole.includes(`\n${GAP}\nPAGE>>>`))
  const old = systemPrompt(page("a".repeat(MAX_PAGE_CHARS)), "", "en")
  assert.ok(old.includes(`\n${GAP}\nPAGE>>>`) && old.includes(CUT_RULE))
  assert.ok(!systemPrompt(page("a".repeat(MAX_PAGE_CHARS - 1)), "", "en").includes(CUT_RULE))
  const over = systemPrompt(page(long), "", "en", [], false, false, 5_000)
  assert.ok(over.includes(`them.\n${GAP}\nPAGE>>>`) && over.includes(CUT_RULE))
  const selection = systemPrompt(page("s".repeat(13_000), "selection"), "", "en")
  assert.ok(selection.includes(CUT_RULE))
})

test("the cached part (rules, profile, page) is the same from one question to the next; the time comes after it", () => {
  const [head, rest] = systemPromptParts(page(para(200)), "I'm a nurse", "en-US")
  assert.ok(head.includes("Paragraph 199") && head.includes("I'm a nurse"))
  assert.ok(!head.includes("Current time") && rest.includes("Current time (UTC)"))
  assert.equal(systemPromptParts(page(para(200)), "I'm a nurse", "en-US")[0], head)
})

test("an answer's cost counts cache writes at 1.25 times and reads at a tenth of the input price", () => {
  const claude = { provider: "anthropic" as const }
  // Sonnet 5.5 list prices: $2 in, $10 out per million tokens.
  assert.equal(answerCost(claude, { promptTokens: 10_000, completionTokens: 0, chars: 0 }), 0.02)
  assert.equal(answerCost(claude, { promptTokens: 10_000, cacheWriteTokens: 8_000, completionTokens: 0, chars: 0 }), 0.024)
  assert.equal(answerCost(claude, { promptTokens: 10_000, cacheReadTokens: 8_000, completionTokens: 0, chars: 0 }), 0.0056)
})
