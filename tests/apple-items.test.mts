// Calendar and Reminders (2.7, plan section 3): the chat's marker, dates on the device's wall clock, and what the
// device accepts from the server's model. The device writes items itself (AppleItems.swift).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { checkItems, deviceNow, ITEM_MARKER, itemNotes, itemPast, validDate, validTime, validZone, wallMoment, wallOf, withoutItemMarker } from "../src/shared/appleItems.ts"
import { ITEM_RULE, systemPromptParts, withItemRule } from "../src/shared/prompt.ts"
import { FEATURES } from "../src/shared/usage.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("the marker comes out of the answer, and a part of it at the end while it streams", () => {
  assert.deepEqual(withoutItemMarker(`I'll remind you on Friday at 9:00 to book the hotel.\n\n${ITEM_MARKER}`), { text: "I'll remind you on Friday at 9:00 to book the hotel.", marked: true })
  assert.deepEqual(withoutItemMarker("Your flight is on 14 March.\n[[cf:a"), { text: "Your flight is on 14 March.\n", marked: false })
  assert.deepEqual(withoutItemMarker("Done.\n[["), { text: "Done.\n", marked: false })
  assert.deepEqual(withoutItemMarker("See [1] and [2]."), { text: "See [1] and [2].", marked: false })
  assert.deepEqual(withoutItemMarker("A [[wiki]] link"), { text: "A [[wiki]] link", marked: false })
  assert.deepEqual(withoutItemMarker(""), { text: "", marked: false })
})

test("dates, times and zones the device can trust", () => {
  assert.ok(validDate("2026-03-14") && validDate("2028-02-29"))
  assert.ok(!validDate("2026-02-30") && !validDate("2026-3-14") && !validDate("14.03.2026") && !validDate(null))
  assert.ok(validTime("00:00") && validTime("23:59"))
  assert.ok(!validTime("24:00") && !validTime("9:30") && !validTime("10:60"))
  assert.ok(validZone("Europe/Moscow") && validZone("America/Los_Angeles") && validZone("UTC"))
  assert.ok(!validZone("Mars/Base") && !validZone("PT") && !validZone("../etc"))
})

test("a wall-clock time in another zone, across the clocks changing", () => {
  // Los Angeles: PST (−8) before 8 March 2026, PDT (−7) after.
  assert.equal(new Date(wallMoment("2026-03-07", "15:00", "America/Los_Angeles")).toISOString(), "2026-03-07T23:00:00.000Z")
  assert.equal(new Date(wallMoment("2026-03-09", "15:00", "America/Los_Angeles")).toISOString(), "2026-03-09T22:00:00.000Z")
  // 02:30 doesn't exist that night: an hour later, as the system does.
  assert.equal(new Date(wallMoment("2026-03-08", "02:30", "America/Los_Angeles")).toISOString(), "2026-03-08T10:30:00.000Z")
  assert.equal(new Date(wallMoment("2026-11-14", "10:40", "Europe/Moscow")).toISOString(), "2026-11-14T07:40:00.000Z")
  // No zone: the device's own.
  const local = new Date(wallMoment("2026-11-14", "10:40"))
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()], [2026, 10, 14, 10, 40])
  assert.deepEqual(wallOf(local.getTime()), { date: "2026-11-14", time: "10:40" })
})

test("an item in the past: by its time, or a whole day once that day is over", () => {
  const now = wallMoment("2026-11-14", "12:00")
  assert.equal(itemPast({ date: "2026-11-14", time: "11:59" }, now), true)
  assert.equal(itemPast({ date: "2026-11-14", time: "12:30" }, now), false)
  assert.equal(itemPast({ date: "2026-11-14" }, now), false, "today, all day")
  assert.equal(itemPast({ date: "2026-11-13" }, now), true)
  assert.equal(itemPast({}, now), false, "a reminder without a date")
})

test("the device's now for the server: its wall clock, weekday and zone, never UTC", () => {
  const d = deviceNow(new Date(2026, 10, 14, 9, 5))
  assert.equal(d.now, "2026-11-14T09:05")
  assert.equal(d.weekday, "Saturday")
  assert.ok(validZone(d.tz))
})

