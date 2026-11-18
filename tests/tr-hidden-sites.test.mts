// The translate offer dismissed and brought back (2.7, build 108, the owner's decision of 18 November): × hides it on
// the site, a translation started by hand there takes the site off the list, × again puts it back; the install's first
// three × get the line saying where it went.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { HIDDEN_KEY, TOLD_KEY, TOLD_TIMES, hiddenOn, hideOn, isHidden, showOn, tellsAt, withHidden, withShown, type SiteStore } from "../src/content/translate/hiddenSites.ts"
import { FIRST_RUN_KEYS } from "../src/shared/firstRun.ts"

function memory(items: Record<string, unknown> = {}): SiteStore & { items: Record<string, unknown> } {
  return {
    items,
    async get(key) {
      return key in items ? { [key]: structuredClone(items[key]) } : {}
    },
    async set(more) {
      Object.assign(items, structuredClone(more))
    }
  }
}

test("hidden → translated by hand → not hidden → dismissed → hidden", async () => {
  const store = memory()
  assert.equal(await hiddenOn(store, "hurriyet.com.tr"), false)
  await hideOn(store, "hurriyet.com.tr")
  assert.equal(await hiddenOn(store, "hurriyet.com.tr"), true)
  // Another site isn't touched either way.
  await hideOn(store, "elpais.com")
  assert.equal(await showOn(store, "hurriyet.com.tr"), true)
  assert.equal(await hiddenOn(store, "hurriyet.com.tr"), false)
  assert.equal(await hiddenOn(store, "elpais.com"), true)
  // A second translation by hand there: nothing to take off.
  assert.equal(await showOn(store, "hurriyet.com.tr"), false)
  await hideOn(store, "hurriyet.com.tr")
  assert.equal(await hiddenOn(store, "hurriyet.com.tr"), true)
  assert.deepEqual(store.items[HIDDEN_KEY], ["hurriyet.com.tr", "elpais.com"])
})

test("the list: most recent first, no repeats, kept short, odd values read as empty", () => {
  assert.deepEqual(withHidden(["a", "b"], "b"), ["b", "a"])
  assert.deepEqual(withHidden(["a", "b", "c"], "d", 3), ["d", "a", "b"])
  assert.deepEqual(withShown(["a", "b"], "a"), ["b"])
  for (const odd of [undefined, null, "a", 5, { a: 1 }, [1, null]]) {
    assert.equal(isHidden(odd, "a"), false)
    assert.deepEqual(withHidden(odd, "a"), ["a"])
  }
})

test("the line after ×: on the install's first three, then only the fold", async () => {
  assert.equal(TOLD_TIMES, 3)
  const store = memory()
  const told = []
  for (let i = 0; i < 5; i++) told.push(await hideOn(store, `site${i % 2}.example`))
  assert.deepEqual(told, [true, true, true, false, false])
  assert.equal(store.items[TOLD_KEY], 3)
  assert.equal(tellsAt(undefined), true)
  assert.equal(tellsAt(2), true)
  assert.equal(tellsAt(3), false)
  // «Start as a new user» starts the count over.
  assert.ok(FIRST_RUN_KEYS.includes(TOLD_KEY))
})

test("the pill: a translation that came out by hand brings the offer back; × hides and says where it went", () => {
  const pill = readFileSync(new URL("../src/content/translate/TranslatePill.tsx", import.meta.url), "utf8")
  // Only one that came out (working → on after a tap): not the consent declined, the limit, or the pill opened and closed.
  assert.match(pill, /if \(tapped\.current && prev\.current === "working" && state\.at === "on"\) \{\s*step\("done"\)\s*void showHere\(\)\.then\(\(was\) => was && unhide\(\)\)/)
  assert.equal((pill.match(/showHere\(\)/g) ?? []).length, 1)
  // ×: hidden, then the line (first three) or straight to the fold into the entry.
  assert.match(pill, /setFolding\(tells\.current \? "told" : "fold"\)/)
  assert.match(pill, /export const TOLD_MS = 4_000/)
  assert.match(pill, /<div class=\{`cf-tr told \$\{side\}`\} style=\{style\} role="status" onClick=\{open\}>/)
  // The entry right after × and its stepping aside over a page's button stay (#207).
  assert.match(pill, /useOverPageControls<HTMLButtonElement>\(visible && !pill && state\.at === "off", false\)/)
})

test("the line is said in every language the panel speaks, none left in English", () => {
  const dir = new URL("../src/locales/", import.meta.url)
  const en = JSON.parse(readFileSync(new URL("en.json", dir), "utf8")).trHiddenTold
  for (const l of ["ar", "de", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const said = JSON.parse(readFileSync(new URL(`${l}.json`, dir), "utf8")).trHiddenTold
    assert.ok(typeof said === "string" && said.length > 8, l)
    assert.notEqual(said, en, l)
    assert.doesNotMatch(said, /\b(Hidden|icon|brings|back)\b/, l)
  }
})
