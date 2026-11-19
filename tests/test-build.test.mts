// 2.7 (108), the owner on TestFlight, about «Start as a new user»: «Не нашел». The row shows in test builds only
// (TestBuild.isTest, Setup.swift). Until 109 a release build on iPhone or iPad counted as one when it talked to a test
// server AND carried TestFlight's receipt name at Bundle.main.appStoreReceiptURL; 108 did talk to the test server, so
// the receipt half is what could fail on his device, and it can't be seen in a simulator. Now the server alone decides
// on every platform, and the block is the first one in Settings.
//
// The decision is run for real where there's a Swift compiler (a Mac: here and on the owner's; CI's tests run on
// Linux and check the source's shape only). Whether TestFlight shows the row is seen on a device, not here.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const setup = read("../ContextFlow/Shared (App)/Setup.swift")
const chat = read("../ContextFlow/Shared (App)/ChatAI.swift")
const view = read("../ContextFlow/Shared (App)/ContentView.swift")
/** Swift without its comments: what the compiler sees. */
const code = (swift: string) => swift.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
const decision = setup.match(/enum TestBuild \{\n[\s\S]*?\n\}\n/)?.[0] ?? ""
const production = chat.match(/static let productionHost = "([^"]+)"/)?.[1] ?? ""

test("a release build is a test build by its server alone, on every platform; nothing reads the receipt", () => {
  assert.ok(decision, "enum TestBuild is in Setup.swift")
  assert.equal(production, "aisidebar.netlify.app")
  assert.match(decision, /#if DEBUG\n\s+return true\n\s+#else\n\s+return releaseIsTest\(server: ChatAI\.base\)\n\s+#endif/)
  assert.match(decision, /static func releaseIsTest\(server: URL\) -> Bool \{\n\s+guard let host = server\.host else \{ return false \}\n\s+return host != ChatAI\.productionHost\n\s+\}/)
  assert.doesNotMatch(decision, /#if os\(/)
  for (const file of [setup, chat, view]) assert.doesNotMatch(code(file), /appStoreReceiptURL|sandboxReceipt/)
})

test("the decision, compiled and run: the store's server gives no test rows, any other server does", { skip: process.platform !== "darwin" || spawnSync("xcrun", ["--find", "swiftc"]).status !== 0 ? "needs a Mac's Swift compiler" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-test-build-"))
  const main = join(dir, "main.swift")
  // The app's own decision, with the server given on the command line in place of ChatAI.base.
  writeFileSync(main, `import Foundation\nenum ChatAI {\n    static let productionHost = "${production}"\n    static var base: URL { URL(string: CommandLine.arguments[1])! }\n}\n${decision}\nprint(TestBuild.isTest ? "test" : "store")\n`)
  const compile = (out: string, flags: string[]) => {
    execFileSync("xcrun", ["swiftc", "-O", ...flags, "-o", join(dir, out), main], { stdio: "pipe" })
    return (server: string) => execFileSync(join(dir, out), [server], { encoding: "utf8" }).trim()
  }
  const release = compile("release", [])
  // What ships to the App Store, and what App Review runs.
  assert.equal(release("https://aisidebar.netlify.app"), "store")
  assert.equal(release("https://aisidebar.netlify.app/api/v2/status"), "store")
  // TestFlight 108's server (a deploy's permalink), a deploy preview, a local stand.
  assert.equal(release("https://6afd67a35bd6ff03000508f8--aisidebar.netlify.app"), "test")
  assert.equal(release("https://deploy-preview-204--aisidebar.netlify.app"), "test")
  assert.equal(release("http://localhost:8811"), "test")
  // The site's own domain isn't the API's: a build pointed there isn't the store's either.
  assert.equal(release("https://context-flow.app"), "test")
  // No host to read: not a test build.
  assert.equal(release("file:///tmp/x"), "store")
  // A debug build is always one.
  assert.equal(compile("debug", ["-D", "DEBUG"])("https://aisidebar.netlify.app"), "test")
})

test("the app's server is production's, or a line that says it is TestFlight's: nothing else makes a test build", () => {
  const base = chat.match(/static var base: URL \{\n[\s\S]*?\n    \}\n/)?.[0] ?? ""
  const lines = base.split("\n").filter((line) => !line.trim().startsWith("//") && /URL\(string: "https?:/.test(line))
  assert.equal(lines.length, 1, "one address in a release build")
  const host = lines[0].match(/URL\(string: "https?:\/\/([^"/]+)/)?.[1]
  if (host === production) return
  // The TestFlight branch alone changes this line to its deploy, and marks it. Anywhere else a test address fails
  // here (2.7 (110), the owner: «Start as a new user» must never reach anyone but him): in a pull request by its head
  // branch, on main by the pushed branch, on a Mac by the branch checked out. A pull request out of the TestFlight
  // branch into another one fails too: merged, it would carry the address there.
  const env = process.env
  const head = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", cwd: new URL("..", import.meta.url) }).trim()
  const testFlight = /^claude\/release-[\d.]+-tf$/
  assert.match(lines[0], /\/\/ TestFlight/, `the app talks to ${host}`)
  assert.match(head, testFlight, `the app in ${head} talks to ${host}: a test server is for the TestFlight branch alone`)
  assert.ok(!env.GITHUB_BASE_REF || testFlight.test(env.GITHUB_BASE_REF), `the TestFlight branch's test server must not be merged into ${env.GITHUB_BASE_REF}`)
})

test("Settings: the «Test build» block is the first one on the screen, in test builds only", () => {
  const form = view.slice(view.indexOf("private var form: some View {"))
  const first = form.indexOf("if TestBuild.isTest { NewUserPreviewSection() }")
  assert.ok(first > 0)
  assert.ok(first < form.indexOf("Section("), "before every other section")
  assert.equal(view.split("NewUserPreviewSection()").length - 1, 1, "once")
  assert.match(setup, /Section\(\n\s+header: Text\(verbatim: "Test build"\)/)
  assert.match(setup, /Text\(verbatim: "Start as a new user"\)/)
})
