import assert from "node:assert/strict"
import { test } from "node:test"

import { fallbackRule, sameValue, shownValue, verdict } from "../src/shared/watch/compare.ts"
import { isOutOfStock } from "../src/shared/watch/detect.ts"
import { digest, locate, pageText, parseNumber, pickSource, readPage, readValue, structured } from "../src/shared/watch/extract.ts"

// Made-up pages in the shapes shops use (not copies of real ones).
const LD = (price: string, stock: string) => `<html><head><title>Mug</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug",
"offers":{"@type":"Offer","price":"${price}","priceCurrency":"EUR","availability":"https://schema.org/${stock}"}}</script>
</head><body><h1>Mug</h1><p>Price <b>${price} €</b></p><button>Add to cart</button></body></html>`

const META = `<html><head><meta property="product:price:amount" content="129.00">
<meta property="product:price:currency" content="USD"><meta property="product:availability" content="instock"></head>
<body><span itemprop="price" content="129.00">$129.00</span></body></html>`

const TEXT = (size42: string, price: string) => `<html><body><script>var x = "$1"</script>
<div class="sizes"><span>Size 41: in stock</span> <span>Size 42: ${size42}</span> <span>Size 43: sold out</span></div>
<div class="buy">Total <strong>${price}</strong> incl. VAT</div></body></html>`

test("prices and stock from JSON-LD, meta and microdata", () => {
  assert.deepEqual(structured(LD("49.85", "InStock")), { ldPrice: "49.85 EUR", ldStock: "InStock" })
  assert.deepEqual(structured(META), { metaPrice: "129.00 USD", metaStock: "instock" })
})

test("the page's text: no scripts, no tags, one space", () => {
  assert.equal(pageText('<p>a&nbsp;<b>b</b></p><script>c</script>\n\n<i>d</i>'), "a b d")
})

test("numbers as shops write them", () => {
  assert.equal(parseNumber("$1,299.99"), 1299.99)
  assert.equal(parseNumber("1.299,99 €"), 1299.99)
  assert.equal(parseNumber("34,500 円"), 34500)
  assert.equal(parseNumber("1 299 ₽"), 1299)
  assert.equal(parseNumber("€ 249,00"), 249)
  assert.equal(parseNumber("49.85 EUR"), 49.85)
  assert.equal(parseNumber("R$ 1.299,90"), 1299.9)
  assert.equal(parseNumber("no number"), null)
})

test("a selected price that the markup states is read from the markup", () => {
  const page = readPage(LD("49.85", "InStock"))
  assert.equal(pickSource(page, "price", "49.85 €"), "ld-price")
  assert.equal(pickSource(page, "stock", "Add to cart"), "ld-stock")
  assert.equal(readValue(readPage(LD("44.10", "OutOfStock")), { source: "ld-price", what: "price" }), "44.10 EUR")
  assert.equal(readValue(readPage(LD("44.10", "OutOfStock")), { source: "ld-stock", what: "stock" }), "OutOfStock")
})

test("a value in the text is found again by the words around it", () => {
  const page = readPage(TEXT("sold out", "$129.00"))
  assert.equal(pickSource(page, "stock", "sold out"), "text")
  const spot = locate(page.text, "sold out")!
  assert.ok(spot.before.endsWith("Size 42: "), spot.before)
  const again = readPage(TEXT("in stock", "$129.00"))
  assert.equal(readValue(again, { source: "text", what: "stock", ...spot }), "in stock")
  const price = locate(page.text, "$129.00")!
  assert.equal(readValue(readPage(TEXT("in stock", "$99.00")), { source: "text", what: "price", ...price }), "$99.00")
})

test("markup that disappeared falls back to the text", () => {
  const spot = locate(readPage(LD("49.85", "InStock")).text, "49.85 €")!
  const bare = readPage(`<body><h1>Mug</h1><p>Price <b>39.90 €</b></p></body>`)
  assert.equal(readValue(bare, { source: "ld-price", what: "price", ...spot }), "39.90 €")
})

test("nothing found is null, not a guess", () => {
  assert.equal(readValue(readPage("<body>Access denied</body>"), { source: "text", what: "price", before: "Total ", after: " incl." }), null)
})

test("a page's digest changes with its words only", () => {
  assert.equal(digest("a  b\nc"), digest("a b c"))
  assert.notEqual(digest("a b c"), digest("a b d"))
})

test("same or changed", () => {
  assert.ok(sameValue("price", "$129.00", "129 USD"))
  assert.ok(!sameValue("price", "$129.00", "$99.00"))
  assert.ok(!sameValue("stock", "Sold out", "In stock"))
  assert.ok(sameValue("stock", "In  Stock", "in stock"))
  assert.ok(isOutOfStock("OutOfStock") && isOutOfStock("Нет в наличии") && isOutOfStock("品切れ") && !isOutOfStock("InStock"))
  assert.ok(isOutOfStock("缺貨") && isOutOfStock("غير متوفر") && isOutOfStock("Hết hàng") && !isOutOfStock("有貨") && !isOutOfStock("متوفر") && !isOutOfStock("Còn hàng"))
})

test("most conditions are decided without the AI", () => {
  assert.equal(verdict({ kind: "change" }, "price", "$129", "$99"), "met")
  assert.equal(verdict({ kind: "below", n: 100 }, "price", "$129", "$99"), "met")
  assert.equal(verdict({ kind: "below", n: 100 }, "price", "$129", "$119"), "not-met")
  assert.equal(verdict({ kind: "in-stock" }, "stock", "Sold out", "In stock"), "met")
  assert.equal(verdict({ kind: "in-stock" }, "stock", "Sold out", "Ausverkauft"), "not-met")
  assert.equal(verdict({ kind: "contains", words: ["42"] }, "status", "41, 43", "41, 42, 43"), "met")
  assert.equal(verdict({ kind: "ask" }, "status", "Pending", "Approved"), "ask")
})

test("without the AI, the plain cases still get a rule", () => {
  assert.deepEqual(fallbackRule("price", "$129", "when it drops below 100"), { kind: "below", n: 100 })
  assert.deepEqual(fallbackRule("price", "1 299 ₽", "когда станет дешевле 1000"), { kind: "below", n: 1000 })
  assert.deepEqual(fallbackRule("stock", "Ausverkauft", "wenn wieder da"), { kind: "in-stock" })
  assert.deepEqual(fallbackRule("date", "12 March", "when the date moves"), { kind: "change" })
})

test("values as a person reads them: markup prices in their currency format, stock in words", () => {
  const words = { inStock: "в наличии", outOfStock: "нет в наличии" }
  assert.equal(shownValue("34.50 EUR", "ru", words), "34,50\u00a0€")
  // Arabic (2.6): Intl writes "‏99.99 US$"; a left-to-right mark after the sign keeps "US$" whole in right-to-left text.
  assert.equal(shownValue("99.99 USD", "ar", words), "\u200f99.99\u00a0US$\u200e")
  assert.equal(shownValue("99.99 EUR", "ar", words), "\u200f99.99\u00a0€")
  assert.equal(shownValue("99.99 USD", "zh-Hant", words), "US$99.99")
  assert.equal(shownValue("129 USD", "en", words), "$129.00")
  assert.equal(shownValue("OutOfStock", "ru", words), "нет в наличии")
  assert.equal(shownValue("InStock", "ru", words), "в наличии")
  assert.equal(shownValue("Size 42: sold out", "en", words), "Size 42: sold out")
})

