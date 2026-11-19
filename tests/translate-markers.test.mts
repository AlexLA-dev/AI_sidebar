// 2.7, a page translated in place: the marked text of a block (src/shared/translate.ts). Links and emphasis go to the
// model as numbered tags; a translation is written back only when it keeps every tag once, inside the same tag.
import assert from "node:assert/strict"
import { test } from "node:test"

import { escapeText, modelLine, parseMarked, plainText, readModelLine, restoreVoids, sameTags, targetCode } from "../src/shared/translate.ts"

test("marked text parses into words, tag pairs and kept elements", () => {
  assert.deepEqual(parseMarked("Lies <1>hier</1> mehr<2/>."), ["Lies ", { tag: 1, kids: ["hier"] }, " mehr", { tag: 2, void: true }, "."])
  assert.deepEqual(parseMarked("<1>a <2>b</2></1>"), [{ tag: 1, kids: ["a ", { tag: 2, kids: ["b"] }] }])
  assert.deepEqual(parseMarked("no tags"), ["no tags"])
  for (const broken of ["<1>open", "close</1>", "<1>a</2>", "<1>a</1><1>b</1>", "<1>a<2>b</1></2>", "<0>x</0>"]) {
    assert.equal(parseMarked(broken), null, broken)
  }
})

test("a translation keeps the tags when each is there once, of its kind, inside the same tag; order may change", () => {
  const source = "Read <1>this <2>article</2></1> and <3>that</3><4/>."
  assert.ok(sameTags(source, "Прочтите <3>то</3> и <1>эту <2>статью</2></1><4/>."), "word order moved the links")
  assert.ok(!sameTags(source, "Прочтите <1>эту статью</1> и <3>то</3><4/>."), "a tag lost")
  assert.ok(!sameTags(source, "Прочтите <1>эту</1> <2>статью</2> и <3>то</3><4/>."), "a tag moved out of its parent")
  assert.ok(!sameTags(source, "Прочтите <1>эту <2/>статью</1> и <3>то</3><4>.</4>"), "kinds swapped")
  assert.ok(!sameTags(source, "Прочтите <1>эту <2>статью</2></1> и <3>то</3><4/><5>!</5>"), "a tag added")
})

test("only lost line breaks and icons are put back (at the end of their parent); anything else lost: null", () => {
  assert.equal(restoreVoids("Line one<1/>line two", "Строка один строка два"), "Строка один строка два<1/>")
  assert.equal(restoreVoids("<1>Docs<2/></1> here", "<1>Документы</1> здесь"), "<1>Документы<2/></1> здесь")
  assert.equal(restoreVoids("<1>Docs</1> here", "Документы здесь"), null)
  assert.equal(restoreVoids("a <1>b</1>", "а <1>б</1>"), "а <1>б</1>")
})

test("the page's own '<12>' can't pass for a tag", () => {
  assert.equal(escapeText("x <12> y </4> z <5/> a < b"), "x ‹12› y ‹/4› z ‹5/› a < b")
  assert.equal(plainText("a <1>b</1> c<2/>"), "a b c")
})

test("lines for the model: one block a line, numbered; the answer's lines read back", () => {
  assert.equal(modelLine(7, "  Hallo \n  <1>Welt</1>  "), "§7 Hallo <1>Welt</1>")
  assert.deepEqual(readModelLine("§7 Привет <1>мир</1>"), { n: 7, text: "Привет <1>мир</1>" })
  assert.deepEqual(readModelLine("§12: Ciao"), { n: 12, text: "Ciao" })
  assert.equal(readModelLine("Here is the translation:"), null)
  assert.equal(readModelLine("§3 "), null)
})

test("the language a page goes into: the base code, Chinese by its script", () => {
  assert.equal(targetCode("ru-RU"), "ru")
  assert.equal(targetCode("pt_BR"), "pt")
  assert.equal(targetCode("zh-TW"), "zh-Hant")
  assert.equal(targetCode("zh-Hant-HK"), "zh-Hant")
  assert.equal(targetCode("zh-CN"), "zh-Hans")
  assert.equal(targetCode("zh"), "zh-Hans")
})
