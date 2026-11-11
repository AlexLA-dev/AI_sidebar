// Find similar: a small model reads a shop's delivery page, and our code checks what its quote proves (2.6). No quote,
// a quote not on the page, or one that doesn't show the verdict, is "not shown".
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { checkShipQuote, shipExcerpt } = await import("../netlify/shared/similar.mts")

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
  // A refusal must carry its words: a list of other countries alone doesn't refuse.
  assert.equal(checkShipQuote("doesnt", "We ship to France, Belgium, Germany and Italy.", page, "ES", langs), "unknown")
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
