// 2.7 after build 107, the owner on the panel: «Кнопки (под ответами) + чипы + полоски сверху + поле ввода текста снизу —
// стало мало рабочей обзорной области чата… Особенно это плохо выглядит на мобайле», and his eight decisions on the
// «Тихая панель» mockup (2026-11-16). These keep the chat's shape; the frames and the numbers are in the PR.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { FEATURES } from "../src/shared/usage.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const app = read("../src/content/App.tsx")
const css = read("../src/content/quiet/quiet.css")
const LANGS = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]

let lib: any
before(async () => {
  // leftBadge alone (the menu itself is JSX): its lines cut out of Plus.tsx.
  const src = read("../src/content/quiet/Plus.tsx")
  const from = src.indexOf("/** Few answers left")
  const to = src.indexOf("export interface PlusProps")
  const dir = mkdtempSync(join(tmpdir(), "cf-quiet-panel-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, src.slice(from, to))
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

test("2. the chips are one line that scrolls sideways, in every row of them", () => {
  assert.match(css, /\.cf-actions:not\(\.wrap\) \{\s*flex-wrap: nowrap;[^}]*overflow-x: auto;/)
  assert.match(css, /\.cf-actions:not\(\.wrap\) > \.cf-chip \{ flex: none; white-space: nowrap; \}/)
  // The empty chat's, the ones under "Now on…" and the ones at the end of a chat about this page: the same ranked row.
  assert.match(app, /<ChipsRow cls="cf-actions" sig=\{chipsSig\} arrows=\{!touch\}>\s*\{actions\.map\(\(a\) => \(\s*chip\(a, false\)\s*\)\)\}/)
  assert.match(app, /<ChipsRow cls="cf-actions follow" sig=\{chipsSig\} arrows=\{!touch\}>\s*\{actions\.map\(\(a\) => chip\(a, true\)\)\}/)
  assert.doesNotMatch(app, /withUltra/)
  // "Ask your chats"' example questions aren't the page's chips: they keep their lines.
  assert.match(app, /<div class="cf-actions wrap">\s*\{\(\["askHistoryEx1"/)
  // A chip a guide's step or a hint points at is brought into view in its row.
  assert.match(app, /row\.scrollLeft \+= c\.left \+ c\.width \/ 2 - \(r\.left \+ r\.width \/ 2\)/)
})

test("the chips' row says that it scrolls: a fade at an edge with more behind it, a peek with a finger, an arrow with a mouse", () => {
  // The owner on the frames: «надо как-то пользователю обозначить, что чипы свайпаются как карусель».
  const row = read("../src/content/quiet/ChipsRow.tsx")
  assert.match(css, /\.cf-chips\[data-more="right"\] > \.cf-actions \{ -webkit-mask-image: linear-gradient\(to right, #000 calc\(100% - 44px\), transparent\);/)
  assert.match(css, /\.cf-chips\[data-more="left"\] > \.cf-actions \{ -webkit-mask-image: linear-gradient\(to left,/)
  assert.match(css, /\.cf-chips\[data-more="both"\] > \.cf-actions \{/)
  // No fade and no arrow at an edge with nothing behind it (and none at all when the row fits).
  assert.match(row, /box\.dataset\.more = el\.scrollWidth > el\.clientWidth \+ 1 \? moreAt\(el\.getBoundingClientRect\(\), chips\) : ""/)
  assert.match(css, /\.cf-chips-arrow \{\s*position: absolute; top: 50%; z-index: 1; display: none;/)
  // The peek: a finger only, once a page, never after the person has swiped the row; it comes back by itself.
  assert.match(row, /if \(!arrows && !peeked && !still\) \{/)
  assert.match(row, /if \(swiped \|\| peeked \|\| el\.scrollWidth <= el\.clientWidth \+ 1 \|\| el\.scrollLeft !== 0\) return/)
  assert.match(row, /if \(Math\.abs\(el\.scrollLeft\) > 12\) markSwiped\(\)/)
  assert.match(css, /@keyframes cf-peek \{ 0%, 100% \{ transform: none; \} 45% \{ transform: translateX\(-40px\); \} \}/)
  assert.match(css, /@keyframes cf-peek-rtl \{ 0%, 100% \{ transform: none; \} 45% \{ transform: translateX\(40px\); \} \}/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cf-actions\.cf-peek > \.cf-chip \{ animation: none; \} \}/)
  // The peek moves the chips' picture, not the row's scroll or its order.
  assert.doesNotMatch(row, /scrollTo\(/)
  // The arrows are a mouse's (it can't swipe); VoiceOver and the keyboard reach every chip without them.
  assert.match(row, /class=\{`cf-chips-arrow \$\{side\}`\} tabIndex=\{-1\} aria-hidden="true"/)
  assert.match(row, /\{arrows && <Arrow side="left"/)
})

test("first-run cards never take the chat from an answer: a hint is one line on the compact chat, the guide's card sits under the answer", () => {
  // The owner's 107 frame: «New in ContextFlow 2.7» over half the panel; the director: one line, once, never over an
  // answer or the quick actions; one card at a time.
  const hint = read("../src/content/Hint.tsx")
  assert.match(hint, /if \(line && !open\) \{\s*return \(\s*<div class="cf-hint line" role="note">/)
  assert.match(hint, /<button type="button" class="cf-hint-open" aria-expanded=\{false\} onClick=\{\(\) => setOpen\(true\)\}>\s*<strong>\{title\}<\/strong>\s*<span class="cf-link">\{t\("hintShow"\)\}<\/span>/)
  // Named with what it closes: the panel's own Close has the bare word.
  assert.match(hint, /<button type="button" class="cf-hint-x" aria-label=\{`\$\{t\("close"\)\}: \$\{title\}`\} title=\{t\("close"\)\} onClick=\{onDone\}>/)
  assert.match(css, /\.cf-hint-open strong \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/)
  // Every hint of the chat and of the chats list: a line on the compact chat, the card where there's room.
  assert.equal(app.match(/<Hint\b/g)?.length, 5)
  assert.equal(app.match(/<Hint\s+line=\{compact/g)?.length, 4)
  // (The page hint's how-to stays a card: it's the answer to a tap on its line by the circle.)
  assert.match(app, /<Hint icon=\{<Icon\.Sparkle size=\{16\} \/>\} title=\{how\.title\} action=\{allTips\} onDone=\{pageHints\.doneChat\}>/)
  // «New in 2.7»: in one opening of the panel, then seen (with the side's hint, which it says too).
  assert.match(app, /line=\{compact && \(newLineShown\.current = true\)\}/)
  assert.match(app, /if \(open \|\| !newLineShown\.current\) return\s*newLineShown\.current = false\s*doneHint\(\["new27", "side"\]\)/)
  // One at a time: a hint waits for the first-run guide to end, and each hint for the one before it.
  assert.match(app, /const hintDue = \(key: HintKey\) => hints !== null && !hints\.includes\(key\) && !touring && tourSeen/)
  assert.match(app, /hintDue\("side"\) && !hintDue\("new27"\)/)
  // The guide's card over the composer: the chat ends above it.
  const guide = read("../src/content/Guide.tsx")
  assert.match(guide, /panel\.style\.setProperty\("--cf-guide-foot", `\$\{Math\.round\(cardRef\.current\.offsetHeight\) \+ 10\}px`\)/)
  assert.match(guide, /return \(\) => panel\.style\.removeProperty\("--cf-guide-foot"\)/)
  assert.match(css, /\.cf-messages \{ padding-bottom: calc\(6px \+ var\(--cf-guide-foot, 0px\)\); \}/)
  for (const lang of LANGS) {
    const m = JSON.parse(read(`../src/locales/${lang}.json`))
    assert.ok(typeof m.hintShow === "string" && m.hintShow.length > 0 && m.hintShow.length <= 10, `${lang} hintShow`)
  }
})

test("the header is about a fifth lower, its buttons the same size", () => {
  // The owner on the frames: «очень высокая шапка… много свободного пространства над и под элементами управления».
  const styles = read("../src/content/styles.css")
  // The buttons: 40 pt with a finger, 34 with a mouse, as before.
  assert.match(styles, /\.cf-icon \{ width: 34px; height: 34px;/)
  assert.match(styles, /\.cf\[data-touch\] \.cf-icon \{ width: 40px; height: 40px; \}/)
  // Before: grabber 18 + (2 + 40 + 10 + 1) = 71 on the sheet; 10 + 40 + 10 + 1 = 61 beside the page; 55 with a mouse.
  assert.match(styles, /\.cf-grabber \{ flex-shrink: 0; height: 18px;/)
  assert.match(styles, /padding: 10px 10px 10px 14px;/)
  // After: 13 + (0 + 40 + 2 + 1) = 56; 4 + 40 + 4 + 1 = 49; 5 + 34 + 5 + 1 = 45.
  assert.match(css, /\.cf-header \{ padding-block: 5px; \}\n\.cf\[data-touch\] \.cf-header \{ padding-block: 4px; \}\n\.cf\[data-layout="sheet"\] \.cf-header \{ padding-block: 0 2px; \}\n\.cf-grabber \{ height: 13px;/)
  const cut = (before: number, after: number) => Math.round((1 - after / before) * 100)
  assert.deepEqual([cut(71, 56), cut(61, 49), cut(55, 45)], [21, 20, 18])
})

test("3. under a message: one row; compact shows Copy, Share, Listen and «…», the rest is in «…»", () => {
  const footer = app.slice(app.indexOf("const messageFooter = "), app.indexOf("{markSaid === idx && mark"))
  assert.match(footer, /<ToolsRow cls=\{`cf-msg-tools \$\{hasField \? "has-insert" : ""\}`\}/)
  // The order in the row: Insert (when the page has a field), Copy, Share, Listen, then what only the roomy chat shows.
  const order = ["class=\"cf-insert\"", "<Icon.Copy />", "<Icon.Share />", "cf-listen-btn", "{!compact && (", "<Icon.Tag />", "{!compact && !historyMode && (", "<Icon.ToCollection />", "ux.moreButton(m, idx"]
  let at = -1
  for (const part of order) {
    const next = footer.indexOf(part, at + 1)
    assert.ok(next > at, `${part} in its place`)
    at = next
  }
  // Decision 7: Insert into the field stays in the row whenever the page has a field.
  assert.match(footer, /\{hasField && \(\s*<button type="button" class="cf-insert"/)
  // Tag and To collection go to «…» (first there) on the compact chat, and with a finger on the roomy one too.
  assert.match(footer, /ux\.moreButton\(m, idx, compact \|\| touch \? \{\s*onTag: \(\) => setTagging\(tagging === idx \? null : idx\),\s*onCollect: historyMode \? undefined : \(\) => setCollecting\(idx\),/)
  const menu = read("../src/content/ux/MessageUx.tsx")
  const items = menu.slice(menu.indexOf('<div ref={ref} class={`cf-msg-menu'), menu.indexOf("</div>", menu.indexOf('<div ref={ref} class={`cf-msg-menu')))
  const menuOrder = ["onTag &&", "onCollect &&", "onClick={onPin}", "onClick={onRemind}", "onAdd &&", "onClick={onDelete}"]
  at = -1
  for (const part of menuOrder) {
    const next = items.indexOf(part, at + 1)
    assert.ok(next > at, `${part} in the menu`)
    at = next
  }
  // Six lines on a phone: where neither side of the row has the room, the menu stays whole inside the chat.
  assert.match(menu, /const lack = Math\.ceil\(box\.height - \(up \? above : floor - anchor\.bottom - 8\)\)\s*if \(lack > 0\) el\.style\[up \? "bottom" : "top"\] = `calc\(100% \+ 4px - \$\{lack\}px\)`/)
  // No second line under the row any more.
  assert.doesNotMatch(footer, /<\/ToolsRow>\s*\{[^}]*\}\s*\{!historyMode && \(\s*<button type="button" class="cf-collect-link"/)
  // The row never wraps; its words give way in two steps, measured with the Mac's hover buttons counted in.
  assert.match(css, /\.cf-msg-tools \{ flex-wrap: nowrap !important; min-width: 0; \}/)
  assert.match(css, /\.cf-msg-tools \[data-off\] \{ display: none; \}/)
  // The order the words go in: To collection, Tag, Share, Listen, Copy; Insert into field keeps its words longest.
  const give = (icon: string) => Number(new RegExp(`${icon}[^\\n]*<span class="cf-tl" data-give="(\\d)">`).exec(footer)?.[1])
  assert.deepEqual(["<Icon.ToCollection />", "<Icon.Tag />", "<Icon.Share />", "<SpeakerIcon />", "<Icon.Copy />", "<QIcon.Insert size=\\{15\\} />"].map(give), [1, 2, 3, 4, 5, 6])
  assert.doesNotMatch(read("../src/content/insert/insert.css"), /\.cf-msg-tools\.has-insert \{[^}]*flex-wrap: wrap/)
  const row = read("../src/content/quiet/ToolsRow.tsx")
  assert.match(row, /while \(step < last && needed\(el\) > el\.clientWidth \+ 1\) setStep\(el, labels, \+\+step\)/)
  assert.match(row, /label\.toggleAttribute\("data-off", Number\(label\.dataset\.give\) < step\)/)
  // Every button keeps its name without its words.
  for (const name of ["qiInsertIntoField", "copy", "share", "tagsButton", "colAdd"]) assert.match(footer, new RegExp(`aria-label=\\{t\\("${name}"\\)\\}`), name)
})

test("4. no row with the page's title over the field; a selection, Ask your chats and an unreadable page keep theirs", () => {
  assert.match(app, /\{\(historyMode \|\| contextKind !== "page"\) && ctxRow\}/)
  assert.equal(app.match(/\{ctxRow\}/g), null)
})

test("5. the bars over the chat: one line each, cut with an ellipsis", () => {
  const styles = read("../src/content/styles.css")
  assert.match(styles, /\.cf-chat-bar-name \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/)
  assert.doesNotMatch(styles, /\.cf-chat-bar-name \{[^}]*line-clamp/)
  // The suggestions' and the pinned messages' bars: the one-line form always, not only when both show.
  assert.match(css, /\.cf-sugbar \.cf-sugbar-text, \.cf-pinbar \.cf-pinbar-text \{ flex-direction: row; align-items: baseline; gap: 7px; \}/)
  assert.match(read("../src/content/organize.css"), /\.cf-sugbar-line \{[^}]*overflow: hidden; white-space: nowrap; text-overflow: ellipsis; \}/)
  assert.match(read("../src/content/ux/ux.css"), /\.cf-pinbar-line \{[^}]*overflow: hidden; white-space: nowrap; text-overflow: ellipsis; \}/)
  // The full name is still there to read.
  assert.match(app, /<span class="cf-chat-bar-name" dir="auto" title=\{headerName\}>/)
})

test("6. «+» by the field: Note, the page snapshot, Whole chat, the answers left; Google and the swipe stay", () => {
  const composer = app.slice(app.indexOf('<footer class="cf-composer">'), app.indexOf("</footer>", app.indexOf('<footer class="cf-composer">')))
  // In the field's row: «+», Google, the field, the count (compact), send.
  const order = ['class={`cf-plus ${plusOpen ? "on" : ""}`}', 'class={`cf-mode ${googleMode ? "on" : ""}`}', "<textarea", "{compact && leftNow && !noteMode && (", 'class="cf-send-wrap" {...switchGestures}']
  let at = composer.indexOf('<div class={`cf-input')
  for (const part of order) {
    const next = composer.indexOf(part, at + 1)
    assert.ok(next > at, `${part} in the field's row`)
    at = next
  }
  // The menu's four.
  const plus = read("../src/content/quiet/Plus.tsx")
  const menuOrder = ['{t("selNote")}', '{t("shotSwitch")}', '{t("wholeChat")}', 'class="cf-plus-usage"']
  at = -1
  for (const part of menuOrder) {
    const next = plus.indexOf(part, at + 1)
    assert.ok(next > at, `${part} in «+»`)
    at = next
  }
  // Note is the swipe's own switch; the snapshot turns the note on with it; Whole chat is the footer's handler.
  assert.match(composer, /onNote=\{\(\) => \{[\s\S]{0,220}flipMode\(\)/)
  assert.match(composer, /setShotPref\(\{ \.\.\.shotPref, on \}\)[\s\S]{0,200}if \(on && !noteMode\) flipMode\(\)/)
  assert.equal(app.match(/setWholeChat\(/g)?.length, 2, "one handler for the switch in «+» and the one under the field")
  // Decision 7: no Templates and no Copied in «+».
  assert.doesNotMatch(plus.slice(plus.indexOf("export function PlusMenu")), /qiTemplates|qiCopied|Copied|Template/)
  // The line under the field is the roomy chat's only; Get Pro goes with the count into «+».
  assert.match(composer, /\{!compact && \(\s*<div class="cf-usage">/)
  assert.match(composer, /usage=\{usageLine\.full\}\s*after=\{getProLink\}/)
  assert.match(composer, /\{t\("wholeChat"\)\}\s*\{!memoryAllowed && <span class="cf-pro-badge">Pro<\/span>\}\s*<\/label>\}\s*\{getProLink\}/)
  for (const what of ["note", "shot", "whole", "tag", "collect"]) assert.ok((FEATURES.quiet.fields?.what as readonly string[]).includes(what), what)
})

test("6. the answers left stay in sight on Free and when few are left", () => {
  const badge = lib.leftBadge
  // Free: always, with the number left.
  assert.deepEqual(badge({ used: 1, limit: 5 }, "free", false), { left: 4, low: false })
  assert.deepEqual(badge({ used: 3, limit: 5 }, "free", false), { left: 2, low: true })
  assert.deepEqual(badge({ used: 5, limit: 5 }, "free", false), { left: 0, low: true })
  assert.deepEqual(badge({ used: 9, limit: 5 }, "free", false), { left: 0, low: true })
  // Own key without the key in use counts as Free does.
  assert.deepEqual(badge({ used: 0, limit: 5 }, "byok", false), { left: 5, low: false })
  // Pro and Ultra: only under a fifth of the week, or the last three.
  assert.equal(badge({ used: 100, limit: 375 }, "pro", false), null)
  assert.equal(badge({ used: 300, limit: 375 }, "pro", false), null)
  assert.deepEqual(badge({ used: 301, limit: 375 }, "pro", false), { left: 74, low: true })
  assert.deepEqual(badge({ used: 373, limit: 375 }, "ultra", false), { left: 2, low: true })
  // Their own key in use, or nothing known yet: no count.
  assert.equal(badge({ used: 4, limit: 5 }, "free", true), null)
  assert.equal(badge(null, "free", false), null)
  assert.equal(badge({ used: 0, limit: 0 }, "pro", false), null)
  // In the field's row, opening «+» where it stands in full.
  assert.match(app, /<button type="button" class=\{`cf-left \$\{leftNow\.low \? "low" : ""\}`\} aria-label=\{usageLine\.full\} title=\{usageLine\.full\} onClick=\{\(\) => setPlusOpen\(true\)\}>\{leftNow\.left\}<\/button>/)
})

test("right to left: «+» and Google start inside the field's edge", () => {
  assert.match(css, /:host\(\[dir="rtl"\]\) \.cf-input \{ padding: 5px 13px 5px 5px; \}/)
  assert.match(css, /:host\(\[dir="rtl"\]\) \.cf-plus-switch input:checked \+ \.cf-switch::after \{ transform: translateX\(-10px\); \}/)
  // Nothing in the quiet chat's own rules is tied to a side: its offsets are logical (inline-start, margin-inline).
  // (The chips' fade and arrows are placed by which edge the hidden chips are behind, whatever the direction.)
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:host\(\[dir="rtl"\]\)[^}]*\}/g, "").replace(/^\.cf-chips[^\n]*$/gm, "")
  assert.doesNotMatch(rules, /margin-(left|right)|padding-(left|right)|[^-](left|right): /)
})

test("8. the header's menu and the chats' menu are as they were", () => {
  // Nothing of the quiet panel's in them.
  for (const file of ["../src/content/ux/PageMenu.tsx", "../src/content/Threads.tsx"]) assert.doesNotMatch(read(file), /quiet|compact|density/i, file)
})

test("the texts that point at what moved, in every language", () => {
  const en = JSON.parse(read("../src/locales/en.json"))
  for (const lang of LANGS) {
    const m = JSON.parse(read(`../src/locales/${lang}.json`))
    for (const key of ["plusButton", "tourWholeBodyPlus", "tourSelectBody", "tourNoteBodyTouch", "tourNoteBodyMouse"]) {
      assert.ok(typeof m[key] === "string" && m[key].length > 3, `${lang} ${key}`)
      if (lang !== "en") assert.notEqual(m[key], en[key], `${lang} ${key} is translated`)
    }
    // The tour's steps say where Whole chat and Note are now: «+» is named.
    for (const key of ["tourWholeBodyPlus", "tourNoteBodyTouch", "tourNoteBodyMouse"]) assert.match(m[key], /[+＋]/, `${lang} ${key}`)
    // The note's name in the step is the menu's own.
    assert.ok(m.tourNoteBodyTouch.includes(m.selNote), `${lang}: the step names Note as «+» does`)
    // Whole chat's step on the compact chat is the old one with where to find it.
    assert.ok(m.tourWholeBodyPlus.endsWith(m.tourWholeBody), lang)
  }
  const tour = read("../src/content/Tour.tsx")
  assert.match(tour, /targets: \[\[compact \? "\.cf-plus" : "\.cf-whole"\]\], icon: <Icon\.Doc \/>, title: "tourWholeTitle", body: compact \? "tourWholeBodyPlus" : "tourWholeBody"/)
  assert.match(app, /steps=\{tourSteps\(TARGET === "safari" && settings\.syncChats, touch, compact\)\}/)
})

test("the app's Tips name the new places, in the catalog's 14 languages", () => {
  const swift = read("../ContextFlow/Shared (App)/ContentView.swift")
  const catalog = JSON.parse(read("../ContextFlow/Shared (App)/Localizable.xcstrings")).strings
  const tips = [
    "Swipe the send button up or down (on a Mac, scroll on it) to write a note instead of asking, or tap + by the field and choose Note. It stays in the chat with its page, syncs with it and uses no answers.",
    "Turn on Whole chat under + by the question field when an answer needs everything: all messages, your notes and the other pages of this chat. Off, answers use the last messages and the open page.",
    "Planning a trip or a purchase? Choose To collection under an answer or a note, or in its … menu, and ContextFlow suggests where it goes. Collections keeps it all in sections, in Safari and in the app. With Pro, the AI sorts the cards, Compare puts the ones you pick side by side, and Summary sums it all up. Any collection saves as a PDF.",
    "Tag a chat, an answer or a note with 🏷, or with Tag in its … menu. Tap a tag to see only its chats, or turn on Folders to group the list by tag."
  ]
  for (const text of tips) {
    assert.ok(swift.includes(`"${text}"`), text.slice(0, 40))
    const langs = Object.keys(catalog[text]?.localizations ?? {})
    assert.equal(langs.length, 14, text.slice(0, 40))
    for (const lang of langs) {
      const value = catalog[text].localizations[lang].stringUnit.value as string
      assert.ok(value.length > 20 && value !== text, `${lang}: ${text.slice(0, 30)}`)
      assert.match(value, /[+＋…]/, `${lang} names «+» or «…»: ${text.slice(0, 30)}`)
    }
  }
  // The old texts are gone from both.
  assert.ok(!swift.includes("Turn on Whole chat under the question field when") && !("Turn on Whole chat under the question field when an answer needs everything: all messages, your notes and the other pages of this chat. Off, answers use the last messages and the open page." in catalog))
})
