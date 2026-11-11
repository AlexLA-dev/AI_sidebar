// Find similar's final list (2.6, build 98): the closest first, the condition and the price deciding only between
// items about as close; then as the chat keeps them. Every count (the notification's too) is this list's.
import assert from "node:assert/strict"
import { test } from "node:test"

const { closeAndLess, finalList, SIMILARITY_BAND } = await import("../src/shared/similar.ts")
type Item = import("../src/shared/similar.ts").SimilarItem
const item = (name: string, similarity: number, over: Partial<Item> = {}): Item =>
  ({ name, url: `https://${name.toLowerCase().replace(/\W+/g, "")}.example`, host: "x", title: name, why: "", fit: "", met: "unknown", source: "item", checked: true, similarity, ...over })

test("the closest first: an 80 % item that misses the chip goes before 60 % ones the price couldn't confirm", () => {
  const list = finalList([item("Alpha", 60), item("Beta", 60), item("Gamma", 80, { met: "no", price: "49.99 USD" })])
  assert.deepEqual(list.map((i) => i.name), ["Gamma", "Alpha", "Beta"])
})

test("one that misses the condition never goes above one that meets it, whatever their similarity (the overfit review, S3)", () => {
  // The writer's rule ("items that meet it first"): a 60 % "yes" before an 80 % "no".
  assert.deepEqual(finalList([item("NotCheaper", 80, { met: "no" }), item("CheaperYes", 60, { met: "yes" }), item("Other", 60)]).map((i) => i.name), ["CheaperYes", "NotCheaper", "Other"])
  // The "yes" moves up just above the first "no"; the rest keep their order (an 80 % "no" stays above a 70 % one not confirmed).
  assert.deepEqual(finalList([item("No80", 80, { met: "no" }), item("Unk70", 70), item("Yes60", 60, { met: "yes" }), item("Unk60", 60)]).map((i) => i.name), ["Yes60", "No80", "Unk70", "Unk60"])
  // Without a "yes", similarity still decides: the 80 % "no" above the 60 % ones not confirmed (build 98, kept).
  assert.deepEqual(finalList([item("Unk60", 60), item("No80", 80, { met: "no" })]).map((i) => i.name), ["No80", "Unk60"])
  // Two "yes" items keep their own order; a "no" below every "yes" stays where it is.
  assert.deepEqual(finalList([item("Y90", 90, { met: "yes" }), item("N85", 85, { met: "no" }), item("Y70", 70, { met: "yes" }), item("Y65", 65, { met: "yes" })]).map((i) => i.name), ["Y90", "Y70", "Y65", "N85"])
  // The same item at another shop still leads, met or not.
  assert.equal(finalList([item("Same", 100, { same: true, met: "no" }), item("Alt", 70, { met: "yes" })])[0].name, "Same")
})

test("about as close (within the band): the one that meets the condition, then the cheaper, in their money", () => {
  assert.equal(SIMILARITY_BAND, 10)
  const list = finalList([
    item("Dear", 80, { met: "yes", price: "120 EUR" }),
    item("Cheap", 80, { met: "yes", price: "99 EUR" }),
    item("Miss", 80, { met: "no", price: "59 EUR" }),
    item("Abroad", 80, { met: "yes", price: "130 USD", priceLocal: "95 EUR" })
  ])
  assert.deepEqual(list.map((i) => i.name), ["Abroad", "Cheap", "Dear", "Miss"])
  // The same item at another shop leads, whatever its price.
  assert.equal(finalList([item("Other", 100, { met: "yes", price: "10 EUR" }), item("Same", 100, { same: true, met: "yes", price: "300 EUR" })])[0].name, "Same")
})

test("the list as the chat keeps it, so every count says what the chat shows", () => {
  // Three close ones: the less similar one isn't shown, so it isn't counted (the notification said 4, the chat 3).
  const list = finalList([item("A", 80), item("B", 60), item("C", 60), item("D", 40)])
  assert.deepEqual(list.map((i) => i.name), ["A", "B", "C"])
  const { close, less } = closeAndLess(list)
  assert.equal(close.length + less.length, list.length)
  // None close: the best of them leads, three more at most.
  assert.deepEqual(finalList([20, 40, 30, 50, 10].map((n) => item(`S${n}`, n))).map((i) => i.name), ["S50", "S40", "S30", "S20"])
})
