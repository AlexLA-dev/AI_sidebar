// 2.7 (110): the owner's notes on the panel of TestFlight 109.
// 1 Whole chat and the count in «+» on every layout; 2 the row under a message never cut off (a note's went past the
// panel's left edge on iPad mini).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const app = read("src/content/App.tsx")
const composer = app.slice(app.indexOf('<footer class="cf-composer">'), app.indexOf("</footer>", app.indexOf('<footer class="cf-composer">')))

test("1. Whole chat and the count are in «+» on every layout, the roomy one too", () => {
  // «+» lists both whatever the density; nothing under the field.
  assert.match(composer, /whole=\{historyMode \? null : \{/)
  assert.match(composer, /usage=\{usageLine\}\s*after=\{getProLink\}/)
  assert.doesNotMatch(composer, /compact/)
  assert.doesNotMatch(app, /class="cf-usage"/)
  assert.doesNotMatch(read("src/content/styles.css"), /\.cf-usage\b/)
  // The number by the field shows on every layout (Free, or few left), and opens «+».
  assert.match(composer, /\{leftNow && !noteMode && \(\s*<button type="button" class=\{`cf-left/)
  // The tour points at «+» for Whole chat on every layout.
  assert.match(read("src/content/Tour.tsx"), /targets: \[\["\.cf-plus"\]\], icon: <Icon\.Doc \/>, title: "tourWholeTitle", body: "tourWholeBodyPlus"/)
})

test("2. the row under a message is its column's width (a note's too), and wraps rather than cut a button off", () => {
  const css = read("src/content/quiet/quiet.css")
  // A note's column puts its children at the end: the row stretches over it, so its measure is the room there is.
  assert.match(read("src/content/styles.css"), /\.cf-msg\.user \{ align-items: flex-end; \}/)
  assert.match(css, /\.cf-msg-tools \{ flex-wrap: nowrap !important; min-width: 0; align-self: stretch; max-width: 100%; box-sizing: border-box; \}/)
  // Still at the end of the line under a note.
  assert.match(read("src/content/styles.css"), /\.cf-msg\.user \.cf-msg-tools \{ justify-content: flex-end; \}|\.cf-msg\.user \.cf-msg-tags, \.cf-msg\.user \.cf-msg-tools \{ justify-content: flex-end; \}/)
  // When even the icons don't fit, it wraps.
  assert.match(css, /\.cf-msg-tools\[data-wrap="1"\] \{ flex-wrap: wrap !important; row-gap: 2px; \}/)
  const row = read("src/content/quiet/ToolsRow.tsx")
  assert.match(row, /delete el\.dataset\.wrap\s*let n = 0/)
  assert.match(row, /while \(n < steps\.length && needed\(el\) > el\.clientWidth \+ 1\) out = apply\(el, steps, \+\+n\)\s*if \(needed\(el\) > el\.clientWidth \+ 1\) el\.dataset\.wrap = "1"/)
})
