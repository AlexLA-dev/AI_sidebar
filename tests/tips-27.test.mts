// 2.7, the owner: «нужно не забыть включить новые функции … в онбординг с Tips в расширении и приложении». Each 2.7
// feature gets a card in Tips (the app's, which the panel's Tips sheet and context-flow.app/features mirror), What's new
// shows the five everyone has, and the panel says once what 2.7 brought to people who had ContextFlow before. Tips point
// to the page hints by ✦ and the hints point back to Tips. Every language.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

// @ts-expect-error: a plain .mjs module (the build's own)
import { CATALOG_LANG, tipsData } from "../scripts/tips-source.mjs"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const content = read("ContextFlow/Shared (App)/ContentView.swift")
const whatsNew = read("ContextFlow/Shared (App)/WhatsNew.swift")
const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
const data = tipsData(root)
const cards = data.groups.flatMap((g: any) => g.tips.map((t: any) => ({ ...t, block: g.id })))
const card = (title: string) => cards.find((t: any) => t.title.en === title)

const NEW = {
  "Read a page in your language": "get-started",
  "A snapshot with your note": "deeper-work",
  "Check or rewrite before you send": "quick-insert",
  "Mistakes underlined as you type": "quick-insert",
  "Add to Calendar or Reminders": "watch-and-remind",
  "Spaces for work and home": "chats-in-order",
  "The chat for this page": "chats-in-order",
  "Tips by the ✦ button": "privacy-and-personalization",
  // #181, merged into 2.7: the code and the link in Settings.
  "Invite a friend": "your-plan",
  // Collections (#175, #182): a card of its own, after the chat for this page.
  "Gather it in a collection": "chats-in-order"
} as const

test("each 2.7 feature has its card in the block its readers look in, with the plan it needs and no prices", () => {
  for (const [title, block] of Object.entries(NEW)) assert.equal(card(title)?.block, block, title)
  // Next to what they grow from.
  const order = (block: string) => data.groups.find((g: any) => g.id === block).tips.map((t: any) => t.title.en)
  assert.deepEqual(order("get-started").slice(1, 4), ["Move ✦ out of the way", "One tap for the gist", "Read a page in your language"])
  assert.deepEqual(order("quick-insert").slice(0, 3), ["Insert into any field", "Check or rewrite before you send", "Mistakes underlined as you type"])
  assert.deepEqual(order("watch-and-remind"), ["Remind me about this page", "Add to Calendar or Reminders", "Know when a price drops"])
  assert.deepEqual(order("chats-in-order").slice(0, 3), ["Start fresh or go back", "Spaces for work and home", "The chat for this page"])
  assert.deepEqual(order("deeper-work").slice(0, 2), ["Notes of your own", "A snapshot with your note"])
  // Plans: the underlines are Pro and Ultra's; Find similar starts at Pro (Pro's quick search, #167), Ultra's in full.
  assert.ok(card("Mistakes underlined as you type").pro && !card("Mistakes underlined as you type").ultra)
  assert.ok(card("Find similar").pro && !card("Find similar").ultra)
  assert.match(card("Find similar").text.en, /Ultra searches in full[\s\S]*Pro has a quick search, up to 5 a week, each one counting as 10 answers\./)
  for (const title of Object.keys(NEW)) if (title !== "Mistakes underlined as you type") assert.ok(!card(title).pro && !card(title).ultra, title)
  // Whole page with Pro, said in the snapshot's card; Spaces never names Free's number (not settled).
  assert.match(card("A snapshot with your note").text.en, /or with Pro the whole page/)
  assert.match(card("Spaces for work and home").text.en, /Free has a limit; with Pro or Ultra, as many as you like\.$/)
  // The invite: where it is, what each side gets, no figures (the invite screens name them).
  assert.match(card("Invite a friend").text.en, /^Settings → Invite a friend, in the app or in Safari,[\s\S]*bonus answers[\s\S]*a discount on your first month of Pro or Ultra\.$/)
  assert.doesNotMatch(card("Invite a friend").text.en, /\d/)
  // A tap on iPhone and iPad, a click or a pointer on a Mac.
  for (const title of ["Read a page in your language", "Check or rewrite before you send", "Mistakes underlined as you type", "A snapshot with your note", "Move ✦ out of the way"]) {
    assert.ok(card(title).mac, `${title}: a Mac's own words`)
    assert.doesNotMatch(card(title).mac.text.en, /\btap\b/i, title)
  }
  // No prices anywhere in them.
  const texts = Object.keys(NEW).concat("Find similar", "Move ✦ out of the way").flatMap((title) => [card(title).text.en, card(title).mac?.text.en ?? ""])
  for (const text of texts) assert.doesNotMatch(text, /[$€£¥₽]|\d+[.,]\d\d|per month|a month|\/mo\b/i, text.slice(0, 40))
  // The side's card says the panel moves too, and keeps its clip on a Mac.
  assert.match(card("Move ✦ out of the way").text.en, /On iPad, drag the panel by its top bar/)
  assert.equal(card("Move ✦ out of the way").mac.clip, "side")
  // Tips point to the hints: the card names their setting as the panel names it.
  const en = JSON.parse(read("src/locales/en.json"))
  assert.ok(card("Tips by the ✦ button").text.en.endsWith(`under ${en.setPageHints}.`))
})

