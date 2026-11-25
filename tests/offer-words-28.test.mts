// 2.8 (the director after acceptance 3): next to the monthly price, «Get Pro 50% off» read as a second, cheaper buy
// button. It's the first month only, through a code in the App Store: the button says the first month, and one line under
// it says it's applied with a code. No second price in the price box. In all 15 languages.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

test("the words: the first month, and the code, in every language", () => {
  const en = JSON.parse(read("src/locales/en.json"))
  assert.equal(en.offerButton, "Get the first month {0}% off")
  assert.equal(en.offerByCode, "Applied with a code in the App Store.")
  const langs = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json"))
  assert.equal(langs.length, 15)
  for (const f of langs) {
    const keys = JSON.parse(read(`src/locales/${f}`))
    assert.match(keys.offerButton, /\{0\}/, f)
    assert.ok(keys.offerByCode && keys.offerByCode !== keys.offerButton, f)
    assert.match(keys.offerByCode, /App Store/, f)
    // Not «Get Pro 50% off» any more (the old wording, Pro at a discount without saying it's the first month).
    if (f !== "en.json") assert.notEqual(keys.offerButton, en.offerButton, `${f} is untranslated`)
  }
})

test("every offer button has the code line with it; the plan cards' price box gets no second price", () => {
  for (const path of ["src/content/App.tsx", "src/content/ProUpsell.tsx"]) {
    const text = read(path)
    const buttons = text.match(/t\("offerButton"/g) ?? []
    const lines = text.match(/<p class="cf-offer-code">\{t\("offerByCode"\)\}<\/p>/g) ?? []
    assert.ok(buttons.length > 0, path)
    assert.equal(lines.length, buttons.length, `${path}: ${buttons.length} offer buttons, ${lines.length} code lines`)
  }
  assert.doesNotMatch(read("src/content/ux/PlanOffer.tsx"), /offerButton|offerByCode|offer\.discount/)
})
