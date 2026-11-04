// Quick insert's switches the app shows too ("On web pages": the button by fields, keeping what's copied) live
// in the settings shared with the app; its sign and per-site lists stay on this device.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, beforeEach, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { COPIED_DEFAULT_ON } from "../src/shared/copied.ts"
import { INSERT_STORAGE } from "../src/shared/insert.ts"
import { STORAGE } from "../src/shared/types.ts"

let store: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (o: Record<string, unknown>) => { Object.assign(store, structuredClone(o)) }
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined }
  },
  runtime: { sendMessage: () => undefined, lastError: undefined }
}

let mod: any
before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-insert-settings-")), "store.mjs")
  await build({ entryPoints: [new URL("../src/content/insert/store.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  mod = await import(pathToFileURL(out).href)
})
beforeEach(() => {
  store = {}
})

test("on a new install: the button and Copied as decided (both on)", async () => {
  const s = await mod.loadInsertSettings()
  assert.equal(s.button, true)
  assert.equal(s.copied, COPIED_DEFAULT_ON)
  assert.equal(s.sign, "/")
})

test("turning the button off in the panel goes into the shared settings, with the time the app needs", async () => {
  store[STORAGE.settings] = { theme: "dark" }
  const before = Date.now()
  await mod.saveInsertSettings({ button: false })
  const shared = store[STORAGE.settings] as Record<string, unknown>
  assert.equal(shared.insertButton, false)
  assert.equal(shared.keepCopied, COPIED_DEFAULT_ON)
  assert.equal(shared.theme, "dark", "the panel's other settings stay")
  assert.ok(Number(store[STORAGE.settingsUpdatedAt]) >= before)
  assert.equal((await mod.loadInsertSettings()).button, false)
})

test("the app's switch wins over this device's old copy", async () => {
  store[INSERT_STORAGE.settings] = { button: true, copied: true, sign: "//" }
  store[STORAGE.settings] = { keepCopied: false, insertButton: true }
  const s = await mod.loadInsertSettings()
  assert.equal(s.copied, false)
  assert.equal(s.sign, "//")
})

test("the sign and the site lists stay on this device: nothing is sent to the app for them", async () => {
  await mod.saveInsertSettings({ sign: "//", buttonOffSites: ["example.com"] })
  assert.equal(store[STORAGE.settings], undefined)
  assert.equal(store[STORAGE.settingsUpdatedAt], undefined)
  assert.deepEqual((store[INSERT_STORAGE.settings] as any).buttonOffSites, ["example.com"])
})
