// «Проверить» и «Переписать» (2.7, plan section 13): what a check changed, word by word; the person's style samples,
// kept on the device; what goes to the server, clipped.
import assert from "node:assert/strict"
import { test } from "node:test"

import { readFileSync } from "node:fs"

import { applyEdits, asSeen, clipAsk, diffParts, diffWords, freeLeft, keepSample, SAMPLES, samplesFor, styleTemplates, tokens, trimmedSpan, worthWriting, WRITE_LIMITS, type Samples } from "../src/shared/writing.ts"
import type { Template } from "../src/shared/templates.ts"

test("a check's changes land on the words that changed, nothing else", () => {
  const a = "Hi Katarina, I definately recieve teh files tommorow."
  const b = "Hi Katarzyna, I definitely receive the files tomorrow."
  const edits = diffWords(a, b)
  assert.deepEqual(edits.map((e) => [a.slice(e.from, e.to), e.text]), [
    ["Katarina", "Katarzyna"],
    // two changes with one space between them are one change
    ["definately recieve teh", "definitely receive the"],
    ["tommorow", "tomorrow"]
  ])
  assert.equal(applyEdits(a, edits), b)
  assert.deepEqual(diffParts(a, edits).slice(0, 3), [{ same: "Hi " }, { was: "Katarina", now: "Katarzyna" }, { same: ", I " }])
})

test("no change, an added comma, a removed word, Cyrillic and line breaks", () => {
  assert.deepEqual(diffWords("same text", "same text"), [])
  const comma = diffWords("Thanks Anna see you", "Thanks Anna, see you")
  assert.deepEqual(comma, [{ from: 11, to: 11, text: "," }])
  const removed = diffWords("I will will come", "I will come")
  assert.equal(applyEdits("I will will come", removed), "I will come")
  const ru = "Извените, я прийду сдесь в пять"
  const fixed = "Извините, я приду здесь в пять"
  assert.deepEqual(diffWords(ru, fixed).map((e) => ru.slice(e.from, e.to)), ["Извените", "прийду сдесь"])
  // a line break is never joined across: each paragraph's changes stay its own
  const lines = diffWords("teh one\nteh two", "the one\nthe two")
  assert.equal(lines.length, 2)
  assert.ok(lines.every((e) => !"teh one\nteh two".slice(e.from, e.to).includes("\n")))
})

test("diffWords and applyEdits always agree", () => {
  const pairs = [
    ["", "Hello there"], ["Hello there", ""], ["a b c d e f", "a c e f g"], ["Привет мир!", "Привет, мир!"],
    ["don't do-it", "do not do it"], ["The quick brown fox", "A quick red fox jumps"], ["x\n\ny", "x\ny"]
  ]
  for (const [a, b] of pairs) assert.equal(applyEdits(a, diffWords(a, b)), b, `${a} → ${b}`)
  assert.deepEqual(tokens("it's well-known, ok"), ["it's", " ", "well-known", ",", " ", "ok"])
})

test("a space of another kind or an invisible character is no change: the field keeps its own (109, Gmail on an iPad)", () => {
  // The owner's case: Gmail kept the typed space as a no-break one, the model wrote a plain one back.
  const gmail = "Is it possible to find the root of the problem?"
  assert.deepEqual(diffWords(gmail, gmail.replace(/ /g, " ")), [])
  // In every script, and the narrow and figure spaces (French before «?», digit groups), a zero-width space, a BOM.
  for (const s of ["Мы готовы начать", "Bonjour !", "1 000 €", "日本語​です", "﻿Hola amigo", "wo​rd"]) {
    assert.deepEqual(diffWords(s, asSeen(s)), [], JSON.stringify(s))
  }
  // A real fix beside a no-break space changes the word only; the space stays the field's.
  const near = "Is it posible to find teh root?"
  const edits = diffWords(near, "Is it possible to find the root?")
  assert.deepEqual(edits.map((e) => [near.slice(e.from, e.to), e.text]), [["posible", "possible"], ["teh", "the"]])
  assert.equal(applyEdits(near, edits), "Is it possible to find the root?")
  // Two changes joined over a no-break space keep it.
  const joined = diffWords("teh quik fox", "the quick fox")
  assert.deepEqual(joined, [{ from: 0, to: 8, text: "the quick" }])
  // A doubled space is still a mistake, however the editor keeps it (a no-break one and a plain one).
  assert.deepEqual(diffWords("find the  root", "find the root").map((e) => e.text), [" "])
  assert.deepEqual(diffWords("find the  root", "find the root").map((e) => e.text), [" "])
  // diffWords and applyEdits agree as a reader sees the text.
  for (const [a, b] of [["a b c", "a b d"], ["Привет мир", "Привет, мир!"], ["x​y z", "x y, z"]]) {
    assert.equal(asSeen(applyEdits(a, diffWords(a, b))), asSeen(b), `${a} → ${b}`)
  }
})