test("the cards name the panel's own buttons, as the panel says them", () => {
  const en = JSON.parse(read("src/locales/en.json"))
  const say = (title: string) => card(title).text.en
  assert.ok(say("Read a page in your language").includes(en.trOriginal))
  assert.ok(say("Check or rewrite before you send").includes(`${en.writeCheck} and ${en.writeRewrite}`))
  for (const tone of [en.writeToneShort, en.writeToneWarm, en.writeToneFormal, en.writeToneConfident]) assert.ok(say("Check or rewrite before you send").includes(tone.toLowerCase()), tone)
  assert.ok(say("Mistakes underlined as you type").includes(`${en.writeFix} or ${en.writeSkip}`))
  assert.ok(say("A snapshot with your note").includes(en.shotSwitch))
  assert.ok(say("Add to Calendar or Reminders").includes(en.appleMenu) && say("Add to Calendar or Reminders").includes(en.appleAlso))
  assert.ok(say("Spaces for work and home").includes(en.spaceNew) && say("Spaces for work and home").includes(en.spaceBind.replace("{0}", "amazon.com")))
  assert.ok(say("The chat for this page").includes(en.matchContinue) && say("The chat for this page").includes(en.newChat))
  assert.ok(say("Move ✦ out of the way").includes(en.setSide))
})

test("What's new 2.7: the five everyone has, as Tips shows them; clips wherever they exist", () => {
  assert.match(whatsNew, /static let version = "2\.7"/)
  assert.match(whatsNew, /\[TipGroup\.translateTip, TipGroup\.writeTip, TipGroup\.spacesTip, TipGroup\.appleTip, TipGroup\.shotTip\]/)
  // Shared with Tips, so not private there.
  for (const name of ["translateTip", "writeTip", "spacesTip", "appleTip", "shotTip"]) assert.match(content, new RegExp(`\\n    static var ${name}: Tip \\{`), name)
  // "Each shown in a short clip" only when every card has one (2.7's are made: tips.test checks every card's clip).
  assert.match(whatsNew, /items\.allSatisfy \{ tip in tip\.clip\.flatMap\(TipClip\.url\) != nil \}/)
  assert.match(whatsNew, /Text\(WhatsNew\.allClips \? LocalizedStringKey\("The main things this version brings, each shown in a short clip\."\) : LocalizedStringKey\("The main things this version brings\."\)\)/)
  for (const key of ["The main things this version brings.", "The main things this version brings, each shown in a short clip."]) {
    assert.equal(Object.keys(catalog[key]?.localizations ?? {}).length, 14, key)
  }
})

test("the panel: what 2.7 brought, once, for people who had ContextFlow before; hints and Tips point to each other", () => {
  const app = read("src/content/App.tsx")
  const bg = read("src/background/index.ts")
  // A new install has the tour: the card is marked seen at install.
  assert.match(bg, /if \(details\.reason === "install"\) \{\s*void installId\(\)\s*\/\/[^\n]*\n\s*void markNewSeen\(\)/)
  assert.match(bg, /if \(!list\.includes\("new27"\)\) await chrome\.storage\.local\.set\(\{ \[STORAGE\.hintsSeen\]: \[\.\.\.list, "new27"\] \}\)/)
  // One hint at a time: not with a page hint's how-to or the video's or PDF's; it says the side too, so the side's own
  // hint isn't shown after it.
  assert.match(app, /!pageHints\.chat && !inviteNew && hintDue\("new27"\) && !\(contextKind === "page" && source\.kind\(\) !== "page" && hintDue\(source\.kind\(\) as HintKey\)\)/)
  assert.match(app, /list=\{\[t\("hintNewTranslate"\), t\("hintNewWrite"\), t\("hintNewSpaces"\), t\("hintNewApple"\), t\("hintNewShot"\), t\("hintNewSide"\)\]\}/)
  assert.match(app, /onDone=\{\(\) => doneHint\(\["new27", "side"\]\)\}/)
  assert.match(app, /hintDue\("side"\) && !hintDue\("new27"\)/)
  // All tips opens the Tips sheet, from this card and from a page hint's how-to.
  assert.match(app, /const allTips = tipsLabel\(\) \? \{ label: t\("hintAllTips"\), run: \(\) => setTipsOpen\(true\) \} : undefined/)
  assert.equal((app.match(/action=\{allTips\}/g) ?? []).length, 2)
  // Several hints marked in one write (two at once would each keep only their own).
  // (2.7 (110): the list is put together by hintsWith; tests/first-run-110.test.mts runs it.)
  assert.match(read("src/content/store.ts"), /const all = hintsWith\(stored, \[\.\.\.\(first \?\? \[\]\), \.\.\.add\]\) \?\? stored/)
})

// ------------------------------------------------------------ the hint card, rendered

let ui: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element })
  Object.assign(globalThis, { chrome: { i18n: { getMessage: (key: string) => (key === "hintGot" ? "Got it" : "") } } })
  const dir = mkdtempSync(join(tmpdir(), "cf-hint27-"))
  const src = JSON.stringify(new URL("../src/content/Hint.tsx", import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { Hint } from ${src}
    export function show(container: Element, props: any) {
      render(h(Hint, { icon: h("i", null), ...props }), container)
    }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [join(root, "node_modules")], mainFields: ["module", "main"]
  })
  ui = await import(pathToFileURL(out).href)
})

