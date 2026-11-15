// 2.7 audit, the owner: every new feature works as well for everyone. Check and Rewrite waited for a space between two
// words, so Japanese, Chinese and Thai (written without spaces) never got the circle on a Mac, Check and Rewrite atop the
// list on iPhone and iPad, the underlines or style samples; and a whole sentence there was one word, so one wrong
// character underlined all of it. Now their characters count, and a run of them is cut into its words.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { DENSE_ENOUGH, denseChars, diffWords, keepSample, liveIssues, liveWorthy, paragraphs, tokens, weightedLength, worthWriting } from "../src/shared/writing.ts"

const CASES = {
  ja: { wrong: "私は昨日学校に行きました。", right: "私は昨日学校へ行きました。", bad: "に", good: "へ", short: "はい", sample: "来週の打ち合わせの件ですが、資料は金曜日までにお送りします。よろしくお願いいたします。" },
  zh: { wrong: "我昨天去了图书管看书。", right: "我昨天去了图书馆看书。", bad: "管", good: "馆", short: "好的", sample: "关于下周的会议，我会在周五之前把资料发给你，有问题随时联系我。" },
  th: { wrong: "ผมไปตลาดเมือวานนี้", right: "ผมไปตลาดเมื่อวานนี้", bad: "เมือ", good: "เมื่อ", short: "ครับ", sample: "เรื่องประชุมสัปดาห์หน้า ผมจะส่งเอกสารให้ก่อนวันศุกร์ครับ ขอบคุณครับ" }
} as const

for (const [lang, c] of Object.entries(CASES)) {
  test(`${lang}: the circle, Check and Rewrite in the list, the underlines and style samples, from a short sentence`, () => {
    // The circle on a Mac and the list's Check and Rewrite on iPhone and iPad: both go by worthWriting.
    assert.equal(worthWriting(c.wrong), true, c.wrong)
    // A word or two isn't enough, as in any language.
    assert.equal(worthWriting(c.short), false, c.short)
    assert.ok(denseChars(c.wrong) >= DENSE_ENOUGH)
    // The underlines check the paragraph after a pause.
    assert.equal(liveWorthy({ from: 0, to: c.wrong.length, text: c.wrong }), true)
    assert.equal(liveWorthy({ from: 0, to: c.short.length, text: c.short }), false)
    // A few sentences written on a site are kept as a style sample (a character counts as two toward the minimum).
    assert.ok(weightedLength(c.sample) > c.sample.length)
    const kept = keepSample({}, "mail.example", c.sample, 1_000)
    assert.equal(kept["mail.example"]?.[0]?.t, c.sample)
  })

  test(`${lang}: an underline covers only the wrong word, not the sentence`, () => {
    const edits = diffWords(c.wrong, c.right)
    assert.equal(edits.length, 1, JSON.stringify(edits))
    assert.equal(c.wrong.slice(edits[0].from, edits[0].to), c.bad)
    assert.equal(edits[0].text, c.good)
    // As the underlines place it in a field: a line above, the paragraph below.
    const text = `${c.short}\n${c.wrong}`
    const issues = liveIssues(new Map([[c.wrong, edits]]), paragraphs(text))
    assert.deepEqual(issues.map((i) => [text.slice(i.from, i.to), i.text]), [[c.bad, c.good]])
  })
}

test("a run of Chinese, Japanese or Thai is cut into its words; spaced languages stay as they were", () => {
  // Where the words break is the system's (ICU's) call and may differ a little between systems: what holds is that the
  // run comes back whole, in several short pieces.
  for (const run of ["私は学校へ行きます。", "我去图书馆看书", "ผมไปตลาดเมื่อวานนี้"]) {
    const parts = tokens(run)
    assert.equal(parts.join(""), run)
    assert.ok(parts.length >= 3 && parts.every((p) => [...p].length <= 5), JSON.stringify(parts))
  }
  // Latin inside a Japanese run keeps its own word.
  assert.equal(tokens("iPhoneの設定")[0], "iPhone")
  // Unchanged elsewhere: apostrophes and hyphens inside a word, spaces as their own tokens, Korean by its spaces.
  assert.deepEqual(tokens("it's well-known, ok"), ["it's", " ", "well-known", ",", " ", "ok"])
  assert.deepEqual(tokens("내일 회의 있어요"), ["내일", " ", "회의", " ", "있어요"])
  assert.equal(worthWriting("내일 회의"), true)
  assert.equal(weightedLength("Hello there"), 11)
})

test("the field's circle and its list items go by the same rule", () => {
  const quick = readFileSync(new URL("../src/content/insert/QuickInsert.tsx", import.meta.url), "utf8")
  assert.match(quick, /const canWrite = \(f: Field \| null\) => Boolean\([\s\S]{0,200}?worthWriting\(/)
  assert.match(quick, /onWrite=\{canWrite\(fieldRef\.current\)/)
  assert.match(quick, /props\.live && settings\.underline && !mode && field && canWrite\(field\)/)
})

test("the Calendar and Reminders prompt's example names no country's route", () => {
  const items = readFileSync(new URL("../netlify/shared/items.mts", import.meta.url), "utf8")
  assert.doesNotMatch(items, /Moscow|Sochi|SU 1234/)
  assert.match(items, /an event names it \("Dentist appointment"\)/)
})
