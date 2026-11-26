// The director's review of #268, point 4: a question the panel gave up on (no word from a slow background, then
// «lost its link» or a resend) isn't run when the background gets to it later (src/shared/droppedAsks.ts).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { DROPPED_KEY, dropAsk, wasDropped } from "../src/shared/droppedAsks.ts"

const area = () => {
  const items: Record<string, unknown> = {}
  return {
    items,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]])),
    set: async (more: Record<string, unknown>) => void Object.assign(items, JSON.parse(JSON.stringify(more)))
  }
}

test("a given-up question is noted for an hour; others aren't", async () => {
  const a = area()
  const t = 1_800_000_000_000
  assert.equal(await wasDropped("q1", a, t), false)
  await dropAsk("q1", a, t)
  await dropAsk("q2", a, t + 1_000)
  assert.equal(await wasDropped("q1", a, t + 59 * 60_000), true)
  assert.equal(await wasDropped("q3", a, t + 1_000), false)
  assert.equal(await wasDropped("q1", a, t + 61 * 60_000), false)
  // Old ones are dropped from the list as new ones are noted.
  await dropAsk("q4", a, t + 2 * 60 * 60_000)
  assert.deepEqual(Object.keys(a.items[DROPPED_KEY] as object), ["q4"])
})

test("the panel notes the question as it gives up; the background skips a noted one, after its immediate «here»", () => {
  const app = readFileSync("src/content/App.tsx", "utf8")
  assert.match(app, /const given = pendingAskRef\.current\?\.job\s*if \(given\) void dropAsk\(given\)/)
  assert.match(app, /pendingAskRef\.current = \{ history, content, opts, job: job\.id \}/)
  const bg = readFileSync("src/background/index.ts", "utf8")
  assert.match(bg, /send\(\{ type: "beat" \}\)\s*if \(spec\) \{/)
  assert.match(bg, /void wasDropped\(spec\.id\)\.then\(\(dropped\) => \{\s*if \(dropped \|\| stopped\) return close\(\)\s*unfollow = startJob\(spec, run, send\)/)
})
