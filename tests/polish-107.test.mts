// 2.7 after the owner's test of build 107 (triage D, E, F): one card of an answer per collection, a new section that
// takes no older card, Copied by age as it's drawn, and a snapshot that gives up fast and leaves the note whole.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  addCard, addSection, cardOf, cardsIn, countedCards, deleteCard, liveCards, liveSections, moveCard, newCollection, placesOf,
  type Card, type Collection
} from "../src/shared/collections.ts"
import { selectionNote } from "../src/shared/conversation.ts"
import { COPIED_TTL_MS, liveCopied, type CopiedItem } from "../src/shared/copied.ts"
import { firstAnswer, SHOT_TIMES } from "../src/shared/shots.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const card = (id: string, sec: string, chat: string, msg: string, k: Card["k"] = "answer"): Omit<Card, "o" | "u"> =>
  ({ id, sec, k, t: `card ${id}`, at: 1000, chat, msg })

function trip(): Collection {
  let rec = newCollection("cf-col-1", "Trip", undefined, 1000, { id: "notes", name: "Notes" })
  rec = addCard(rec, card("a", "notes", "chat-1", "k1"), 1001)
  return rec
}

// ------------------------------------------------------------ E2: duplicates

test("E2: the same answer added again makes no second card, whichever section it's sent to", () => {
  let rec = addSection(trip(), "see", "See", 1010)
  const again = addCard(rec, card("a2", "see", "chat-1", "k1"), 1011)
  assert.equal(again, rec, "the collection is untouched")
  assert.deepEqual(liveCards(again).map((c) => c.id), ["a"])
  assert.deepEqual(cardsIn(again, "notes").map((c) => c.id), ["a"])
  assert.deepEqual(cardsIn(again, "see"), [])
  // Another answer, and the same message key in another chat, are other cards.
  rec = addCard(rec, card("b", "see", "chat-1", "k2"), 1012)
  rec = addCard(rec, card("c", "see", "chat-2", "k1"), 1013)
  assert.deepEqual(liveCards(rec).map((c) => c.id).sort(), ["a", "b", "c"])
  // The same card saved again (its own id) is an update, not a copy.
  assert.equal(liveCards(addCard(rec, { ...card("b", "see", "chat-1", "k2"), t: "new gist" }, 1014)).find((c) => c.id === "b")!.t, "new gist")
})

test("E2: copies made before 107 stay in the record but show and count once; removing the card removes them all", () => {
  // As build 107 left it: the same answer three times, in two sections.
  const base = addSection(trip(), "see", "See", 1010)
  const twin = (id: string, sec: string, o: number): Card => ({ ...card(id, sec, "chat-1", "k1"), o, u: 1020 })
  const rec: Collection = { ...base, c: [...base.c, twin("a9", "see", 0), twin("a5", "notes", 1)] }
  assert.equal(rec.c.filter((c) => !c.d).length, 3, "nothing is cleaned up in the data")
  assert.deepEqual(liveCards(rec).map((c) => c.id), ["a"], "the first of them by id, the same on every device")
  assert.equal(countedCards(rec), 1)
  assert.deepEqual(cardsIn(rec, "see"), [])
  assert.equal(cardOf(rec, "chat-1", "k1")!.id, "a")
  // Moved, it's still the one that shows (no copy takes its place in the old section).
  const moved = moveCard(rec, "a", "see", 0, 1030)
  assert.deepEqual(cardsIn(moved, "see").map((c) => c.id), ["a"])
  assert.deepEqual(cardsIn(moved, "notes"), [])
  // Removed, no copy comes up in its place.
  const gone = deleteCard(rec, "a", 1040)
  assert.deepEqual(liveCards(gone), [])
  assert.equal(cardOf(gone, "chat-1", "k1"), undefined)
  assert.equal(gone.c.filter((c) => c.d).length, 3)
  // A comparison has no answer of its own: two of them are two cards.
  let tables = addCard(base, { id: "t1", sec: "notes", k: "compare", t: "x", at: 1 }, 1050)
  tables = addCard(tables, { id: "t2", sec: "notes", k: "compare", t: "x", at: 1 }, 1051)
  assert.equal(liveCards(tables).filter((c) => c.k === "compare").length, 2)
})

