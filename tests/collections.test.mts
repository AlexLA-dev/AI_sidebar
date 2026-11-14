// Подборки (2.7, plan section 2, src/shared/collections.ts): a collection is one record with its sections and cards; each
// merged newest-wins with deletions kept; Free one collection of ten cards, Pro no limit; cards from answers and notes;
// «В подборку» by words; «Сравнить» next to the cards; the AI's layout keeps the user's sections.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  addCard, addComparison, addSection, applyLayout, canAddCard, canAddCollection, cardFrom, cardsIn, changedCollection, cleanCollection, collectionChanges, collectionForCloud, collectionFromCloud,
  COLLECTION_PREFIX, countedCards, deleteCard, deleteCollection, deleteSection, FREE_CARDS, FREE_COLLECTIONS, gistOf, isCollectionId, liveCollections, liveSections, MAX_GIST,
  mergeCollections, moveCard, moveSection, newCollection, renameSection, sameCollection, setSummary, suggestPlace, takeCollection, type Collection
} from "../src/shared/collections.ts"
import { addSpace, emptySpaces, FIRST_SPACE } from "../src/shared/spaces.ts"
import { applyRemote, threadFromCloud, type Threads } from "../src/shared/threads.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"

const CID = `${COLLECTION_PREFIX}trip`
let n = 0
const card = (sec: string, t: string, extra: Record<string, unknown> = {}) => ({ id: `k${++n}`, sec, k: "answer" as const, t, at: 1_000 + n, ...extra })

/** A trip with two sections and three cards, made at time 1,000 on one device. */
function trip(): Collection {
  let c = newCollection(CID, "Trip to Japan", undefined, 1_000, { id: "stay", name: "Where to stay" })
  c = addSection(c, "fly", "Flights", 1_001)
  c = addCard(c, card("stay", "Shinjuku: easy for a first visit, many metro lines.", { src: { url: "https://guide.example/shinjuku", title: "Shinjuku guide" } }), 1_002)
  c = addCard(c, card("stay", "Asakusa: quieter and cheaper, near old Tokyo."), 1_003)
  c = addCard(c, card("fly", "Tickets for March are cheaper two or three months ahead."), 1_004)
  return c
}

test("a collection is its own record: a prefixed id, 2.6 skips it (no m), JSON in one form", () => {
  assert.ok(isCollectionId(CID))
  assert.equal(isCollectionId("4b1d6a3e-0000-4000-8000-000000000000"), false)
  const base = trip()
  const data = collectionForCloud(base)
  assert.equal(threadFromCloud(data), null)
  const threads: Threads = {}
  assert.equal(applyRemote(threads, {}, [{ id: CID, updatedAt: 5_000, data }], []).changed, false)
  assert.ok(sameCollection(collectionFromCloud(data, CID)!, base))
  assert.equal(collectionFromCloud("{}", CID), null)
  assert.equal(collectionFromCloud(JSON.stringify({ kind: "collection", s: [], c: [] }), CID), null)
})

test("sections and cards: in their order, moved by dragging, deleted ones gone, a deleted section's cards kept", () => {
  let c = trip()
  assert.deepEqual(liveSections(c).map((s) => s.n), ["Where to stay", "Flights"])
  assert.deepEqual(cardsIn(c, "stay").map((k) => k.t.split(":")[0]), ["Shinjuku", "Asakusa"])
  // Dragged: Asakusa first; then into Flights at the top.
  const asakusa = cardsIn(c, "stay")[1].id
  c = moveCard(c, asakusa, "stay", 0, 2_000)
  assert.equal(cardsIn(c, "stay")[0].id, asakusa)
  c = moveCard(c, asakusa, "fly", 0, 2_001)
  assert.deepEqual(cardsIn(c, "fly").map((k) => k.id)[0], asakusa)
  // Sections: renamed by the user (theirs from then on), moved left, deleted (its cards go to the other).
  c = addSection(c, "see", "Sights", 2_002, true)
  c = renameSection(c, "see", "To see", 2_003)
  assert.equal(liveSections(c).find((s) => s.id === "see")!.ai, undefined)
  c = moveSection(c, "see", 0, 2_004)
  assert.deepEqual(liveSections(c).map((s) => s.id), ["see", "stay", "fly"])
  c = deleteSection(c, "fly", 2_005)
  assert.deepEqual(liveSections(c).map((s) => s.id), ["see", "stay"])
  assert.equal(cardsIn(c, "see").length, 2)
  // The last section with cards stays.
  let one = newCollection(`${COLLECTION_PREFIX}one`, "One", undefined, 1, { id: "a", name: "A" })
  one = addCard(one, card("a", "x"), 2)
  assert.equal(deleteSection(one, "a", 3), one)
  // A card deleted is gone, its tombstone kept.
  const gone = deleteCard(c, cardsIn(c, "stay")[0].id, 2_006)
  assert.equal(cardsIn(gone, "stay").length, 0)
  assert.ok(gone.c.some((k) => k.d))
})

