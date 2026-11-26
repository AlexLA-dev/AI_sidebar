// Round 138: a measuring run may raise the agent's step cap, behind the same gate as the named driver (a request
// signed with the measuring key, on a deploy preview). Production and unsigned requests keep the configured cap; the
// value is clamped to 60; the shipped panel never sends it.
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { evalAccess, MEASURED_STEPS_MAX, stepCap } from "../netlify/shared/plan.mts"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
process.env.CF_EVAL_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64")
const install = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const signed = () => {
  const at = Date.now()
  return new Request("https://x/api/v2/act", { method: "POST", headers: { "x-cf-eval": `${at}.${sign(null, Buffer.from(`${install}.${at}`), privateKey).toString("base64url")}` } })
}
const plain = () => new Request("https://x/api/v2/act", { method: "POST" })
const preview = { deploy: { context: "deploy-preview" } }
const production = { deploy: { context: "production" } }

test("the step cap: raised only for a signed request on a deploy preview, clamped to 60, never lowered", () => {
  const ok = evalAccess(signed(), install, preview)
  assert.ok(ok, "a signed preview request is a measuring one")
  assert.equal(stepCap(ok, 60, 30), 60)
  assert.equal(stepCap(ok, 500, 30), MEASURED_STEPS_MAX)
  assert.equal(MEASURED_STEPS_MAX, 60)
  assert.equal(stepCap(ok, 10, 30), 30, "never lowered")
  assert.equal(stepCap(ok, "60", 30), 30, "a number only")
  assert.equal(stepCap(ok, undefined, 30), 30)
  // Production, even signed: the configured cap.
  assert.equal(evalAccess(signed(), install, production), null)
  assert.equal(stepCap(evalAccess(signed(), install, production), 60, 30), 30)
  // A preview request without the signature: the configured cap.
  assert.equal(stepCap(evalAccess(plain(), install, preview), 60, 30), 30)
  // A bad signature on a preview: the configured cap.
  const forged = new Request("https://x", { headers: { "x-cf-eval": `${Date.now()}.AAAA` } })
  assert.equal(stepCap(evalAccess(forged, install, preview), 60, 30), 30)
})

test("only the act endpoint's step count reads it; the shipped panel never sends maxSteps", () => {
  const act = readFileSync("netlify/functions/v2-act.mts", "utf8")
  assert.match(act, /const maxSteps = stepCap\(measuring, body\.maxSteps, a\.maxSteps\)/)
  assert.doesNotMatch(act, /a\.maxSteps(?!\))/, "every other use reads the request's cap")
  for (const f of ["src/background/agent.ts", "src/shared/agent/runner.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /maxSteps:\s*[^,}\n]*,?[^\n]*body|"maxSteps"|maxSteps: io\.|\.\.\.\{ maxSteps/, f)
  // The body the runner sends has no maxSteps field.
  assert.doesNotMatch(readFileSync("src/shared/agent/runner.ts", "utf8"), /body[^\n]*maxSteps/)
})
