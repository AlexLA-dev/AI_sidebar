// Build 110, the director's clean install after #230: on our own site, where the app's «Open Safari» takes every new
// person, the line «Find it cheaper?» stood by the round button before the person had ever tapped it. While the
// panel's first run is still to come, a page gets no hint line at all: the first thing said is the first run itself.
// After it the lines work as in 109 (free apps' store pages included: the page's kind is untouched).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("the page's line isn't looked for while the first run is to come, and nothing is counted for it", () => {
  const hook = read("src/content/pagehints/PageHints.tsx")
  assert.match(hook, /export function usePageHints\(\{ plan, ready, firstRunAhead, open, may, onUsed \}: \{\n\s+plan: Plan; ready: boolean; firstRunAhead: boolean; open: \(\) => void\n/)
  // Read through a ref: the look runs from a timer set when the page loaded, and must see the mark as it is then.
  assert.match(hook, /const aheadRef = useRef\(firstRunAhead\)\n\s+aheadRef\.current = firstRunAhead/)
  const look = hook.slice(hook.indexOf("const look = async () => {"), hook.indexOf("timer = setTimeout(() => void look(), FIRST_LOOK_MS)"))
  assert.match(look, /if \(aheadRef\.current\) \{\n\s+done\.current = true\n\s+return\n\s+\}/)
  // Before the page's kind is read, before a line is picked, shown or counted against the first days' five.
  const ahead = look.indexOf("if (aheadRef.current)")
  // (2.8.1, R4: shown and counted only once the coordinator puts the line on screen: PageHints' seen(), not in the look.)
  for (const later of ["if (!readyRef.current", "pageIsForeign()", "pickHint(", "setLine(id)"]) {
    assert.ok(look.indexOf(later) > ahead, `${later} comes after the first-run check`)
  }
  // The page is settled with it: no line later on the same page, once the first run is over (no retry).
  const block = look.slice(ahead, look.indexOf("if (!readyRef.current"))
  assert.doesNotMatch(block, /setTimeout/)
})

test("the panel says so by the same mark that puts Summarize first: the tour not seen yet", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /usePageHints\(\{ plan: status\?\.plan \?\? keptPlan \?\? "free", ready: [^}]*, firstRunAhead: !tourSeen, open: openFromHint,\n/)
  assert.match(app, /setChipOrder\(!tourSeenRef\.current \|\| guideRef\.current === "summarize" \? chipFirst\(order, "summarize"\) : order\)/)
  // Unknown until the stored marks are read (a moment after the page loads, long before the line's first look):
  // "seen" until then, so a page whose marks can't be read keeps its lines as in 109.
  assert.match(app, /const \[tourSeen, setTourSeen\] = useState\(true\)/)
  // The first run's end, either way (the cards' tour, the guided request), sets it: lines from the next page on.
  assert.ok((app.match(/setTourSeen\(true\)\n\s+void markTourSeen\(\)/g)?.length ?? 0) >= 2)
})

test("after the first run nothing about the lines has changed: a product's page, a free app's among them, still has its two", () => {
  const rules = read("src/content/pagehints/rules.ts")
  assert.match(rules, /case "product":\n\s+return \["similar", "watch"\]/)
  const detect = read("src/content/pagehints/detect.ts")
  // The kind is by the offer, free or not (#230's last form): only the chips' row drops «Watch the price» there.
  assert.match(detect, /if \(rec\.offers && typeof rec\.offers === "object"\) out\.add\("offer"\)/)
})

test("the built extension has it", () => {
  const dist = read("ContextFlow/Shared (Extension)/Resources/dist/content.js")
  assert.match(dist, /firstRunAhead/)
})
