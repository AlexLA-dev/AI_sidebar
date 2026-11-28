// Round 142, the director's decision 11: a listing's card in scripts written without spaces (Han, Hiragana, Katakana,
// Hangul count two in the amount rule's card length; the «from» joined to its price counts), on pages that don't take payment.
import assert from "node:assert/strict"
import { test } from "node:test"

import { classify } from "../src/shared/agent/classify.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

const cls = (label: string, opts: { role?: string; pay?: boolean } = {}) => {
  const role = opts.role ?? "link"
  const map = { url: "https://places.example/list", title: "", lang: "ja", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role, label, href: "/p/1" }], ...(opts.pay ? { pay: true } : {}) } as PageMap
  return classify({ tool: "click", id: "1", why: "", expect: { label, role } } as never, { map, startHost: "places.example", request: "予約して", confirmedHere: false, policy: {} } as never)
}
const PAY = { cls: "self", reason: "pay" }

// Cards of 21 or more such characters with a price (under 40 raw characters, so today's rule called them pay).
const CARDS = [
  "鮨さいとう 港区六本木 カウンター席 おまかせコース ¥30,000",
  "살롱 미라 강남역 헤어 커트 펌 염색 전문 리뷰 이백십개 €35",
  "福和慧 上海静安区素食餐厅 米其林推荐 人均消费 ¥300",
  "足湯養生館 台北大安區 經絡按摩 精油推拿 評價很好 NT$900"
]

test("a card of 21+ CJK characters with a price isn't pay by the amount rule (ja, ko, zh-Hans, zh-Hant)", () => {
  for (const c of CARDS) {
    assert.ok([...c].filter((ch) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)).length >= 21, c)
    assert.ok(c.length <= 40, `${c} is short in raw characters`)
    assert.notDeepEqual(cls(c), PAY, c)
  }
})

test("short priced links stay the person's own; priced buttons of any length stay pay; a payment page is as today", () => {
  for (const l of ["今すぐ購入 ¥3,500", "¥3,500で購入", "결제 35,000원", "立即购买 ¥300", "カット €35", "커트 €35", "剪发 ¥300"]) assert.deepEqual(cls(l), PAY, l)
  for (const c of CARDS) {
    assert.deepEqual(cls(c, { role: "button" }), PAY, `button ${c}`)
    assert.deepEqual(cls(c, { pay: true }), PAY, `payment page ${c}`)
  }
})

test("«from» joined to its price is a «from»; a bare «から» elsewhere isn't", () => {
  for (const l of ["カット €35から", "カット 3,500円〜", "커트 35,000원부터", "剪发 ¥300起", "カット ¥3,500～"]) assert.notDeepEqual(cls(l), PAY, l)
  for (const l of ["東京から ¥3,500", "京都から大阪 ¥3,500"]) assert.deepEqual(cls(l), PAY, l)
})

test("the stand's Japanese card, unchanged: 40 raw characters, 51 counted, no longer pay", () => {
  assert.notDeepEqual(cls("Salon Mira ★ 4.8 · 210 件のレビュー カット €35 予約"), PAY)
})
