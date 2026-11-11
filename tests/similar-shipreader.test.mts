// Find similar: a small model reads a shop's delivery page, and our code checks what its quote proves (2.6). No quote,
// a quote not on the page, or one that doesn't show the verdict, is "not shown".
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { checkShipQuote, shipExcerpt, shipsTo } = await import("../netlify/shared/similar.mts")

const page = [
  "Shipping and returns.",
  "Orders are dispatched within 2 working days from our warehouse in Lyon.",
  "We ship to France, Belgium, Germany and Italy.",
  "International shipping is not available for furniture.",
  "Our team is happy to help with any question about your order.",
  "Wir liefern nicht in die Schweiz."
].join(" ")

test("the reader sees the page's sentences about shipping, abroad or the country, and nothing else", () => {
  const ex = shipExcerpt(page, "DE", ["en", "fr", "de"])
  assert.match(ex, /We ship to France, Belgium, Germany and Italy\./)
  assert.match(ex, /International shipping is not available/)
  assert.doesNotMatch(ex, /happy to help/)
  assert.equal(shipExcerpt("Our team is happy to help. Call us any day.", "DE", ["en"]), "")
})

test("a quote must be on the page and show the verdict: the country, worldwide or the EU; a refusal with a negation or 'only'", () => {
  const langs = ["en", "fr", "de"]
  assert.equal(checkShipQuote("ships", "We ship to France, Belgium, Germany and Italy.", page, "DE", langs), "yes")
  // Not on the page (made up, or changed): not shown.
  assert.equal(checkShipQuote("ships", "We ship to Germany and Austria.", page, "DE", langs), "unknown")
  // On the page, but it doesn't name the country or anywhere wider.
  assert.equal(checkShipQuote("ships", "Orders are dispatched within 2 working days from our warehouse in Lyon.", page, "AT", langs), "unknown")
  // A "ships" quote our rules read as a refusal.
  assert.equal(checkShipQuote("ships", "Wir liefern nicht in die Schweiz.", page, "CH", langs), "unknown")
  assert.equal(checkShipQuote("doesnt", "Wir liefern nicht in die Schweiz.", page, "CH", langs), "no")
  assert.equal(checkShipQuote("doesnt", "International shipping is not available for furniture.", page, "JP", langs), "no")
  // A refusal must carry its words: a list of other countries alone doesn't refuse; nor does an "only" about rates or a
  // service, or a refusal of another country.
  assert.equal(checkShipQuote("doesnt", "We ship to France, Belgium, Germany and Italy.", page, "ES", langs), "unknown")
  const rates = "These shipping rates apply to deliveries within Portugal only. Express shipping is unavailable for islands. Sorry, we can't currently ship to Norway."
  assert.equal(checkShipQuote("doesnt", "These shipping rates apply to deliveries within Portugal only.", rates, "BR", ["en", "pt"]), "unknown")
  assert.equal(checkShipQuote("doesnt", "Express shipping is unavailable for islands.", rates, "BR", ["en", "pt"]), "unknown")
  assert.equal(checkShipQuote("doesnt", "Sorry, we can't currently ship to Norway.", rates, "BR", ["en", "pt"]), "unknown")
  assert.equal(checkShipQuote("doesnt", "Sorry, we can't currently ship to Norway.", rates, "NO", ["en", "no"]), "no")
  // A country picker's line isn't shipping there.
  assert.equal(checkShipQuote("ships", "Austria (EUR)", "Change your country: Austria (EUR) Belgium (EUR)", "AT", ["en", "de"]), "unknown")
  // A "doesnt" quote our rules read as shipping there.
  assert.equal(checkShipQuote("doesnt", "We ship to France, Belgium, Germany and Italy.", page, "DE", langs), "unknown")
  assert.equal(checkShipQuote("unclear", "", page, "DE", langs), "unknown")
  // Worldwide, and the EU for an EU country.
  const eu = "Livraison dans toute l'Union européenne sous 5 jours."
  assert.equal(checkShipQuote("ships", eu, eu, "PT", ["fr", "pt"]), "yes")
  assert.equal(checkShipQuote("ships", eu, eu, "CH", ["fr", "de"]), "unknown")
  const ww = "海外発送も承ります。"
  assert.equal(checkShipQuote("ships", ww, ww, "KR", ["ja", "ko"]), "yes")
})

