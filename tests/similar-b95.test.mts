// Build 95, Find similar (the owner's notes on 94): a chip is weighed softly, their own words strictly; the very item
// at another shop when they asked for it cheaper or in stock; prices in their currency (the ECB's rates of the day);
// the servers' one-call search keeps the same rules as the parallel one (one marketplace listing at most).
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { describePage } = await import("../netlify/shared/pagecheck.mts")
const { askedLines, checkCondition, checkPlan, finishItems, localPrice, modelKey, rescueQueries, sameAsSubject, sameModel, whereLine, writeMessage, Claims, WRITE_SYSTEM } = await import("../netlify/shared/similar.mts")
const { convert, currencyOf, parseEcb, roughAmount } = await import("../netlify/shared/money.mts")
const { cleanItem, similarMarkdown } = await import("../src/shared/similar.ts")
type Plan = import("../netlify/shared/similar.mts").Plan
type CheckedCandidate = import("../netlify/shared/similar.mts").CheckedCandidate

const rates = { EUR: 1, USD: 1.16, GBP: 0.87 }
const words = "A 575-piece LEGO City steam train with a tender and two carriages, for kids from 7. ".repeat(4)
const html = (title: string, head = "") => `<html lang="de"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${words}</p></main></body></html>`
const offer = (amount: string, currency = "EUR", stock = "InStock") => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", price: amount, priceCurrency: currency, availability: `https://schema.org/${stock}` } })}</script>`
const plan = (over: Partial<Plan> = {}): Plan => ({
  category: "product", subject: "LEGO City Klassischer Dampfzug 60511", traits: ["LEGO City set", "steam train", "575 pieces", "age 7+", "about 90 EUR"],
  condition: { kind: "cheaper", maxPrice: 0, currency: "EUR", language: "", place: "", soft: true }, sourcePrice: 89.99, sourceCurrency: "EUR",
  queries: ["LEGO 60511 günstig"], language: "de", money: { currency: "EUR", rates }, ...over
})
const source = { title: "Klassischer Dampfzug 60511 | LEGO", url: "https://www.lego.com/de-de/product/vintage-steam-train-60511", text: "LEGO City Klassischer Dampfzug" }
const facts = { price: { amount: 89.99, currency: "EUR" } }

function page(url: string, title: string, head: string, p = plan(), f: typeof facts = facts): CheckedCandidate {
  const checked = describePage(html(title, head), url, url, 200, 0)
  const condition = checkCondition(p, f, checked)
  return { url, name: title, kind: "item", resultTitle: title, pageAge: null, page: checked, score: 1, condition, kept: true, why: "ok" }
}

// ---- their money ----------------------------------------------------------------------------------

test("their currency by country, the ECB's rates read and used, amounts rounded as people read them", () => {
  assert.equal(currencyOf("CY"), "EUR")
  assert.equal(currencyOf("de"), "EUR")
  assert.equal(currencyOf("BG"), "EUR")
  assert.equal(currencyOf("US"), "USD")
  assert.equal(currencyOf("GB"), "GBP")
  assert.equal(currencyOf("RU"), "RUB")
  assert.equal(currencyOf("XX"), "")
  const xml = `<gesmes:Envelope><Cube><Cube time='2026-11-10'><Cube currency='USD' rate='1.1600'/><Cube currency='GBP' rate='0.8700'/></Cube></Cube></gesmes:Envelope>`
  const r = parseEcb(xml)!
  assert.equal(r.EUR, 1)
  assert.equal(r.USD, 1.16)
  assert.ok(Math.abs(r.AED - 1.16 * 3.6725) < 1e-9, "a currency pegged to the dollar")
  assert.equal(parseEcb("<html>maintenance</html>"), null)
  assert.equal(Math.round(convert(132.29, "USD", "EUR", r)!), 114)
  assert.equal(convert(10, "EUR", "EUR", null), 10)
  assert.equal(convert(10, "XYZ", "EUR", r), null)
  assert.equal(roughAmount(114.04, "EUR"), "114 EUR")
  assert.equal(roughAmount(7.456, "EUR"), "7.46 EUR")
  assert.equal(localPrice({ amount: 132.29, currency: "USD" }, { currency: "EUR", rates: r }), "114 EUR")
  assert.equal(localPrice({ amount: 99, currency: "EUR" }, { currency: "EUR", rates: r }), "")
})

