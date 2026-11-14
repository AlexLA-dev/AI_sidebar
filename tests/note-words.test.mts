// 2.6 (97), the owner: «Когда выделяю текст (или беру всю страницу) и хочу себе поставить напоминалку или следить — мне
// некуда приписать себе заметку… Я бы хотел, чтобы то, что выделено, было оформлено как цитата, и при создании
// напоминалки/следить можно было написать свою заметку к ней.» A note on a selection keeps the selection apart (`cite`):
// the chat shows it as a quote and the person's own words as the note; the notifications say those words; older notes
// and watches look as before. The app draws and says the same (Chats.swift, ChatsView.swift, Later.swift).
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { citedNote, noteWords, selectionNote, withNoteWords, type Entry } from "../src/shared/conversation.ts"
import { reminderNotice, remindWords, withRemindWords } from "../src/shared/reminders.ts"
import { reminderRows } from "../src/content/ux/reminderList.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const locales = readdirSync(new URL("../src/locales/", import.meta.url)).filter((f) => f.endsWith(".json"))
const strings = (file: string) => JSON.parse(read(`../src/locales/${file}`)) as Record<string, string>
const page = { url: "https://shop.example/desk", title: "Standing desk", hash: "abc", at: 1 }
const asked = (text: string) => `You asked to be reminded: ${text}`

test("a note on a selection keeps the selection apart, in every language's quote marks", () => {
  assert.equal(locales.length, 14)
  for (const file of locales) {
    const mark = strings(file).noteQuote
    const quoted = (text: string) => mark.replace("{0}", text)
    const entry = selectionNote("Width 140 cm\n\nOak top", "  fits by the window?  ", page, quoted)
    assert.equal(entry.cite, "Width 140 cm\n\nOak top", file)
    // The text stays as before (older versions, search, sharing): the quote in the language's marks, then the words.
    assert.equal(entry.content, `${quoted("Width 140 cm\n\nOak top")}\n\nfits by the window?`, file)
    assert.deepEqual(citedNote(entry), { cite: "Width 140 cm\n\nOak top", note: "fits by the window?" }, file)
    assert.equal(noteWords(entry), "fits by the window?", file)
    // New words: the quote and its marks as they were.
    const changed = withNoteWords(entry, "measure the wall first")
    assert.equal(changed.content, `${quoted("Width 140 cm\n\nOak top")}\n\nmeasure the wall first`, file)
    assert.deepEqual(citedNote(withNoteWords(entry, " ")), { cite: "Width 140 cm\n\nOak top", note: "" }, file)
    // No words: just the quote.
    assert.deepEqual(citedNote(selectionNote("Width 140 cm", "", page, quoted)), { cite: "Width 140 cm", note: "" }, file)
  }
})

test("notes made before (no cite), typed notes and answers look and read as before", () => {
  const old: Entry = { role: "user", content: "«Width 140 cm»\n\nfits?", note: true, quote: true, page }
  assert.equal(citedNote(old), null)
  assert.equal(noteWords(old), old.content)
  assert.equal(withNoteWords(old, "x"), old)
  const typed: Entry = { role: "user", content: "Call the shop", note: true }
  assert.equal(citedNote(typed), null)
  // A cite the text doesn't start with (changed elsewhere): its text, as it is.
  assert.equal(citedNote({ ...old, cite: "something else" }), null)
  assert.equal(citedNote({ role: "assistant", content: "An answer" }), null)
})

test("the reminder's notification says the person's words when there are some, else what it said before", () => {
  const quoted = (text: string) => `“${text}”`
  const withWords = { ...selectionNote("Width 140 cm", "measure the wall", page, quoted), remind: { at: 1, page: true as const } }
  assert.deepEqual(reminderNotice(withWords, "Chat", asked), { title: "Standing desk", body: "You asked to be reminded: measure the wall", url: page.url })
  const without = { ...selectionNote("Width 140 cm", "", page, quoted), remind: { at: 1, page: true as const } }
  assert.equal(reminderNotice(without, "Chat", asked).body, "You asked to be reminded: “Width 140 cm”")
  // A note made before: its whole text, as before.
  const old: Entry = { role: "user", content: "«Width 140 cm»\n\nfits?", note: true, quote: true, page, remind: { at: 1, page: true } }
  assert.equal(reminderNotice(old, "Chat", asked).body, "You asked to be reminded: «Width 140 cm» fits?")
  // The whole page: the words when written, else the page's name, as before.
  const pageNote: Entry = { role: "user", content: "compare with the other shop", note: true, page, remind: { at: 1, page: true } }
  assert.equal(reminderNotice(pageNote, "Chat", asked).body, "You asked to be reminded: compare with the other shop")
  assert.equal(reminderNotice({ ...pageNote, content: "Standing desk" }, "Chat", asked).body, "You asked to be reminded: Standing desk")
})