test("two devices at once: both cards kept, a deletion wins over an older copy, the newest name; either way round the same", () => {
  const base = trip()
  const iphone = addCard(base, card("stay", "Ueno: near the park."), 3_000)
  const mac = setSummary(addCard(base, card("fly", "JAL includes two bags."), 3_001), "Fly in late March.", 3_002)
  const merged = mergeCollections(iphone, mac)
  assert.equal(countedCards(merged), 5)
  assert.equal(merged.sum?.t, "Fly in late March.")
  assert.ok(sameCollection(merged, mergeCollections(mac, iphone)))
  // Deleted on one, the name changed on the other later: deleted (newest meta); a card deleted stays deleted.
  const deleted = deleteCollection(base, 4_000)
  const renamed = { ...base, n: "Japan", mu: 3_500 }
  assert.equal(mergeCollections(deleted, renamed).d, true)
  const k = cardsIn(base, "stay")[0].id
  assert.ok(mergeCollections(deleteCard(base, k, 4_100), base).c.find((x) => x.id === k)!.d)
})

test("a copy from iCloud or the app is merged in; what only this device has goes up newer than both; the time never goes back", () => {
  const base = trip()
  const mine = changedCollection(undefined, addCard(base, card("fly", "Mine"), 5_000), 5_000)
  const theirs = addCard(base, card("stay", "Theirs"), 6_000)
  const taken = takeCollection(mine, { id: CID, updatedAt: 6_000, data: collectionForCloud(theirs) })!
  assert.equal(countedCards(taken.rec), 5)
  assert.equal(taken.u, 6_001)
  assert.deepEqual(collectionChanges({ [CID]: taken }, { [CID]: 6_000 }).map((c) => c.id), [CID])
  // Theirs has it all: kept with its time, nothing to send back.
  const all = takeCollection(taken, { id: CID, updatedAt: 7_000, data: collectionForCloud(taken.rec) })!
  assert.equal(all.u, 7_000)
  assert.deepEqual(collectionChanges({ [CID]: all }, { [CID]: 7_000 }), [])
  // Nothing new: nothing changes.
  assert.equal(takeCollection(all, { id: CID, updatedAt: 6_500, data: collectionForCloud(mine.rec) }), null)
  // First copy here: as it is.
  assert.equal(takeCollection(undefined, { id: CID, updatedAt: 1, data: collectionForCloud(theirs) })!.u, 1)
})

test("Free: one collection of up to ten cards (a comparison doesn't count); Pro: no limit", () => {
  assert.equal(FREE_COLLECTIONS, 1)
  assert.equal(FREE_CARDS, 10)
  let c = trip()
  assert.equal(canAddCollection([c], false), false)
  assert.equal(canAddCollection([c], true), true)
  assert.equal(canAddCollection([deleteCollection(c, 9)], false), true)
  for (let i = 0; i < 7; i++) c = addCard(c, card("stay", `More ${i}`), 2_000 + i)
  assert.equal(countedCards(c), 10)
  assert.equal(canAddCard(c, false), false)
  assert.equal(canAddCard(c, true), true)
  const [a, b] = cardsIn(c, "stay")
  const compared = addComparison(c, "cmp", [a.id, b.id], { h: ["Area", "Night"], r: [["Shinjuku", "≈ ¥22,000"], ["Asakusa", "≈ ¥14,000"]] }, 3_000)
  assert.equal(countedCards(compared), 10)
})

