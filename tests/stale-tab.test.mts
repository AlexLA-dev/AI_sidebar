// 2.7, the owner on TestFlight 107: after an update Listen asked about notifications that were on, opened the app, and
// the app said the text was gone, round and round. A tab left open across an update of the app keeps the old panel, and
// the tab's link to the extension is dead; a panel put there again is cut off the same way (seen on a device). So the
// new background puts a notice there: «ContextFlow was updated. Reload this page», shown when our button or panel is
// touched, and never a reload by itself.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { changedSince, checkTab, noticePlace, panelLooksOpen, watching } from "../src/shared/staleTabs.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("after an update a tab is asked first: a live panel is left alone, a silent one is told, a page that refuses stays as it is", async () => {
  const log: string[] = []
  const deps = (ask: () => Promise<{ ok?: boolean } | null>, tell: () => Promise<unknown>) => ({
    ask: async (id: number) => { log.push(`ask ${id}`); return ask() },
    tell: async (id: number) => { log.push(`tell ${id}`); return tell() }
  })
  assert.equal(await checkTab(7, deps(async () => ({ ok: true }), async () => undefined)), "alive")
  assert.deepEqual(log, ["ask 7"])
  log.length = 0
  assert.equal(await checkTab(7, deps(async () => { throw new Error("timeout") }, async () => undefined)), "told")
  assert.deepEqual(log, ["ask 7", "tell 7"])
  // An answer that isn't the panel's (an empty reply) counts as none.
  assert.equal(await checkTab(7, deps(async () => null, async () => undefined)), "told")
  assert.equal(await checkTab(7, deps(async () => { throw new Error("timeout") }, async () => { throw new Error("cannot access") })), "refused")
})

test("an update is told by the app's build, since Safari doesn't always say 'update'", () => {
  assert.equal(changedSince("107", "108", true), true)
  assert.equal(changedSince("108", "108", true), false)
  // None kept (2.6.1 and build 107 kept none): an earlier ContextFlow's data on the device says there was one.
  assert.equal(changedSince(undefined, "108", true), true)
  // A first install: nothing here before.
  assert.equal(changedSince(undefined, "108", false), false)
  // The native side didn't say (Chrome, or no answer): nothing is concluded.
  assert.equal(changedSince("107", "", true), false)
})

test("only for a day after an update", () => {
  const now = 1_800_000_000_000
  assert.equal(watching(now + 1000, now), true)
  assert.equal(watching(now - 1, now), false)
  assert.equal(watching(undefined, now), false)
  assert.equal(watching("soon", now), false)
})

test("the panel open or only our button: by how much of the screen our root covers", () => {
  // The round button, or the selection buttons: a point or two of 25.
  assert.equal(panelLooksOpen(0, 25), false)
  assert.equal(panelLooksOpen(2, 25), false)
  // iPhone's sheet over the lower part, the side panel on an iPad.
  assert.equal(panelLooksOpen(15, 25), true)
  assert.equal(panelLooksOpen(5, 25), true)
  assert.equal(panelLooksOpen(0, 0), false)
})

test("the notice goes by the touch, inside what's visible; at the top when nothing was touched", () => {
  const view = { left: 0, top: 0, right: 402, bottom: 700 }
  // Our button at the right edge: above the finger, pulled in from the edge.
  assert.deepEqual(noticePlace({ x: 366, y: 560 }, 300, 52, view), { left: 94, top: 480 })
  // The button at the top: no room above, so below.
  assert.deepEqual(noticePlace({ x: 366, y: 40 }, 300, 52, view), { left: 94, top: 68 })
  // The panel was open when the update came: top centre.
  assert.deepEqual(noticePlace(null, 300, 52, view), { left: 51, top: 12 })
  // A page zoomed and moved: what's visible starts elsewhere, and the notice stays inside it.
  const moved = { left: 120, top: 300, right: 371, bottom: 737 }
  assert.deepEqual(noticePlace({ x: 150, y: 320 }, 200, 40, moved), { left: 128, top: 348 })
  // Wider than what's visible: from the left edge.
  assert.deepEqual(noticePlace(null, 400, 52, { left: 0, top: 0, right: 320, bottom: 500 }), { left: 8, top: 12 })
})

test("wired: the background asks and tells, the page's script watches the old root and mounts nothing", () => {
  const background = read("../src/background/index.ts")
  assert.match(background, /const staleTabs = watchStaleTabs\(appBuild\)/)
  assert.match(background, /details\.reason === "update"\) \{[\s\S]{0,200}?staleTabs\.updated\(\)/)
  assert.match(background, /case "alive":[\s\S]{0,200}?sendResponse\(\{ ok: true \}\)\n\s+return false/)
  const wires = read("../src/background/staleTabs.ts")
  // The words, then the panel's script; never a reload from here.
  assert.match(wires, /__contextflowStale = w \}, args: \[words\] \}\)\n\s+\.then\(\(\) => chrome\.scripting\.executeScript\(\{ target: \{ tabId \}, files: \["dist\/content\.js"\] \}\)\)/)
  assert.doesNotMatch(wires, /tabs\.reload/)
  // Within the day, every start of the background asks the tab in front.
  assert.match(wires, /void chrome\.storage\.local\.get\(KEY\)\.then\(\(stored\) => \{\n\s+if \(watching\(stored\[KEY\], Date\.now\(\)\)\) void checkFront\(\)/)
  const index = read("../src/content/index.tsx")
  assert.match(index, /if \(message\?\.type === "alive"\) sendResponse\(\{ ok: true \}\)/)
  assert.match(index, /const words = takeStaleWords\(\)\n\s+if \(window\.__contextflowBus && !words\) return\n\s+const old = document\.querySelector\(HOST_TAG\)\n\s+if \(words \|\| old\) \{\n\s+if \(old\) void watchStaleTab\(old, words\)\n\s+return\n\s+\}/)
  const stale = read("../src/content/stale.ts")
  // Told by the background, the tab is cut off whatever this script's own link says (on a single update this script
  // was heard while the old panel wasn't). Only a root found without the background's words is checked by that link.
  assert.match(stale, /if \(root\.hasAttribute\(TOLD\)\) return\n\s+if \(!words && \(\(await linked\(\)\) \|\| root\.hasAttribute\(TOLD\)\)\) return/)
  // The only reload is the button's.
  assert.equal(stale.match(/location\.reload\(\)/g)?.length, 1)
  assert.match(stale, /reload\.addEventListener\("click", \(\) => location\.reload\(\)\)/)
  assert.match(stale, /if \(panelLooksOpen\(covered\(root\)\.hits, 25\)\) show\(null\)/)
})

test("every language has the line, and it names no single feature", () => {
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const words = JSON.parse(read(`../src/locales/${lang}.json`)) as Record<string, string>
    assert.ok(words.updatedReload?.includes("ContextFlow"), lang)
    assert.ok(words.updatedReload.length < words.writeUpdated.length, lang)
    assert.ok(words.writeReload, lang)
  }
  assert.equal(JSON.parse(read("../src/locales/en.json")).updatedReload, "ContextFlow was updated. Reload this page.")
})
