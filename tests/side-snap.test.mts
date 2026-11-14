// 2.7, plan section 9 (the owner: «чтобы когда перетаскиваешь кружок - он тянулся за пальцем, но магнитился к ближайшей
// стороне. Но и нужно сайдбар тоже перемещать, а не только кружок»): the numbers of a drag (src/content/side/snap.ts),
// and the wiring: one side for the circle and the panel, the panel mirrored by it, its header the handle.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { FAB_SIZE, fabLeftAt, fabLeftFor, HEADER_CONTROLS, heightPercent, isDrag, nearestSide, panelSideFor, resolveSide } from "../src/content/side/snap.ts"

test("the circle lands on the nearer edge, at the height it was let go, never under the very top or bottom", () => {
  assert.equal(nearestSide(10, 390), "left")
  assert.equal(nearestSide(194, 390), "left")
  assert.equal(nearestSide(196, 390), "right")
  assert.equal(heightPercent(426, 852), 50)
  assert.equal(heightPercent(-30, 852), 8)
  assert.equal(heightPercent(900, 852), 92)
})

test("while dragged it follows the finger, centred on it and kept on screen; let go, it settles at its side's place", () => {
  assert.equal(fabLeftFor(200, 390), 200 - FAB_SIZE / 2)
  assert.equal(fabLeftFor(2, 390), 4)
  assert.equal(fabLeftFor(389, 390), 390 - FAB_SIZE - 4)
  assert.equal(fabLeftAt("left", 390), 14)
  assert.equal(fabLeftAt("right", 390), 390 - 14 - FAB_SIZE)
  assert.equal(fabLeftAt("right", 844, 47), 844 - 47 - FAB_SIZE, "past a landscape notch")
})

test("a press that hardly moves is a tap (it opens the panel); the panel goes where its middle is", () => {
  assert.equal(isDrag(3, 4), false)
  assert.equal(isDrag(6, 3), true)
  assert.equal(panelSideFor({ left: 1010, width: 420 }, 1440), "right")
  assert.equal(panelSideFor({ left: 200, width: 420 }, 1440), "left")
  assert.equal(panelSideFor({ left: 500, width: 420 }, 1440), "left", "dragged just past the middle")
})

test("until the person picks a side, the interface's direction decides; their choice wins in any language", () => {
  assert.equal(resolveSide({}, "rtl"), "left", "Arabic, nothing chosen: left")
  assert.equal(resolveSide({ fabSide: "right", fabSideChosen: true }, "rtl"), "right", "Arabic, chose right: right")
  assert.equal(resolveSide({}, "ltr"), "right", "English: right")
  assert.equal(resolveSide({ fabSide: "left", fabSideChosen: true }, "ltr"), "left", "English, chose left: left")
  // Before 2.7 every save wrote "right" (the old default), and only a drag wrote "left".
  assert.equal(resolveSide({ fabSide: "right" }, "rtl"), "left", "a stored old default isn't a choice")
  assert.equal(resolveSide({ fabSide: "left" }, "ltr"), "left", "an old drag to the left stays")
  const types = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8")
  const defaults = types.slice(types.indexOf("export const DEFAULT_SETTINGS"))
  assert.doesNotMatch(defaults.slice(0, defaults.indexOf("}")), /fabSide/, "no side written at install")
})

test("the header's buttons stay buttons: a press on them never drags the panel", () => {
  for (const tag of ["button", "a", "input", "[role=menu]"]) assert.ok(HEADER_CONTROLS.includes(tag), tag)
})

test("one side for both: the panel opens where the circle is, mirrored in CSS; its header is the handle (iPad, Mac only)", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /data-side=\{side\}/)
  assert.match(app, /<header class="cf-header" \{\.\.\.panelDrag\.handlers\}>/)
  assert.match(app, /usePanelDrag\(\{[\s\S]*?enabled: layout === "side"/)
  assert.match(app, /const side: Side = resolveSide\(settings, uiDirection\(\)\)/)
  assert.match(app, /onSide: \(to\) => \{[\s\S]*?updateSettings\(\{ fabSide: to, fabSideChosen: true \}\)/)
  assert.match(app, /updateSettings\(\{ fabY, fabSide: to, fabSideChosen: true \}\)/)
  assert.match(app, /<EdgeGlow side=\{fabDrag\.state\.glow \?\? panelDrag\.glow\} \/>/)
  assert.match(app, /<TranslatePill\s+side=\{side\}/, "the translate pill follows the side")
  const css = readFileSync(new URL("../src/content/side/side.css", import.meta.url), "utf8")
  assert.match(css, /\.cf\[data-layout="side"\]\[data-side="left"\] \.cf-panel \{ right: auto; left: 10px; transform: translateX\(-24px\); \}/)
  const base = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  assert.doesNotMatch(base, /:host\(\[dir="rtl"\]\) \.cf\[data-layout="side"\] \.cf-panel/, "no second rule moving it by language")
  const index = readFileSync(new URL("../src/content/index.tsx", import.meta.url), "utf8")
  assert.match(index, /import sideStyles from "\.\/side\/side\.css"[\s\S]*?\$\{sideStyles\}/, "its styles are in the panel's style sheet")
  const settings = readFileSync(new URL("../src/content/Settings.tsx", import.meta.url), "utf8")
  assert.match(settings, /t\("setSide"\)[\s\S]*?resolveSide\(settings, uiDirection\(\)\)[\s\S]*?\["right", t\("sideRight"\)\], \["left", t\("sideLeft"\)\][\s\S]*?onChange\(\{ fabSide, fabSideChosen: true \}\)/)
})