test("cheaper across currencies: at the day's rate with a margin either way; without rates, not confirmed as before", () => {
  const p = plan({ condition: { kind: "cheaper", maxPrice: 0, currency: "EUR", language: "", place: "" } })
  const at = (amount: number, currency: string, over: Partial<Plan> = {}) => checkCondition({ ...p, ...over }, { price: { amount: 249, currency: "EUR" } }, { ...describePage(html("x"), "https://x.test", "https://x.test", 200, 0), price: { amount, currency } })
  assert.equal(at(132.29, "USD").met, "yes")
  assert.match(at(132.29, "USD").note, /≈ 114 EUR/)
  assert.equal(at(330, "USD").met, "no")
  assert.equal(at(285, "USD").met, "unknown", "about the same after conversion")
  assert.equal(at(132.29, "USD", { money: { currency: "EUR", rates: null } }).met, "unknown")
})

test("near them: shops that sell there, in their money; a shop abroad comes last", () => {
  const line = whereLine({ page: source, facts: {}, condition: "", locale: "en-CY", region: "local", country: "CY" })
  assert.match(line, /Cyprus \(CY\)/)
  assert.match(line, /prices in EUR/)
  assert.match(line, /another country or another currency comes last/)
})

// ---- chips softly, their words strictly -------------------------------------------------------------

test("the plan: a chip is the kind and weighed softly; a price their words name holds; their words never come to none", () => {
  const base = { page: source, facts: {}, locale: "de-DE" }
  const chip = checkPlan({ condition: { kind: "other" }, queries: ["q"] }, { ...base, condition: "Günstiger", chip: "cheaper" })
  assert.equal(chip.condition.kind, "cheaper")
  assert.equal(chip.condition.soft, true)
  assert.equal(chip.words, undefined)
  const both = checkPlan({ condition: { kind: "cheaper", max_price: 200 }, queries: ["q"] }, { ...base, condition: "Günstiger, unter 200 €", chip: "cheaper", words: "unter 200 €" })
  assert.equal(both.condition.maxPrice, 200)
  assert.equal(both.condition.soft, undefined, "their own price limit holds strictly")
  assert.equal(both.words, "unter 200 €")
  const typed = checkPlan({ condition: { kind: "none" }, queries: ["q"] }, { ...base, condition: "fragrance-free, for sensitive skin", words: "fragrance-free, for sensitive skin" })
  assert.equal(typed.condition.kind, "other", "build 94 dropped «fragrance-free» as no condition")
  assert.equal(typed.condition.soft, undefined)
  // An older panel: the condition is their words, strict as before.
  const legacy = checkPlan({ condition: { kind: "cheaper" }, queries: ["q"] }, { ...base, condition: "Cheaper", words: "Cheaper" })
  assert.equal(legacy.condition.soft, undefined)
  assert.deepEqual(askedLines({ ...base, condition: "Günstiger, mit Hocker", chip: "cheaper", words: "mit Hocker" }), [
    "A quick choice they tapped: cheaper — weigh it, but close alternatives that miss it are still worth showing.",
    "Their own words, which must hold: \"mit Hocker\""
  ])
})