test("the hint card: its lines and its way on, or a plain line as before", () => {
  const box = dom.document.getElementById("root")
  let tipsOpened = 0
  let done = 0
  ui.show(box, { title: "New in ContextFlow 2.7", list: ["One", "Two"], action: { label: "All tips", run: () => tipsOpened++ }, onDone: () => done++ })
  assert.deepEqual([...box.querySelectorAll(".cf-hint-list li")].map((li: any) => li.textContent), ["One", "Two"])
  assert.equal(box.querySelector(".cf-hint-text p"), null)
  box.querySelector(".cf-hint-more").dispatchEvent(new dom.window.Event("click"))
  box.querySelector(".cf-hint-done").dispatchEvent(new dom.window.Event("click"))
  assert.deepEqual([tipsOpened, done], [1, 1])
  ui.show(box, { title: "Side", children: "Drag it.", onDone: () => undefined })
  assert.equal(box.querySelector(".cf-hint-text p").textContent, "Drag it.")
  assert.equal(box.querySelector(".cf-hint-more"), null)
  assert.equal(box.querySelector(".cf-hint-done").textContent, "Got it")
})

// ------------------------------------------------------------ every language

test("every language: the panel's lines, the app's new texts and the site's cards", () => {
  const en = JSON.parse(read("src/locales/en.json"))
  const keys = ["hintNewTitle", "hintNewTranslate", "hintNewWrite", "hintNewSpaces", "hintNewApple", "hintNewShot", "hintNewSide", "hintAllTips"]
  const files = readdirSync(join(root, "src/locales")).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 15)
  for (const file of files) {
    const own = JSON.parse(read(`src/locales/${file}`))
    for (const key of keys) {
      assert.ok(typeof own[key] === "string" && own[key].trim(), `${file}: ${key}`)
      if (file !== "en.json" && key !== "hintNewTitle") assert.notEqual(own[key], en[key], `${file}: ${key} translated`)
    }
    // ✦ stays ✦, 2.7 stays 2.7.
    assert.match(own.hintNewTitle, /2\.7/, file)
    assert.match(own.hintNewSide, /✦/, file)
  }
  // The app: every new card's words in every language (tips.test checks all of Tips the same way).
  const appTexts = Object.keys(NEW).concat("Find similar").flatMap((title) => [card(title).title.en, card(title).text.en, card(title).mac?.text.en].filter(Boolean))
  appTexts.push(card("Move ✦ out of the way").text.en, card("Move ✦ out of the way").mac.text.en)
  for (const text of appTexts) {
    for (const code of Object.values(CATALOG_LANG) as string[]) {
      const value = catalog[text]?.localizations?.[code]?.stringUnit?.value
      assert.ok(value && catalog[text].localizations[code].stringUnit.state === "translated", `${code}: ${text.slice(0, 40)}`)
    }
  }
  // The site: every language's /features has the same sections, cards and badges as the English one.
  const shape = (html: string) => [...html.matchAll(/<section id="([a-z-]+)">([\s\S]*?)<\/section>/g)]
    .map((m) => `${m[1]}:` + [...m[2].matchAll(/<article class="feat">(.*?)<\/article>/g)].map((a) => (a[1].includes("pro-badge") ? "P" : a[1].includes("ultra-badge") ? "U" : "-") + (/data-src="\/clips\/([\w-]+)/.exec(a[1])?.[1] ?? "")).join(","))
  const english = read("site/features.html")
  // As many cards as the app's Tips (tips.test checks the English page card by card).
  assert.equal(shape(english).reduce((n, sec) => n + sec.split(":")[1].split(",").length, 0), cards.length)
  for (const folder of ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-br", "ru", "uk", "vi", "zh-hans", "zh-hant"]) {
    const page = read(`site/${folder}/features.html`)
    assert.deepEqual(shape(page), shape(english), folder)
    // The new cards are in the page's language.
    for (const title of Object.keys(NEW)) assert.ok(!page.includes(`<h3>${title}`), `${folder}: ${title}`)
  }
})
