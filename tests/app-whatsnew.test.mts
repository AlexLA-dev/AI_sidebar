// 2.6 (98), the owner on TestFlight 97: «Нужна возможность слать нотификации в приложение пользователям когда новая версия
// вышла, и открывать в приложении обычно скрытую вкладку, где описано, что меняется в приложении, с новыми короткими видео
// как в Tips». The director: a background App Store check with a local notification (no server push), once per version and
// none with notifications off; a tap opens a hidden "What's new" tab with Tips' clips; after an update it opens once itself.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const whatsNew = read("../ContextFlow/Shared (App)/WhatsNew.swift")
const content = read("../ContextFlow/Shared (App)/ContentView.swift")
const catalog = JSON.parse(read("../ContextFlow/Shared (App)/Localizable.xcstrings")).strings

test("the App Store's version, read at most every 12 hours, in the background too on iPhone and iPad", () => {
  assert.match(whatsNew, /static let every: TimeInterval = 12 \* 3600/)
  assert.match(whatsNew, /guard force \|\| now - defaults\.double\(forKey: checkedKey\) > every else \{ return \}/)
  assert.match(whatsNew, /URLComponents\(string: "https:\/\/itunes\.apple\.com\/lookup"\)/)
  const plist = execFileSync("plutil", ["-convert", "json", "-o", "-", "ContextFlow/iOS (App)/Info.plist"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" })
  const info = JSON.parse(plist)
  assert.deepEqual(info.BGTaskSchedulerPermittedIdentifiers, ["com.contextflow.app.versioncheck"])
  assert.ok(info.UIBackgroundModes.includes("fetch") && info.UIBackgroundModes.includes("audio"))
  assert.match(whatsNew, /static let taskId = "com\.contextflow\.app\.versioncheck"/)
  assert.match(read("../ContextFlow/iOS (App)/AppDelegate.swift"), /WhatsNew\.registerBackground\(\)/)
})

test("a newer version is told once, by a local notification, only when notifications are on (never asked for it)", () => {
  assert.match(whatsNew, /guard newer\(found\.version, than: installed\), defaults\.string\(forKey: notifiedKey\) != found\.version else \{ return \}/)
  assert.match(whatsNew, /guard settings\.authorizationStatus == \.authorized \|\| settings\.authorizationStatus == \.provisional else \{ return \}/)
  assert.doesNotMatch(whatsNew, /requestAuthorization/)
  assert.match(whatsNew, /defaults\.set\(found\.version, forKey: notifiedKey\)/)
  // A tap opens the tab, on iPhone, iPad and Mac.
  for (const delegate of ["../ContextFlow/iOS (App)/AppDelegate.swift", "../ContextFlow/macOS (App)/AppDelegate.swift"]) {
    assert.match(read(delegate), /if info\["whatsNew"\] is String \{\s*await MainActor\.run \{ DeepLinkRouter\.shared\.handle\(WhatsNew\.link\) \}/)
  }
  assert.match(content, /case "whatsnew": openWhatsNew\(\)/)
})

test("the tab is hidden until it opens; after an update it opens once by itself, never on a first install", () => {
  assert.match(content, /case home, chats, templates, tips, pro, settings, whatsNew/)
  assert.equal((content.match(/if whatsNewShown \{ whatsNewTab \}/g) ?? []).length, 2)
  assert.match(content, /if whatsNewShown \{ Label\("What's new", systemImage: "sparkles\.rectangle\.stack"\)\.tag\(AppTab\.whatsNew\) \}/)
  assert.match(whatsNew, /guard seen != now else \{ return false \}\s*defaults\.set\(now, forKey: seenKey\)\s*guard seen != nil \|\| existingUser else \{ return false \}/)
  // Before the 2.5 sheet, which then doesn't show.
  assert.match(content, /openWhatsNewAfterUpdate\(\)\s*showWhatsNewIfDue\(\)/)
  assert.match(content, /UserDefaults\.standard\.set\(true, forKey: "cf_whatsnew_organize"\)\s*openWhatsNew\(\)/)
})

test("its cards are Tips' (their words and clips, in every language); a version not installed yet shows its notes and Update", () => {
  assert.match(whatsNew, /\[TipGroup\.similarTip, TipGroup\.listenTip, TipGroup\.chipsTip, TipGroup\.remindTip, TipGroup\.watchTip\]/)
  assert.match(whatsNew, /TipCard\(tip: WhatsNew\.items\[i\]\)/)
  assert.match(whatsNew, /if let store, WhatsNew\.newer\(store\.version, than: WhatsNew\.installed\)/)
  for (const key of ["What's new", "New in ContextFlow %@", "The main things this version brings, each shown in a short clip.", "ContextFlow %@ is here", "See what's new in this version.", "Version %@ is in the App Store", "Update"]) {
    assert.equal(Object.keys(catalog[key]?.localizations ?? {}).length, 13, key)
  }
  // The project builds it for iPhone, iPad and Mac.
  const project = read("../ContextFlow/ContextFlow.xcodeproj/project.pbxproj")
  assert.equal((project.match(/WhatsNew\.swift in Sources \*\/,/g) ?? []).length, 2)
})

test("Tips and the plan tour no longer send people to the ✦ by the search (gone in #130)", () => {
  assert.doesNotMatch(content, /tap ✦ (next to|by) the search/i)
  for (const key of ["Open the search over the chat list, choose By meaning and describe the chat you remember — “that article about sleep and coffee” — even without the exact words.", "In Chats, open the search, choose By meaning and describe the chat you remember. Ask your chats, at the top of the list, answers from all your chats at once."]) {
    assert.equal(Object.keys(catalog[key].localizations).length, 13, key)
    assert.doesNotMatch(JSON.stringify(catalog[key]), /✦/)
  }
})