test("what the model gives back is checked: kinds, real dates, known zones, short texts, at most five", () => {
  const items = checkItems({
    items: [
      { kind: "event", title: "Flight SU 1234 Moscow → Sochi", date: "2026-03-14", time: "10:40", end_date: "2026-03-14", end_time: "13:10", location: "Sheremetyevo", notes: "Seat 12A", confidence: "sure" },
      { kind: "reminder", title: "Book the hotel", date: "2026-11-20", confidence: "guess" },
      { kind: "reminder", title: "Call the bank", confidence: "sure" },
      { kind: "event", title: "No date", confidence: "sure" },
      { kind: "event", title: "Bad date", date: "2026-02-30", time: "10:00", confidence: "sure" },
      { kind: "reminder", title: "  ", confidence: "sure" },
      { kind: "note", title: "Not a kind", confidence: "sure" },
      { kind: "event", title: "Call in PT", date: "2026-11-20", time: "15:00", tz: "America/Los_Angeles", confidence: "sure" },
      { kind: "event", title: "Ends before it starts", date: "2026-11-20", time: "15:00", end_time: "14:00", confidence: "maybe" },
      { kind: "reminder", title: "Bad zone", date: "2026-11-20", time: "09:00", tz: "Nowhere/Land", confidence: "sure" },
      { kind: "reminder", title: "Sixth", confidence: "sure" }
    ]
  })
  assert.equal(items.length, 5)
  assert.deepEqual(items[0], { kind: "event", title: "Flight SU 1234 Moscow → Sochi", confidence: "sure", notes: "Seat 12A", location: "Sheremetyevo", date: "2026-03-14", time: "10:40", endDate: "2026-03-14", endTime: "13:10" })
  assert.deepEqual(items[1], { kind: "reminder", title: "Book the hotel", confidence: "guess", date: "2026-11-20" })
  assert.deepEqual(items[2], { kind: "reminder", title: "Call the bank", confidence: "sure" }, "a reminder may have no date")
  assert.equal(items[3].tz, "America/Los_Angeles")
  assert.deepEqual(items[4], { kind: "event", title: "Ends before it starts", confidence: "guess", date: "2026-11-20", time: "15:00" }, "an end before the start goes")
  // The kind the person asked for wins; nonsense gives nothing.
  assert.deepEqual(checkItems({ items: [{ kind: "event", title: "Pay rent", date: "2026-12-01", confidence: "sure" }] }, "reminder").map((i) => i.kind), ["reminder"])
  assert.deepEqual(checkItems(null), [])
  assert.deepEqual(checkItems({ items: "x" }), [])
  assert.equal(checkItems({ items: [{ kind: "reminder", title: "x".repeat(500), confidence: "sure" }] })[0].title.length, 120)
})

test("a reminder's notes: its own, then the page and the link back to the chat", () => {
  assert.equal(itemNotes("Seat 12A", { url: "https://air.example/b/1", chat: "contextflow://chat?id=c1&m=k1" }, "Booking"), "Seat 12A\n\nBooking\nhttps://air.example/b/1\n\ncontextflow://chat?id=c1&m=k1")
  assert.equal(itemNotes(undefined, { chat: "contextflow://chat?id=c1&m=k1" }), "contextflow://chat?id=c1&m=k1")
})

test("the chat's rule goes with the rules (cached part), only when asked for", () => {
  const parts = systemPromptParts(null, "", "ru-RU")
  assert.deepEqual(withItemRule(parts, false), parts)
  const [rules, rest] = withItemRule(parts, true)
  assert.ok(rules.includes(ITEM_RULE) && rules.indexOf(ITEM_RULE) > rules.indexOf("Rules:"))
  assert.ok(rules.indexOf(ITEM_RULE) < rules.indexOf("No page content"))
  assert.equal(rest, parts[1])
  assert.match(ITEM_RULE, /\[\[cf:add\]\]/)
})