test("E1: where an answer is collected: each collection that has it, with the section its card shows in", () => {
  let other = newCollection("cf-col-2", "Gifts", undefined, 1000, { id: "g", name: "Ideas" })
  other = addCard(other, card("x", "g", "chat-9", "k9"), 1001)
  const deleted: Collection = { ...trip(), id: "cf-col-3", d: true }
  const places = placesOf([trip(), other, deleted], "chat-1", "k1")
  assert.deepEqual(places.map((p) => [p.rec.n, p.card.id, p.section?.n]), [["Trip", "a", "Notes"]])
  assert.deepEqual(placesOf([trip(), other], "chat-1", "nope"), [])
  // The button under the answer says which collection, with open / move / remove; the sheet never adds a second card.
  const ui = read("src/content/Collections.tsx")
  assert.match(ui, /t\("colIn", first\.rec\.n\)/)
  assert.match(ui, /t\("colOpen"\)[\s\S]*t\("colMoveTo", s\.n\)[\s\S]*t\("colRemove"\)[\s\S]*t\("colAddOther"\)/)
  assert.match(ui, /if \(there\) \{[\s\S]*?if \(!to\) return onAdded\(t\("colAlready", rec\.n\)\)/)
})

// ------------------------------------------------------------ E3: a new section

test("E3: a new section takes no card that was there before it, with sections or without", () => {
  // With sections: the new one is last and empty.
  const rec = addSection(trip(), "see", "See", 1010, true, { id: "rest", name: "Notes" })
  assert.deepEqual(liveSections(rec).map((s) => s.id), ["notes", "see"], "no extra section when the cards have one")
  assert.deepEqual(cardsIn(rec, "notes").map((c) => c.id), ["a"])
  assert.deepEqual(cardsIn(rec, "see"), [])
  // Before any section (the first one deleted on another device, a card whose section never arrived): the older card
  // gets a section of its own, and stays out of the one being made.
  const bare: Collection = { ...trip(), s: [{ id: "notes", n: "", o: 0, u: 1005, d: true }] }
  assert.deepEqual(liveSections(bare), [])
  const made = addSection(bare, "see", "See", 1010, true, { id: "rest", name: "Notes" })
  assert.deepEqual(liveSections(made).map((s) => [s.id, s.n, s.ai === true]), [["rest", "Notes", false], ["see", "See", true]])
  assert.deepEqual(cardsIn(made, "see"), [], "the new section is empty until its card is added")
  assert.deepEqual(cardsIn(made, "rest").map((c) => c.id), ["a"])
  const withNew = addCard(made, card("b", "see", "chat-1", "k2"), 1011)
  assert.deepEqual(cardsIn(withNew, "see").map((c) => c.id), ["b"])
  assert.deepEqual(cardsIn(withNew, "rest").map((c) => c.id), ["a"])
  // An empty collection without sections needs no section for older cards.
  const empty = addSection(newCollection("cf-col-4", "Empty", undefined, 1000), "s1", "First", 1001, false, { id: "rest", name: "Notes" })
  assert.deepEqual(liveSections(empty).map((s) => s.id), ["s1"])
  // The panel's sheet passes that section for older cards whenever it makes a section.
  assert.match(read("src/content/Collections.tsx"), /addSection\(next, sid, place\.newSection \|\| t\("colFirstSection"\), now, place\.by === "ai", \{ id: newItemId\(\), name: t\("colFirstSection"\) \}\)/)
})

// ------------------------------------------------------------ F4: Copied

test("F4: Copied is filtered by age when the list is drawn, not only when it's loaded or cleaned", () => {
  const now = 1_800_000_000_000
  const item = (text: string, age: number): CopiedItem => ({ id: text, text, host: "a.com", at: now - age, from: "page" })
  // What the panel holds since it last loaded the list: fresh then, a 25-hour-old piece among them now.
  const held = [item("fresh", 60_000), item("day-old", 25 * 3600_000), item("edge", COPIED_TTL_MS), item("just in", COPIED_TTL_MS - 1)]
  assert.deepEqual(liveCopied(held, now).map((c) => c.text), ["fresh", "just in"])
  // Both places that draw it filter as they draw.
  assert.match(read("src/content/insert/QuickInsert.tsx"), /const copied = liveCopied\(p\.settings\.copied \? p\.copied : \[\], Date\.now\(\)\)/)
  assert.match(read("src/content/insert/FillForm.tsx"), /const copied = liveCopied\(p\.copied, Date\.now\(\)\)/)
  // And what's held goes by age when the oldest piece runs out, before the stored list is read again (that read may
  // never answer in a tab left open across an update).
  assert.match(read("src/content/insert/QuickInsert.tsx"), /setCopied\(\(list\) => liveCopied\(list, Date\.now\(\)\)\)\s*void loadCopied\(\)\.then\(setCopied\)/)
})

// ------------------------------------------------------------ D1: the snapshot's failure path

const never = <T,>() => new Promise<T>(() => undefined)
const after = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))
const good = (v: string) => v.startsWith("data:image/")

