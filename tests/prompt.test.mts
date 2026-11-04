import { test } from "node:test"
import assert from "node:assert/strict"

import { MULTI_PAGE_RULE, systemPrompt, systemPromptParts } from "../src/shared/prompt.ts"
import { googlePrompt } from "../netlify/shared/google.mts"

const page = (name: string, text: string) => ({ kind: "page" as const, title: name, url: `https://example.com/${name}`, text })
const tabs = page("tabs", "Safari 27 adds vertical tabs: Settings → Tabs → Vertical Tabs.")

test("earlier answers about another page are trusted, not taken back; the quotes rule is about the answer written now", () => {
  // 2.5: after a move to another page the model "corrected" its right answers about the essay before, since
  // the quote in them wasn't on the page it had now.
  const prompt = systemPrompt(tabs, "", "en")
  assert.match(prompt, /Your earlier answers to questions asked on another page were written from that page's text, which you are not given now/)
  assert.match(prompt, /don't correct, doubt or take them back because that text isn't here/)
  assert.match(prompt, /say in one short sentence that you'd need that page open to answer from it, and don't guess/)
  assert.match(prompt, /Never invent quotes, numbers or links that are not in the page\. This is about what you write now about the page the user is on/)
  assert.ok(googlePrompt(tabs, "", "en").includes(MULTI_PAGE_RULE), "Google mode shares the rule")
})

test("the rule is in the cached part, the same for a page whether or not the chat spans pages", () => {
  const [alone, restAlone] = systemPromptParts(tabs, "", "en")
  const [spanning, restSpanning] = systemPromptParts(tabs, "", "en", [page("essay", "The essay ends on its last line.")])
  assert.ok(alone.includes(MULTI_PAGE_RULE))
  assert.equal(spanning, alone)
  assert.ok(!restAlone.includes("essay") && restSpanning.includes("essay"))
})