test("a text is worth checking from two words; the field's own white space stays out", () => {
  assert.equal(worthWriting("Hello"), false)
  assert.equal(worthWriting("  Hello there "), true)
  assert.deepEqual(trimmedSpan("\n  Hi you \n\n"), { from: 3, to: 9 })
  assert.deepEqual(trimmedSpan("   "), { from: 0, to: 0 })
})

test("style samples: per site, newest first, a draft written on replaces itself, old ones go", () => {
  const day = 24 * 3600_000
  let all: Samples = {}
  all = keepSample(all, "mail.google.com", "too short", 1)
  assert.deepEqual(all, {}, "under the minimum: not kept")
  const long = "Hi Anna, thanks for the update on the launch plan. Friday works for me."
  all = keepSample(all, "mail.google.com", long, 1000)
  all = keepSample(all, "mail.google.com", long + " See you then!", 2000)
  assert.equal(all["mail.google.com"].length, 1, "the same draft, written on")
  assert.ok(all["mail.google.com"][0].t.endsWith("See you then!"))
  for (let i = 0; i < 7; i++) all = keepSample(all, "mail.google.com", `Message number ${i} about something different entirely, sent today.`, 3000 + i)
  assert.equal(all["mail.google.com"].length, SAMPLES.perSite)
  assert.ok(all["mail.google.com"][0].t.startsWith("Message number 6"))
  all = keepSample(all, "linkedin.com", "Congrats on the new role, well deserved after all that work!", 5000)
  assert.deepEqual(Object.keys(all).sort(), ["linkedin.com", "mail.google.com"])
  // Expired ones go the next time anything is kept.
  all = keepSample(all, "linkedin.com", "Another comment, a bit later, still about the same post here.", 5000 + SAMPLES.ttl + day)
  assert.equal(all["mail.google.com"], undefined)
  assert.equal(all["linkedin.com"].length, 1)
  const long2 = "word ".repeat(400)
  const clipped = keepSample({}, "x.com", long2, 1)["x.com"][0].t
  assert.ok(clipped.length <= WRITE_LIMITS.sampleChars && !clipped.endsWith(" "))
})

test("the samples that go with a request: this site's, never the text being checked", () => {
  const all: Samples = { "x.com": [{ t: "Hello Anna, the report is attached to this message.", at: 10 }, { t: "Yes, let's meet on Friday at the usual place.", at: 9 }] }
  assert.deepEqual(samplesFor(all, "x.com", 100, "Hello Anna, the report is attached"), ["Yes, let's meet on Friday at the usual place."])
  assert.deepEqual(samplesFor(all, "y.com", 100), [])
  assert.equal(samplesFor(all, "x.com", SAMPLES.ttl + 50).length, 0)
})

