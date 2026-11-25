// 2.7 (plan section 8, «Активация»), owner-approved: the way from the app to ContextFlow switched on, counted step by
// step. Before, only «opened the app», «extension enabled» and «first answer» were seen, with nothing in between and the
// app's people apart from Safari's. Counts only: f "activation" in the usage registry, never what's on screen.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { FEATURES, featureBase, useFields } from "../src/shared/usage.ts"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const app = (f: string) => read(`ContextFlow/Shared (App)/${f}`)
const MIGRATION = "supabase/migrations/20261114120000_contextflow_activation_funnel.sql"

test("the registry keeps the activation steps and the ways in, nothing else, from 2.7 in the app", () => {
  for (const a of ["video", "back", "enabled", "linked"]) assert.deepEqual(useFields({ f: "activation", a, s: "app" }), { f: "activation", a })
  for (const via of ["card", "chats"]) assert.deepEqual(useFields({ f: "activation", a: "settings", via }), { f: "activation", a: "settings", via })
  // An unknown step, a way that isn't one, anything else sent along: left out.
  assert.equal(useFields({ f: "activation", a: "uninstalled" }), null)
  assert.deepEqual(useFields({ f: "activation", a: "settings", via: "banner", what: "Settings > Safari", page: "x" }), { f: "activation", a: "settings" })
  assert.equal(FEATURES.activation.on, "app")
  assert.deepEqual(featureBase().activation, { since: "2.7", on: "app" })
})

