// 2.8: the install's first day (the plan's rule: on day 1 plans appear only at the limit), as the hint coordinator
// defines it: the device-local calendar day the panel first ran (cf:coach.first; cf:firstSeen until the coordinator keeps it).
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { before, test } from "node:test"

import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let store: Record<string, unknown> = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let day: Record<string, (...args: any[]) => any>
before(async () => {
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: { local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items)
    } }
  }
  const out = join(mkdtempSync(join(tmpdir(), "cf-first-day-")), "day.mjs")
  await build({ entryPoints: [join(root, "src/content/firstDay.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" })
  day = await import(pathToFileURL(out).href)
})

test("day 1 is the calendar day the panel first ran; the coordinator's word wins; set once", async () => {
  store = {}
  const morning = new Date(2026, 10, 24, 9, 0).getTime()
  assert.equal(await day.isFirstDay(morning), true)
  assert.equal(store["cf:firstSeen"], morning)
  assert.equal(await day.isFirstDay(new Date(2026, 10, 24, 23, 59).getTime()), true)
  assert.equal(await day.isFirstDay(new Date(2026, 10, 25, 0, 1).getTime()), false)
  assert.equal(store["cf:firstSeen"], morning)
  store["cf:coach"] = { first: new Date(2026, 10, 20, 12).getTime() }
  assert.equal(await day.isFirstDay(morning), false)
})