test("templates as style: most used on this site first, then anywhere; tiny or blank-heavy ones left out", () => {
  const tpl = (id: string, text: string): Template => ({ id, title: id, text, keywords: [], createdAt: 1, updatedAt: 1 })
  const list = [
    tpl("a", "Thanks for reaching out! I'll get back to you by Friday."),
    tpl("b", "Hi {Name}, your order {Order} ships {Date} from {Place} via {Carrier}."),
    tpl("c", "Short"),
    tpl("d", "Best regards and talk soon, have a lovely weekend.")
  ]
  const use = { d: { at: 5, sites: { "mail.google.com": 3 } }, a: { at: 4, sites: { "x.com": 9 } } }
  assert.deepEqual(styleTemplates(list, use, "mail.google.com").map((t) => t[0]), ["B", "T"])
})

test("what goes to the server is clipped to its limits", () => {
  const ask = clipAsk({
    action: "rewrite", tone: "warm", text: "Hello there",
    page: { title: "t".repeat(400), url: "https://x", text: "p".repeat(20_000), conversation: true },
    field: "f".repeat(500),
    style: { about: "a".repeat(2000), samples: ["s1", "", "s2", "s3", "s4"], templates: ["x".repeat(900)] }
  })
  assert.equal(ask.page.text.length, WRITE_LIMITS.page)
  assert.equal(ask.page.title.length, 300)
  assert.equal(ask.field.length, WRITE_LIMITS.field)
  assert.equal(ask.style.about!.length, WRITE_LIMITS.about)
  assert.deepEqual(ask.style.samples, ["s1", "s2", "s3"])
  assert.equal(ask.style.templates[0].length, WRITE_LIMITS.templateChars)
  assert.equal(clipAsk({ ...ask, action: "check" }).tone, undefined, "a check has no tone")
})

// 2.7, the director from the store captures: on Ultra (and Pro) the card said «Free answers left today: 374», the
// subscription's week in Free's words. Free keeps its line; Pro, Ultra and Own key get none on the card, as the fill card
// (the panel's usage line has the week).
test("the card's «left today» is Free's only, whatever the page thinks the plan is", () => {
  const day = { used: 1, limit: 5, period: "day" as const }
  const week = { used: 1, limit: 375, period: "week" as const }
  // Free: the day's remainder, even when the page hasn't heard its status yet.
  assert.equal(freeLeft({ plan: "free", usage: day }, true), 4)
  assert.equal(freeLeft({ plan: "free", usage: day }, false), 4)
  assert.equal(freeLeft({ plan: "free", usage: { used: 7, limit: 5, period: "day" } }, true), 0)
  assert.equal(freeLeft({ plan: "free", usage: null }, true), null)
  // Pro and Ultra: nothing, though the page still thinks Free (the captures' case).
  for (const plan of ["pro", "ultra"]) {
    assert.equal(freeLeft({ plan, usage: week }, true), null, plan)
    assert.equal(freeLeft({ plan, usage: week }, false), null, plan)
  }
  // Own key: nothing, with its own key (no usage) or on ContextFlow's day without one.
  assert.equal(freeLeft({ plan: "byok", usage: null }, true), null)
  assert.equal(freeLeft({ plan: "byok", usage: day }, true), null)
  // A server that doesn't say the plan yet: only a day's allowance on a page that thinks Free.
  assert.equal(freeLeft({ usage: day }, true), 4)
  assert.equal(freeLeft({ usage: week }, true), null)
  assert.equal(freeLeft({ usage: day }, false), null)
  // The card goes by it.
  const card = readFileSync(new URL("../src/content/insert/Write.tsx", import.meta.url), "utf8")
  assert.match(card, /const left = freeLeft\(reply, p\.free\)/)
  assert.doesNotMatch(card, /p\.free && reply\.usage/)
  // The background hands the server's plan on to the card (it used to keep only the text and the usage).
  const bg = readFileSync(new URL("../src/background/insert.ts", import.meta.url), "utf8")
  assert.match(bg, /return \{ ok: true, text: body\.text, \.\.\.\(typeof body\.plan === "string" \? \{ plan: body\.plan \} : \{\}\), usage: body\.usage \?\? null \}/)
})