test("the server, the background and the panel: marker out, flag on, counts only", () => {
  const chat = read("../netlify/functions/v2-chat.mts")
  assert.match(chat, /const items = body\.items === true && !history/)
  assert.match(chat, /withItemRule\(systemPromptParts\(page, profile, locale, others, fromApp, hasMarks\(messages\), tokens\), items\)/)
  assert.match(chat, /withItemRule\(\[googlePrompt\(/)
  assert.match(read("../src/background/chat.ts"), /\.\.\.\(req\.payload\.items \? \{ items: true \} : \{\}\)/)
  assert.match(read("../src/background/jobs.ts"), /const \{ text, marked \} = withoutItemMarker\(grounded\?\.text \?\? job\.snapshot\.text\)/)
  const app = read("../src/content/App.tsx")
  assert.match(app, /\.\.\.\(appleNow\(\)\?\.available \? \{ items: true as const \} : \{\}\)/)
  assert.match(app, /<Markdown text=\{withoutItemMarker\(partial\)\.text\} \/>/)
  assert.match(app, /\{!picked && ux\.addCard\(m, idx\)\}/)
  // Counted as "use" steps of "apple": named values only.
  assert.deepEqual(FEATURES.apple.fields, { what: ["reminder", "event"] })
  for (const a of ["open", "shown", "nothing", "added", "app", "denied", "failed", "not_asked", "dismissed", "also_on", "also_off"]) assert.ok(FEATURES.apple.actions.includes(a), a)
})

test("native: iOS 17 and macOS 14 only, the keys and the Mac's Calendars entitlement, the app routes the link", () => {
  const items = read("../ContextFlow/Shared (Extension)/AppleItems.swift")
  assert.match(items, /if #available\(iOS 17\.0, macOS 14\.0, \*\) \{ return true \}/)
  assert.match(items, /requestFullAccessToReminders\(\)/)
  assert.match(items, /requestWriteOnlyAccessToEvents\(\)/)
  const handler = read("../ContextFlow/Shared (Extension)/SafariWebExtensionHandler.swift")
  for (const c of ["apple_status", "apple_add", "apple_remove"]) assert.match(handler, new RegExp(`case "${c}":`))
  for (const plist of ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"]) {
    assert.match(read(`../ContextFlow/${plist}/Info.plist`), /NSRemindersFullAccessUsageDescription/, plist)
  }
  for (const plist of ["macOS (App)", "macOS (Extension)"]) assert.match(read(`../ContextFlow/${plist}/Info.plist`), /NSCalendarsWriteOnlyAccessUsageDescription/)
  for (const e of ["ContextFlow (macOS).entitlements", "ContextFlow Extension (macOS).entitlements"]) {
    assert.match(read(`../ContextFlow/${e}`), /<key>com\.apple\.security\.personal-information\.calendars<\/key>\s*<true\/>/, e)
  }
  const strings = JSON.parse(read("../ContextFlow/Shared (App)/InfoPlist.xcstrings")).strings
  for (const key of ["NSRemindersFullAccessUsageDescription", "NSCalendarsWriteOnlyAccessUsageDescription"]) {
    assert.equal(Object.keys(strings[key].localizations).length, 14, key)
  }
  assert.match(read("../ContextFlow/Shared (App)/ContentView.swift"), /case "add":\s*appleAdd\.open\(url\)/)
  const project = read("../ContextFlow/ContextFlow.xcodeproj/project.pbxproj")
  assert.equal([...project.matchAll(/AppleItems\.swift in Sources \*\/,/g)].length, 4, "the app and the extension, iOS and macOS")
  assert.equal([...project.matchAll(/AppleAdd\.swift in Sources \*\/,/g)].length, 2, "the apps")
})

test("the panel's new strings are in all 14 languages", () => {
  const en = JSON.parse(read("../src/locales/en.json"))
  const keys = Object.keys(en).filter((k) => k.startsWith("apple"))
  assert.ok(keys.length >= 26)
  for (const lang of ["ar", "de", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "uk", "vi", "zh_CN", "zh_TW"]) {
    const l = JSON.parse(read(`../src/locales/${lang}.json`))
    for (const k of keys) assert.ok(typeof l[k] === "string" && l[k].length > 0, `${lang} ${k}`)
  }
})