test("«Сравнить»: a table card right after the compared cards, in their section", () => {
  const c = trip()
  const [a, b] = cardsIn(c, "stay")
  const next = addComparison(c, "cmp", [a.id, b.id], { h: ["Area", "Night"], r: [["Shinjuku", "≈ ¥22,000"], ["Asakusa", "≈ ¥14,000"]], note: "Metro: 3 and 5 min" }, 3_000)
  assert.deepEqual(cardsIn(next, "stay").map((k) => k.id), [a.id, b.id, "cmp"])
  const cmp = next.c.find((k) => k.id === "cmp")!
  assert.equal(cmp.k, "compare")
  assert.deepEqual(cmp.of, [a.id, b.id])
  assert.equal(addComparison(c, "cmp", [a.id], { h: ["x", "y"], r: [] }, 3_000), c)
})

test("the AI's layout: new sections made, the user's kept and used, cards placed, the AI's old empty ones gone", () => {
  let c = trip()
  c = addSection(c, "old", "Misc", 2_000, true)
  let k = 0
  const laid = applyLayout(c, {
    sections: [{ id: "stay", name: "Where to stay" }, { id: null, name: "Getting there" }],
    cards: [...cardsIn(c, "stay"), ...cardsIn(c, "fly")].map((x, i) => ({ id: x.id, section: i < 2 ? 0 : 1 }))
  }, () => `new${++k}`, 3_000)
  const names = liveSections(laid).map((s) => s.n)
  assert.ok(names.includes("Where to stay") && names.includes("Getting there"))
  assert.ok(!names.includes("Misc"))
  // The user's "Flights" is theirs: it stays, empty or not.
  assert.ok(names.includes("Flights"))
  assert.equal(cardsIn(laid, "new1").length, 1)
})

test("a card from an answer or a note: its gist, the question's page, tags, the way back to the chat", () => {
  const entries = [
    { role: "user" as const, content: "Where should I stay?", t: 10, id: "q1", page: { url: "https://guide.example/tokyo", title: "Tokyo areas", at: 10 } },
    { role: "assistant" as const, content: "**Asakusa** is quieter [1](https://a.example) and about a third cheaper. It's near old Tokyo, the river and the train to Nikko, which makes it a good base for day trips.", t: 11, id: "a1", tags: ["trip"] },
    { role: "user" as const, content: "Bring an adapter", t: 12, id: "n1", note: true }
  ]
  const answer = cardFrom(entries, 1, "chat-1", "c1", "stay", 99)!
  assert.equal(answer.k, "answer")
  assert.equal(answer.src?.url, "https://guide.example/tokyo")
  assert.deepEqual(answer.tags, ["trip"])
  assert.equal(answer.chat, "chat-1")
  assert.equal(answer.msg, "a1")
  assert.ok(!answer.t.includes("**") && !answer.t.includes("[1]"))
  assert.ok(answer.t.length <= MAX_GIST)
  assert.equal(cardFrom(entries, 2, "chat-1", "c2", "stay")!.k, "note")
  // A note has only its own page: none here («Ваша заметка»), not the question's before it.
  assert.equal(cardFrom(entries, 2, "chat-1", "c2", "stay")!.src, undefined)
  assert.equal(cardFrom(entries, 0, "chat-1", "c3", "stay"), null)
  assert.equal(gistOf("Short."), "Short.")
})

