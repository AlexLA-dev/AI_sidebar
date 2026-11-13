// 2.6.1, the owner on his iPad: «Вот кстати как в приложении отображается окно Share...». Share under an answer opened a
// sliver of a popover under the tab bar: ShareLink and our own share sheet hung the iPad's popover from wherever they
// guessed (the middle of the screen, a corner). Every Share in the app now goes through ShareButton, which hangs it
// from the button that was tapped (iPad), the usual sheet on an iPhone, the share menu by the button on a Mac.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const dir = "ContextFlow/Shared (App)"
const swift = readdirSync(join(root, dir)).filter((f) => f.endsWith(".swift"))
const code = (f: string) => read(`${dir}/${f}`).replace(/^\s*\/\/.*$/gm, "")
const button = code("ShareButton.swift")
const chats = code("ChatsView.swift")

test("the popover hangs from the button that was tapped", () => {
  assert.match(button, /\.background\(ShareAnchorView\(anchor: anchor\)\)/)
  assert.match(button, /ShareSheet\.present\(items\(\), from: anchor\.view, done: done\)/)
  assert.match(button, /popover\.sourceView = anchor\s+popover\.sourceRect = anchor\.bounds/)
  // Taps and clicks go to the button, not to its anchor.
  assert.match(button, /view\.isUserInteractionEnabled = false/)
  assert.match(button, /override func hitTest\(_ point: NSPoint\) -> NSView\? \{ nil \}/)
  // The window the button is in (an iPad can show the app in two windows), the top of what it shows.
  assert.match(button, /let window = anchor\?\.window \?\?/)
  // The Mac: the share menu by the button.
  assert.match(button, /NSSharingServicePicker\(items: items\)\.show\(relativeTo: view\.bounds, of: view, preferredEdge: \.minY\)/)
})

test("no Share in the app hangs from a guessed point any more", () => {
  for (const f of swift.filter((f) => f !== "ShareButton.swift")) {
    const c = code(f)
    assert.doesNotMatch(c, /UIActivityViewController|NSSharingServicePicker|popoverPresentationController/, f)
  }
  // ShareLink only for the Mac's picked messages (its own menu by the button), never on an iPad.
  const links = [...chats.matchAll(/ShareLink\(/g)].map((m) => m.index!)
  assert.equal(links.length, 1)
  const before = chats.slice(0, links[0])
  assert.ok(before.lastIndexOf("#else") > before.lastIndexOf("#if os(iOS)"), "ShareLink is the Mac's branch")
  assert.doesNotMatch(chats, /RichAnswer\.share|shareRich|ShareSheet\.present\(/)
})

test("Share under a message and for picked messages goes through ShareButton, with what it shared before", () => {
  assert.match(chats, /ShareButton\(items: share\) \{ Label\("Share", systemImage: "square\.and\.arrow\.up"\) \}/)
  assert.match(chats, /ShareButton\(items: \{ \[text\(\)\] \}, done: \{ self\.picked = nil \}\)/)
  // An answer with highlights: rich text, the highlights in bold; the rest: the text with its links.
  assert.match(chats, /if !entry\.isNote, let marks = entry\.marks, !marks\.isEmpty \{\s+ChatAI\.reportUx\("ux_mark", \["action": "shared"\]\)\s+return \[RichAnswer\.bold\(entry\.content, marks: marks\)\]\s+\}\s+return \[entry\.isNote \? ShareText\.note\(thread\.entries, index, labels\) : ShareText\.answer\(thread\.entries, index, labels\)\]/)
  assert.match(chats, /share: \{ \[ShareText\.answer\(entries, index, labels\)\] \}/)
})

test("ShareButton.swift is built into the iPhone/iPad app and the Mac app", () => {
  const pbx = read("ContextFlow/ContextFlow.xcodeproj/project.pbxproj")
  const ref = pbx.match(/(\w{24}) \/\* ShareButton\.swift \*\/ = \{isa = PBXFileReference/)?.[1]
  assert.ok(ref)
  const builds = [...pbx.matchAll(new RegExp(`(\\w{24}) /\\* ShareButton\\.swift in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `, "g"))].map((m) => m[1])
  assert.equal(builds.length, 2)
  for (const b of builds) assert.equal(pbx.split(`${b} /* ShareButton.swift in Sources */,`).length - 1, 1)
})

// ------------------------------------------------------------ it builds for both (swiftc, on a Mac)

const xcrun = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0
const skip = !xcrun && "needs Xcode's swiftc (a Mac)"
const typecheck = (sdk: string, target: string) => {
  const path = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"]).toString().trim()
  execFileSync("xcrun", ["swiftc", "-typecheck", "-swift-version", "5", "-default-isolation", "MainActor", "-sdk", path, "-target", target, join(root, dir, "ShareButton.swift")], { stdio: "pipe", timeout: 300_000, killSignal: "SIGKILL" })
}

test("ShareButton typechecks for iOS 16.6", { skip }, () => typecheck("iphonesimulator", "arm64-apple-ios16.6-simulator"))
test("ShareButton typechecks for macOS 13.5", { skip }, () => typecheck("macosx", "arm64-apple-macos13.5"))