test("the app sends each step where it happens, in order", () => {
  const setup = app("Setup.swift")
  // Settings from the home card (iPhone, iPad): counted as it opens, after the guide's video when that started.
  // 2.8: "card" from the switch-it-on step, "allow" from the «Open Safari» step's way to All Websites: Allow.
  assert.match(setup, /private func openExtensionSettings\(\) \{ openExtensionSettings\(via: "card"\) \}/)
  assert.match(setup, /private func openExtensionSettings\(via: String\) \{\s*activation\.wentToSettings\(via\)/)
  assert.match(setup, /pictureInPictureControllerDidStartPictureInPicture[\s\S]{0,300}?Activation\.shared\.guideStarted\(\)\s*self\.openPending\(\)/)
  // A failed start opens Settings without a "video" (2.8: and the frames stop playing in the card first).
  assert.match(setup, /failedToStartPictureInPictureWithError error: Error\) \{[\s\S]{0,500}?Task \{ @MainActor in self\.openPending\(\) \}/)
  assert.doesNotMatch(setup, /failedToStartPictureInPictureWithError[\s\S]{0,300}?guideStarted/)
  // Back counts once a trip, and only after the app really left the front.
  assert.match(setup, /func wentToSettings\(_ via: String\) \{\s*trip = \.going\s*settingsHow = nil\s*UserDefaults\.standard\.set\(Date\(\)\.timeIntervalSince1970, forKey: Self\.tripKey\)\s*UserDefaults\.standard\.removeObject\(forKey: Self\.howKey\)\s*step\("settings", \["via": via\]\)/)
  assert.match(setup, /private func wentAway\(\) \{\s*if trip == \.going \{ trip = \.away \}/)
  // "Left" from the system (the views get no scene phase in the background): iPhone and iPad, and the Mac.
  assert.match(setup, /#if os\(iOS\)\s*let left = UIApplication\.didEnterBackgroundNotification\s*#else\s*let left = NSApplication\.didResignActiveNotification\s*#endif\s*NotificationCenter\.default\.addObserver\(forName: left, object: nil, queue: \.main\) \{ \[weak self\] _ in\s*Task \{ @MainActor in self\?\.wentAway\(\) \}/)
  // Switching it on in Settings can end the app: the trip is kept on disk, and a relaunch within the hour is the way back.
  // 2.8 (В2.1): "back" says how Settings was opened ("direct" or "app"), known only once the app has started leaving.
  assert.match(setup, /func cameBack\(\) \{[\s\S]*?guard at > 0, trip != \.going else \{ return \}\s*trip = nil\s*defaults\.removeObject\(forKey: Self\.tripKey\)\s*let how = settingsHow \?\? defaults\.string\(forKey: Self\.howKey\)\s*defaults\.removeObject\(forKey: Self\.howKey\)\s*if Date\(\)\.timeIntervalSince1970 - at < 3600 \{ step\("back", how\.map \{ \["how": \$0\] \} \?\? \[:\]\) \}/)
  assert.match(setup, /func launched\(\) async \{[\s\S]{0,120}?cameBack\(\)\s*await refresh\(\)/)
  // Enabled: the first time the app sees it go from off to on, once an install.
  assert.match(setup, /let before = state\s*state = next[\s\S]{0,80}?if before == \.off, next != \.off \{ reportEnabled\(\) \}/)
  assert.match(setup, /guard !defaults\.bool\(forKey: Self\.enabledReportedKey\) else \{ return \}\s*defaults\.set\(true, forKey: Self\.enabledReportedKey\)\s*step\("enabled"\)/)
  // "App opened" goes where the steps go (production; a debug build's local stand), never hard-wired to production.
  assert.match(setup, /var request = URLRequest\(url: ChatAI\.base\.appendingPathComponent\("api\/v2\/event"\)\)/)
  assert.doesNotMatch(setup, /aisidebar\.netlify\.app/)
  // Steps a moment apart go a second apart, so the server gets them in order; none waits on another's answer.
  assert.match(setup, /let at = max\(now, nextStepAt\)\s*nextStepAt = at\.addingTimeInterval\(1\)\s*ChatAI\.reportUse\(feature, action, fields, after: at\.timeIntervalSince\(now\)\)/)
  const chatAI = app("ChatAI.swift")
  assert.match(chatAI, /after delay: TimeInterval\) \{[\s\S]*?if delay > 0 \{ try\? await Task\.sleep\(nanoseconds: UInt64\(delay \* 1_000_000_000\)\) \}\s*_ = try\? await URLSession\.shared\.data\(for: request\)/)
  assert.doesNotMatch(chatAI, /await previous/)

  const content = app("ContentView.swift")
  // "back" before the refresh that may send "enabled".
  assert.match(content, /activation\.cameBack\(\)\s*Task \{ await activation\.refresh\(\) \}/)
  assert.doesNotMatch(content, /wentAway/)
  // The Mac's Safari settings: the home card and the chats' empty state.
  assert.match(content, /activation\.wentToSettings\("card"\)\s*SFSafariApplication\.showPreferencesForExtension/)
  assert.match(app("ChatsView.swift"), /Activation\.shared\.wentToSettings\("chats"\)\s*SFSafariApplication\.showPreferencesForExtension/)
})

test("the extension's side links the two random ids until the server has them, and sends nothing else", () => {
  const handler = read("ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift")
  // 2.7.1: the native side only answers the app's id with the ping; the background sends the link (src/background/link.ts).
  assert.doesNotMatch(handler, /reportLinked|knewInstall/)
  // 2.8 (В1.9): and whether this is one of our simulator or debug builds (tests/our-builds-marked.test.mts).
  assert.match(handler, /case "ping":[\s\S]{0,700}?if let app = SharedDefaults\.shared\.appId\(\) \{ data\["app"\] = app \}[\s\S]{0,200}?Self\.reply\(context, \["success": true, "data": data\]\)/)
  const background = read("src/background/index.ts")
  assert.match(background, /callNative<NativeEntitlement>\("getEntitlement", \{ installId: await installId\(\), base: API_BASE \}, 6000\)/)
  // The ping carries the install id (the app learns it from the extension's first message), and is asked again while
  // the app hasn't made its id.
  assert.match(background, /callNative<\{ build\?: string; app\?: string; test\?: boolean \}>\("ping", \{ installId: id \}, 1500\)/)
  assert.match(background, /if \(!data\?\.build\) nativeAsk = null/)
  assert.match(background, /if \(nativeAsk && nativeAppAskedAt && Date\.now\(\) - nativeAppAskedAt > 60_000\) nativeAsk = null/)
  assert.match(background, /nativeAppAskedAt = data\?\.build && !app \? Date\.now\(\) : 0/)
  // Sent when the background starts and when the panel gets the subscription, Safari only.
  assert.match(background, /\/\/ 2\.7\.1: the app's id with this install's[\s\S]{0,160}?void reportLinked\(\)\.catch/)
  assert.match(background, /entitlementCache = \{ at: Date\.now\(\), value \}\s*\/\/[^\n]*\n\s*void reportLinked\(\)/)
  assert.match(background, /function reportLinked\(\): Promise<boolean> \{\s*if \(TARGET !== "safari"\) return Promise\.resolve\(false\)/)
  // Read-only on the extension's side: the app's id is made by the app alone.
  for (const copy of ["ContextFlow/Shared (App)/SharedDefaults.swift", "ContextFlow/Shared (Extension)/SharedDefaults.swift"]) {
    assert.match(read(copy), /func appId\(\) -> String\? \{\s*defaults\.dictionary\(forKey: appKey\)\?\["id"\] as\? String\s*\}/, copy)
  }
})

test("the funnels: the activation steps in order, 2.7 and later, the app's id joined through them", () => {
  const sql = read(MIGRATION)
  const steps = (funnel: string) => [...sql.matchAll(new RegExp(`\\('${funnel}', (\\d), '(\\w+)', '\\{(\\w+)\\}', null, null\\)`, "g"))]
    .map((m) => `${m[1]} ${m[2]}.${m[3]}`)
  assert.deepEqual(steps("activation"), [
    "1 app.open", "2 activation.video", "3 activation.settings", "4 activation.back", "5 activation.enabled", "6 ext.on", "7 ask.answer"
  ])
  assert.deepEqual(steps("activation_all"), [
    "1 app.open", "2 activation.settings", "3 activation.back", "4 activation.enabled", "5 ext.on", "6 ask.answer"
  ])
  assert.match(sql, /since\(funnel, ver\) as \(values \('activation', '2\.7'\), \('activation_all', '2\.7'\)\)/)
  assert.match(sql, /where d1\.k = 1 and \(s\.ver is null or contextflow\.version_num\(e\.version\) >= contextflow\.version_num\(s\.ver\)\)/)
  assert.match(sql, /where \(kind = 'app_open' or \(kind = 'use' and data->>'f' = 'activation'\)\) and install_id is not null and data \? 'app'/)
  // Every funnel the latest version had is still there.
  const before = read("supabase/migrations/20261108120000_contextflow_ultra.sql")
  const names = (s: string) => new Set([...s.matchAll(/\('(\w+)', \d, '/g)].map((m) => m[1]))
  for (const name of names(before.slice(before.lastIndexOf("create or replace function public.cf_feature_funnels")))) assert.ok(names(sql).has(name), name)
  // Grants as everywhere: reports for service_role only.
  assert.match(sql, /revoke all on function public\.cf_feature_funnels\(integer\) from public, anon, authenticated;\s*grant execute on function public\.cf_feature_funnels\(integer\) to service_role;/)
  assert.match(sql, /revoke all on function contextflow\.feature_events\(timestamptz\) from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /\b(insert|update|delete) (into|from)?\s*contextflow\.events/i)
})

test("the analytics page names both funnels and every step", () => {
  const page = read("site/analytics.html")
  const funnels = /const FUNNEL_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ""
  assert.match(funnels, /activation: "Активация с видео \(iPhone, iPad\), с 2\.7", activation_all: "Активация, все устройства, с 2\.7"/)
  const actions = /const ACTION_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ""
  for (const a of FEATURES.activation.actions) assert.match(actions, new RegExp(`\\b${a}: "`), a)
  const via = /const VIA_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ""
  for (const v of FEATURES.activation.via ?? []) assert.match(via, new RegExp(`\\b${v}: "`), v)
  assert.match(/const FEATURE_RU = \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? "", /activation: "Активация"/)
})
