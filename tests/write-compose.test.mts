// 2.7 (108), W2: a field with nothing written in it gets Compose instead of Rewrite (the owner: «Compose нужно
// показывать, когда окно для текста пустое, вместо Rewrite»); the person says what to write, a tone if they like, and
// the draft goes into the field (above Gmail's signature).
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

import { draftSpot, placedDraft, waitsFor } from "../src/content/insert/compose.ts"
import { clipAsk, writeDeadline, WRITE_LIMITS } from "../src/shared/writing.ts"

// The chips' ranker imports without extensions: bundled first, as tests/quiet-chips.test.mts does.
let fieldState: (field: { usable: boolean; text: string } | null, kind: null) => "none" | "blank" | "empty" | "text"
let rankChips: (s: Record<string, unknown>, can: Record<string, boolean>) => string[]
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-compose-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${new URL("../src/content/quiet/chips.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  ;({ fieldState, rankChips } = await import(pathToFileURL(out).href))
})

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("the card waits for Compose's words, and for a tone when a rewrite comes without one (the panel's chip)", () => {
  assert.equal(waitsFor({ action: "compose" }), "ask")
  assert.equal(waitsFor({ action: "compose", request: "say yes to Thursday" }), null)
  assert.equal(waitsFor({ action: "compose", tone: "warm", request: "say yes" }), null)
  assert.equal(waitsFor({ action: "rewrite" }), "tones")
  assert.equal(waitsFor({ action: "rewrite", tone: "short" }), null)
  assert.equal(waitsFor({ action: "check" }), null)
})

test("the draft goes at the caret, never inside the signature; on its own line next to words", () => {
  // Gmail's empty reply: two lines, then the signature (skipped).
  const gmail = { text: "\n\n-- \nAlex", skips: [{ from: 2, to: 10 }] }
  assert.equal(draftSpot(gmail, 0), 0)
  assert.equal(draftSpot(gmail, 6), 0, "a caret inside the signature: the draft goes at the top of the reply")
  assert.equal(draftSpot(gmail, null), 0, "no caret: the reply's first line, its blank line before the signature kept")
  // A quoted mail on top, the reply under it.
  assert.equal(draftSpot({ text: "> earlier\n\n", skips: [{ from: 0, to: 10 }] }, null), 10)
  assert.equal(draftSpot({ text: "", skips: [] }, null), 0)
  assert.equal(draftSpot({ text: "", skips: [] }, 0), 0)
  assert.equal(placedDraft("", 0, "  Thanks, Thursday works.  "), "Thanks, Thursday works.")
  assert.equal(placedDraft(gmail.text, 0, "Thanks!"), "Thanks!", "the blank lines before the signature stay")
  assert.equal(placedDraft("Hi Anna,", 8, "Thursday works."), "\nThursday works.")
  assert.equal(placedDraft("-- \nAlex", 0, "Thanks!"), "Thanks!\n")
})

test("an empty field's chips: Compose and Templates; a word or two: Templates; text: Check and Rewrite", () => {
  const can = { write: true, translatePage: true, watch: true, similar: true }
  const rank = (field: string) => rankChips({ field, foreign: false, kind: null, media: "page" }, can)
  assert.equal(fieldState({ usable: true, text: "" }, null), "blank")
  assert.equal(fieldState({ usable: true, text: " \n " }, null), "blank")
  assert.equal(fieldState({ usable: true, text: "Hi" }, null), "empty")
  assert.deepEqual(rank("blank").slice(0, 2), ["compose", "templates"])
  assert.ok(!rank("empty").includes("compose"))
  assert.ok(!rank("text").includes("compose"))
  assert.ok(!rank("none").includes("compose"))
  assert.ok(!rankChips({ field: "blank", foreign: false, kind: null, media: "page" }, { ...can, write: false }).includes("compose"))
  // The panel's field is read without the signature (an empty Gmail reply is blank).
  assert.match(read("../src/content/quiet/signals.ts"), /text: draftText\(f\.el\)/)
})

test("Compose's request is clipped to its own limit and keeps its tone; its deadline fits a whole draft", () => {
  const ask = { action: "compose" as const, tone: "warm" as const, text: "x".repeat(3000), page: { title: "", url: "", text: "", conversation: false }, field: "", style: { samples: [], templates: [] } }
  const clipped = clipAsk(ask)
  assert.equal(clipped.text.length, WRITE_LIMITS.instruction)
  assert.equal(clipped.tone, "warm")
  assert.equal(clipAsk({ ...ask, action: "check" }).tone, undefined)
  assert.ok(writeDeadline("compose", 20) >= 20_000)
})

test("the list's row, the Mac's circle and the panel's chip all open the same card; the field keeps its text until Insert", () => {
  const write = read("../src/content/insert/Write.tsx")
  assert.match(write, /if \(empty\) \{[\s\S]{0,400}onPick\("compose"\)/, "an empty field's menu is Compose alone")
  assert.match(write, /if \(!open\) setBlank\(fixes === 0 && empty\(\)\)/, "the circle reads the field as its menu opens")
  assert.match(write, /\[\{ from: state\.at, to: state\.at, text: placedDraft\(state\.base, state\.at, state\.next\) \}\]/)
  assert.match(write, /if \(state\.step === "ask" && !p\.touch\) box\.current\?\.focus/, "on touch the person taps the box (iOS raises the keyboard only then)")
  // The caret the field had when Compose opened decides where the draft goes (the box has the focus since).
  assert.match(write, /const field = compose \? p\.field : updateCaret\(p\.field\)/)
  // The box takes taps (the rest of the card keeps the field's focus) and its keys stay ours.
  assert.match(write, /onPointerDown=\{\(e\) => !\(e\.target as Element\)\.closest\("textarea"\) && e\.preventDefault\(\)\}/)
  const app = read("../src/content/App.tsx")
  assert.match(app, /picked\.id === "check" \|\| picked\.id === "rewrite" \|\| picked\.id === "compose"/)
  const quick = read("../src/content/insert/QuickInsert.tsx")
  assert.match(quick, /writeEmpty=\{blankField\(fieldRef\.current\)\}/)
  assert.match(quick, /action === "compose" \? "writeInserted"/)
})

test("Compose's strings are in all 15 languages", () => {
  const keys = ["writeCompose", "writeComposeGo", "writeComposing", "writeComposeHint", "writeComposeEdit", "writeToneAsk", "writeInserted"]
  for (const lang of ["en", "ru", "uk", "de", "fr", "es", "it", "pt_BR", "ja", "ko", "zh_CN", "zh_TW", "ar", "vi", "tr"]) {
    const strings = JSON.parse(read(`../src/locales/${lang}.json`)) as Record<string, string>
    for (const k of keys) assert.ok(strings[k]?.trim(), `${lang}: ${k}`)
    if (lang !== "en") assert.notEqual(strings.writeComposeHint, JSON.parse(read("../src/locales/en.json")).writeComposeHint, `${lang} is translated`)
  }
})
