// Build 110, the director's hands-on pass, the second finding: on our own site, where «Open Safari» now takes every
// new person, the first step's frame («Tap Summarize») stood beside its chip. Two causes, both by class:
// - the frame was measured when the step came and again only on a scroll or a resize; the chip before «Summarize» grew
//   its "Pro" mark when the plan arrived, which is neither, so the chip moved and the frame didn't;
// - the page counted as a product's (its structured data declares the app with a free offer), so Find similar and
//   Watch the price led the row and «Summarize» was half-way along it.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { sameHoles } from "../src/content/holes.ts"

let lib: any

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-first-run-110b-"))
  const src = new URL("../src/content/", import.meta.url).pathname
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export * from "${src}quiet/chips.ts"\nexport * from "${src}pagehints/detect.ts"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" })
  lib = await import(pathToFileURL(out).href)
})

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const doc = (head: string, body = "") => parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const can = { write: true, translatePage: true, watch: true, similar: true }
const page = (kind: string | null) => ({ field: "none", foreign: false, kind, media: "page" })

// ---------------------------------------------------------------- the frame stays on its part

test("the frame's place is read at every frame while the step shows, and the state changes only when the place does", () => {
  const tour = read("src/content/Tour.tsx")
  const hook = tour.slice(tour.indexOf("export function useParts"), tour.indexOf("/** Everything lit up"))
  assert.match(hook, /let frame = requestAnimationFrame\(function follow\(\) \{\n\s+measure\(\)\n\s+frame = requestAnimationFrame\(follow\)\n\s+\}\)/)
  assert.match(hook, /return \(\) => cancelAnimationFrame\(frame\)/)
  assert.match(hook, /if \(last && sameHoles\(last, next\)\) return\n\s+last = next\n\s+setParts\(next\)/)
  // Not by events any more: a chip that grows moves its neighbours with no scroll and no resize of theirs.
  assert.doesNotMatch(hook, /ResizeObserver|addEventListener/)
  // The place comes from rectangles on screen against the panel's: the same in a right-to-left panel, at any width.
  assert.match(hook, /left: r\.left - p\.left - PAD/)
  // Both the tour's cards and the guided request's use it.
  assert.match(tour, /const parts = useParts\(panel, step\.targets, step\)/)
  assert.match(read("src/content/Guide.tsx"), /const parts = useParts\(panel, spec\?\.targets \?\? \[\], step\)/)
})

test("two readings of a place: the same to half a point, different once a chip has moved along", () => {
  const at = (left: number) => [{ top: 300, left, width: 109, height: 46 }]
  assert.equal(sameHoles(at(146), at(146.2)), true)
  assert.equal(sameHoles(at(146), at(182)), false, "the Pro mark: 36 points")
  assert.equal(sameHoles(at(146), []), false)
  assert.equal(sameHoles([], []), true)
  assert.equal(sameHoles(at(146), [{ top: 300, left: 146, width: 120, height: 46 }]), false)
})

test("the chips' row doesn't peek under a step, and the pointed chip is centred again when the row changes", () => {
  const row = read("src/content/quiet/ChipsRow.tsx")
  assert.match(row, /const calm = still \|\| \(typeof window\.matchMedia === "function"/)
  assert.match(row, /if \(!arrows && !peeked && !calm\) \{/)
  assert.match(row, /\}, \[sig, arrows, still\]\)/)
  const app = read("src/content/App.tsx")
  assert.equal(app.match(/<ChipsRow [^>]*still=\{guide !== null \|\| touring\}>/g)?.length, 3, "every row of chips")
  assert.equal(app.match(/<ChipsRow /g)?.length, 3)
  assert.match(app, /\}, \[open, view, pointedChip, messages\.length, chipsSig, markUltra\]\)/)
  // The hook sits after what it reads (both are worked out further down the panel than it used to be).
  assert.ok(app.indexOf("const markUltra =") < app.indexOf("const pointedChip ="))
  assert.ok(app.indexOf("const chipsSig =") < app.indexOf("const pointedChip ="))
})

// ---------------------------------------------------------------- the step's chip leads the row

test("chipFirst: the step's chip first, the rest in their order; nothing changes when it's first or not there", () => {
  const product = lib.rankChips(page("product"), can)
  assert.deepEqual(product.slice(0, 3), ["similar", "watch", "summarize"])
  const first = lib.chipFirst(product, "summarize")
  assert.equal(first[0], "summarize")
  assert.deepEqual(first.slice(1), product.filter((id: string) => id !== "summarize"))
  assert.equal(first.length, product.length)
  const article = lib.rankChips(page("article"), can)
  assert.equal(lib.chipFirst(article, "summarize"), article, "already first: the same list")
  const none = ["check", "rewrite"]
  assert.equal(lib.chipFirst(none, "summarize"), none)
  // A field being written in, a page in another language: the first run's chip still leads.
  for (const s of [{ field: "text", foreign: false, kind: null, media: "page" }, { field: "none", foreign: true, kind: "product", media: "page" }]) {
    assert.equal(lib.chipFirst(lib.rankChips(s, can), "summarize")[0], "summarize")
  }
})

