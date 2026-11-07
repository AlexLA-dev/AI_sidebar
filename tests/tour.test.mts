import { test } from "node:test"
import assert from "node:assert/strict"

import { countersFor } from "../netlify/shared/plan.mts"
import { tourAsked, tourCounters } from "../netlify/shared/tour.mts"

const ID = "6f1d3c1e-2b0a-4a5e-9c41-7d2f0b3e8a11"
const free = { plan: "free" as const, entitlement: null }

test("the guide's mark is tried only for an ordinary answer, not Google, not Ask your chats, not Pro", () => {
  assert.equal(tourAsked({ tour: true }, "free", false, false), true)
  assert.equal(tourAsked({ tour: true }, "byok", false, false), true)
  assert.equal(tourAsked({ tour: true }, "pro", false, false), false)
  assert.equal(tourAsked({ tour: true }, "free", true, false), false)
  assert.equal(tourAsked({ tour: true }, "free", false, true), false)
  // Only the very value true: "1", "true" and the like are no mark.
  for (const tour of [undefined, "true", 1, {}]) assert.equal(tourAsked({ tour }, "free", false, false), false)
})

test("a free guided answer is charged to everything but the install's own daily answers", () => {
  const all = countersFor(free, ID, "ip:abc")
  assert.deepEqual(tourCounters(all, ID, false), all)
  const charged = tourCounters(all, ID, true).map((c) => c.subject)
  assert.deepEqual(charged, ["ip:abc", "global:free"])
  // Another install's counter is never taken out.
  assert.equal(tourCounters(countersFor(free, ID, "ip:abc"), "00000000-0000-4000-8000-000000000000", true).length, all.length)
})