test("D1: a capture that never answers is given up within the limit, and says so", async () => {
  const began = Date.now()
  const out = await firstAnswer([() => never<string>(), () => never<string>()], good, { gap: 20, total: 120 })
  const took = Date.now() - began
  assert.deepEqual(out, { ok: false, error: "timeout" })
  assert.ok(took >= 110 && took < 400, `gave up after ${took} ms`)
  // The real limits: seconds, not the 9 + 7 of build 107; the page stops waiting just after the background gives up.
  assert.ok(SHOT_TIMES.total <= 3000 && SHOT_TIMES.wait > SHOT_TIMES.total && SHOT_TIMES.wait <= 4000)
})

test("D1: a form of the capture that hangs doesn't hold back the next one; failures go straight on; the last error is kept", async () => {
  const calls: string[] = []
  const began = Date.now()
  const hung = await firstAnswer([
    () => { calls.push("window"); return never<string>() },
    () => { calls.push("current"); return after(10, "data:image/jpeg;base64,AAAA") }
  ], good, { gap: 30, total: 500 })
  assert.deepEqual(hung, { ok: true, value: "data:image/jpeg;base64,AAAA" })
  assert.deepEqual(calls, ["window", "current"])
  assert.ok(Date.now() - began < 200, "the second form started after the gap, not after the first one's whole time")

  const order: string[] = []
  const failing = await firstAnswer([
    () => { order.push("a"); return Promise.reject(new Error("no permission")) },
    () => { order.push("b"); throw new Error("not a function") },
    () => { order.push("c"); return Promise.resolve("about:blank") }
  ], good, { gap: 5000, total: 5000 })
  assert.deepEqual(order, ["a", "b", "c"], "a failed form doesn't wait for the gap")
  assert.deepEqual(failing, { ok: false, error: "no image" })
  assert.deepEqual(await firstAnswer([() => Promise.reject(new Error("Failed to capture tab"))], good, { gap: 10, total: 100 }), { ok: false, error: "Failed to capture tab" })
  assert.deepEqual(await firstAnswer<string>([], good, { gap: 10, total: 100 }), { ok: false, error: "unavailable" })
})

