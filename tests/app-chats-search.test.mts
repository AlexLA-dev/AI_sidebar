// 2.6 (98), the owner on TestFlight 97, of the app's Chats screen (the ✦ button by the search field and the "Describe what
// you remember…" row): «Не понятно, что это в приложении и зачем». One search field with its two ways named under it
// ("By words", "By meaning": AI search, Pro), what "By meaning" does as words under the field (not a row that looks like
// a field), and "Ask your chats" its own named row.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const view = readFileSync(new URL("../ContextFlow/Shared (App)/ChatsView.swift", import.meta.url), "utf8")
const screen = view.slice(view.indexOf("struct ChatsView"), view.indexOf("/// On top of the list: questions about all the chats"))
const catalog = JSON.parse(readFileSync(new URL("../ContextFlow/Shared (App)/Localizable.xcstrings", import.meta.url), "utf8")).strings

test("one field, its two ways named under it; no ✦ toggle in the toolbar", () => {
  assert.equal((screen.match(/\.searchable\(/g) ?? []).length, 1)
  // Named under the field as the list's first row while it's open (iOS 26 shows no system scope bar there).
  assert.match(screen, /SearchWayRow\(way: \$way, pro: isPro, typed: searching\)/)
  assert.match(screen, /if isSearching \|\| typed \{[\s\S]*?Text\("By words"\)\.tag\(ChatsView\.SearchWay\.words\)\s*Text\(pro \? "By meaning" : "By meaning · Pro"\)\.tag\(ChatsView\.SearchWay\.meaning\)[\s\S]*?\.pickerStyle\(\.segmented\)/)
  const toolbar = screen.slice(screen.indexOf(".toolbar {"), screen.indexOf(".toolbar {") + 600)
  assert.doesNotMatch(toolbar, /sparkles|aiSearch\.toggle/)
  // Without Pro, "By meaning" opens Pro and the field stays on words.
  assert.match(screen, /if next == \.meaning && !isPro \{\s*way = \.words\s*openPro\(\)/)
})

test("what By meaning does is words under the field, not a row that looks like a field; the chats stay", () => {
  assert.match(screen, /private var meaningHint: some View \{\s*Section \{\s*\} footer: \{\s*Text\("Describe what you remember/)
  assert.doesNotMatch(screen, /Label\("Describe what you remember/)
  // Closed or empty, the list is the chats (with the words over them on "By meaning").
  assert.match(screen, /if aiSearch && \(searching \|\| finding \|\| found != nil\) \{\s*aiResults/)
  assert.match(screen, /if aiSearch \{ meaningHint \}\s*chatList/)
})

test("\"Ask your chats\" stays its own named row; the new words in every language", () => {
  assert.match(screen, /AskHistoryRow\(pro: true\)/)
  for (const key of ["By words", "By meaning", "By meaning · Pro", "Tap a chat to read it, swipe it to pin, tag or delete it, or long-press it for more. Search by words or #tag, and turn on Folders to group by tag. In Pro, “By meaning” finds a chat from a description."]) {
    assert.ok(catalog[key], key)
    assert.equal(Object.keys(catalog[key].localizations).length, 13, key)
  }
  assert.equal(catalog["By meaning"].localizations.ru.stringUnit.value, "По смыслу")
  assert.match(catalog["Tap a chat to read it, swipe it to pin, tag or delete it, or long-press it for more. Search by words or #tag, and turn on Folders to group by tag. In Pro, “By meaning” finds a chat from a description."].localizations.ru.stringUnit.value, /«По смыслу»/)
  assert.doesNotMatch(JSON.stringify(Object.keys(catalog).filter((k) => k.startsWith("Tap a chat to read it"))), /✦/)
})
