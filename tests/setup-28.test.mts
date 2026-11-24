// 2.8 (growth plan, section В: the iPad enable path and the bridge to Safari), the container app's side:
// В2.1 the iPad path told as it is, В2.2 no frame left over the steps, В2.3/В3.2 no notifications question during setup,
// В2.4 the «Open Safari» step, В2.6 quiet setup reminders, В3.4 no friend's code card on the first screen, and the
// events В1.1, В1.6, В1.7. The Swift side is checked by its source, as the other app tests do.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { FEATURES, useFields } from "../src/shared/usage.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const app = (f: string) => read(`ContextFlow/Shared (App)/${f}`)
const ext = (f: string) => read(`ContextFlow/Shared (Extension)/${f}`)
const setup = app("Setup.swift")
const content = app("ContentView.swift")
const catalog = JSON.parse(app("Localizable.xcstrings")).strings as Record<string, { localizations?: Record<string, { stringUnit: { value: string } }> }>
const LANGS = ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-BR", "ru", "tr", "uk", "vi", "zh-Hans", "zh-Hant"]

test("В2.3: nothing asks about notifications at launch; the reminders to finish setup go quietly", () => {
  const launched = /func launched\(\) async \{([\s\S]*?)\n {4}\}/.exec(setup)?.[1] ?? ""
  assert.match(launched, /await SetupReminders\.schedule\(\)/)
  assert.doesNotMatch(launched, /NotifyAsk|Task\.sleep/)
  assert.doesNotMatch(setup, /case launch\b/)
  assert.doesNotMatch(setup, /\.show\(\.launch\)/)
  // Provisional only when nothing was ever asked: never in place of a "no", never a question.
  const schedule = /static func schedule\(\) async \{([\s\S]*?)\n {4}\}/.exec(setup)?.[1] ?? ""
  assert.match(schedule, /if await center\.notificationSettings\(\)\.authorizationStatus == \.notDetermined \{\s*_ = try\? await center\.requestAuthorization\(options: \[\.alert, \.sound, \.provisional\]\)/)
  assert.match(schedule, /guard NotifyStatus\.on\(status\) \|\| status == \.provisional else \{ return \}/)
  assert.doesNotMatch(schedule, /requestAuthorization\(options: \[\.alert, \.sound\]\)/)
  // Withdrawn once it's on: by the app and by the extension's first message.
  assert.match(setup, /if next != \.off \{ SetupReminders\.cancel\(\) \}/)
  assert.match(ext("SafariWebExtensionHandler.swift"), /recordExtensionSeen[\s\S]{0,300}?removePendingNotificationRequests\(withIdentifiers: SharedDefaults\.setupReminderIds\)/)
})

test("В2.6: quiet permission carries the setup reminders only; everything else counts it as not asked", () => {
  for (const copy of ["ContextFlow/Shared (App)/SharedDefaults.swift", "ContextFlow/Shared (Extension)/SharedDefaults.swift"]) {
    const s = read(copy)
    assert.match(s, /static func on\(_ status: UNAuthorizationStatus\) -> Bool \{[\s\S]*?return status == \.authorized\s*\}/, copy)
    assert.match(s, /static func notAsked\(_ status: UNAuthorizationStatus\) -> Bool \{\s*status == \.notDetermined \|\| status == \.provisional\s*\}/, copy)
  }
  assert.equal(app("SharedDefaults.swift"), ext("SharedDefaults.swift"))
  // No sender other than the setup reminders accepts .provisional.
  const senders: [string, string][] = [
    ["WhatsNew.swift", app("WhatsNew.swift")], ["MessageReminders.swift", ext("MessageReminders.swift")],
    ["WatchStore.swift", ext("WatchStore.swift")], ["SimilarAway.swift", ext("SimilarAway.swift")],
    ["AgentTasks.swift", ext("AgentTasks.swift")], ["SafariWebExtensionHandler.swift", ext("SafariWebExtensionHandler.swift")]
  ]
  for (const [name, s] of senders) assert.doesNotMatch(s, /== \.provisional|\.provisional,|\.provisional \|\|/, name)
  // The panel hears "not asked" for quiet permission, so it still routes to the app's question.
  assert.match(ext("SafariWebExtensionHandler.swift"), /case \.provisional: return "notDetermined"/)
  // The app's question still comes from quiet permission, and asks for the full one.
  assert.match(setup, /guard NotifyStatus\.notAsked\(status\) \|\| status == \.denied else \{/)
  assert.match(setup, /func turnOn\(\) async \{[\s\S]*?_ = try\? await UNUserNotificationCenter\.current\(\)\.requestAuthorization\(options: \[\.alert, \.sound\]\)\s*finish\(\)/)
  assert.match(setup, /case \.provisional: return "quiet"/)
  assert.match(read("netlify/functions/v2-event.mts"), /const NOTIFICATIONS = new Set\(\["granted", "denied", "not_asked", "quiet"\]\)/)
})

test("В3.2: one way in for the panel's moments of value, from a fixed list", () => {
  assert.match(setup, /case ultra, listen\s*\/\/\/[^\n]*\n\s*\/\/\/[^\n]*\n\s*case later, watch, answers_back/)
  assert.match(setup, /guard let reason = value\("why"\)\.flatMap\(Reason\.init\(rawValue:\)\), reason != \.listen, reason != \.ultra else \{ return \}/)
  // Only a web page to go back to.
  assert.match(setup, /\$0\.scheme == "https" \|\| \$0\.scheme == "http" \? \$0 : nil/)
  assert.match(content, /case "notifications":[\s\S]{0,700}?Task \{ await NotifyAsk\.shared\.show\(link: url\) \}/)
  // The 2.8 event schema's names (events-2.8.md).
  assert.deepEqual(FEATURES.notify.fields?.why, ["launch", "ultra", "listen", "later", "watch", "answers_back"])
  for (const key of ["So the reminder you just set reaches you.", "So you hear when the page you watch changes.", "So you know when your free answers are back."]) {
    assert.match(setup, new RegExp(`"${key.replace(/[.?]/g, "\\$&")}"`), key)
  }
})

test("В2.1: the card, its footnote and the guide over Settings show the whole way, and promise no page Settings may not open on", () => {
  assert.match(setup, /if UIDevice\.current\.userInterfaceIdiom == \.pad \{ return \.fromApps \}\s*if #available\(iOS 26\.2, \*\) \{ return \.maybeDirect \}\s*return \.appPage/)
  assert.match(setup, /var phases: \[Int\] \{ Array\(0\.\.<6\) \}/)
  // No «Settings opens on ContextFlow» anywhere: the iPhone's footnote reads right whichever page opens.
  assert.doesNotMatch(setup, /"Settings opens on ContextFlow: switch it on/)
  assert.match(setup, /case \.maybeDirect:[\s\S]{0,120}?Text\("If Settings opens on ContextFlow's page, start at step 2\. If not, start from Apps\."\)/)
  assert.match(setup, /case \.fromApps:[\s\S]{0,120}?Text\("On iPad, Settings doesn't open on ContextFlow's page: start from Apps on the left and follow the steps above\."\)/)
  // The walkthrough's first step and the floating frames say where to start on iPad.
  assert.match(setup, /Step\(number: 1, text: path\.firstStep\)/)
  assert.match(setup, /let step: LocalizedStringKey = phase < 2 \? path\.firstStep/)
  assert.match(setup, /SettingsPiP\.shared\.start\(phases: path\.phases, path: path, then: openExtensionSettings\)/)
  // How the system took it is recorded for "back": direct, or the app's own page.
  assert.match(setup, /if error != nil \{ appSettings\(\) \} else \{ activation\.settingsOpened\("direct"\) \}/)
  assert.match(setup, /UIApplication\.openSettingsURLString\) \{ UIApplication\.shared\.open\(url\) \}\s*activation\.settingsOpened\("app"\)/)
})

test("В2.2: back from Settings, nothing of the guide stays over the steps", () => {
  assert.match(setup, /private func clear\(\) \{\s*layer\.stopRequestingMediaData\(\)\s*layer\.flushAndRemoveImage\(\)\s*queued = 0\s*\}/)
  assert.match(setup, /func stop\(\) \{[\s\S]{0,700}?if controller\?\.isPictureInPictureActive == true \{ controller\?\.stopPictureInPicture\(\) \} else \{ clear\(\) \}/)
  assert.match(setup, /pictureInPictureControllerDidStopPictureInPicture[\s\S]{0,200}?self\.clear\(\)/)
  // Auto-start from the background only for the trip to Settings: off again when the app is back.
  assert.match(setup, /func stop\(\) \{[\s\S]{0,400}?canStartPictureInPictureAutomaticallyFromInline = false/)
  assert.match(setup, /func start\(phases: \[Int\], path: SetupPath, then open: @escaping \(\) -> Void\) \{[\s\S]{0,400}?canStartPictureInPictureAutomaticallyFromInline = true/)
  assert.match(setup, /guide\.onAppear \{\s*activation\.instructionShown\(\)\s*SettingsPiP\.shared\.prepare\(phases: path\.phases, path: path\)/)
  assert.match(content, /SettingsPiP\.shared\.stop\(\)/)
  // And from the system's own "back to the front", which arrives where SwiftUI's scene phase didn't.
  assert.match(setup, /addObserver\(forName: UIApplication\.didBecomeActiveNotification, object: nil, queue: \.main\) \{ _ in\s*Task \{ @MainActor in\s*guard SettingsPiP\.shared\.away else \{ return \}\s*SettingsPiP\.shared\.away = false\s*SettingsPiP\.shared\.stop\(\)/)
  assert.match(setup, /addObserver\(forName: UIApplication\.didEnterBackgroundNotification, object: nil, queue: \.main\) \{ _ in\s*Task \{ @MainActor in SettingsPiP\.shared\.away = true \}/)
})

test("В2.4: switched on and never used, the app's next step is Safari, with one big button and what to tap there", () => {
  assert.match(setup, /case \.on: safariStep\.onAppear \{ activation\.safariStepShown\(\) \}/)
  const step = /private var safariStep: some View \{([\s\S]*?)\n {4}\}/.exec(setup)?.[1] ?? ""
  assert.match(step, /Card\(title: "Next: open Safari", systemImage: "safari"\)/)
  assert.match(step, /Step\(number: 1, text: "Tap ✦ on the page\."\)/)
  // No ✦ while All Websites is still Ask: Safari's page menu is the way in, and Safari's question comes there.
  assert.match(step, /Step\(number: 2, text: SetupPath\.safariMenuStep\)/)
  assert.match(step, /Step\(number: 3, text: "When Safari asks, choose Always Allow, then Always Allow on Every Website\."\)/)
  assert.ok(step.indexOf("safariButton") < step.indexOf("TipClipView"), "the button before the clip")
  // Back from Safari with the panel unused: the page menu comes first (All Websites likely still on Ask).
  assert.match(step, /if activation\.backFromSafariUnused \{\s*Text\("No ✦ on the page\? Safari is waiting for your permission\."\)[\s\S]{0,200}?Step\(number: 1, text: SetupPath\.safariMenuFirst\)\s*Step\(number: 2, text: "When Safari asks, choose Always Allow, then Always Allow on Every Website\."\)\s*Step\(number: 3, text: "Tap ✦ on the page\."\)/)
  // Where Safari keeps ContextFlow on a page: the iPhone's page menu, the iPad's puzzle-piece button (its page menu has
  // no extensions; seen on iPadOS 26.5 and 27).
  assert.match(setup, /static var safariMenuStep: LocalizedStringKey \{\s*UIDevice\.current\.userInterfaceIdiom == \.pad\s*\? "No ✦\? Tap the puzzle-piece button next to the address, then ContextFlow\."\s*: "No ✦\? Open the page menu in the address bar and choose ContextFlow\."/)
  assert.match(setup, /static var safariMenuFirst: LocalizedStringKey \{\s*UIDevice\.current\.userInterfaceIdiom == \.pad\s*\? "In Safari, tap the puzzle-piece button next to the address, then ContextFlow\."\s*: "In Safari, open the page menu in the address bar and choose ContextFlow\."/)
  assert.match(setup, /func openedSafari\(_ via: String\) \{[\s\S]{0,120}?UserDefaults\.standard\.set\(Date\(\)\.timeIntervalSince1970, forKey: Self\.safariTripKey\)/)
  assert.match(setup, /guard state == \.on, !backFromSafariUnused else \{ return \}\s*backFromSafariUnused = true/)
  assert.match(setup, /if before == \.off, next != \.off \{ reportEnabled\(\) \}\s*checkSafariTrip\(\)/)
  assert.deepEqual(useFields({ f: "setup", a: "ask_shown" }), { f: "setup", a: "ask_shown" })
  assert.match(step, /safariButton\("step", large: true\)/)
  assert.match(setup, /activation\.openedSafari\(via\)\s*openSafari\(\)/)
})

test("В3.4: the friend's code card left the first screen; a code is entered on Invite a friend", () => {
  assert.doesNotMatch(content, /FriendCodeCard/)
  assert.match(app("Invite.swift"), /Section\(header: Text\("Have a friend's code\?"\)\) \{\s*FriendCodeField\(via: "app"\)/)
  assert.match(content, /InviteModel\.shared\.shown = true/)
})

test("В1.1: the setup funnel from its zero step, counted once where it should be, nothing on screen sent", () => {
  // Names from the 2.8 event schema (events-2.8.md): activation.shown, setup.open_safari, setup.reminder.
  assert.deepEqual([...FEATURES.activation.actions], ["video", "settings", "back", "enabled", "linked", "shown"])
  assert.deepEqual(useFields({ f: "activation", a: "shown", via: "card" }), { f: "activation", a: "shown", via: "card" })
  assert.deepEqual(useFields({ f: "activation", a: "back", how: "direct" }), { f: "activation", a: "back", how: "direct" })
  assert.deepEqual(useFields({ f: "activation", a: "back", how: "Settings › Apps" }), { f: "activation", a: "back" })
  assert.deepEqual(useFields({ f: "setup", a: "open_safari", via: "step" }), { f: "setup", a: "open_safari", via: "step" })
  assert.deepEqual(useFields({ f: "setup", a: "safari_shown" }), { f: "setup", a: "safari_shown" })
  assert.deepEqual(useFields({ f: "setup", a: "reminder", perm: "quiet" }), { f: "setup", a: "reminder", perm: "quiet" })
  assert.deepEqual(useFields({ f: "setup", a: "reminder_seen", what: "24h" }), { f: "setup", a: "reminder_seen", what: "24h" })
  assert.match(setup, /func openedSafari\(_ via: String\) \{\s*step\("open_safari", \["via": via\], feature: "setup"\)/)
  assert.match(setup, /Activation\.shared\.remindersScheduled\(status == \.provisional \? "quiet" : "on"\)/)
  assert.deepEqual(useFields({ f: "notif", a: "tap", what: "setup", when: "15m" }), { f: "notif", a: "tap", what: "setup", when: "15m" })
  assert.match(setup, /case \.off:\s*guide\.onAppear \{\s*activation\.instructionShown\(\)/)
  assert.match(setup, /func instructionShown\(\) \{ once\("shown", key: "cf_activation_shown_reported", fields: \["via": "card"\]\) \}/)
  assert.match(setup, /private func once\(_ action: String, key: String, fields: \[String: String\] = \[:\], feature: String = "activation"\) \{\s*guard !NewUserPreview\.isOn, !UserDefaults\.standard\.bool\(forKey: key\) else \{ return \}/)
  assert.match(content, /\.onAppear \{ if !enabled \{ activation\.instructionShown\(\) \} \}/)
  // A reminder delivered is counted when the app is next in front; its tap where it arrives, then the guide opens.
  assert.match(setup, /let key = "cf_activation_reminder_\\\(what\)"/)
  assert.match(setup, /await reportOpen\(\)\s*await reportDeliveredReminders\(\)\s*\}/)
  for (const delegate of ["ContextFlow/iOS (App)/AppDelegate.swift", "ContextFlow/macOS (App)/AppDelegate.swift"]) {
    assert.match(read(delegate), /if let which = info\["setup"\] as\? String \{[\s\S]{0,300}?"f": "notif", "a": "tap", "what": "setup"/, delegate)
  }
  assert.match(setup, /content\.userInfo = \["setup": index == 0 \? "15m" : "24h"\]/)
  assert.match(content, /case "setup":\s*if hasChats \{ showingSetup = true \} else \{ tab = \.home \}/)
  // The analytics page names the new steps and ways in.
  const page = read("site/analytics.html")
  for (const f of ["activation", "setup", "whatsnew"] as const) {
    for (const a of FEATURES[f].actions) assert.match(/const ACTION_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? "", new RegExp(`\\b${a}: "`), `${f}.${a}`)
    for (const v of FEATURES[f].via ?? []) assert.match(/const VIA_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? "", new RegExp(`\\b${v}: "`), `${f} via ${v}`)
    assert.match(/const FEATURE_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? "", new RegExp(`\\b${f}: "`), f)
  }
})

test("В1.6: every app event carries the build, the storefront and whether an ad brought it; the server keeps them, nothing else", () => {
  const chatAI = app("ChatAI.swift")
  assert.equal((chatAI.match(/"client": AppSource\.client\(platform: platform, locale: Locale\.current\.identifier\)/g) ?? []).length, 3)
  assert.doesNotMatch(chatAI, /"client": \["platform"/)
  assert.match(setup, /"client": AppSource\.client\(platform: Self\.platform/)
  assert.match(setup, /"build": build,/)
  assert.match(setup, /guard let code = await Storefront\.current\?\.countryCode/)
  assert.match(setup, /if answer == "attributed" \{ UserDefaults\.standard\.set\("yes", forKey: adKey\) \}\s*if answer == "organic" \{ UserDefaults\.standard\.set\("no", forKey: adKey\) \}/)
  const server = read("netlify/functions/v2-event.mts")
  assert.match(server, /typeof client\.sf === "string" && \/\^\[A-Z\]\{2,3\}\$\/\.test\(client\.sf\) \? \{ sf: client\.sf \} : \{\}/)
  assert.match(server, /client\.ad === "yes" \|\| client\.ad === "no" \? \{ ad: client\.ad \} : \{\}/)
})

test("В1.7: Tips, What's new and the Pro tab are counted when opened", () => {
  assert.match(content, /\.onChange\(of: tab\) \{ next in\s*reportTab\(next\)/)
  assert.match(content, /ChatAI\.reportUse\("tab", "open", \["what": next\.event\]\)/)
  for (const what of ["tips", "whats_new", "pro"]) {
    assert.ok(FEATURES.tab.fields?.what?.includes(what), what)
    assert.match(content, new RegExp(`return "${what}"`), what)
  }
  assert.equal(FEATURES.tab.tracked, "2.8")
  assert.match(content, /if next == \.tips \{ ChatAI\.reportUse\("tips", "open"\) \}/)
  assert.match(content, /if next == \.whatsNew \{ ChatAI\.reportUse\("whatsnew", "shown"\) \}/)
  assert.match(content, /if next != \.whatsNew, whatsNewShown \{ ChatAI\.reportUse\("whatsnew", "close"\) \}/)
  assert.match(app("WhatsNew.swift"), /ChatAI\.reportUse\("whatsnew", "tap"\)\s*openURL\(url\)/)
  assert.deepEqual([...FEATURES.whatsnew.actions], ["shown", "tap", "close"])
})

test("every new text is translated into the app's 14 other languages; on iPad in Arabic the sidebar is on the right", () => {
  const keys = [
    "In Settings, tap Apps on the left, then Safari in the list (not ContextFlow), then Extensions.",
    "Open the Settings app and go to Apps → Safari (not ContextFlow) → Extensions.",
    "No ✦? Tap the puzzle-piece button next to the address, then ContextFlow.",
    "In Safari, tap the puzzle-piece button next to the address, then ContextFlow.",
    "On iPad, Settings doesn't open on ContextFlow's page: start from Apps on the left and follow the steps above.",
    "Next: open Safari",
    "So the reminder you just set reaches you.", "So you hear when the page you watch changes.", "So you know when your free answers are back.",
    "Tap ✦ on the page.", "No ✦? Open the page menu in the address bar and choose ContextFlow.",
    "When Safari asks, choose Always Allow, then Always Allow on Every Website.",
    "If Settings opens on ContextFlow's page, start at step 2. If not, start from Apps.",
    "No ✦ on the page? Safari is waiting for your permission.",
    "In Safari, open the page menu in the address bar and choose ContextFlow."
  ]
  for (const key of keys) {
    assert.match(setup, new RegExp(key.replace(/[.?()]/g, "\\$&")), key)
    assert.deepEqual(Object.keys(catalog[key]?.localizations ?? {}).sort(), [...LANGS].sort(), key)
    for (const lang of LANGS) assert.ok(catalog[key].localizations![lang].stringUnit.value.trim().length > 4, `${key} ${lang}`)
  }
  // Each language names Settings' rows as the system does (the same words as the existing walkthrough).
  const first = catalog[keys[0]].localizations!
  const old = catalog["Open the Settings app and go to Apps → Safari → Extensions."].localizations!
  const words: Record<string, string[]> = { ru: ["Приложения", "Расширения"], de: ["Apps", "Erweiterungen"], ja: ["アプリ", "機能拡張"], uk: ["Програми", "Розширення"], "zh-Hant": ["App", "延伸功能"], it: ["App", "Estensioni"] }
  for (const [lang, names] of Object.entries(words)) for (const name of names) {
    assert.ok(old[lang].stringUnit.value.includes(name) && first[lang].stringUnit.value.includes(name), `${lang} ${name}`)
  }
  assert.match(first.ar.stringUnit.value, /على اليمين/)
  assert.match(catalog["On iPad, Settings doesn't open on ContextFlow's page: start from Apps on the left and follow the steps above."].localizations!.ar.stringUnit.value, /على اليمين/)
})

test("the Apps list has ContextFlow itself in view: the first step says Safari, not ContextFlow, on every device", () => {
  assert.match(setup, /self == \.fromApps \? "In Settings, tap Apps on the left, then Safari in the list \(not ContextFlow\), then Extensions\."\s*: "Open the Settings app and go to Apps → Safari \(not ContextFlow\) → Extensions\."/)
  for (const key of ["In Settings, tap Apps on the left, then Safari in the list (not ContextFlow), then Extensions.", "Open the Settings app and go to Apps → Safari (not ContextFlow) → Extensions."]) {
    for (const lang of LANGS) assert.match(catalog[key].localizations![lang].stringUnit.value, /ContextFlow/, `${lang}: ${key}`)
  }
})

test("the floating guide starts once picture in picture is possible, within the second before Settings opens", () => {
  assert.match(setup, /startWhenPossible\(controller, tries: 9\)\s*\/\/[^\n]*\n\s*DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ 1\.0\) \{ \[weak self\] in self\?\.openPending\(\) \}/)
  assert.match(setup, /private func startWhenPossible\(_ controller: AVPictureInPictureController, tries: Int\) \{\s*guard pendingOpen != nil else \{ return \}\s*if controller\.isPictureInPicturePossible \|\| tries == 0 \{\s*controller\.startPictureInPicture\(\)/)
})

test("В3.3 (app side): a new install never gets 2.5's What's new sheet or the What's new tab, and no promo sheet on its first day or during a purchase", () => {
  assert.match(content, /guard hasChats, !store\.purchasing, !Paywall\.shared\.purchasing, Paywall\.shared\.buyNow == nil, !UserDefaults\.standard\.bool\(forKey: "cf_whatsnew_organize"\) else \{ return \}\s*(\/\/[^\n]*\n\s*)+guard SharedDefaults\.shared\.appUpdatedInstall\(\), !QuietDay\.firstDay else \{ return \}/)
  assert.match(content, /let existing = SharedDefaults\.shared\.appUpdatedInstall\(\) \|\| UserDefaults\.standard\.object\(forKey: "cf_whatsnew_organize"\) != nil/)
  assert.doesNotMatch(content, /let existing = hasChats/)
  assert.match(content, /enum QuietDay \{\s*static var firstDay: Bool \{\s*guard !SharedDefaults\.shared\.appUpdatedInstall\(\), let first = SharedDefaults\.shared\.appFirstLaunch\(\) else \{ return false \}\s*return Date\(\)\.timeIntervalSince1970 - first < 86_400/)
})

test("a page goes to Safari itself through x-safari- only when it's https (iOS has no x-safari-http), else as it is", () => {
  assert.match(setup, /static func safariURL\(_ page: URL\) -> URL\? \{\s*guard page\.scheme\?\.lowercased\(\) == "https" else \{ return nil \}\s*if #available\(iOS 17, \*\) \{ return URL\(string: "x-safari-\\\(page\.absoluteString\)"\) \}\s*return nil/)
  assert.match(setup, /static func open\(_ page: URL\) \{\s*if let safari = safariURL\(page\) \{\s*UIApplication\.shared\.open\(safari\) \{ opened in if !opened \{ UIApplication\.shared\.open\(page\) \} \}\s*\} else \{\s*UIApplication\.shared\.open\(page\)/)
  // Every place of this session's opens a page through it: no other x-safari- address is made there.
  for (const file of ["ContextFlow/Shared (App)/Setup.swift", "ContextFlow/Shared (App)/Chats.swift", "ContextFlow/iOS (App)/AppDelegate.swift"]) {
    const src = read(file)
    assert.equal((src.match(/URL\(string: "x-safari-/g) ?? []).length, file.endsWith("Setup.swift") ? 1 : 0, file)
  }
  assert.equal((read("ContextFlow/iOS (App)/AppDelegate.swift").match(/SafariPage\.open\(page\)/g) ?? []).length, 2)
  assert.match(read("ContextFlow/Shared (App)/Chats.swift"), /SafariPage\.open\(link\)/)
})
