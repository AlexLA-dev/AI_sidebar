// 2.8 (В1.9): our own simulator and debug builds reached production as new people (160 "installs" on 14–22.11, our
// sessions' simulator loops). Every request they send is now marked audience "test", which the server keeps and every
// report leaves out (contextflow.test_ids); a release build on a real device never is.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")

test("one flag, in both copies of SharedDefaults: a debug build or any simulator build, never a release on a device", () => {
  const app = read("ContextFlow/Shared (App)/SharedDefaults.swift")
  assert.equal(app, read("ContextFlow/Shared (Extension)/SharedDefaults.swift"))
  const flag = /enum OurBuild \{\s*static let isOurs: Bool = \{([\s\S]*?)\}\(\)\s*\}/.exec(app)?.[1] ?? ""
  assert.match(flag, /^\s*#if DEBUG\s*return true\s*#elseif targetEnvironment\(simulator\)\s*return true\s*#else\s*return false\s*#endif\s*$/)
})

test("the app marks every request it sends: events, app opened, and the AI requests' identity", () => {
  const setup = read("ContextFlow/Shared (App)/Setup.swift")
  // AppSource.client is every event's client (ChatAI.eventRequest, reportRenewal, reportSocial) and app_open's.
  assert.match(setup, /static func client\(platform: String, locale: String\) -> \[String: String\] \{[\s\S]*?if OurBuild\.isOurs \{ client\["audience"\] = "test" \}\s*return client/)
  assert.match(setup, /"client": AppSource\.client\(platform: Self\.platform/)
  const chatAI = read("ContextFlow/Shared (App)/ChatAI.swift")
  assert.equal((chatAI.match(/"client": AppSource\.client\(/g) ?? []).length, 3)
  assert.match(chatAI, /static func identity\(\) -> \[String: Any\] \{[\s\S]*?if OurBuild\.isOurs \{ client\["audience"\] = "test" \}[\s\S]*?"client": client/)
  // No other client dictionary is built in the app.
  for (const file of ["Setup.swift", "ChatAI.swift"]) {
    const s = read(`ContextFlow/Shared (App)/${file}`)
    assert.equal((s.match(/"platform": (Self\.)?platform/g) ?? []).length, 1, file)
  }
})

test("the extension marks every request through the native ping", () => {
  const handler = read("ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift")
  assert.match(handler, /case "ping":[\s\S]{0,900}?if OurBuild\.isOurs \{ data\["test"\] = true \}\s*Self\.reply\(context, \["success": true, "data": data\]\)/)
  const bg = read("src/background/index.ts")
  assert.match(bg, /return \{ build: data\?\.build \?\? "", app, test: data\?\.test === true \}/)
  assert.match(bg, /async function clientInfo\(\) \{[\s\S]*?\.\.\.\(test \? \{ audience: "test" \} : \{\}\) \}/)
  // Chrome (no native side) is never marked by this.
  assert.match(bg, /if \(TARGET !== "safari"\) return Promise\.resolve\(\{ build: "", app: null, test: false \}\)/)
  // Every event the extension sends takes its client from clientInfo (the deps' or the background's own).
  for (const file of ["src/background/watch.ts", "src/background/translate.ts", "src/background/insert.ts"]) {
    assert.match(read(file), /deps\.clientInfo\(\)/, file)
  }
})

test("the server keeps the mark on every step, and the reports leave such installs out", () => {
  assert.match(read("netlify/functions/v2-event.mts"), /\.\.\.\(body\.audience === "test" \|\| client\.audience === "test" \? \{ audience: "test" \} : \{\}\)/)
  assert.match(read("netlify/functions/v2-chat.mts"), /\.\.\.\(client\.audience === "test" \? \{ audience: "test" \} : \{\}\)/)
  const sql = read("supabase/migrations/20261110180000_contextflow_test_installs.sql")
  assert.match(sql, /where data \? 'app' and \(data->>'audience' = 'test'/)
})
