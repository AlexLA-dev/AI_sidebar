// The Xcode project: every object id once. Two PRs that pick the same hand-made id (2.7: Invite.swift and
// BoardPDF.swift both CF27D0…) merge cleanly, and Xcode then silently keeps one file and drops the other.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("every object in the Xcode project has its own id", () => {
  const project = readFileSync(new URL("../ContextFlow/ContextFlow.xcodeproj/project.pbxproj", import.meta.url), "utf8")
  const ids = [...project.matchAll(/^\t\t([0-9A-F]{24}) \/\* (.+?) \*\/ = \{/gm)].map((m) => [m[1], m[2]] as const)
  assert.ok(ids.length > 50)
  const seen = new Map<string, string>()
  const twice = ids.filter(([id, name]) => {
    const before = seen.get(id)
    seen.set(id, name)
    return before !== undefined
  }).map(([id, name]) => `${id}: ${seen.get(id)} / ${name}`)
  assert.deepEqual(twice, [])
})
