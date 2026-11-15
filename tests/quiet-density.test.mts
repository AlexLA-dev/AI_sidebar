// 2.7 after build 107, the owner's decision 1 on the quiet panel: «телефоны и iPad mini без клавиатуры» get the compact
// chat; an iPad with a keyboard and the Mac keep what they showed. Chosen by what the panel has (its size, a pointer, a
// hardware keyboard seen), never by the device's name (src/content/quiet/density.ts).
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-quiet-density-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${new URL("../src/content/quiet/density.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const touch = { finePointer: false, hover: false, keyboard: false }
const density = (layout: string, screen: { width: number; height: number }, over = {}) =>
  lib.panelDensity({ ...lib.panelSize(layout, screen), ...touch, ...over })

test("phones and an iPad mini in the hands: compact", () => {
  assert.equal(density("sheet", { width: 393, height: 750 }), "compact", "iPhone, portrait")
  assert.equal(density("sheet", { width: 440, height: 830 }), "compact", "iPhone Pro Max")
  assert.equal(density("sheet", { width: 852, height: 340 }), "compact", "iPhone on its side: wide but low")
  assert.equal(density("side", { width: 744, height: 1040 }), "compact", "iPad mini, portrait")
  assert.equal(density("side", { width: 1133, height: 650 }), "compact", "iPad mini on its side")
  assert.equal(density("side", { width: 1024, height: 1290 }), "compact", "a big iPad without a keyboard: the same 420-point panel")
})

test("a pointer or a keyboard: roomy, at any size", () => {
  assert.equal(density("side", { width: 1440, height: 800 }, { finePointer: true, hover: true }), "roomy", "a Mac")
  assert.equal(density("side", { width: 700, height: 500 }, { finePointer: true, hover: true }), "roomy", "a small Mac window")
  assert.equal(density("side", { width: 744, height: 1040 }, { finePointer: true }), "roomy", "iPad mini with a trackpad")
  assert.equal(density("side", { width: 1024, height: 1290 }, { hover: true }), "roomy")
  assert.equal(density("side", { width: 1024, height: 1290 }, { keyboard: true }), "roomy", "iPad with a keyboard and no trackpad")
})

test("a panel that is itself wide and tall: roomy", () => {
  assert.equal(lib.panelDensity({ width: lib.ROOMY_WIDTH, height: lib.ROOMY_HEIGHT, ...touch }), "roomy")
  assert.equal(lib.panelDensity({ width: lib.ROOMY_WIDTH - 1, height: 900, ...touch }), "compact")
  assert.equal(lib.panelDensity({ width: 900, height: lib.ROOMY_HEIGHT - 1, ...touch }), "compact")
})

test("the panel's size from its layout, as the stylesheet draws it", () => {
  assert.deepEqual(lib.panelSize("side", { width: 1440, height: 800 }), { width: 420, height: 780 })
  assert.deepEqual(lib.panelSize("side", { width: 400, height: 800 }), { width: 380, height: 780 })
  assert.deepEqual(lib.panelSize("sheet", { width: 393, height: 750 }), { width: 393, height: 585 })
  assert.deepEqual(lib.panelSize("sheet", { width: 393, height: 1000 }), { width: 393, height: 640 })
  assert.deepEqual(lib.panelSize("popup", { width: 400, height: 600 }), { width: 400, height: 600 })
  const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  assert.match(css, /\.cf\[data-layout="side"\] \.cf-panel \{\s*top: 10px; right: 10px; bottom: 10px;\s*width: min\(420px, calc\(100vw - 20px\)\);/)
  assert.match(css, /height: min\(78dvh, 640px\);\s*max-height: calc\(100dvh - 40px\);/)
})

test("a hardware keyboard, seen by what the screen does when the panel's field takes the focus", () => {
  // The on-screen keyboard takes a third of the screen and more; a hardware one leaves it whole (or a bar of shortcuts).
  assert.equal(lib.keyboardSeen({ width: 744, height: 1040 }, 1040), true)
  assert.equal(lib.keyboardSeen({ width: 744, height: 1040 }, 985), true)
  assert.equal(lib.keyboardSeen({ width: 744, height: 1040 }, 700), false)
  // A phone stays compact with any keyboard: nothing is noted there.
  assert.equal(lib.keyboardSeen({ width: 393, height: 750 }, 750), null)
})

test("read as the panel opens and kept until it opens again; the chat knows it by data-density", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  const show = app.slice(app.indexOf("const show = useCallback("), app.indexOf("const hide = useCallback("))
  assert.ok(show.indexOf("setDensity(densityNow(layoutRef.current))") > 0 && show.indexOf("setDensity(densityNow(layoutRef.current))") < show.indexOf("setOpen(true)"))
  assert.equal(app.match(/setDensity\(/g)?.length, 1)
  assert.match(app, /data-density=\{density\}/)
  assert.match(app, /onFocus=\{\(\) => setTimeout\(noteKeyboard, 700\)\}/)
  const src = readFileSync(new URL("../src/content/quiet/density.ts", import.meta.url), "utf8")
  assert.match(src, /finePointer: media\("\(any-pointer: fine\)"\), hover: media\("\(any-hover: hover\)"\), keyboard/)
  assert.doesNotMatch(src, /userAgent|detectPlatform|navigator\.platform|isTouch/, "by what the panel has, not the device's name")
})
