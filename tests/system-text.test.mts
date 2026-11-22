// 2.7.1, after the VoiceOver pass: the panel follows the iPhone/iPad text size (systemText.ts) and its tertiary grey
// passes WCAG AA.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { DEFAULT_BODY_PX, MAX_UI_SCALE, scaleFor } from "../src/content/systemText.ts"

test("the default and smaller system sizes keep the approved layout", () => {
  assert.equal(scaleFor(DEFAULT_BODY_PX), 1)
  assert.equal(scaleFor(14), 1)
  assert.equal(scaleFor(Number.NaN), 1)
})

test("larger sizes scale the panel, capped at the first accessibility size", () => {
  assert.equal(scaleFor(19), 1.12)
  assert.equal(scaleFor(23), 1.35)
  assert.equal(scaleFor(28), MAX_UI_SCALE)
  assert.equal(scaleFor(53), MAX_UI_SCALE)
})

test("the zoom rule and the AA greys are in the panel's styles", () => {
  const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  assert.match(css, /\.cf\[data-ui\] \.cf-panel > \* \{ zoom: var\(--ui, 1\); \}/)
  // The header stops at 1.2 and its space name gives way (the owner: the share and chats icons covered the name).
  assert.match(css, /\.cf\[data-ui\] \.cf-panel > \.cf-header \{ zoom: min\(var\(--ui, 1\), 1\.2\); \}/)
  const spaces = readFileSync(new URL("../src/content/spaces.css", import.meta.url), "utf8")
  assert.match(spaces, /\.cf\[data-ui\] \.cf-space-switch \{ flex: 0 1 auto; min-width: 0; \}/)
  assert.doesNotMatch(css, /--text-3: #8d8a96/)
  assert.doesNotMatch(css, /--text-3: #85828f/)
})
