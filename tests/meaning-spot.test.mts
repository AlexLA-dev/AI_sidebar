// Build 98 (the owner: a meaning result opens its chat at the message it refers to, highlighted): which message, in
// every shipped language (src/shared/meaningSpot.ts); the panel's results and the app's use it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { meaningSpot, meaningSpotIn, spotStems } from "../src/shared/meaningSpot.ts"
import { CASES } from "./meaning-spot.cases.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("a meaning result's message: the one sharing the description's and the why's rarer words, in every language", () => {
  for (const c of CASES) assert.equal(meaningSpot(c.texts, c.query, c.why) ?? null, c.expect, c.name)
})

test("stems: accents off, five letters, Korean two syllables, Chinese and Japanese pairs", () => {
  assert.deepEqual([...spotStems("Caffeine, CAFÉ and Straße")].sort(), ["and", "cafe", "caffe", "stras"])
  assert.deepEqual([...spotStems("커피를 마시면")].sort(), ["마시", "커피"])
  assert.deepEqual([...spotStems("睡眠と")].sort(), ["睡眠", "眠と"].sort())
  assert.equal(spotStems("an of 42").size, 0)
})

test("a question counts its page's name, a note its quote", () => {
  const entries = [
    { role: "user", content: "Summarize", page: { url: "https://a.example", title: "Why the four-day week works" } },
    { role: "assistant", content: "In short: hours cut by 20%." },
    { role: "user", content: "Check this", note: true, cite: "Caffeine has a half-life of about 5 hours" },
    { role: "assistant", content: "Pasta, garlic, oil." }
  ] as any
  assert.equal(meaningSpotIn(entries, "the four-day week article", ""), 0)
  assert.equal(meaningSpotIn(entries, "caffeine half-life", ""), 2)
})

test("the panel's meaning results open their chat at that message; the app's too", () => {
  const threads = read("../src/content/Threads.tsx")
  assert.match(threads, /const open = \(\) => onOpen\(id, meaningSpotIn\(thread\.m, found\?\.query \?\? query, why\)\)/)
  assert.match(threads, /onClick=\{open\} onKeyDown=\{\(e\) => \{ if \(e\.key === "Enter"\) open\(\) \}\}/)
  const app = read("../ContextFlow/Shared (App)/ChatsView.swift")
  assert.match(app, /ChatRoute\(id: thread\.id, history: thread\.isHistory, scrollTo: thread\.isHistory \? nil : meaningSpot\(thread, found\.query, result\.why\)\)/)
  // The file is in the app's targets (iPhone and iPad, Mac).
  assert.equal((read("../ContextFlow/ContextFlow.xcodeproj/project.pbxproj").match(/MeaningSpot\.swift in Sources \*\/,/g) ?? []).length, 2)
})