test("a card's gist: the answer's first sentences, not its title or table, from the start", () => {
  const takeaways = "**Key takeaways**\n\n| Metric | Result |\n|---|---|\n| Revenue change | +1.4% |\n| Less burnout | 71% of staff |\n\n- Hours were cut **20% with full pay**, as long as output held.\n- Two firms went back to five days because of client expectations.\n- Results may be optimistic: participants **volunteered**."
  assert.equal(gistOf(takeaways), "Hours were cut 20% with full pay, as long as output held. Two firms went back to five days because of client expectations.")
  // Bullets without full stops are sentences too; a decimal point doesn't end one.
  assert.equal(gistOf("## Prices\n- Revenue rose 1.4% on average\n- Churn fell"), "Revenue rose 1.4% on average. Churn fell.")
  // A bold label that starts the text stays.
  assert.match(gistOf("**In short:** a four-day week kept revenue flat."), /^In short: a four-day week/)
  // A table alone is still something.
  assert.ok(gistOf("| a | b |\n|---|---|\n| 1 | 2 |").length > 0)
  // CJK sentences end without a space.
  const ja = "浅草は静かで安いです。新宿は初めての旅行に便利で、地下鉄の路線が多く、夜遅くまでにぎやかです。".repeat(3)
  assert.ok(gistOf(ja).endsWith("。") && gistOf(ja).length <= MAX_GIST)
})

test("«В подборку» by words: the collection and section that share most of the card's words", () => {
  const japan = trip()
  const phones = addCard(newCollection(`${COLLECTION_PREFIX}phones`, "New headphones", undefined, 1, { id: "anc", name: "Noise cancelling" }), card("anc", "The Aero 2 cancels noise well on planes."), 2)
  const place = suggestPlace([japan, phones], { t: "Asakusa hotels are quieter and cheaper than Shinjuku.", src: { title: "Asakusa River Hotel" } })
  assert.deepEqual([place?.collection, place?.section], [CID, "stay"])
  assert.equal(suggestPlace([japan, phones], { t: "Which headphones cancel noise best?" })?.collection, phones.id)
  assert.equal(suggestPlace([], { t: "x" }), null)
})

test("collections live in a space; with Spaces off, all of them", () => {
  const list = addSpace(emptySpaces(), "work", "Work", "green", 1)
  const home = trip()
  const work = { ...newCollection(`${COLLECTION_PREFIX}w`, "Report", "work", 2), mu: 2 }
  assert.deepEqual(liveCollections([home, work], list, FIRST_SPACE, true).map((c) => c.id), [CID])
  assert.deepEqual(liveCollections([home, work], list, "work", true).map((c) => c.id), [work.id])
  assert.equal(liveCollections([home, work], list, "work", false).length, 2)
  assert.equal(liveCollections([deleteCollection(home, 3)], list, FIRST_SPACE, false).length, 0)
})

test("the background syncs collections next to the chats, merged, never as chats", () => {
  const sync = readFileSync(new URL("../src/background/sync.ts", import.meta.url), "utf8")
  assert.match(sync, /const collectionsSent = collectionChanges\(/)
  assert.match(sync, /takeCloudCollections\(changes\.filter\(\(c\) => isCollectionId\(c\.id\)\), collectionsSent, collectionsSynced\)/)
  assert.match(sync, /const taken = takeCollection\(all\[c\.id\], c\)/)
})

test("usage: counts only", () => {
  const spec = FEATURES.collect
  assert.equal(spec.since, "2.7")
  assert.deepEqual(useFields({ f: "collect", a: "add", via: "app", name: "Trip", cards: 3 }), { f: "collect", a: "add", via: "app", cards: 3 })
})

test("a collection kept on this device loads back and takes the next edit (its stored form has no kind)", () => {
  const rec = addCard(newCollection("cf-col-1", "Trip", undefined, 1000, { id: "s", name: "Stay" }), { id: "c", sec: "s", k: "answer", t: "Shinjuku", at: 1000 }, 1001)
  const stored = changedCollection(undefined, rec, 1002)
  // The panel's load and saveCollection read it this way (store.ts collectionsOf).
  const back = cleanCollection(stored.rec, "cf-col-1")
  assert.ok(back)
  assert.deepEqual(back!.c.map((c) => c.t), ["Shinjuku"])
  assert.ok(sameCollection(back!, rec))
  // A copy that says it's something else isn't one.
  assert.equal(cleanCollection({ ...rec, kind: "chat" }, "cf-col-1"), null)
})