test("a close item that misses the chip comes last, only when fewer than 3 close ones meet it; their words must hold", () => {
  const p = plan({ subject: "KitchenAid Artisan 5KSM125", traits: ["stand mixer", "4.7 L bowl", "tilt head", "10 speeds", "metal body"], sourcePrice: 351.2 })
  const mixer = { price: { amount: 351.2, currency: "EUR" } }
  const pages = [
    page("https://a.test/kenwood", "Kenwood Chef Titanium", offer("299"), p, mixer),
    page("https://b.test/bosch", "Bosch MUM9 OptiMUM", offer("399"), p, mixer),
    page("https://c.test/smeg", "Smeg SMF03", offer("459"), p, mixer)
  ]
  assert.equal(pages[1].condition.met, "no")
  const raw = {
    intro: "", note: "",
    items: [
      { page: 1, name: "Kenwood Chef Titanium", why: "w", fit: "f", met: "yes", words_met: "n/a", same: false, shares: [1, 2, 3, 4], differs: "" },
      { page: 2, name: "Bosch MUM9 OptiMUM", why: "w", fit: "not cheaper: 399 EUR", met: "no", words_met: "n/a", same: false, shares: [1, 2, 3, 4, 5], differs: "" },
      { page: 3, name: "Smeg SMF03", why: "w", fit: "not cheaper", met: "no", words_met: "n/a", same: false, shares: [1, 2, 3, 4, 5], differs: "" }
    ]
  }
  const { result, dropped } = finishItems(raw, pages, p, source)
  assert.deepEqual(result.items.map((i) => [i.name, i.met]), [["Kenwood Chef Titanium", "yes"], ["Bosch MUM9 OptiMUM", "no"]], "399 EUR comes last; 459 EUR is too far over 351.20 EUR")
  assert.ok(dropped.some((d) => d.name === "Smeg SMF03" && d.why === "far from the chip"))
  // Three close ones meet it: the one that misses isn't needed.
  const many = [0, 1, 2].map((i) => page(`https://m${i}.test/x`, `Mixer Model ${i}00`, offer("199"), p, mixer))
  const raw2 = { intro: "", note: "", items: [...many.map((_, i) => ({ page: i + 1, name: `Mixer Model ${i}00`, why: "w", fit: "f", met: "yes", words_met: "n/a", same: false, shares: [1, 2, 3, 4], differs: "" })), { page: 4, name: "Bosch MUM9 OptiMUM", why: "w", fit: "f", met: "no", words_met: "n/a", same: false, shares: [1, 2, 3, 4, 5], differs: "" }] }
  assert.equal(finishItems(raw2, [...many, pages[1]], p, source).result.items.length, 3)
  // From their own words the condition holds strictly; and words the page contradicts drop the item.
  const strict = { ...p, condition: { ...p.condition, soft: undefined } }
  assert.deepEqual(finishItems(raw, pages.map((c) => ({ ...c })), strict, source).result.items.map((i) => i.name), ["Kenwood Chef Titanium"])
  const said = { ...p, words: "mit Glasschüssel" }
  const raw3 = { ...raw, items: [{ ...raw.items[0], words_met: "no" }, { ...raw.items[0], page: 3, name: "Smeg SMF03", met: "yes", words_met: "unknown" }] }
  const smeg = page("https://c.test/smeg", "Smeg SMF03", offer("249"), p, mixer)
  const out = finishItems(raw3, [pages[0], pages[1], smeg], said, source)
  assert.deepEqual(out.result.items.map((i) => [i.name, i.met]), [["Smeg SMF03", "unknown"]], "their words not shown on the page: not confirmed")
  assert.ok(out.dropped.some((d) => d.why === "fails their words"))
})

// ---- the same item, cheaper elsewhere ----------------------------------------------------------------

