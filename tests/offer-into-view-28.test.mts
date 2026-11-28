// 2.8 (the director on #273): a plans message that answers a tap came below the fold on iPhone (the agent's: only its
// title above the field). PlanOffer now brings itself into view as it comes and while its prices and facts come in: the
// whole card when it fits, else its plan and the button under it.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let lib: { revealDelta: (list: { top: number; bottom: number }, card: { top: number; bottom: number }, button: { bottom: number } | null, pad?: number) => number }
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-into-view-"))
  writeFileSync(join(dir, "entry.ts"), `export { revealDelta } from ${JSON.stringify(join(root, "src/content/ux/PlanOffer.tsx"))}`)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [join(root, "node_modules")], loader: { ".css": "empty" }
  })
  lib = await import(pathToFileURL(out).href)
})

// The chat list on an iPhone at the panel's opening height: 266 px from 240 to 506.
const list = { top: 240, bottom: 506 }

test("a card that fits: scrolled up just enough to show it whole (the agent's: only its title above the field)", () => {
  // The card starts at 470 (its title line visible) and is 250 tall: 222 px to scroll, its bottom 8 px above the field.
  assert.equal(lib.revealDelta(list, { top: 470, bottom: 720 }, { bottom: 690 }), 222)
  // Already in view: nothing.
  assert.equal(lib.revealDelta(list, { top: 250, bottom: 480 }, { bottom: 460 }), 0)
})

test("a card taller than the chat: its plan and button in view, the title scrolled off rather than the button", () => {
  // 400 tall from 470: the button's bottom at 820 → to 498 (the list's bottom less 8), 330 px.
  assert.equal(lib.revealDelta(list, { top: 470, bottom: 870 }, { bottom: 820 }), 330)
  // No button found: its own bottom.
  assert.equal(lib.revealDelta(list, { top: 470, bottom: 870 }, null), 372)
})

test("never scrolled up; a fitting card never past the list's top", () => {
  assert.equal(lib.revealDelta(list, { top: 100, bottom: 300 }, { bottom: 280 }), 0)
  // Fits, but most of it is already above: no more than its top allows.
  assert.equal(lib.revealDelta(list, { top: 245, bottom: 510 }, { bottom: 495 }), 5)
})

test("PlanOffer runs it as it comes and while its prices and facts come in, inside the chat list only", () => {
  const offer = readFileSync(join(root, "src/content/ux/PlanOffer.tsx"), "utf8")
  assert.match(offer, /if \(Date\.now\(\) - since\.current > 2_000\) return/)
  assert.match(offer, /card\?\.closest<HTMLElement>\("\.cf-messages"\)/)
  assert.match(offer, /\}, \[priced, Boolean\(facts\)\]\)/)
  assert.match(offer, /<div ref=\{ref\} class=\{`cf-card cf-offer \$\{place\}`\}/)
})
