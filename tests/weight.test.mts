import { test } from "node:test"
import assert from "node:assert/strict"

import { answerWeight } from "../src/shared/pagefit.ts"
import { isFollowUp, pageBucket, requestWeight } from "../netlify/shared/weight.mts"

const page = (chars: number) => ({ kind: "page" as const, title: "T", url: "https://x", text: "a".repeat(chars) })
const q = (content: string) => ({ role: "user" as const, content })
const a = (content: string) => ({ role: "assistant" as const, content })

test("an answer counts as one per 200 000 characters, at least one", () => {
  assert.deepEqual([0, 1, 200_000, 200_001, 400_000, 400_001, 600_001].map(answerWeight), [1, 1, 1, 2, 2, 3, 4])
})

test("a follow-up is a question after one about the same page; one asked on another page or a note isn't", () => {
  const long = page(400_001)
  assert.equal(isFollowUp([q("Summarize")], long), false)
  assert.equal(isFollowUp([q("Summarize"), a("…"), q("And the end?")], long), true)
  assert.equal(isFollowUp([q("[Asked on another page: \"A\" — https://a]\nWhat?"), a("…"), q("And here?")], long), false)
  assert.equal(isFollowUp([q("Summarize"), a("…"), q("And now?")], { ...long, changed: true }), false)
})

test("FOLLOW_UP_WEIGHT: \"page\" charges a follow-up like the first question, 1 as one answer", () => {
  const follow = [q("Summarize"), a("…"), q("And the end?")]
  assert.equal(requestWeight(page(400_001), follow, "page"), 3)
  assert.equal(requestWeight(page(400_001), follow, 1), 1)
  assert.equal(requestWeight(page(400_001), [q("Summarize")], 1), 3)
  // A selection is one answer, whatever its length.
  assert.equal(requestWeight({ ...page(400_001), kind: "selection" }, [q("What?")]), 1)
  assert.equal(requestWeight(null, [q("Hi")]), 1)
})

test("page length buckets for the analytics", () => {
  assert.deepEqual([10_000, 24_000, 60_000, 200_000, 300_000, 900_000, 2_000_000].map(pageBucket), ["24k", "24k", "100k", "200k", "400k", "1m", "more"])
})
