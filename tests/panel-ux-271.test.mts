// 2.7.1, the owner's notes on build 121 (iPad with a Magic Keyboard, iPhone, Mac):
// 1. two fingers on a trackpad over the send button switch as the finger's swipe does: up for a note, down for Do,
//    once per gesture, the glide after the fingers lift ignored (ux/wheelSwitch.ts), plus a menu for a pointer;
// 2. the page doesn't scroll under the panel (scrollGuard.ts);
// 3. Settings in sections by feature that fold, as Tips do (settingsFold.ts, Settings.tsx).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { parseHTML } from "linkedom"

import { fingers, SWITCH_AT, SWITCH_GAP, wheelSwitch, wheelSwitchStep, type WheelInput } from "../src/content/ux/wheelSwitch.ts"
import { WHEEL_IDLE } from "../src/content/ux/swipeMath.ts"
import { canScroll, guardScroll, type ScrollBox, touchStops, wheelStops } from "../src/content/scrollGuard.ts"
import { foldScroll, keptOpen, OPEN_FIRST, SECTIONS, stuckSection, toggled } from "../src/content/settingsFold.ts"

const read = (p: string) => readFileSync(p, "utf8")

// A gesture: deltaY per event (the iPad's way: + is the fingers going down), 16 ms apart from `from`.
function run(deltas: number[], { from = 1000, mac = false, inverted, mode = 0, every = 16, s = wheelSwitch() }: { from?: number; mac?: boolean; inverted?: boolean; mode?: number; every?: number; s?: ReturnType<typeof wheelSwitch> } = {}) {
  const out: (string | null)[] = []
  deltas.forEach((dy, i) => {
    const e: WheelInput = { deltaX: 0, deltaY: dy, deltaMode: mode, inverted, at: from + i * every }
    out.push(wheelSwitchStep(s, e, mac))
  })
  return { out: out.filter(Boolean), s, end: from + (deltas.length - 1) * every }
}

test("iPad: two fingers up switch to the note, down to Do, as the finger's swipe on the button", () => {
  assert.deepEqual(run([-2, -4, -6]).out, ["up"])
  assert.deepEqual(run([2, 4, 6]).out, ["down"])
  // A small travel is enough: SWITCH_AT px.
  assert.deepEqual(run([-SWITCH_AT]).out, ["up"])
  assert.deepEqual(run([-(SWITCH_AT - 1)]).out, [])
  // Safari reporting natural scrolling off: the other way round (as the chat rows read it).
  assert.deepEqual(run([2, 4, 6], { inverted: false }).out, ["up"])
})

test("one switch per gesture: the fingers going on, then the glide after they lift, switch nothing more", () => {
  // Fingers up fast, then momentum running out, each step smaller, no gap.
  const swipe = [-2, -5, -9, -14, -18, -20, -18, -12, -8, -5, -3, -2, -1, -1, -1]
  assert.deepEqual(run(swipe).out, ["up"])
  // Back and forth without lifting: still one.
  assert.deepEqual(run([-4, -6, -8, 6, 8, 10, -6]).out, ["up"])
  // A mouse wheel's notches in a row (lines): one switch for the roll.
  assert.deepEqual(run([1, 1, 1, 1, 1], { mode: 1, every: 40 }).out, ["down"])
})

test("the next gesture: after a gap, or the fingers moving again during the glide", () => {
  const first = run([-3, -6, -9, -12])
  assert.deepEqual(first.out, ["up"])
  // A gap longer than WHEEL_IDLE (and past SWITCH_GAP): a new gesture, down this time.
  const second = run([3, 6, 9], { from: first.end + WHEEL_IDLE + SWITCH_GAP, s: first.s })
  assert.deepEqual(second.out, ["down"])
  // During a glide that has run out a little, a step bigger than the last: the fingers again.
  const glide = run([-4, -10, -20, -20, -10, -6, -3, -2, -1], { from: second.end + 1000, s: second.s })
  assert.deepEqual(glide.out, ["up"])
  const again = run([-2, -6, -12], { from: glide.end + SWITCH_GAP, s: glide.s })
  assert.deepEqual(again.out, ["up"])
})

