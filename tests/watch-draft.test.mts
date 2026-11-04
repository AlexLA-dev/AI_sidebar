// Page watch: what the panel reads from the live page when someone asks to be told about a change.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let draftFor: (url: string, title: string, selection: string | null) => any

const page = (body: string, head = "") => {
  const { document } = parseHTML(`<!doctype html><html><head><title>Shop</title>${head}</head><body>${body}</body></html>`)
  ;(globalThis as any).document = document
}

before(async () => {
  ;(globalThis as any).chrome = { i18n: { getMessage: () => "" } }
  const out = join(mkdtempSync(join(tmpdir(), "cf-watch-draft-")), "draft.mjs")
  await build({
    entryPoints: [new URL("../src/content/watch/draft.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  draftFor = (await import(pathToFileURL(out).href)).draftFor
})

test("a selected price: its kind, the words around it, the markup, a condition to start from", () => {
  page(
    `<h1>Mug</h1><p>Price <b>49,85 €</b> incl. VAT</p>`,
    `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"49.85","priceCurrency":"EUR"}}</script>`
  )
  const d = draftFor("https://shop.example/mug", "Mug", "49,85 €")
  assert.equal(d.what, "price")
  assert.equal(d.condition, "when the price changes (now 49,85 €)")
  assert.deepEqual(d.candidates, { ldPrice: "49.85 EUR" })
  assert.ok(d.before.endsWith("Price "), d.before)
  // Read where the background will read it (the markup), so the first check compares like with like.
  assert.equal(d.value, "49.85 EUR")
  assert.ok(d.around.includes("Mug Price 49,85 €"))
})

test("sold out starts from \"when it's back\"", () => {
  page(`<div>Size 42: <span>Sold out</span></div>`)
  const d = draftFor("https://shop.example/shoe", "Shoe", "Sold out")
  assert.equal(d.what, "stock")
  assert.equal(d.condition, "when it's back in stock")
})

test("no selection: the whole page, with its text kept for the AI", () => {
  page(`<h1>News</h1><p>Registration opens soon.</p>`)
  const d = draftFor("https://uni.example/news", "News", null)
  assert.equal(d.what, "page")
  assert.equal(d.condition, "when something new appears on the page")
  assert.ok(d.text.includes("Registration opens soon."))
  assert.match(d.value, /^[0-9a-z]+:\d+$/)
})

test("a selection that isn't a price, stock or date is watched as a status", () => {
  page(`<p>Case status: <b>Pending review</b> since May</p>`)
  const d = draftFor("https://gov.example/case", "Case", "Pending review")
  assert.equal(d.what, "status")
})
