// Build 95, the owner on TestFlight 94: with the panel open on a selected price, Watch and Remind were only in the
// pop-up, and what the question is about was in the header, far from the field. Now: the label (the selection with its
// ring, the page, "Ask your chats") is on a row over the field, and by a selection that row has the pop-up's bell and
// eye, doing the same. The frames are in the PR; these keep the shape.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { FEATURES } from "../src/shared/usage.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const app = read("../src/content/App.tsx")
const css = read("../src/content/styles.css")

test("the header shows no label in a chat; the row over the field does, before the field", () => {
  const header = app.slice(app.indexOf('<header class="cf-header">'), app.indexOf("</header>"))
  assert.doesNotMatch(header, /<ContextChip|cf-ctx history/)
  const composer = app.slice(app.indexOf('<footer class="cf-composer">'))
  assert.ok(composer.indexOf("{ctxRow}") > 0 && composer.indexOf("{ctxRow}") < composer.indexOf('<div class={`cf-input'))
  const row = app.slice(app.indexOf("const ctxRow = ("), app.indexOf("const ctxRow = (") + 1200)
  assert.match(row, /<ContextChip/)
  assert.match(row, /cf-ctx history/)
  // The ring stays: the label keeps its glow, the page keeps its own.
  assert.match(app, /<span class="cf-ctx selection glow">\s*<span class="cf-glow-run"/)
  assert.match(app, /\{glowRange && <SelectionGlow range=\{glowRange\} \/>\}/)
})

test("by a selection, the row has the pop-up's bell and eye; the eye knows it's in the panel", () => {
  const acts = app.slice(app.indexOf("const panelSelActs"), app.indexOf("const ctxRow = ("))
  assert.match(acts, /contextKind === "selection" && selection/)
  assert.match(acts, /setLater\(\{ selection, range: selectionRange\(\) \}\)/)
  assert.match(acts, /f: "later", a: "open", via: "panel"/)
  assert.match(acts, /bubbleActions\(\)/)
  assert.match(acts, /panel: true/)
  const register = read("../src/content/watch/register.tsx")
  assert.match(register, /how: ctx\.panel \? "panel" : "bubble"/)
  // In the panel the page keeps its selection (the label and the ring are about it).
  assert.match(register, /if \(ctx\.panel\) return\s*\n\s*\/\/[^\n]*\n\s*document\.getSelection\(\)\?\.removeAllRanges\(\)/)
  assert.ok(FEATURES.later.via?.includes("panel") && FEATURES.watch.via?.includes("panel"))
})

test("one line on a phone: the label gives way, and when it would be cut the buttons keep only their icons", () => {
  assert.match(css, /\.cf-ctx-row > \.cf-ctx \{ flex: 0 1 auto; min-width: 0; \}/)
  assert.match(css, /\.cf-ctx-acts \{[^}]*flex: none;[^}]*\}/)
  assert.match(css, /\.cf-ctx-row\.tight \.cf-ctx-act-l, \.cf-ctx-row\.tight \.cf-sel-watch-l \{ display: none; \}/)
  assert.match(app, /text\.scrollWidth > text\.clientWidth \+ 1\) setCtxTight\(ctxKey\)/)
})

test("the tour's selection step points at the label where it is now", () => {
  assert.match(read("../src/content/Tour.tsx"), /targets: \[\["\.cf-ctx-row \.cf-ctx", "\.cf-ctx-row"\]\], icon: <Icon\.Cursor \/>, title: "tourSelectTitle"/)
})
