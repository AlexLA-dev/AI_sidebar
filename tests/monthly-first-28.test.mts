// 2.8, the owner: «всегда лучше поначалу показывать месячные подписки». Every purchase surface opens on Monthly, from
// one constant in the panel (DEFAULT_PERIOD) and one in the app (PlanDefaults); a subscriber changing plan sees their own
// period. This fails if a surface starts on Yearly again.
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { DEFAULT_PERIOD, startPeriod } from "../src/shared/plan.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(path, ext) : ext.test(name) ? [path] : []
  })
}

test("the panel's one default is Monthly; a subscriber's own period wins", () => {
  assert.equal(DEFAULT_PERIOD, "monthly")
  assert.equal(startPeriod(null), "monthly")
  assert.equal(startPeriod(undefined), "monthly")
  assert.equal(startPeriod("com.contextflow.pro.monthly"), "monthly")
  assert.equal(startPeriod("com.contextflow.ultra.yearly"), "yearly")
  assert.equal(startPeriod("something.else"), "monthly")
})

test("every period switch in the panel starts from startPeriod(), none from a literal", () => {
  const sources = files("src", /\.(tsx?|mts)$/)
  const switches: string[] = []
  for (const path of sources) {
    const text = read(path)
    for (const m of text.matchAll(/useState<Period>\(([^\n]*)\)/g)) {
      switches.push(path)
      assert.match(m[1], /^startPeriod\(/, `${path}: a period switch starts from ${m[1]}`)
    }
    assert.doesNotMatch(text, /useState(<Period>)?\(\s*"yearly"\s*\)/, `${path} starts a switch on Yearly`)
  }
  // The plans sheet and the plan cards (the limit card, Find similar, Pro-only, memory).
  assert.ok(switches.includes(join("src", "content", "Plans.tsx")))
  assert.ok(switches.includes(join("src", "content", "ux", "PlanOffer.tsx")))
})

test("the app's one default is Monthly: the Pro screen (iPhone, iPad, Mac) opens on it unless a link or the subscription names one", () => {
  const swift = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(swift, /enum PlanDefaults \{\s*static let yearlyFirst = false/)
  assert.match(swift, /@Published var yearly = PlanDefaults\.yearlyFirst/)
  assert.doesNotMatch(swift, /var yearly = true/)
  // The only assignments: a link's period, or the opening's start (default or the subscriber's own).
  const sets = [...swift.matchAll(/\byearly = ([^\n;]+)/g)].map((m) => m[1].trim())
  assert.deepEqual(sets.filter((s) => !s.startsWith("PlanDefaults.") && s !== 'period == "yearly"'), [])
  assert.match(swift, /\.onAppear \{ paywall\.startPeriod\(subscribed: store\.entitlement\.active \? store\.entitlement\.productId : nil\) \}/)
  assert.match(swift, /Picker\("Billing", selection: \$paywall\.yearly\)/)
})