test("a reminder made with Remind has words to change with its time; others don't", () => {
  const quoted = (text: string) => `«${text}»`
  const cited = { ...selectionNote("Width 140 cm", "measure", page, quoted), remind: { at: 1, page: true as const } }
  assert.equal(remindWords(cited), "measure")
  assert.equal(withRemindWords(cited, "measure twice").content, "«Width 140 cm»\n\nmeasure twice")
  assert.equal(withRemindWords(cited, "").content, "«Width 140 cm»")
  assert.equal(withRemindWords(cited, undefined), cited)
  // The whole page: its name is no words; new words become its text, none brings the name back.
  const named: Entry = { role: "user", content: "Standing desk", note: true, page, remind: { at: 1, page: true } }
  assert.equal(remindWords(named), "")
  assert.equal(withRemindWords(named, "ask about delivery").content, "ask about delivery")
  assert.equal(remindWords({ ...named, content: "ask about delivery" }), "ask about delivery")
  assert.equal(withRemindWords({ ...named, content: "ask about delivery" }, " ").content, "Standing desk")
  const untitled: Entry = { ...named, content: page.url, page: { ...page, title: "" } }
  assert.equal(remindWords(untitled), "")
  // An answer's reminder, a note typed in the chat, a note on a selection made before: no words to change.
  assert.equal(remindWords({ role: "assistant", content: "An answer", remind: { at: 1 } }), undefined)
  assert.equal(remindWords({ role: "user", content: "Call the shop", note: true, remind: { at: 1 } }), undefined)
  assert.equal(remindWords({ role: "user", content: "«x»\n\ny", note: true, quote: true, page, remind: { at: 1, page: true } }), undefined)
})

test("the Reminders list shows the quote and the person's words apart, and the words to change", () => {
  const at = Date.now() + 3_600_000
  const cited = { ...selectionNote("Width 140 cm", "measure the wall", page, (x) => `“${x}”`), remind: { at, page: true as const } }
  const old: Entry = { role: "user", content: "Call the shop", note: true, remind: { at: at + 1 } }
  const rows = reminderRows({ c1: { id: "c1", u: 1, m: [cited, old] } } as any, undefined, Date.now(), () => "Soon", (x) => x)
  assert.equal(rows[0].quote, "Width 140 cm")
  assert.equal(rows[0].text, "measure the wall")
  assert.equal(rows[0].words, "measure the wall")
  assert.equal(rows[1].text, "Call the shop")
  assert.equal(rows[1].quote, undefined)
  assert.equal(rows[1].words, undefined)
})

test("the change notification says the person's note first, then what changed; without one, as before", async () => {
  await ready
  assert.equal(watchBody("ask for the oak top", "Now: €89.00"), "ask for the oak top\nNow: €89.00")
  assert.equal(watchBody(undefined, "Now: €89.00"), "Now: €89.00")
  assert.equal(watchBody("  ", "Now: €89.00"), "Now: €89.00")
})

test("the note fields' words in all 14 languages; the eye's never speaks of reminders", () => {
  const en = strings("en.json")
  for (const file of locales) {
    const s = strings(file)
    for (const key of ["uxNoteWords", "watchNoteWords"]) {
      assert.ok(s[key]?.trim(), `${file} ${key}`)
      if (file !== "en.json") assert.notEqual(s[key], en[key], `${file} ${key} translated`)
    }
  }
  assert.doesNotMatch(en.watchNoteWords, /remind/i)
  assert.match(read("../src/content/ux/MessageUx.tsx"), /t\(watch \? "watchNoteWords" : "uxNoteWords"\)/)
})

// ---- the chat: the quote and the words, rendered ----------------------------------------------------------

let NoteText: any
let RemindSheet: any
let watchBody: any
let h: any
let render: any
let doc: any
let loaded: () => void
const ready = new Promise<void>((r) => (loaded = r))