test("the panel: Summarize leads for someone whose first run is to come, and when the guided request starts", () => {
  const app = read("src/content/App.tsx")
  assert.match(app, /const order = chipsNowRef\.current\(\)\n\s+setChipOrder\(!tourSeenRef\.current \|\| guideRef\.current === "summarize" \? chipFirst\(order, "summarize"\) : order\)/)
  assert.match(app, /setChipOrder\(\(order\) => chipFirst\(order, "summarize"\)\)\n\s+setGuide\("summarize"\)/)
  // The step points at that chip by its action, wherever it is in the row.
  assert.match(read("src/content/Guide.tsx"), /\.cf-empty \.cf-chip\[data-action=summarize\]/)
})

// ---------------------------------------------------------------- a free offer isn't a product

test("offers that all cost nothing don't make a page a product's; any real price, or none stated, still does", () => {
  const free = [{ price: 0 }, { price: "0" }, { price: "0.00" }, { price: "0,00" }, { price: "Free" }, { "@type": "AggregateOffer", lowPrice: 0, highPrice: "0" }, [{ price: 0 }, { price: "0.0" }]]
  for (const offers of free) assert.equal(lib.freeOffers(offers), true, JSON.stringify(offers))
  const priced = [{ price: 4.99 }, { price: "199" }, { "@type": "AggregateOffer", lowPrice: 0, highPrice: 9.99 }, [{ price: 0 }, { price: "2.99" }], { priceSpecification: { price: 0 } }, { "@type": "Offer" }, {}, [], "https://shop.example/offer", { price: "" }]
  for (const offers of priced) assert.equal(lib.freeOffers(offers), false, JSON.stringify(offers))
})

test("the page's kind: an app's own site and a free app's store page aren't products; a paid app and a Product are", () => {
  const app = (offers: unknown, type = "SoftwareApplication") => ({ "@type": type, name: "Reader", offers })
  const kind = (o: unknown) => lib.pageKind(doc(ld(o)), "https://site.example/app")
  assert.equal(kind(app({ "@type": "Offer", price: "0", priceCurrency: "USD" })), null)
  assert.equal(kind({ "@graph": [{ "@type": "WebPage", name: "What it can do" }, app({ "@type": "Offer", price: 0, priceCurrency: "EUR" })] }), null)
  assert.equal(kind(app({ "@type": "Offer", price: 0, category: "free" }, "MobileApplication")), null)
  assert.equal(kind(app({ "@type": "Offer", price: "0" }, "Service")), null, "by the offer, not by the thing's type")
  assert.equal(kind(app({ "@type": "Offer", price: 4.99, priceCurrency: "USD" })), "product")
  assert.equal(kind(app([{ "@type": "Offer", price: 0 }, { "@type": "Offer", price: "39.00" }])), "product", "a free tier beside a paid one")
  assert.equal(kind(app({ "@type": "Offer", price: 0 }, "Product")), "product", "a page that calls itself a Product is one")
  assert.equal(kind({ "@type": "Product", name: "Desk", offers: { price: 199 } }), "product")
  assert.equal(kind(app({ "@type": "Offer" })), "product", "no price stated: as before")
  // A long read with a free offer is an article, as it would be without the offer.
  const words = Array.from({ length: 14 }, () => `<p>${"Ein langer Absatz über die Stadt und ihre neue Brücke. ".repeat(6)}</p>`).join("")
  assert.equal(lib.pageKind(doc(ld(app({ price: 0 })), `<article>${words}</article>`), "https://site.example/a"), "article")
})

test("our own site's pages, as they are in the repo: none is a product's, so Summarize isn't behind Watch the price", () => {
  for (const file of ["site/features.html", "site/index.html", "site/de/features.html", "site/ar/features.html", "site/ja/features.html"]) {
    const page = parseHTML(read(file)).document as unknown as Document
    const kind = lib.pageKind(page, `https://context-flow.app/${file.replace(/^site\/|index\.html$|\.html$/g, "")}`)
    assert.notEqual(kind, "product", file)
    const chips = lib.rankChips({ field: "none", foreign: false, kind, media: "page" }, can)
    assert.equal(chips[0], "summarize", file)
    assert.ok(!chips.includes("watch"), file)
  }
})
