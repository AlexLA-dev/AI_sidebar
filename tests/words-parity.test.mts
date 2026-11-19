// 2.7: the app finds a card's collection by the same words as the panel (src/shared/words.ts topicWords and
// ContextFlow/Shared (App)/TopicWords.swift, built here with tests/words-parity/main.swift), in every shipped language.
// Skipped where there's no Swift compiler; run on a Mac.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { topicWords } from "../src/shared/words.ts"
import { WORD_CASES } from "./words.cases.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"

test("the app's topic words are the panel's, in every language", { skip }, () => {
  const bin = join(mkdtempSync(join(tmpdir(), "cf-words-")), "words")
  execFileSync("swiftc", ["-O", "-swift-version", "6", "-default-isolation", "MainActor", join(root, "ContextFlow/Shared (App)/TopicWords.swift"), join(root, "tests/words-parity/main.swift"), "-o", bin], { stdio: "pipe", timeout: 300_000, killSignal: "SIGKILL" })
  const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
  const out = execFileSync(bin, { input: JSON.stringify(WORD_CASES.map(units)), timeout: 60_000, killSignal: "SIGKILL" })
  const app = JSON.parse(out.toString()) as string[][]
  WORD_CASES.forEach((text, i) => assert.deepEqual(app[i], [...topicWords(text)].sort(), text))
})
