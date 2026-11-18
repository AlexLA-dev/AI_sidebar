// 2.7 after build 107, the owner's notes G1 and H: «чипы быстрых действий в сайдбаре меняются после открытия сайдбара +
// как-то странно не всегда в тему. например в Gmail не было чипов типо переписать и т.п. (при открытом черновике ответа),
// при этом в том же LinkedIn с чатом было». One ranker (src/content/quiet/chips.ts) orders the chips from what the page
// is; its signals are the page hints', the translate pill's and quick insert's; the order is read as the panel opens
// and kept until it opens again.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { FEATURES } from "../src/shared/usage.ts"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-quiet-chips-"))
  const src = new URL("../src/content/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${src}quiet/chips.ts"\nexport { pageKind } from "${src}pagehints/detect.ts"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const ALL = { write: true, translatePage: true, watch: true, similar: true }
const page = (over: Record<string, unknown> = {}) => ({ field: "none", foreign: false, kind: null, media: "page", ...over })
const rank = (over: Record<string, unknown> = {}, can = ALL) => lib.rankChips(page(over), can) as string[]
const fixture = (name: string) => parseHTML(read(`../tools/preview/${name}`)).document as unknown as Document

test("a field with text: Check, Rewrite, Templates lead; an empty one: Templates", () => {
  assert.deepEqual(rank({ field: "text" }).slice(0, 3), ["check", "rewrite", "templates"])
  assert.deepEqual(rank({ field: "empty" }).slice(0, 2), ["templates", "summarize"])
  assert.ok(!rank({ field: "empty" }).includes("check") && !rank({ field: "empty" }).includes("rewrite"), "nothing to check in an empty field")
  // No field: none of the three.
  for (const id of ["check", "rewrite", "templates"]) assert.ok(!rank().includes(id))
})

test("main text in another language: Translate page first; a product: Find similar, Watch the price; an article: Summarize, Key takeaways", () => {
  assert.equal(rank({ foreign: true })[0], "translate_page")
  assert.deepEqual(rank({ kind: "product" }).slice(0, 2), ["similar", "watch"])
  assert.deepEqual(rank({ kind: "article" }).slice(0, 2), ["summarize", "key_points"])
  // A page in another language that is a product: its translation, then the product's.
  assert.deepEqual(rank({ foreign: true, kind: "product" }).slice(0, 3), ["translate_page", "similar", "watch"])
  // A little foreign text (menus, buttons) is no offer: the chip isn't there at all.
  assert.ok(!rank({ kind: "article" }).includes("translate_page"))
  // Watch the price belongs to a product; elsewhere watching stays in the header's menu.
  assert.ok(!rank({ kind: "article" }).includes("watch"))
})

test("a video or a PDF: its summaries first, whatever else the page is", () => {
  assert.deepEqual(rank({ media: "video", kind: "video" }).slice(0, 2), ["summarize", "key_points"])
  assert.deepEqual(rank({ media: "pdf", kind: "product", foreign: true }).slice(0, 2), ["summarize", "key_points"])
  assert.ok(!rank({ media: "pdf", foreign: true }).includes("translate_page"), "a PDF isn't translated in place")
})

test("someone writing comes before the page's language, and both before its kind", () => {
  assert.deepEqual(rank({ field: "text", foreign: true, kind: "product" }).slice(0, 6), ["check", "rewrite", "templates", "translate_page", "similar", "watch"])
})

test("every chip once, and the old ones are all still there", () => {
  for (const s of [page(), page({ field: "text", foreign: true, kind: "product" }), page({ kind: "article" }), page({ media: "video" })]) {
    const got = lib.rankChips(s, ALL) as string[]
    assert.equal(new Set(got).size, got.length)
    for (const id of lib.BASE_ORDER) assert.ok(got.includes(id), `${id} is still offered`)
  }
  // A plain page in another language: as it was before the ranker (with Translate page ahead of it).
  assert.deepEqual(rank({ foreign: true }), ["translate_page", ...lib.BASE_ORDER])
})

test("«Translate» is last on a page in the person's own language, also under an answer", () => {
  // An English article for an English reader had it third among the chips under the answer.
  assert.deepEqual(rank(), ["summarize", "key_points", "explain", "google", "similar", "translate"])
  assert.deepEqual(rank({ kind: "article" }), ["summarize", "key_points", "explain", "google", "similar", "translate"])
  assert.equal(rank({ kind: "product" }).at(-1), "translate")
  assert.equal(rank({ field: "text" }).at(-1), "translate")
  // A page in another language keeps it where it was, after Translate page.
  const foreign = rank({ foreign: true, kind: "article" })
  assert.ok(foreign.indexOf("translate") < foreign.indexOf("google"))
  // The chips under an answer are the same ranked list, less what was already asked about this page.
  const app = read("../src/content/App.tsx")
  assert.match(app, /\{actions\.filter\(\(a\) => !messages\.some\(\(m\) => m\.label === actionLabel\(a\) && m\.page\?\.url === pageUrl\)\)\.map\(\(a\) => chip\(a, true\)\)\}/)
  assert.match(app, /<div class="cf-newpage">[\s\S]{0,260}\{actions\.map\(\(a\) => chip\(a, true\)\)\}/)
})

test("what can't run here isn't shown", () => {
  const none = { write: false, translatePage: false, watch: false, similar: true }
  assert.deepEqual(rank({ field: "text", foreign: true, kind: "product" }, none), ["similar", "summarize", "key_points", "explain", "translate", "google"])
})

test("the same page ranks the same: nothing to swap after the panel has opened", () => {
  const s = page({ field: "text", foreign: true, kind: "article" })
  assert.deepEqual(lib.rankChips(s, ALL), lib.rankChips({ ...s }, ALL))
  const app = read("../src/content/App.tsx")
  // Read in show(), before the panel is set open; never from an effect that follows the page.
  const show = app.slice(app.indexOf("const show = useCallback("), app.indexOf("const hide = useCallback("))
  assert.ok(show.indexOf("setChipOrder(chipsNowRef.current())") > 0 && show.indexOf("setChipOrder(chipsNowRef.current())") < show.indexOf("setOpen(true)"))
  assert.equal(app.match(/setChipOrder\(/g)?.length, 1, "the order is set in one place")
  assert.match(app, /contextKind === "page" \? chipOrder\.map\(\(id\) => PAGE_CHIPS\[id\]\) : \[\]/)
})

test("Gmail with a reply draft open (the owner's case): the writing chips lead, as in a chat's box", () => {
  // The cause: the writing chips existed only for selected text ("Improve writing", "Draft a reply"), so a draft with
  // the caret in it and nothing selected got the page's chips. The field itself is the signal now.
  const mail = fixture("mail-reply.html")
  // No layout in the test's DOM: the reply box gets the size it has on screen.
  Object.defineProperty(mail.querySelector("#body")!, "getBoundingClientRect", { value: () => ({ width: 716, height: 180 }) })
  const kind = lib.pageKind(mail, "https://mail.google.com/mail/u/0/#inbox/abc")
  assert.equal(kind, "form")
  const draft = mail.querySelector("#body")!.textContent ?? ""
  // The draft in use (quick insert's field), with text in it.
  assert.deepEqual(rank({ field: lib.fieldState({ usable: true, text: draft }, kind), kind }).slice(0, 3), ["check", "rewrite", "templates"])
  // Opened but not touched yet (no field of quick insert's): Templates lead.
  assert.equal(rank({ field: lib.fieldState(null, kind), kind })[0], "templates")
  // A chat's box (LinkedIn's messages) with a few words typed: the same.
  const chat = fixture("messaging.html")
  assert.deepEqual(rank({ field: lib.fieldState({ usable: true, text: "Thanks, see you on Friday" }, lib.pageKind(chat, "https://www.linkedin.com/messaging/")) }).slice(0, 2), ["check", "rewrite"])
  // A search box, a password: not a field to write in.
  assert.equal(lib.fieldState({ usable: false, text: "two words" }, null), "none")
  // Any script: a few characters of Chinese are text to check; one Latin word isn't yet.
  assert.equal(lib.fieldState({ usable: true, text: "明天上午十点见面" }, null), "text")
  assert.equal(lib.fieldState({ usable: true, text: "Hi" }, null), "empty")
  assert.equal(lib.fieldState({ usable: true, text: "مرحبا بك في الاجتماع" }, null), "text")
})

test("text selected in the person's own draft: improving it and replying lead; elsewhere the order stays", () => {
  const sel = ["sel_explain", "sel_summarize", "sel_translate", "sel_google", "sel_improve", "sel_reply", "sel_similar"].map((id) => ({ id }))
  assert.deepEqual(lib.rankSelectionChips(sel, false), sel)
  assert.deepEqual(lib.rankSelectionChips(sel, true).map((a: { id: string }) => a.id), ["sel_improve", "sel_reply", "sel_explain", "sel_summarize", "sel_translate", "sel_google", "sel_similar"])
})

test("the signals are the ones already worked out: the hints' kind, the pill's offer, quick insert's field", () => {
  const signals = read("../src/content/quiet/signals.ts")
  assert.match(signals, /import \{ pageKind, type PageKind \} from "\.\.\/pagehints\/detect"/)
  assert.match(signals, /import \{ pageForeignOffer, pageTranslatedNow \} from "\.\.\/translate\/TranslatePill"/)
  assert.match(signals, /import \{ rememberedField \} from "\.\.\/insert\/target"/)
  assert.match(signals, /import \{ writableField \} from "\.\.\/insert\/Write"/)
  // The pill keeps what it found where it's hidden on a site too, and starts the translation for the chip.
  const pill = read("../src/content/translate/TranslatePill.tsx")
  assert.match(pill, /foundNow = found\.offer\n/)
  assert.match(pill, /export function translatePageNow\(\): boolean \{\s*if \(!foundNow \|\| !starter\) return false/)
})

test("the chips that act on the page run what's already there; each tap is counted", () => {
  const app = read("../src/content/App.tsx")
  const run = app.slice(app.indexOf("const runAction = useCallback("), app.indexOf("runActionRef.current = runAction"))
  assert.match(run, /bus\.dispatchEvent\(new CustomEvent\(QI_EVENTS\.write, \{ detail: picked\.id \}\)\)/)
  assert.match(run, /if \(picked\.id === "templates"\) return setView\("templates"\)/)
  assert.match(run, /translatePageNow\(\)/)
  assert.match(run, /pageWatcher\(\)\?\.\(\{ url: source\.href\(\), title: source\.title\(\) \}\)/)
  assert.match(run, /f: "quiet", a: "chip", what: picked\.id/)
  const qi = read("../src/content/insert/QuickInsert.tsx")
  assert.match(qi, /startWriteRef\.current\(\(e as CustomEvent<WriteAction>\)\.detail, undefined, "panel"\)/)
  assert.ok(FEATURES.write.via?.includes("panel"))
  const what = FEATURES.quiet.fields?.what as readonly string[]
  for (const id of ["check", "rewrite", "templates", "translate_page", "watch", ...lib.BASE_ORDER]) assert.ok(what.includes(id), id)
  // Find similar keeps its plan colour (#199 owns it: blue on Pro): the chip is drawn by the same function as before.
  assert.match(app, /class=\{`cf-chip \$\{similarTone\(plan\)\}\$\{small \? " small" : ""\}`\} data-action=\{a\.id\}/)
})

test("the new chips' names in all 15 languages", () => {
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const m = JSON.parse(read(`../src/locales/${lang}.json`))
    for (const key of ["chipTranslatePage", "chipWatchPrice", "writeCheck", "writeRewrite", "qiTemplates"]) assert.ok(typeof m[key] === "string" && m[key].length > 1, `${lang} ${key}`)
    if (lang !== "en") assert.notEqual(m.chipTranslatePage, "Translate page", lang)
  }
})

test("which edges of the row have chips behind them", () => {
  const box = { left: 0, right: 393 }
  assert.equal(lib.moreAt(box, []), "")
  assert.equal(lib.moreAt(box, [{ left: 14, right: 120 }, { left: 128, right: 300 }]), "", "the row fits: no fade, no arrow")
  assert.equal(lib.moreAt(box, [{ left: 14, right: 120 }, { left: 128, right: 520 }]), "right")
  assert.equal(lib.moreAt(box, [{ left: -200, right: -60 }, { left: -52, right: 379 }]), "left")
  assert.equal(lib.moreAt(box, [{ left: -90, right: 60 }, { left: 68, right: 480 }]), "both")
  // Right to left the row starts at the right: more is to the left.
  assert.equal(lib.moreAt(box, [{ left: 250, right: 379 }, { left: -120, right: 242 }]), "left")
})
