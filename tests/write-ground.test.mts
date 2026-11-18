// 2.7 (108), W1: the live underlines' line is made for the page's own ground (a dark page under a light panel and the
// other way round), read from the computed backgrounds going up from the field.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { groundOf, luminance, parseRgb } from "../src/content/insert/ground.ts"

test("computed colours as browsers give them", () => {
  assert.deepEqual(parseRgb("rgb(255, 255, 255)"), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseRgb("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 })
  assert.deepEqual(parseRgb("rgb(32 33 36 / 50%)"), { r: 32, g: 33, b: 36, a: 0.5 })
  assert.equal(parseRgb("transparent"), null)
  assert.equal(parseRgb("color(display-p3 1 1 1)"), null)
  assert.ok(luminance({ r: 255, g: 255, b: 255 }) > 0.99)
  assert.ok(luminance({ r: 0, g: 0, b: 0 }) < 0.01)
})

test("the first mostly opaque background decides; none: the canvas", () => {
  // Gmail light: the field transparent, its box white.
  assert.equal(groundOf(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)", "rgb(32, 33, 36)"]), "light")
  // A dark site (X, YouTube's comments, GitHub dark).
  assert.equal(groundOf(["rgba(0, 0, 0, 0)", "rgb(13, 17, 23)"]), "dark")
  assert.equal(groundOf(["rgb(32, 33, 36)"]), "dark")
  // A faint wash over a dark page doesn't count.
  assert.equal(groundOf(["rgba(255, 255, 255, 0.06)", "rgb(0, 0, 0)"]), "dark")
  // A mid grey reads as light (the line's dark end shows on it).
  assert.equal(groundOf(["rgb(160, 160, 160)"]), "light")
  assert.equal(groundOf(["rgba(0, 0, 0, 0)"]), "light")
  assert.equal(groundOf(["rgba(0, 0, 0, 0)"], true), "dark")
})

test("the underline's colours come from the accent tokens, and it is still with Reduce Motion", () => {
  const css = readFileSync(new URL("../src/content/insert/insert.css", import.meta.url), "utf8")
  const block = css.slice(css.indexOf(".cf-ul-layer {"), css.indexOf(".cf-ul-pop {"))
  assert.ok(block.length > 0)
  assert.doesNotMatch(block, /#38bdf8|#2563eb|rgba\(37, 99, 235/, "no hard-coded accent colours")
  assert.match(block, /var\(--accent-2\)/)
  assert.match(block, /var\(--accent\)/)
  // Only a transform moves, and the new underline's light runs a few times, not for ever.
  assert.match(block, /@keyframes cf-ul-shine \{[^}]*transform[^}]*\}/)
  assert.match(block, /\.cf-ul::after \{[^}]*animation: cf-ul-shine [\d.]+s [a-z-]+ 3 forwards/)
  assert.match(block, /prefers-reduced-motion: reduce\)[\s\S]*\.cf-ul::after[^{]*\{[^}]*animation: none/)
})
