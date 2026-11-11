// Build 95: a text written for the ear is cut into the same parts however it came: streamed from the server the first
// time, whole from this device or iCloud on a replay. A part's key is its words, so before this a replay was new parts:
// its audio made again and its seconds counted in the week's minutes again. (The app's side: tests/speech-parity.)
import assert from "node:assert/strict"
import { test } from "node:test"

import { PartSplitter, speechText } from "../src/shared/speech.ts"

const SCRIPT = "Here are the three options. The first one, the Backvac Pro, costs 189 euros and folds flat for travel. The second, the Pro Max, has wheels and a bigger frame, but it costs 272 euros and weighs more. The third is the Lite, which is the cheapest at 129 euros, though it has no rain cover. If you want wheels under 200 euros, none of these fits; the Pro is the closest. Overall the Pro is the best value for most people who fly a few times a year."

function parts(text: string, step: number, first = true): string[] {
  const splitter = new PartSplitter(first)
  const out: string[] = []
  if (step <= 0) out.push(...splitter.push(text))
  else for (let at = 0; at < text.length; at += step) out.push(...splitter.push(text.slice(at, at + step)))
  return [...out, ...splitter.end()]
}

test("a text written for the ear: the same parts streamed in any pieces and whole (a replay)", () => {
  const texts = [
    SCRIPT,
    "Short first. Then a much longer sentence follows here, long enough to be a part of its own and then some more words.",
    speechText("## Short answer\n\nYes, it folds flat.\n\n- Weight: 6.2 kg\n- Wheels: no\n- Price: 189 €\n- Rain cover: included\n\nThe Pro is the best value for most people."),
    "Ответ: да. Модель Pro складывается, а у Pro Max есть колёса, но она дороже. Что выбрать? Если летаете пару раз в год, хватит Pro.",
    "这是什么？这是一款可折叠的旅行背包。它的价格是189欧元，重6.2公斤。总结：适合经常出差的人。".repeat(4)
  ]
  for (const text of texts) {
    for (const first of [true, false]) {
      const whole = parts(text, 0, first)
      for (const step of [1, 2, 5, 13, 40, 120]) assert.deepEqual(parts(text, step, first), whole, `by ${step}: ${text.slice(0, 40)}`)
    }
  }
  // The first part still comes early: its first sentence that says something.
  assert.equal(parts(SCRIPT, 0)[0], "Here are the three options. The first one, the Backvac Pro, costs 189 euros and folds flat for travel.")
})
