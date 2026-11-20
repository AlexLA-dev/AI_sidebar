// 2.7 (112): «Да» on «Translate all pages of the site?» marks the page as translated, so the first «Original» on it
// stays original instead of the site's yes translating it again (found on 110/111 while shooting the store preview).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("the site's yes marks the page it was said on, so Original there isn't undone by the auto-translation", () => {
  const src = readFileSync(new URL("../src/content/translate/TranslatePill.tsx", import.meta.url), "utf8")
  const yes = src.slice(src.indexOf("const siteYes = () => {"), src.indexOf("const siteOff = () => {"))
  assert.ok(yes.length > 0, "siteYes found")
  assert.match(yes, /autoTried\.current = urlKey\(location\.href\)/)
  // The auto-translation skips a page whose address is marked.
  assert.match(src, /if \(autoTried\.current === here\) return/)
})
