// Page watch's rows in the panel's "Reminders" (chat UX's list, through addLaterSource).
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let mod: any
const sent: any[] = []
let list: any[] = []

before(async () => {
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    runtime: { sendMessage: async (m: any) => (sent.push(m), m.type === "watchList" ? list : { ok: true }) }
  }
  const out = join(mkdtempSync(join(tmpdir(), "cf-watch-list-")), "list.mjs")
  await build({
    entryPoints: [new URL("../src/content/watch/list.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  mod = await import(pathToFileURL(out).href)
})

const NOW = Date.UTC(2026, 10, 4, 12, 0)
const w = (over: Record<string, unknown> = {}) => ({
  id: "a1", url: "https://shop.example/mug", host: "shop.example", title: "Mug", what: "price", label: "Price",
  condition: "", source: "ld-price", value: "49.85 EUR", rule: { kind: "change" }, mode: "bg", site: "shop",
  createdAt: NOW - 3_600_000, checkedAt: NOW - 300_000, checks: 3, failures: 0, ...over
})

test("a row's status says what's watched and how it stands", () => {
  assert.equal(mod.watchRow(w(), NOW).status, "Watching: Price · now €49.85 · checked 5 minutes ago")
  assert.equal(mod.watchRow(w({ checks: 0 }), NOW).status, "Watching: Price · now €49.85")
  assert.equal(mod.watchRow(w({ mode: "live" }), NOW).status, "Watching: Price · now €49.85 · I'll check when you open the page")
  assert.equal(mod.watchRow(w({ metAt: NOW - 120_000, metValue: "39.90 EUR" }), NOW).status, "Changed: Price, now €39.90 · 2 minutes ago")
  assert.equal(mod.watchRow(w({ what: "page", label: "The page", metAt: NOW - 120_000, metValue: "x:1" }), NOW).status, "Changed: The page · 2 minutes ago")
})

test("what it waits for, whole, with the value now (the owner, build 75: the price set can't be seen)", () => {
  // The person's own words stay as they are, with today's value after them.
  assert.equal(mod.watchRow(w({ condition: "when it drops below 40 EUR" }), NOW).status, "Watching: when it drops below 40 EUR · now €49.85 · checked 5 minutes ago")
  // The words the panel started from come back with today's value, not the one when the watch was made.
  assert.equal(mod.watchRow(w({ condition: "when the price changes (now €55.00)" }), NOW).status, "Watching: when the price changes (now €49.85) · checked 5 minutes ago")
  // Started as a price, planned as a status: still the starting words, with today's value.
  assert.equal(mod.watchRow(w({ what: "status", condition: "when the price changes (now 40 EUR)" }), NOW).status, "Watching: when the price changes (now €49.85) · checked 5 minutes ago")
  // A page watched as a whole: its words only.
  assert.equal(mod.watchRow(w({ what: "page", label: "The page", condition: "when something new appears on the page", value: "x:1" }), NOW).status, "Watching: when something new appears on the page · checked 5 minutes ago")
})

test("a watch's row opens watching's window, not the page; other rows aren't its own", () => {
  assert.equal(mod.watchSource.open({ id: "remind:c1:k1", kind: "remind", title: "Chat", status: "", sortAt: 0 }), false)
  assert.equal(mod.watchSource.open({ id: "watch:a1", kind: "watch", title: "Mug", status: "", sortAt: 0 }), true)
})

test("a row in the list's shape: an id of its own, the page, the last check for the order", () => {
  const row = mod.watchRow(w(), NOW)
  assert.deepEqual({ ...row, status: undefined }, { id: "watch:a1", kind: "watch", title: "Mug", url: "https://shop.example/mug", status: undefined, sortAt: NOW - 300_000 })
  assert.equal(mod.watchRow(w({ metAt: NOW - 60_000 }), NOW).sortAt, NOW - 60_000)
})

test("the source lists this device's watches and stops only its own", async () => {
  list = [w(), w({ id: "b2", mode: "live" })]
  const rows = await mod.watchSource.items()
  assert.deepEqual(rows.map((r: any) => r.id), ["watch:a1", "watch:b2"])
  sent.length = 0
  await mod.watchSource.cancel("remind:chat:1")
  assert.equal(sent.length, 0, "a reminder's id isn't ours")
  await mod.watchSource.cancel("watch:b2")
  assert.deepEqual(sent, [{ type: "watchCancel", id: "b2", via: "list" }])
})

test("times in the panel's language", () => {
  assert.equal(mod.ago(NOW - 10_000, NOW, "en"), "this minute")
  assert.equal(mod.ago(NOW - 3 * 3_600_000, NOW, "ru"), "3 часа назад")
  assert.equal(mod.ago(NOW - 86_400_000, NOW, "en"), "yesterday")
})
