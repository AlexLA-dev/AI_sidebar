import assert from "node:assert/strict"
import { test } from "node:test"

import { CONSENT_VERSION, consentStatus } from "../src/shared/consent.ts"

test("consent given for the old text (OpenAI only) is asked again; the current one is not", () => {
  assert.equal(CONSENT_VERSION, 2)
  // 2.3 and 2.4 (66) stored `true` for the text that named OpenAI only.
  assert.equal(consentStatus(true), "old")
  assert.equal(consentStatus(1), "old")
  assert.equal(consentStatus(2), "ok")
  assert.equal(consentStatus(3), "ok")
  // Never asked: the card as before.
  for (const none of [undefined, null, false, 0, ""]) assert.equal(consentStatus(none), "none")
})
