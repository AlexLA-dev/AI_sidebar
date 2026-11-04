// The panel's shadow roots are closed in what ships: no page script can read Copied, the chats or the answers
// (a release blocker in the director's 2.5 audit). Only a test build against a local stand leaves them open.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const build = (env: Record<string, string>) => {
  const out = mkdtempSync(join(tmpdir(), "cf-shadow-"))
  execFileSync("node", ["scripts/build-extension.mjs", `--out=${out}`], { cwd: root, env: { ...process.env, ...env }, stdio: "pipe" })
  return out
}
// The mode each attachShadow gets: a literal, or the minified constant it was folded into (ir="closed").
const attach = (code: string) =>
  [...code.matchAll(/attachShadow\(\{mode:("(\w+)"|[\w$]+)\}\)/g)].map((m) => {
    if (m[2]) return m[2]
    const name = m[1].replace(/\$/g, "\\$")
    return new RegExp(`(?:^|[^\\w$.])${name}="(open|closed)"`).exec(code)?.[1] ?? `unknown:${m[1]}`
  })

test("a production build attaches only closed shadow roots (the panel, the popup, Google's suggestions)", () => {
  const out = build({ CF_API_BASE: "", CF_OPEN_SHADOW: "" })
  const content = readFileSync(join(out, "dist/content.js"), "utf8")
  const popup = readFileSync(join(out, "dist/popup.js"), "utf8")
  assert.ok(attach(content).length >= 2, "the panel's root and the suggestions' root")
  assert.ok(attach(popup).length >= 1)
  for (const mode of [...attach(content), ...attach(popup)]) assert.equal(mode, "closed")
  for (const file of readdirSync(join(out, "dist"))) {
    assert.doesNotMatch(readFileSync(join(out, "dist", file), "utf8"), /mode:"open"/, file)
  }
})

test("an open root needs a local stand: never with the production API", () => {
  assert.throws(() => build({ CF_API_BASE: "", CF_OPEN_SHADOW: "1" }), /test builds/)
  const out = build({ CF_API_BASE: "http://localhost:8810", CF_OPEN_SHADOW: "1" })
  assert.deepEqual([...new Set(attach(readFileSync(join(out, "dist/content.js"), "utf8")))], ["open"])
})

test("presses and keys read their path through listenAround: from the page, a closed root shows only its host", () => {
  // A menu that closed on a press of its own item (the click then fell through to the page) was the first sign.
  const files = execFileSync("grep", ["-rln", "composedPath", "src"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  assert.deepEqual(files, ["src/content/around.ts"])
})

test("every shadow root in the code takes its mode from SHADOW_MODE", () => {
  const files = execFileSync("grep", ["-rln", "attachShadow", "src"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  for (const file of files) {
    const src = readFileSync(join(root, file), "utf8")
    for (const m of src.matchAll(/attachShadow\(\{\s*mode:\s*([^}\s]+)\s*\}\)/g)) assert.equal(m[1], "SHADOW_MODE", file)
  }
})