test("never two switches within SWITCH_GAP, and a sideways swipe is no switch", () => {
  const s = wheelSwitch()
  assert.deepEqual(run([-10], { s, from: 0 }).out, ["up"])
  // A gap long enough to end the gesture, but too soon after the switch.
  assert.deepEqual(run([10], { s, from: WHEEL_IDLE + 20 }).out, [])
  const side = wheelSwitch()
  const outs = [0, 1, 2].map((i) => wheelSwitchStep(side, { deltaX: 12, deltaY: 3, deltaMode: 0, at: i * 16 }, false))
  assert.deepEqual(outs.filter(Boolean), [])
})

test("a Mac reads its deltas the content's way with natural scrolling: the fingers are the other way round", () => {
  // Natural scrolling (Safari: inverted): the fingers up give deltaY > 0.
  assert.deepEqual(run([2, 4, 6], { mac: true, inverted: true }).out, ["up"])
  assert.deepEqual(run([-2, -4, -6], { mac: true, inverted: true }).out, ["down"])
  // Natural scrolling off: deltaY < 0 is the fingers (and the wheel) going up.
  assert.deepEqual(run([-2, -4, -6], { mac: true, inverted: false }).out, ["up"])
  // Not said (not Safari): taken as natural, the Mac's default.
  assert.equal(fingers({ deltaX: 0, deltaY: 5, deltaMode: 0 }, true).y, -5)
  assert.equal(fingers({ deltaX: 0, deltaY: 5, deltaMode: 0 }, false).y, 5)
})