test("D1: the note is kept before the picture is tried, with its quote; our panel always comes back", () => {
  const app = read("src/content/App.tsx")
  const save = app.slice(app.indexOf("const saveNote = useCallback"), app.indexOf("const shotBusyRef = useRef(false)"))
  // The note (the selection's quote with it) is in the chat and stored before the snapshot starts.
  assert.ok(save.indexOf("selectionNote(sel.text, content, ref") > 0)
  assert.ok(save.indexOf("void saveThread(id, next)") > 0 && save.indexOf("void saveThread(id, next)") < save.indexOf("shootForRef.current("))
  assert.match(save, /if \(!out\.ok\) setUndoBar\(\{ text: t\("shotFailed"\)/)
  // The quote itself: the selection first, the person's words after it.
  const note = selectionNote("Our players love to pay.", "Запомнить аргументы", { url: "https://mail.example/", title: "Mail", at: 5 }, (q) => `“${q}”`)
  assert.equal(note.content, "“Our players love to pay.”\n\nЗапомнить аргументы")
  assert.equal(note.cite, "Our players love to pay.")
  // Whatever the capture does, what was hidden is shown again (the finally), and the wait is the short one.
  const shot = read("src/content/shot.ts")
  const take = shot.slice(shot.indexOf("export async function takeShot"))
  assert.match(take, /\} finally \{[\s\S]*?if \(host\) \{[\s\S]*?host\.style\.removeProperty\("visibility"\)/)
  assert.match(shot, /setTimeout\(\(\) => resolve\(null\), SHOT_TIMES\.wait\)/)
  assert.doesNotMatch(shot, /9000/)
  // A later screen of a whole page that can't be taken leaves the picture with the screens before it.
  assert.match(take, /if \(i === 0\) throw err\s+break/)
})

// ------------------------------------------------------------ F1: Find similar's colour

import { similarTone } from "../src/shared/plan.ts"

test("F1: Find similar is violet on Ultra only; on Pro, Own key and Free (offered Pro) it's blue, wherever it shows", () => {
  assert.equal(similarTone("ultra"), "ultra")
  for (const plan of ["pro", "byok", "free", null, undefined] as const) assert.equal(similarTone(plan), "pro", String(plan))
  const app = read("src/content/App.tsx")
  // The panel's chips (the empty chat, under an answer) and the selection popup's chip take the plan's tone.
  assert.match(app, /class=\{`cf-chip \$\{similarTone\(plan\)\}\$\{small \? " small" : ""\}`\} data-action=\{a\.id\}/)
  assert.match(app, /<SelField touch=\{touch\} placeholder=\{t\("selQuestion"\)\} markUltra=\{markUltra\} tone=\{similarTone\(plan\)\}/)
  assert.match(app, /class=\{`cf-sel-chip \$\{tone\}`\}/)
  assert.doesNotMatch(app, /cf-chip ultra|cf-sel-chip ultra/)
  // "Pro" on it for Free is Pro's blue too, in the chips and in the page menu.
  assert.match(app, /<span class="cf-ultra-mark pro">Pro<\/span>/)
  assert.match(read("src/content/ux/PageMenu.tsx"), /similarLocked && <span class="cf-ultra-badge pro">Pro<\/span>/)
  const css = read("src/content/styles.css")
  for (const rule of [/\.cf-chip\.pro, \.cf-chip\.pro:hover \{[^}]*color: var\(--accent-text\); background: var\(--accent-soft\)/, /\.cf-bubble\.touch button\.cf-sel-chip\.pro \{[^}]*var\(--accent-text\)/, /\.cf-bubble \.cf-ask-field\.mouse button\.cf-sel-chip\.pro \{[^}]*var\(--accent-text\)/]) assert.match(css, rule)
})

// ------------------------------------------------------------ F2, F3: Tips

import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
// @ts-expect-error: a plain .mjs module (the build's own)
import { tipsData } from "../scripts/tips-source.mjs"
import { isNewTip } from "../src/content/tips/fresh.ts"

test("F2: the cards of this version's features carry a quiet «New», in the app and the panel, gone with the next version", () => {
  const data = tipsData(fileURLToPath(new URL("..", import.meta.url))) as any
  assert.equal(data.newIn, "2.7", "the version What's new is about (WhatsNew.version)")
  const cards = data.groups.flatMap((g: any) => g.tips)
  const fresh = cards.filter((c: any) => isNewTip(c, data)).map((c: any) => c.title.en).sort()
  assert.deepEqual(fresh, [
    "A snapshot with your note", "Add to Calendar or Reminders", "Check or rewrite before you send", "Gather it in a collection", "Invite a friend",
    "Mistakes underlined as you type", "Move ✦ out of the way", "Read a page in your language", "Spaces for work and home", "The chat for this page", "Tips by the ✦ button"
  ])
  // Not the older cards, the lead, or a changed one (Find similar).
  assert.ok(!isNewTip(data.lead, data) && !isNewTip(cards.find((c: any) => c.title.en === "Find similar"), data))
  // The next version: its own cards only; no version named, nothing marked.
  assert.equal(cards.filter((c: any) => isNewTip(c, { newIn: "2.8" })).length, 0)
  assert.equal(cards.filter((c: any) => isNewTip(c, null)).length, 0)
  // The app marks by the same rule, on the card and on a folded block that holds one.
  const swift = read("ContextFlow/Shared (App)/ContentView.swift")
  assert.match(swift, /var isNew: Bool \{ since == WhatsNew\.version \}/)
  assert.match(swift, /if tip\.isNew \{ NewBadge\(\) \}/)
  assert.match(swift, /hasNew: group\.tips\.contains\(where: \\\.isNew\)/)
  const sheet = read("src/content/tips/TipsSheet.tsx")
  assert.match(sheet, /\{fresh && <span class="cf-new-badge">\{t\("tipNew"\)\}<\/span>\}/)
  assert.match(sheet, /!isOpen && group\.tips\.some\(\(tip\) => isNewTip\(tip, data\)\) && <span class="cf-new-badge">/)
  // «New» in every language: the panel's and the app's catalog.
  const catalog = JSON.parse(read("ContextFlow/Shared (App)/Localizable.xcstrings")).strings
  const en = JSON.parse(read("src/locales/en.json"))
  const files = readdirSync(new URL("../src/locales", import.meta.url)).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 15)
  for (const file of files) {
    const own = JSON.parse(read(`src/locales/${file}`))
    for (const key of ["tipNew", "shotAdd", "shotAdded", "colIn", "colOpen", "colAddOther", "colAlready"]) {
      assert.ok(typeof own[key] === "string" && own[key].trim(), `${file}: ${key}`)
      if (file !== "en.json") assert.notEqual(own[key], en[key], `${file}: ${key} translated`)
    }
    for (const key of ["colIn", "colAlready"]) assert.match(own[key], /\{0\}/, `${file}: ${key}`)
  }
  for (const code of ["ar", "de", "es", "fr", "it", "ja", "ko", "pt-BR", "ru", "tr", "uk", "vi", "zh-Hans", "zh-Hant"]) {
    for (const key of ["New", "In “%@”"]) assert.equal(catalog[key]?.localizations?.[code]?.stringUnit?.state, "translated", `${code}: ${key}`)
    assert.match(catalog["In “%@”"].localizations[code].stringUnit.value, /%@/, code)
  }
})

test("F3: «What your plan adds» is gone from Tips: the app, the panel's sheet and the site's /features", () => {
  const data = tipsData(fileURLToPath(new URL("..", import.meta.url))) as any
  assert.ok(!data.groups.some((g: any) => g.tips.some((c: any) => c.title.en === "What your plan adds")))
  assert.deepEqual(data.groups.find((g: any) => g.id === "your-plan").tips.map((c: any) => c.title.en), ["Monthly or yearly", "Invite a friend"])
  assert.doesNotMatch(read("site/features.html"), /What your plan adds/)
})

// ------------------------------------------------------------ D1: a page whose window is locked (a mail app)

import { windowScrolls } from "../src/shared/shots.ts"

test("D1: a whole-page snapshot never walks through a locked window's hidden overflow (a mail app is one screen)", () => {
  const page = (o: { html?: string; body?: string; height: number; y?: number; scriptScrolls?: boolean }) => {
    const root = { scrollHeight: o.height, tag: "html" }
    const body = { scrollHeight: o.height, tag: "body" }
    const calls: number[] = []
    const view = {
      innerHeight: 800, scrollX: 0, scrollY: o.y ?? 0,
      getComputedStyle: (el: { tag: string }) => ({ overflowY: el.tag === "html" ? o.html ?? "visible" : o.body ?? "visible" }),
      scrollTo(to: { top: number }) {
        calls.push(to.top)
        if (o.scriptScrolls !== false) this.scrollY = to.top
      }
    }
    return { out: windowScrolls({ documentElement: root, body } as never, view as never), calls, view }
  }
  // An article: taller than the screen, the window scrolls it; left where it was.
  const article = page({ height: 4200 })
  assert.equal(article.out, true)
  assert.equal(article.view.scrollY, 0)
  assert.equal(page({ height: 4200, y: 900 }).out, true)
  // A mail app (Gmail's shape): html or body locked, far more height in what's hidden, and a script could scroll it.
  // It isn't walked through screen by screen: no scroll is even tried.
  for (const locked of [{ html: "hidden" }, { body: "hidden" }, { html: "clip" }, { html: "hidden", body: "auto" }]) {
    const mail = page({ ...locked, height: 4200 })
    assert.equal(mail.out, false, JSON.stringify(locked))
    assert.deepEqual(mail.calls, [], "the page isn't touched")
  }
  // html's own overflow wins over body's (body: hidden under a scrolling html locks nothing).
  assert.equal(page({ html: "auto", body: "hidden", height: 4200 }).out, true)
  // All on screen already; and a page that says it's tall but doesn't move.
  assert.equal(page({ height: 802 }).out, false)
  assert.equal(page({ height: 4200, scriptScrolls: false }).out, false)
  // The page side uses it for «Whole page», and takes one screen when it says no.
  const shot = read("src/content/shot.ts")
  assert.match(shot, /const whole = kind === "full" && windowScrolls\(document, window\)/)
  assert.match(shot, /if \(!chrome\.runtime\?\.id\) return \{ ok: false, code: "UNAVAILABLE"/)
})