test("their very item at another shop that sells it cheaper: first, 100 %, at most two shops; never when it isn't cheaper", () => {
  const p = plan()
  const pages = [
    page("https://steinehelden.de/LEGO-Klassischer-Dampfzug-60511/60511", "LEGO City Klassischer Dampfzug 60511", offer("62.89")),
    page("https://www.spielemax.de/lego-60511", "LEGO City Klassischer Dampfzug 60511 Bauset", offer("94.99")),
    page("https://www.lego.com/de-de/product/vintage-steam-train-60511", "LEGO City Klassischer Dampfzug 60511", offer("89.99")),
    page("https://toys.test/train", "Playmobil Dampflok 70179", offer("49.99"))
  ]
  const raw = {
    intro: "", note: "",
    items: [
      { page: 1, name: "LEGO City Klassischer Dampfzug 60511", why: "w", fit: "62,89 €", met: "yes", words_met: "n/a", same: true, shares: [1, 2, 3, 4, 5], differs: "das gleiche Set bei Steinehelden" },
      { page: 2, name: "LEGO City Klassischer Dampfzug 60511 Bauset", why: "w", fit: "f", met: "no", words_met: "n/a", same: true, shares: [1, 2, 3, 4, 5], differs: "" },
      { page: 3, name: "LEGO City Klassischer Dampfzug 60511", why: "w", fit: "f", met: "no", words_met: "n/a", same: true, shares: [1, 2, 3], differs: "" },
      { page: 4, name: "Playmobil Dampflok 70179", why: "w", fit: "f", met: "yes", words_met: "n/a", same: false, shares: [2, 4], differs: "" }
    ]
  }
  const { result, dropped } = finishItems(raw, pages, p, source)
  assert.deepEqual(result.items.map((i) => [i.host, i.same ?? false, i.similarity]), [["steinehelden.de", true, 100], ["toys.test", false, 40]])
  assert.ok(dropped.filter((d) => d.why === "the item itself").length >= 2, "the dearer shop and the page they're on")
  // Without cheaper or in stock, their item is never one of the alternatives.
  const none = plan({ condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" } })
  assert.deepEqual(finishItems(raw, pages.map((c) => ({ ...c, condition: { met: "n/a" as const, note: "" } })), none, source).result.items.map((i) => i.host), ["toys.test"])
  assert.match(WRITE_SYSTEM, /the very same item at another shop/)
})

// ---- what goes out ------------------------------------------------------------------------------------

test("the writer is told the chip, their words and their currency; prices abroad come with ≈ theirs", () => {
  const p = plan({ words: "mit Anhänger" })
  const usd = page("https://us.test/train", "LEGO Steam Train 60511", offer("70", "USD"), p)
  const msg = writeMessage({ page: source, facts, condition: "Günstiger, mit Anhänger", locale: "de-DE", chip: "cheaper", words: "mit Anhänger" }, p, [usd])
  assert.match(msg, /a quick choice they tapped — cheaper \(weighed softly\)/)
  assert.match(msg, /Their own words \(a must\): "mit Anhänger"/)
  assert.match(msg, /Their currency: EUR/)
  assert.match(msg, /price 70 USD \(≈ 60 EUR at today's rate\)/)
  const { result } = finishItems({ intro: "", note: "", items: [{ page: 1, name: "LEGO Steam Train 60511", why: "w", fit: "f", met: "yes", words_met: "yes", same: false, shares: [1, 2], differs: "" }] }, [usd], p, source)
  assert.equal(result.items[0].priceLocal, "60 EUR")
  assert.equal(cleanItem({ ...result.items[0] })?.priceLocal, "60 EUR")
  assert.equal(cleanItem({ ...result.items[0], priceLocal: "≈ lots" })?.priceLocal, undefined)
})

test("the answer's text carries the price ≈ theirs, how close, how it differs and what people say (the app shows it)", () => {
  const md = similarMarkdown({
    intro: "Ähnliche Züge.",
    note: "",
    items: [
      { name: "LEGO 60511", why: "Gleiches Set.", fit: "62,89 €.", met: "yes", url: "https://s.test/a", host: "s.test", title: "t", source: "item", checked: true, price: "62.89 EUR", same: true, similarity: 100 },
      { name: "Playmobil 70179", why: "Dampflok.", fit: "", met: "unknown", url: "https://p.test/b", host: "p.test", title: "t", source: "item", checked: true, price: "70 USD", priceLocal: "60 EUR", similarity: 40, differs: "kein LEGO", reviews: { rating: { value: 4.6, best: 5, count: 687 }, pros: "stabil", sources: ["https://p.test/r"] } }
    ]
  }, {
    inStock: "Auf Lager", outOfStock: "Nicht auf Lager", notConfirmed: "Nicht bestätigt", notOpened: "x", percent: (n) => `${n} % ähnlich`, differs: (s) => `Unterschied: ${s}`,
    say: "Was andere sagen:", ratings: (n) => `${n} Bewertungen`, pros: (s) => `gelobt: ${s}`, cons: (s) => `kritisiert: ${s}`, same: "Gleicher Artikel, anderer Shop", misses: "m"
  })
  assert.match(md, /1\. \*\*\[LEGO 60511\]\(https:\/\/s\.test\/a\)\*\* \(s\.test\) — Gleiches Set\. 62,89 €\. _\(Gleicher Artikel, anderer Shop · 62\.89 EUR\)_/)
  assert.match(md, /_\(70 USD \(≈ 60 EUR\) · 40 % ähnlich · Nicht bestätigt\)_ Unterschied: kein LEGO\. Was andere sagen: ★ 4\.6 · 687 Bewertungen · gelobt: stabil\./)
})

// ---- the servers' one-call search ----------------------------------------------------------------------

test("the one-call search keeps one marketplace listing at most; a rescue round looks for alternatives near them", () => {
  const claims = new Claims(source)
  const c = (url: string, name: string) => ({ url, name, kind: "item" as const, resultTitle: name, pageAge: null })
  const taken = claims.take([c("https://www.amazon.com/a", "A"), c("https://www.amazon.de/b", "B"), c("https://www.walmart.com/c", "C"), c("https://shop.test/d", "D")])
  assert.deepEqual(taken.map((t) => t.name), ["A", "D"])
  const q = rescueQueries({ page: source, facts: {}, condition: "", locale: "en-CY", region: "local", country: "CY" }, plan())
  // Near them, the second round looks at shops abroad that deliver there (the first looked at the country's own).
  assert.deepEqual(q, ["LEGO City Klassischer Dampfzug 60511 alternatives delivery to Cyprus", "LEGO City set steam train shop delivers to Cyprus"])
  assert.deepEqual(rescueQueries({ page: source, facts: {}, condition: "", locale: "en-US", region: "world" }, plan()), ["LEGO City Klassischer Dampfzug 60511 alternatives", "LEGO City set steam train"])
})

// ---- the notification's tap opens the panel ----------------------------------------------------------------

test("the page the notification opens names its chat in the address; the panel takes it out at once", async () => {
  const g = globalThis as unknown as { location: { hash: string; pathname: string; search: string; href: string }; history: { state: unknown; replaceState: (s: unknown, t: string, u: string) => void } }
  const urls: string[] = []
  const at = (hash: string) => {
    g.location = { hash, pathname: "/collections/vacuum-rollerbags", search: "?v=1", href: "" }
    g.history = { state: null, replaceState: (_s, _t, u) => urls.push(u) }
  }
  const { takeSimilarMark } = await import("../src/content/similar/mark.ts")
  at("#cf-similar=5f2c9e1a-4b7d-4c1e-9f00-1a2b3c4d5e6f")
  assert.equal(takeSimilarMark(), "5f2c9e1a-4b7d-4c1e-9f00-1a2b3c4d5e6f")
  assert.equal(urls.pop(), "/collections/vacuum-rollerbags?v=1")
  at("#reviews&cf-similar=abc_123")
  assert.equal(takeSimilarMark(), "abc_123")
  assert.equal(urls.pop(), "/collections/vacuum-rollerbags?v=1#reviews")
  at("#reviews")
  assert.equal(takeSimilarMark(), null)
  at("#cf-similar=../../etc")
  assert.equal(takeSimilarMark(), null)
  assert.equal(urls.length, 0)
})

// ---- one model once, and their item told apart ------------------------------------------------------------

test("one model in colours or at two shops is one item; other models of a brand are not", () => {
  const same = (a: string, b: string) => sameModel(modelKey(a)!, modelKey(b)!)
  assert.ok(same("Small Leather Wallet/ Vegetable tanned", "Small Leather Wallet/ Ocean blue"))
  assert.ok(same("Weber Spirit E-325 3-Burner LP Gas Grill", "Weber Spirit E-325 Liquid Propane Gas Grill"))
  assert.ok(same("Garmin Forerunner 970", "GARMIN 010-02969-10 Forerunner 970 Music Smartwatch, Black"))
  assert.ok(same("Allbirds Men's Tree Runner NZ", "Men's Tree Runner NZ"))
  assert.ok(!same("Weber Spirit E-325", "Weber Spirit E-310"))
  assert.ok(!same("Weber Spirit 3-Burner Gas Grill", "Weber Genesis 3-Burner Gas Grill"))
  assert.ok(!same("Sony WH-1000XM6", "Sony WH-1000XM5"))
  assert.ok(!same("Wantdo Women's Packable Puffer Jacket", "Wantdo Women's Hooded Puffer Jacket"))
  const p = plan({ subject: "Weber Spirit E-310", traits: ["gas grill", "3 burners", "side tables"], condition: { kind: "none", maxPrice: 0, currency: "", language: "", place: "" } })
  const pages = ["https://pcrichard.test/e325", "https://abt.test/e325"].map((u, i) => page(u, i ? "Weber Spirit E-325 Liquid Propane Gas Grill" : "Weber Spirit E-325 3-Burner LP Gas Grill", offer("549", "USD"), p))
  const raw = { intro: "", note: "", items: pages.map((c, i) => ({ page: i + 1, name: c.name, why: "w", fit: "f", met: "yes", words_met: "n/a", same: false, shares: [1, 2], differs: "" })) }
  assert.equal(finishItems(raw, pages, p, source).result.items.length, 1)
})

test("their very item: by its model words, else by the words that name it, not by its kind", () => {
  const lego = plan()
  assert.ok(sameAsSubject("LEGO® City Klassischer Dampfzug (60511); Bauset", lego))
  assert.ok(!sameAsSubject("LEGO City Güterzug 60336", lego))
  const chair = plan({ subject: "POÄNG Sessel mit Hocker", traits: ["Birkenfurnier-Gestell", "Bezug in Beige", "Mit Fußhocker", "Bequemer Relaxsessel", "Preis unter 200 €"] })
  assert.ok(sameAsSubject("IKEA POÄNG Sessel mit Hocker, beige", chair))
  assert.ok(!sameAsSubject("SVITA Charles Relaxsessel Hocker Sessel Fernsehsessel", chair))
})

test("a price without a currency on a country's own domain is in that country's money", async () => {
  const { domainCurrency } = await import("../netlify/shared/pagecheck.mts")
  assert.equal(domainCurrency("https://www.stephanis.com.cy/en/products/1"), "EUR")
  assert.equal(domainCurrency("https://shop.example.co.uk/x"), "GBP")
  assert.equal(domainCurrency("https://www.example.com/x"), "")
  const meta = `<meta property="product:price:amount" content="599.99">`
  const p = describePage(html("Philips EP3249", meta), "https://www.superhome.com.cy/p/1", "https://www.superhome.com.cy/p/1", 200, 0)
  assert.deepEqual(p.price, { amount: 599.99, currency: "EUR" })
})

test("an expired deal is no offer", () => {
  const p = describePage(html("LEGO 60511 for 56.99 EUR", offer("56.99")).replace("</main>", "<p>This deal has expired.</p></main>"), "https://deals.test/1", "https://deals.test/1", 200, 0)
  assert.equal(p.reason, "unavailable")
  assert.equal(checkCondition(plan(), facts, p).met, "no")
})
