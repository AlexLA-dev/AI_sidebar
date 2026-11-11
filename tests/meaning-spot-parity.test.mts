// Build 98: the panel and the app pick the same message for a meaning result (src/shared/meaningSpot.ts and
// ContextFlow/Shared (App)/MeaningSpot.swift, built here with tests/meaning-spot-parity/main.swift), in every shipped
// language. Skipped where there's no Swift compiler; run on a Mac.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { meaningSpot, spotStems } from "../src/shared/meaningSpot.ts"
import { CASES } from "./meaning-spot.cases.ts"

const root = new URL("..", import.meta.url).pathname
const swiftc = spawnSync("which", ["swiftc"]).status === 0
const skip = process.platform !== "darwin" ? "the app's Foundation is Apple's: run on a Mac" : !swiftc && "no swiftc here"
// As speech-parity: a stuck build or run fails the test instead of holding the suite.
const BUILD_MS = 300_000
const RUN_MS = 60_000

async function swift(cases: typeof CASES): Promise<Array<{ stems: string[]; spot: number | null }>> {
  const bin = join(mkdtempSync(join(tmpdir(), "cf-spot-")), "spot")
  execFileSync("swiftc", ["-O", "-swift-version", "6", "-default-isolation", "MainActor", join(root, "ContextFlow/Shared (App)/MeaningSpot.swift"), join(root, "tests/meaning-spot-parity/main.swift"), "-o", bin], { stdio: "pipe", timeout: BUILD_MS, killSignal: "SIGKILL" })
  const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
  const child = spawn(bin, { stdio: "pipe" })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on("data", (b: Buffer) => out.push(b))
  child.stderr.on("data", (b: Buffer) => err.push(b))
  child.stdin.on("error", () => undefined)
  child.stdin.end(JSON.stringify(cases.map((c) => ({ texts: c.texts.map(units), query: units(c.query), why: units(c.why) }))))
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code))
  })
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), RUN_MS) })
  const code = await Promise.race([done, late]).finally(() => clearTimeout(timer))
  if (code === "late") {
    child.kill("SIGKILL")
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy()
    throw new Error(`the Swift side didn't answer in ${RUN_MS / 1000} s`)
  }
  if (code !== 0) throw new Error(`the Swift side exited with ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`)
  return JSON.parse(Buffer.concat(out).toString())
}

test("the app picks the same message and the same stems as the panel", { skip }, async () => {
  const app = await swift(CASES)
  CASES.forEach((c, i) => {
    assert.deepEqual([...app[i].stems].sort(), [...spotStems(c.query)].sort(), `${c.name}: stems`)
    assert.equal(app[i].spot, meaningSpot(c.texts, c.query, c.why) ?? null, `${c.name}: the message`)
  })
})
