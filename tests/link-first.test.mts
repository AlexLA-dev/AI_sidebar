// 2.7 (108): on a fresh install the first Listen from Safari opened the app on «New in ContextFlow · Everything in one
// chat?» (Try Pro / Not now) instead of the notifications question, which then never came. When one of our links opens
// the app, the link's own screen comes first; what the app shows by itself waits for an open no link started.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const app = readFileSync(new URL("../ContextFlow/Shared (App)/ContentView.swift", import.meta.url), "utf8")

test("a link marks the stay in front as its own, until the app leaves the front", () => {
  assert.match(app, /func handle\(_ url: URL\) \{\n\s+guard url\.scheme == "contextflow" else \{ return \}\n\s+byLink = true/)
  assert.match(app, /func leftFront\(\) \{\n\s+byLink = false\n\s+\}/)
  assert.match(app, /\} else if phase == \.background \{\n\s+router\.leftFront\(\)/)
})

test("the «New in» sheet and the What's new tab wait, and aren't marked as shown meanwhile", () => {
  // The guard comes before the mark, so the sheet is still due at the next open.
  assert.match(app, /guard hasChats, !router\.byLink, !UserDefaults\.standard\.bool\(forKey: "cf_whatsnew_organize"\) else \{ return \}\n\s+UserDefaults\.standard\.set\(true, forKey: "cf_whatsnew_organize"\)\n\s+whatsNew = true/)
  assert.match(app, /guard !preview\.on, !router\.byLink else \{ return \}\n\s+let existing = /)
})

test("an open no link started shows what waited, a moment after the app is in front and never over another sheet", () => {
  assert.match(app, /if phase == \.active \{[\s\S]{0,900}?try\? await Task\.sleep\(nanoseconds: 700_000_000\)[\s\S]{0,200}?guard tour\.run == nil, !otherSheet else \{ return \}\n\s+openWhatsNewAfterUpdate\(\)\n\s+showWhatsNewIfDue\(\)/)
})