test("the send button: wheel switches by way, the menu for a pointer, the finger's swipes and hold as before", () => {
  const app = read("src/content/App.tsx")
  // Touch: unchanged (swipe down is Do on Pro and Ultra, otherwise the note; up is the note; the hold flips the note).
  assert.match(app, /if \(dy > 0 && swipeDo\) flipDo\(\)\n\s+else flipMode\(\)/)
  // Wheel: the way decides, the same as the finger.
  assert.match(app, /wheelSwitchStep\(wheelGesture\.current, \{[\s\S]+?\}, platform === "macos"\)[\s\S]+?if \(dir === "down" && swipeDo\) flipDo\(\)\n\s+else flipMode\(\)/)
  // The pointer's menu: a right-click, or the pointer held; never for a finger.
  assert.match(app, /if \(mouse\) setSendMenu\(true\)\n\s+else flipMode\(\)/)
  assert.match(app, /onContextMenu: \(e: Event\) => \{\n\s+e\.preventDefault\(\)\n\s+if \(lastPointer\.current === "touch"\) return/)
  assert.match(app, /<SendMenu note=\{noteMode\} doing=\{doMode\} canDo=\{swipeDo\}/)
  // The hint names what the hand has: the pointer's once on this device.
  assert.match(app, /const sendHintKey = touch && !pointerUsed \?/)
  assert.match(app, /pointerHintSeen\(\)/)
})

// ---- 2. the page under the panel

const box = (o: Partial<ScrollBox>): ScrollBox => ({ overflowX: "visible", overflowY: "visible", scrollTop: 0, scrollLeft: 0, scrollHeight: 100, scrollWidth: 100, clientHeight: 100, clientWidth: 100, ...o })

test("a list takes a scroll its way only while it has room; a list that doesn't overflow takes none", () => {
  const list = box({ overflowY: "auto", scrollHeight: 500, clientHeight: 200 })
  assert.equal(canScroll(list, "y", 0), true)
  assert.equal(canScroll(list, "y", -10), false)
  assert.equal(canScroll(list, "y", 10), true)
  assert.equal(canScroll({ ...list, scrollTop: 300 }, "y", 10), false)
  assert.equal(canScroll({ ...list, scrollTop: 300 }, "y", -10), true)
  assert.equal(canScroll(box({ overflowY: "auto" }), "y", 0), false)
  assert.equal(canScroll(box({ overflowY: "hidden", scrollHeight: 500 }), "y", 0), false)
  // Right to left: scrollLeft from 0 down to minus the room.
  const rtl = box({ overflowX: "auto", scrollWidth: 400, clientWidth: 200, scrollLeft: -200 })
  assert.equal(canScroll(rtl, "x", 10), false)
  assert.equal(canScroll(rtl, "x", -10), true)
})

test("a wheel over the panel stops where nothing can take it: the header, a short chat, a list at its end", () => {
  const header = [box({}), box({})]
  assert.equal(wheelStops(header, 0, 40), true)
  const chat = [box({}), box({ overflowY: "auto", scrollHeight: 900, clientHeight: 300, scrollTop: 0 }), box({})]
  assert.equal(wheelStops(chat, 0, 40), false)
  assert.equal(wheelStops(chat, 0, -40), true)
  assert.equal(wheelStops(chat, 0, 0), false)
  // Sideways over the chips (they scroll sideways): taken; up and down over them goes to the chat around them.
  const chips = [box({ overflowX: "auto", overflowY: "hidden", scrollWidth: 600, clientWidth: 300 }), chat[1]]
  assert.equal(wheelStops(chips, 30, 0), false)
  assert.equal(wheelStops(chips, 0, 30), false)
  // A finger: held from the page only where nothing at all scrolls under it.
  assert.equal(touchStops(header), true)
  assert.equal(touchStops(chat), false)
  assert.equal(touchStops([chips[0]]), false)
})

test("the guard in a page: a wheel over the panel's header is cancelled, over a list with room it isn't, outside the panel never", () => {
  const { window, document } = parseHTML(`<!doctype html><html><body><div id="root"><section class="cf-panel"><header id="head">h</header><div id="list"><p id="msg">m</p></div></section><button id="fab">✦</button></div></body></html>`)
  const g = globalThis as unknown as Record<string, unknown>
  const was = { getComputedStyle: g.getComputedStyle, Element: g.Element, HTMLElement: g.HTMLElement }
  g.Element = window.Element
  g.HTMLElement = window.HTMLElement
  const list = document.getElementById("list") as unknown as HTMLElement
  Object.defineProperty(list, "scrollHeight", { value: 900 })
  Object.defineProperty(list, "clientHeight", { value: 300 })
  Object.defineProperty(list, "scrollTop", { value: 0, writable: true })
  g.getComputedStyle = (el: Element) => ({ overflowX: "visible", overflowY: el === list ? "auto" : "visible" })
  try {
    const root = document.getElementById("root") as unknown as ShadowRoot
    const stop = guardScroll(root)
    const wheel = (id: string, deltaY: number, extra: Record<string, unknown> = {}) => {
      const e = new window.Event("wheel", { bubbles: true, cancelable: true }) as unknown as WheelEvent
      Object.assign(e, { deltaX: 0, deltaY, ...extra })
      document.getElementById(id)!.dispatchEvent(e)
      return e.defaultPrevented
    }
    assert.equal(wheel("head", 30), true)
    assert.equal(wheel("msg", 30), false)
    // The list at its top: scrolling further up goes nowhere, and not to the page.
    assert.equal(wheel("msg", -30), true)
    // A pinch (the page's zoom) and our floating circle: left alone.
    assert.equal(wheel("head", 30, { ctrlKey: true }), false)
    assert.equal(wheel("fab", 30), false)
    stop()
    assert.equal(wheel("head", 30), false)
  } finally {
    Object.assign(g, was)
  }
})

test("the panel's lists keep their scroll to themselves", () => {
  const css = read("src/content/styles.css")
  assert.match(css, /\.cf-messages \{[^}]*overscroll-behavior: contain/)
  assert.match(css, /\.cf-settings \{[^}]*overscroll-behavior: contain/)
  assert.match(css, /\.cf-sheet, \.cf-move-list,[^{]*\{\s*overscroll-behavior: contain;/)
  // The guard's wheel is not passive (it cancels), and the chips keep a vertical swipe for the chat.
  assert.match(read("src/content/scrollGuard.ts"), /addEventListener\("wheel", wheel as EventListener, \{ passive: false \}\)/)
  assert.doesNotMatch(css, /\.cf-chips[^{]*\{[^}]*overscroll-behavior: contain/)
})

// ---- 3. Settings in sections

test("Settings' sections: «Основное» open at first, what's kept read safely, a link opens its setting's section", () => {
  assert.deepEqual(OPEN_FIRST, ["general"])
  assert.deepEqual(keptOpen(undefined), ["general"])
  assert.deepEqual(keptOpen("general"), ["general"])
  assert.deepEqual(keptOpen([]), [])
  // «О приложении» isn't folded (2.7.1, 123): an old device's kept "about" is let go.
  assert.deepEqual(keptOpen(["about", "bogus", "general", "general", "data"]), ["general", "data"])
  assert.deepEqual(toggled(["general"], "agent"), ["general", "agent"])
  assert.deepEqual(toggled(["general", "agent"], "general"), ["agent"])
  assert.deepEqual(toggled(["general"], "general", true), ["general"])
  assert.equal(SECTIONS.ownKey, "plan")
  assert.equal(SECTIONS.access, "agent")
})

test("Settings: every group is still there, in its section; the own-key links open it there", () => {
  const ui = read("src/content/Settings.tsx")
  for (const group of ["planGroup", "ownKeyGroup", "aboutGroup", "buttonGroup", "chatsGroup", "dataGroup", "<InsertSettingsGroup", "<MyDetailsGroup />", "<AccessGroup />", "<CookieGroup site={site} />", "<InviteGroup", "<PageHintsSwitch />"]) {
    assert.ok(ui.includes(group), group)
  }
  for (const id of ["plan", "general", "button", "writing", "agent", "cookies", "chats", "data"]) assert.match(ui, new RegExp(`fold\\("${id}"`))
  assert.doesNotMatch(ui, /fold\("about"/)
  for (const key of ["setFab", "setSide", "setSelectionButton", "uxShareMarks", "setAbout", "setOwnKey", "setOwnKeyModel", "setOrganize", "setSpaces", "setSyncChats", "deleteChats", "tourShow", "privacyPolicy", "terms"]) {
    assert.ok(ui.includes(`t("${key}")`), key)
  }
  assert.match(ui, /data-set-at="ownKey"/)
  assert.match(ui, /data-set-at="access"/)
  const app = read("src/content/App.tsx")
  assert.equal((app.match(/openSettingsAt\("ownKey"\)/g) ?? []).length, 4)
  assert.match(app, /<SettingsView\n\s+key=\{settingsAt \?\? "settings"\}\n\s+at=\{settingsAt\}/)
})

test("the new strings are in all 15 languages", () => {
  const keys = ["sendMenuNote", "noteHintPointerDo", "setSecGeneral", "setSecButton", "setSecWriting", "setSecAgent", "setSecCookies", "setSecChats", "setSecData", "setSecPlan", "setSecAbout"]
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const messages = JSON.parse(read(`src/locales/${lang}.json`)) as Record<string, string>
    for (const key of keys) assert.ok(messages[key]?.trim(), `${lang} ${key}`)
    // Do is called by the same word as on the button.
    assert.ok(messages.setSecAgent.includes(messages.agentMode), `${lang} setSecAgent`)
    assert.ok(messages.noteHintPointerDo.includes(messages.agentMode), `${lang} noteHintPointerDo`)
  }
})

// ---- 4. «Мои данные» (the director's notes from the owner on 121)

import { FIELD_ORDER, orderedEntries, syncState } from "../src/content/agent/detailsView.ts"
import { FORM_KEYS } from "../src/shared/agent/formdata.ts"

test("My details in one order: name, phone, e-mail, the address street to country, birth date, work; facts last by name", () => {
  const e = (key: string, label = "", updatedAt = 0) => ({ key, label, updatedAt } as { key: never; label: string; updatedAt: number })
  // As they were added in the owner's panel: last name, e-mail, city, country; then a first name and two facts.
  const added = [e("name.family", "", 1), e("email", "", 2), e("address.city", "", 3), e("address.country", "", 4), e("fact", "Размер обуви", 5), e("name.given", "", 6), e("fact", "Пол", 7), e("phone", "", 8), e("address.postal", "", 9), e("birthDate", "", 10)]
  assert.deepEqual(orderedEntries(added, "ru").map((x) => x.label || x.key), ["name.given", "name.family", "phone", "email", "address.city", "address.postal", "address.country", "birthDate", "Пол", "Размер обуви"])
  // A key this build doesn't know (a newer app's) goes last too; two of one key keep the order they were added in.
  assert.deepEqual(orderedEntries([e("vehicle.plate", "", 1), e("email", "", 3), e("email", "", 2)]).map((x) => `${x.key}${x.updatedAt}`), ["email2", "email3", "vehicle.plate1"])
  // Every key the store knows has its place, and the add menu uses the same order; the app's list is the same.
  for (const key of FORM_KEYS) assert.ok(FIELD_ORDER.includes(key), key)
  const swift = read("ContextFlow/Shared (App)/AgentApp.swift")
  const appKeys = [...swift.match(/static let keys: \[String\] = \[([\s\S]+?)\]/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(appKeys, FIELD_ORDER)
  assert.match(read("src/content/agent/MyDetails.tsx"), /FIELD_ORDER\.filter\(/)
})

test("the iCloud line: only here until the person turns it on; syncing; synced just now or when; why not", () => {
  assert.deepEqual(syncState({}, false), { line: "local" })
  assert.deepEqual(syncState({ icloud: false, syncedAt: 5 }, false), { line: "local" })
  assert.deepEqual(syncState({ icloud: true }, true), { line: "syncing" })
  assert.deepEqual(syncState({ icloud: false }, true), { line: "local" })
  assert.deepEqual(syncState({ icloud: true, syncError: "no_account" }, false), { line: "noAccount" })
  assert.deepEqual(syncState({ icloud: true, syncError: "failed", syncedAt: 1 }, false), { line: "failed" })
  // Said yes on 121 (no sync noted yet): the hint about the private iCloud until the next sync notes one.
  assert.deepEqual(syncState({ icloud: true }, false), { line: "private" })
  assert.deepEqual(syncState({ icloud: true, syncedAt: 1_000_000 }, false, 1_060_000), { line: "synced", when: "now" })
  assert.deepEqual(syncState({ icloud: true, syncedAt: 1_000_000 }, false, 1_200_000), { line: "synced", when: 1_000_000 })
})

test("My details: the iCloud switch always there (never on by default), no one-time card; the app the same", () => {
  const ui = read("src/content/agent/MyDetails.tsx")
  assert.doesNotMatch(ui, /askICloud|fdICloudAsk/)
  assert.match(ui, /<label class="cf-row toggle cf-fd-icloud">\n\s+<span class="cf-label">\{t\("fdICloud"\)\}<\/span>\n\s+<input type="checkbox" checked=\{data\.icloud === true\}/)
  assert.match(ui, /<p class="cf-hint" role="status">\{syncLine\(data, syncing\)\}<\/p>/)
  // The rules' switches at the end of their rows, as every other switch in Settings; the specialist's hint.
  assert.match(ui, /<span>\{text\}<\/span>\n\s+<input type="checkbox" checked=\{rules\[key\]\}/)
  assert.match(ui, /t\("agentRuleAnySpecialistHint"\)/)
  // The background passes the last sync's result on; the app keeps it and says it.
  assert.match(read("src/background/agent.ts"), /\.\.\.formDataState\(raw\), icloud: message\.on/)
  const handler = read("ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift")
  assert.match(handler, /if on \{ _ = await Self\.withTimeout\(seconds: 12\) \{ await FormDataSync\.syncNoted\(\) \} \}/)
  assert.match(handler, /out\["syncedAt"\] = at/)
  const store = read("ContextFlow/Shared (Extension)/FormData.swift")
  assert.match(store, /static func syncNoted\(\) async -> Bool \{\n\s+guard FormDataStore\.syncChoice == true else \{ return false \}/)
  const app = read("ContextFlow/Shared (App)/AgentApp.swift")
  assert.doesNotMatch(app, /askICloud/)
  assert.match(app, /Toggle\("Sync through iCloud", isOn: Binding\(get: \{ model\.icloud == true \}/)
  const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")) as { strings: Record<string, { localizations: Record<string, unknown> }> }
  for (const key of ["Only on this device for now", "Syncing…", "Synced · %@", "just now", "Not synced: sign in to iCloud on this device", "Not synced: iCloud didn't answer. It tries again next time."]) {
    assert.equal(Object.keys(catalog.strings[key]?.localizations ?? {}).length, 14, key)
  }
})

test("the rule's words: any specialist, not just a master; lines that stand alone start with a capital, in every language", () => {
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const m = JSON.parse(read(`src/locales/${lang}.json`)) as Record<string, string>
    for (const key of ["fdICloudLocal", "fdICloudSyncing", "fdICloudSynced", "fdICloudJustNow", "fdICloudNoAccount", "fdICloudFailed", "agentRuleAnySpecialistHint"]) assert.ok(m[key]?.trim(), `${lang} ${key}`)
    assert.match(m.fdICloudSynced, /\{0\}/)
    for (const key of ["agentRuleCalNeeds", "agentCalNotChecked", "fdICloudLocal", "fdICloudNoAccount", "agentRuleAnySpecialist"]) {
      const first = m[key][0]
      assert.ok(first === first.toUpperCase(), `${lang} ${key}: «${m[key]}»`)
    }
  }
  const ru = JSON.parse(read("src/locales/ru.json")) as Record<string, string>
  assert.equal(ru.agentRuleAnySpecialist, "Любой специалист (мастер, врач, репетитор, тренер, гид…)")
  assert.equal(ru.agentRuleCalNeeds, "Нужен доступ к календарю")
})

// ---- 5. TestFlight 123 (iPad): the open section's head stays at the top; «О приложении» never folds

test("the open section's head stays at the top while its settings scroll, until the next head pushes it off", () => {
  const head = 44
  // The list's top at 100. «Основное» open, scrolled 300 into it (its top at -200, its end at 500): its head stays.
  const at = (generalTop: number) => [
    { id: "general", open: true, top: generalTop, bottom: generalTop + 700, head },
    { id: "button", open: false, top: generalTop + 700, bottom: generalTop + 760, head },
    { id: "agent", open: true, top: generalTop + 760, bottom: generalTop + 1900, head }
  ]
  assert.equal(stuckSection(at(100), 100), null)
  assert.equal(stuckSection(at(-200), 100), "general")
  // Its end has come up to the head's bottom: the next head (a folded one) is taking over; none is stuck.
  assert.equal(stuckSection(at(100 - 700 + head - 1), 100), null)
  // Further, inside the open «Сделать» section: its head.
  assert.equal(stuckSection(at(-900), 100), "agent")
  // A folded section never sticks, wherever it is.
  assert.equal(stuckSection([{ id: "button", open: false, top: -50, bottom: 400, head }], 100), null)
})

test("folding the stuck section scrolls its head back to the top; a section in view folds where it is", () => {
  assert.equal(foldScroll(-200, 100), -300)
  assert.equal(foldScroll(100, 100), 0)
  assert.equal(foldScroll(260, 100), 0)
})

test("Settings: sticky heads in the CSS, the hairline while stuck, «О приложении» always open with no chevron", () => {
  const css = read("src/content/styles.css")
  assert.match(css, /\.cf-set-sec\.open > \.cf-set-head:not\(\.static\) \{ position: sticky; top: -12px; z-index: 2; \}/)
  assert.match(css, /\.cf-set-head \{[^}]*background: var\(--bg\)/)
  assert.match(css, /\.cf-set-head\[data-stuck\] \{ box-shadow: 0 1px 0 var\(--border\); \}/)
  // The list's top padding is what the sticky top takes back.
  assert.match(css, /\.cf-settings \{[^}]*padding: 12px 14px 18px/)
  const ui = read("src/content/Settings.tsx")
  const about = ui.slice(ui.indexOf('<section class="cf-set-sec open cf-set-about">'), ui.indexOf("</section>", ui.indexOf("cf-set-about")))
  assert.ok(about.includes('<div class="cf-set-head static"><span class="cf-set-title">{t("setSecAbout")}</span></div>'))
  assert.doesNotMatch(about, /cf-set-chev|onClick=\{onToggle|aria-expanded/)
  for (const key of ["tourShow", "rateApp", "support", "privacyPolicy", "terms", "version"]) assert.ok(about.includes(`t("${key}"`), key)
  // The about section comes last.
  assert.ok(ui.indexOf("cf-set-about") > ui.indexOf('{hasPro(plan) && planSection}'))
  assert.match(ui, /<div ref=\{box\} class="cf-settings" onScroll=\{onScroll\}>/)
})
