// Round 142, the director's decision 10: on a page that takes payment a nav word that moves the purchase forward is the
// person's own; one that leads away or shows more stays quiet. Off a payment page nothing changes.
import assert from "node:assert/strict"
import { test } from "node:test"

import { classify } from "../src/shared/agent/classify.ts"
import type { PageMap } from "../src/shared/agent/types.ts"

// [language, forward, away] in the panel's 15 languages.
const PAIRS: [string, string, string][] = [
  ["en", "Continue", "Continue shopping"], ["ru", "Продолжить", "Назад"], ["uk", "Продовжити", "Показати ще"],
  ["de", "Weiter", "Weiter einkaufen"], ["fr", "Continuer", "Continuer mes achats"], ["es", "Continuar", "Seguir comprando"],
  ["it", "Procedi", "Indietro"], ["pt", "Próximo", "Voltar"], ["tr", "Devam et", "Alışverişe devam et"],
  ["ja", "次へ", "買い物を続ける"], ["ko", "계속", "쇼핑 계속하기"], ["zh-Hans", "去结算", "继续购物"],
  ["zh-Hant", "前往結帳", "繼續購物"], ["vi", "Tiếp tục", "Tiếp tục mua sắm"], ["ar", "متابعة", "رجوع"]
]
const cls = (label: string, pay: boolean) => {
  const map = { url: "https://shop.example/order", title: "", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "", items: [{ id: "1", role: "button", label }], ...(pay ? { pay: true } : {}) } as PageMap
  return classify({ tool: "click", id: "1", why: "", expect: { label, role: "button" } } as never, { map, startHost: "shop.example", request: "Finish my order", confirmedHere: false, policy: {} } as never)
}

test("on a page that takes payment: forward is the person's own, away stays as it was, in all 15 languages", () => {
  for (const [lang, forward, away] of PAIRS) {
    assert.deepEqual(cls(forward, true), { cls: "self", reason: "pay" }, `${lang} ${forward}`)
    assert.deepEqual(cls(away, true), cls(away, false), `${lang} ${away}`)
    assert.notEqual(cls(away, true).cls, "self", `${lang} ${away}`)
  }
  for (const w of ["Next", "Checkout", "Back", "Show more", "Search", "View cart"]) assert.ok(cls(w, true).cls === (["Next", "Checkout"].includes(w) ? "self" : "free"), w)
})

test("off a payment page both directions are as before (free nav)", () => {
  for (const [lang, forward, away] of PAIRS) {
    assert.equal(cls(forward, false).cls, "free", `${lang} ${forward}`)
    assert.equal(cls(away, false).cls, "free", `${lang} ${away}`)
  }
})
