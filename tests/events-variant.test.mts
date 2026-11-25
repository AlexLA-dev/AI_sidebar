// 2.8 (growth plan, events-2.8.md): every event of an install in a test carries its arms ("variant"), and the free
// answers' limit row carries the app build, so the ladder can be read by test arm and by build.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { variantFields } from "../src/shared/usage.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")

test("a variant is one to three named arms; anything else is left out", () => {
  assert.deepEqual(variantFields({ variant: "guide=b" }), { variant: "guide=b" })
  assert.deepEqual(variantFields({ variant: "guide=b,setup_v2=a,plans=control" }), { variant: "guide=b,setup_v2=a,plans=control" })
  for (const bad of ["", "guide", "Guide=B", "guide=b,", "a=1,b=2,c=3,d=4", "guide=b c", "x".repeat(17) + "=a", "guide=00000000-0000-4000-8000-000000000000", 3, null]) {
    assert.deepEqual(variantFields({ variant: bad }), {}, String(bad))
  }
  assert.deepEqual(variantFields(null), {})
  assert.deepEqual(variantFields({}), {})
})

test("/api/v2/event keeps it on every step; /api/v2/chat on the answer's row and the limit's, with the build", () => {
  const event = read("netlify/functions/v2-event.mts")
  assert.match(event, /const shared = \{[\s\S]*?\.\.\.variantFields\(client\),[\s\S]*?\n  \}/)
  const chat = read("netlify/functions/v2-chat.mts")
  assert.match(chat, /const step = \{[\s\S]*?\.\.\.variantFields\(client\),[\s\S]*?\n  \}/)
  assert.match(chat, /logEvent\("limit", installId, \{ plan: access\.plan, reason, platform, version, \.\.\.\(build \? \{ build \} : \{\}\),[^\n]*\.\.\.step \}\)/)
  assert.match(chat, /logEvent\("chat", installId, \{[\s\S]*?\n      build,\n      \.\.\.step\n    \}\)/)
})