test("the error bank: the reader's recorded responses on 208 labelled delivery cases, re-checked: no right one goes wrong, no wrong verdict grows", (t) => {
  const { cases } = JSON.parse(readFileSync(new URL("./fixtures/similar-bank/delivery-model.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; set: string; country: string; langs: string[]; excerpt: string; verdict: string; quote: string; truth: string; expect: string }> }
  assert.equal(cases.length, 208)
  const now = cases.map((c) => ({ ...c, now: checkShipQuote(c.verdict, c.quote, c.excerpt, c.country, c.langs) }))
  assert.deepEqual(now.filter((c) => c.expect === c.truth && c.now !== c.truth).map((c) => c.id), [])
  for (const set of ["tuned", "held-out", "fresh"]) {
    const wrong = (key: "expect" | "now", v: string) => now.filter((c) => c.set === set && c[key] === v && c.truth !== v).length
    assert.ok(wrong("now", "yes") <= wrong("expect", "yes") && wrong("now", "no") <= wrong("expect", "no"), set)
    const n = now.filter((c) => c.set === set)
    t.diagnostic(`${set}: ${n.filter((c) => c.now === c.truth).length}/${n.length} right; wrong "ships there" ${wrong("now", "yes")}, wrong "doesn't ship" ${wrong("now", "no")}; real yes ${n.filter((c) => c.now === "yes" && c.truth === "yes").length}/${n.filter((c) => c.truth === "yes").length}`)
  }
})

test("a refusal after the country's name, in any language (the overfit review, S9): rules and the reader's quote", () => {
  const refusals: Array<[string, string, string[]]> = [
    ["Nach Österreich liefern wir leider nicht.", "AT", ["de"]],
    ["В Казахстан доставка не осуществляется.", "KZ", ["ru"]],
    ["До Польщі доставка не здійснюється.", "PL", ["uk"]],
    ["Giao hàng đến Lào hiện không hỗ trợ.", "LA", ["vi"]],
    ["Delivery to Canada: not available.", "CA", ["en"]],
    ["Envíos a México: no disponibles por ahora.", "MX", ["es"]],
    ["Spedizioni in Svizzera non disponibili.", "CH", ["it"]],
    ["Livraison en Suisse : non disponible.", "CH", ["fr"]],
    ["Entregas para Angola não estão disponíveis.", "AO", ["pt"]],
    ["الشحن إلى لبنان غير متاح حاليا.", "LB", ["ar"]]
  ]
  for (const [text, country, langs] of refusals) {
    assert.equal(shipsTo(text, country, langs), "no", `rules: ${text}`)
    // The reader saying so is taken; the reader saying it ships, on that quote, isn't.
    assert.equal(checkShipQuote("doesnt", text, text, country, langs), "no", `doesnt: ${text}`)
    assert.equal(checkShipQuote("ships", text, text, country, langs), "unknown", `ships: ${text}`)
  }
  // A "not" about another part of the sentence (between other commas) or about a cost isn't a refusal.
  assert.equal(shipsTo("We ship to Canada, no minimum order.", "CA", ["en"]), "yes")
  assert.equal(shipsTo("Wir liefern nach Österreich, nicht aber auf Inseln.", "AT", ["de"]), "yes")
  assert.equal(shipsTo("Livraison en France, pas de frais cachés.", "FR", ["fr"]), "yes")
  assert.equal(shipsTo("Shipping to Canada isn't free.", "CA", ["en"]), "unknown")
  assert.equal(checkShipQuote("ships", "Shipping to Canada isn't free.", "Shipping to Canada isn't free.", "CA", ["en"]), "unknown")
  assert.equal(checkShipQuote("ships", "We ship to Canada.", "We ship to Canada.", "CA", ["en"]), "yes")
})