before(async () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>")
  doc = document
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  ;(globalThis as any).chrome = { i18n: { getMessage: () => "", getUILanguage: () => "en" } }
  const dir = mkdtempSync(join(tmpdir(), "cf-note-"))
  const out = join(dir, "note.mjs")
  await build({
    stdin: { contents: `export { NoteText } from "./src/content/ux/NoteText"; export { RemindSheet } from "./src/content/ux/MessageUx"; export { watchBody } from "./src/shared/watch/line"; export { h, render } from "preact"`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".tsx": "tsx" }, define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  ;({ NoteText, RemindSheet, watchBody, h, render } = await import(pathToFileURL(out).href))
  loaded()
})

const drawn = (entry: Entry) => {
  const box = doc.createElement("div")
  render(h(NoteText, { entry }), box)
  return box
}

test("in the chat: the selection as a quote, the person's words under it; older notes as before", () => {
  const cited = drawn(selectionNote("Width 140 cm", "measure the wall", page, (x) => `«${x}»`))
  assert.equal(cited.querySelector("blockquote.cf-note-cite")?.textContent, "Width 140 cm")
  assert.match(cited.textContent, /measure the wall$/)
  assert.doesNotMatch(cited.textContent, /«/)
  const quoteOnly = drawn(selectionNote("Width 140 cm", "", page, (x) => `«${x}»`))
  assert.equal(quoteOnly.querySelector("blockquote")?.textContent, "Width 140 cm")
  assert.ok(quoteOnly.querySelector("blockquote .cf-note-mark"), "the note's pencil stays")
  const old = drawn({ role: "user", content: "«Width 140 cm»\n\nfits?", note: true, quote: true, page })
  assert.equal(old.querySelector("blockquote"), null)
  assert.match(old.textContent, /«Width 140 cm»\n\nfits\?$/)
})

// ---- the app: the same rules and look ----------------------------------------------------------------------

test("the app reads the selection apart and draws the quote as the panel does", () => {
  const chats = read("../ContextFlow/Shared (App)/Chats.swift")
  assert.match(chats, /var cite: String\?/)
  // The same rule for where the quote ends: the opening mark within 3 characters, then a blank line.
  assert.match(chats, /content\.utf16\.distance\(from: content\.startIndex, to: found\.lowerBound\) <= 3/)
  assert.match(read("../src/shared/conversation.ts"), /if \(at < 0 \|\| at > 3\) return -1/)
  const view = read("../ContextFlow/Shared (App)/ChatsView.swift")
  assert.match(view, /struct NoteBody: View \{[\s\S]*?if let cited = entry\.cited \{[\s\S]*?QuoteBlock\(text: cited\.cite\)/)
  assert.match(view, /NoteBody\(entry: entry\)/)
})

test("the app's reminder notifications say the words too, and its windows change them with the time", () => {
  const later = read("../ContextFlow/Shared (App)/Later.swift")
  assert.equal((later.match(/body: ReminderTimes\.asked\(entry\.reminderText\)/g) ?? []).length, 2)
  assert.doesNotMatch(later, /ReminderTimes\.asked\(entry\.content\)/)
  assert.match(later, /words: reminderEntry\(item\)\?\.remindWords/)
  assert.match(read("../ContextFlow/Shared (App)/ChatsView.swift"), /words: thread\.entries\[index\]\.remindWords/)
  const ux = read("../ContextFlow/Shared (App)/ChatUX.swift")
  assert.match(ux, /TextField\("Your note \(optional\)"/)
  const catalog = JSON.parse(read("../ContextFlow/Shared (App)/Localizable.xcstrings")).strings["Your note (optional)"]
  assert.equal(Object.keys(catalog.localizations).length, 13)
})

test("the app's Watching list gets each watch's note", () => {
  assert.match(read("../src/background/watch.ts"), /\.\.\.\(w\.note \? \{ note: w\.note \} : \{\}\)/)
  const store = read("../ContextFlow/Shared (Extension)/WatchStore.swift")
  assert.match(store, /var note: String\?/)
  assert.match(store, /note: \(d\["note"\] as\? String\)/)
  assert.match(read("../ContextFlow/Shared (App)/WatchOpen.swift"), /detail: w\.note/)
})

// ---- the Remind window: the words, optional --------------------------------------------------------------

test("the Remind window has the person's words, optional and not focused; a time saves them, or saves without", async () => {
  const picks: any[] = []
  const box = doc.createElement("div")
  doc.body.appendChild(box)
  render(h(RemindSheet, { later: true, quote: "Width 140 cm", words: "", onPick: (...a: any[]) => picks.push(a), onCancel: () => undefined, onClose: () => undefined }), box)
  const field = box.querySelector("textarea.cf-note-words")
  assert.ok(field, "the field")
  assert.equal(field.getAttribute("placeholder"), "Your note (optional)")
  assert.notEqual(doc.activeElement, field, "not focused by itself")
  assert.equal(box.querySelector("blockquote.cf-sheet-quote")?.textContent, "Width 140 cm", "the selection as a quote")
  const rows = () => [...box.querySelectorAll(".cf-sheet-row")] as any[]
  rows()[0].dispatchEvent(new (globalThis as any).window.Event("click"))
  assert.equal(picks[0][2], "", "a time saves without words")
  field.value = "  measure the wall  "
  field.dispatchEvent(new (globalThis as any).window.Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 10))
  rows()[1].dispatchEvent(new (globalThis as any).window.Event("click"))
  assert.equal(picks[1][2], "measure the wall")
  // A reminder on an answer: no field, no words.
  render(h(RemindSheet, { current: 1, onPick: (...a: any[]) => picks.push(a), onCancel: () => undefined, onClose: () => undefined }), box)
  assert.equal(box.querySelector("textarea.cf-note-words"), null)
  rows()[0].dispatchEvent(new (globalThis as any).window.Event("click"))
  assert.equal(picks[2][2], undefined)
  // Build 98 (the owner: «приходится угадывать как закрыть»): a ✕ at the end of the title closes it.
  let closed = 0
  render(h(RemindSheet, { later: true, words: "", onPick: () => undefined, onCancel: () => undefined, onClose: () => { closed++ } }), box)
  const x = box.querySelector(".cf-sheet-title .cf-sheet-close")
  assert.ok(x, "the ✕")
  assert.equal(x.getAttribute("aria-label"), "Close")
  x.dispatchEvent(new (globalThis as any).window.Event("click"))
  assert.equal(closed, 1)
  render(null, box)
})

test("everywhere a reminder is made or changed in the panel, the words go with it", () => {
  const app = read("../src/content/App.tsx")
  const laterSheet = app.slice(app.indexOf("const laterSheet = (page: boolean)"), app.indexOf("const laterItems = async"))
  assert.match(laterSheet, /words=""/)
  // 2.7: with «Также в Напоминания» (the window's checkbox).
  assert.match(laterSheet, /noteSelection\(from\.selection, words \?\? "", at, preset, apple\)/)
  // The whole page: the person's words, else the page's name.
  assert.match(app, /content: comment\.trim\(\) \|\| page\.title \|\| source\.href\(\)/)
  // The panel's row over the field (build 95) opens the same window.
  assert.match(app, /setLater\(\{ selection, range: selectionRange\(\) \}\)/)
  const reschedule = app.slice(app.indexOf("const rescheduleLaterItem"), app.indexOf("const remindButton"))
  assert.match(reschedule, /const entry = withRemindWords\(found, words\)/)
  assert.match(reschedule, /withReminderAt\(worded\(thread\.m\), ref\.key, at, dev, apple\)/)
  const ux = read("../src/content/ux/useMessageUx.tsx")
  assert.match(ux, /words=\{remindWords\(messages\[reminding\.idx\]\)\}/)
  assert.match(ux, /const m = at === null \? found : withRemindWords\(found, words\)/)
  assert.match(read("../src/content/ux/RemindersSheet.tsx"), /words=\{changing\.item\.words\}/)
  assert.match(app, /<NoteText entry=\{m\} \/>/)
})

// 2.6 (98), the owner on TestFlight 97: «в поле ввода заметки надо дописать "(optional)" чтобы пользователь понимал».
test("the note fields say they're optional, in all 14 languages", () => {
  const optional: Record<string, RegExp> = {
    "en.json": /\(optional\)$/, "ru.json": /\(необязательно\)$/, "uk.json": /\(необов'язково\)$/, "de.json": /\(optional\)$/,
    "fr.json": /\(facultatif\)$/, "es.json": /\(opcional\)$/, "it.json": /\(facoltativo\)$/, "pt_BR.json": /\(opcional\)$/,
    "ja.json": /（任意）$/, "ko.json": /\(선택\)$/, "zh_CN.json": /（可选）$/, "zh_TW.json": /（選填）$/,
    "vi.json": /\(không bắt buộc\)$/, "ar.json": /\(اختياري\)$/
  }
  assert.deepEqual(Object.keys(optional).sort(), [...locales].sort())
  for (const file of locales) {
    for (const key of ["uxNoteWords", "watchNoteWords"]) assert.match(strings(file)[key], optional[file], `${file} ${key}`)
    // Build 98 (the owner: a hint on two lines sat low in its one-line field): short, one line in every language.
    for (const key of ["uxNoteWords", "watchNoteWords"]) assert.ok([...strings(file)[key]].length <= 30, `${file} ${key}: ${strings(file)[key]}`)
  }
  const catalog = JSON.parse(read("../ContextFlow/Shared (App)/Localizable.xcstrings")).strings["Your note (optional)"]
  const app = { ru: "ru.json", uk: "uk.json", de: "de.json", fr: "fr.json", es: "es.json", it: "it.json", "pt-BR": "pt_BR.json", ja: "ja.json", ko: "ko.json", "zh-Hans": "zh_CN.json", "zh-Hant": "zh_TW.json", vi: "vi.json", ar: "ar.json" } as Record<string, string>
  for (const [lang, file] of Object.entries(app)) assert.equal(catalog.localizations[lang].stringUnit.value, strings(file).uxNoteWords, lang)
})
