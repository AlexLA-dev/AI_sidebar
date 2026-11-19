// Build 110, the director's hands-on pass, the second finding: on our own site, where «Open Safari» now takes every
// new person, the first step's frame («Tap Summarize») stood beside its chip. Two causes, both by class:
// - the frame was measured when the step came and again only on a scroll or a resize; the chip before «Summarize» grew
//   its "Pro" mark when the plan arrived, which is neither, so the chip moved and the frame didn't;
// - the page counts as a product's (its structured data declares the app with a free offer), so Find similar and
//   Watch the price led the row and «Summarize» was half-way along it. A free app's page stays a product's (Find similar
//   leads there, as in 109: the director's decision); only Watch the price goes where there is no price, and in the
//   first run «Summarize» leads whatever the page is.
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

// ---------------------------------------------------------------- a free offer: still a product, nothing to watch

test("offers that all cost nothing are free; any real price, or none stated, isn't", () => {
  const free = [{ price: 0 }, { price: "0" }, { price: "0.00" }, { price: "0,00" }, { price: "Free" }, { "@type": "AggregateOffer", lowPrice: 0, highPrice: "0" }, [{ price: 0 }, { price: "0.0" }]]
  for (const offers of free) assert.equal(lib.freeOffers(offers), true, JSON.stringify(offers))
  const priced = [{ price: 4.99 }, { price: "199" }, { "@type": "AggregateOffer", lowPrice: 0, highPrice: 9.99 }, [{ price: 0 }, { price: "2.99" }], { priceSpecification: { price: 0 } }, { "@type": "Offer" }, {}, [], "https://shop.example/offer", { price: "" }]
  for (const offers of priced) assert.equal(lib.freeOffers(offers), false, JSON.stringify(offers))
})

const app = (offers: unknown, type = "SoftwareApplication") => ({ "@type": type, name: "Reader", offers })
const signals = (d: Document) => {
  const kind = lib.pageKind(d, "https://site.example/app")
  return { field: "none", foreign: false, kind, media: "page", free: kind === "product" && lib.pageFree(d) }
}

test("a free app's page (a store's, or the app's own site) is a product's as before: Find similar first, no Watch the price", () => {
  for (const o of [
    app({ "@type": "Offer", price: "0", priceCurrency: "USD" }),
    app({ "@type": "Offer", price: 0, category: "free" }, "MobileApplication"),
    { "@graph": [{ "@type": "WebPage", name: "What it can do" }, app({ "@type": "Offer", price: 0, priceCurrency: "EUR" })] }
  ]) {
    const d = doc(ld(o))
    assert.equal(lib.pageKind(d, "https://apps.example/app/id1"), "product", "the kind is as it was in 109")
    assert.equal(lib.pageFree(d), true)
    const chips = lib.rankChips(signals(d), can)
    assert.equal(chips[0], "similar")
    assert.ok(!chips.includes("watch"), "nothing to watch")
    assert.equal(chips[1], "summarize")
    // The page hints go by the kind alone, so the line by the round button is as it was.
    assert.deepEqual(lib.rankChips({ ...signals(d), free: false }, can).slice(0, 2), ["similar", "watch"])
  }
})

test("a price anywhere on the page keeps Watch the price: a paid app, a free tier beside a paid one, a shop's own tags", () => {
  const paid = [
    doc(ld(app({ "@type": "Offer", price: 4.99, priceCurrency: "USD" }))),
    doc(ld(app([{ "@type": "Offer", price: 0 }, { "@type": "Offer", price: "39.00" }]))),
    doc(ld({ "@type": "Product", name: "Desk", offers: { price: 199 } })),
    doc(ld(app({ "@type": "Offer" }))),
    doc(ld(app({ price: 0 })) + ld({ "@type": "Product", name: "Case", offers: { price: "12.00" } })),
    doc(ld(app({ price: 0 })) + '<meta property="product:price:amount" content="9.99">'),
    doc(ld(app({ price: 0 })), '<span itemprop="price" content="19.99">19,99 €</span>'),
    doc('<meta property="og:type" content="product">'),
    doc("", '<span itemprop="price">19.99</span>')
  ]
  for (const d of paid) {
    assert.equal(lib.pageKind(d, "https://shop.example/x"), "product")
    assert.equal(lib.pageFree(d), false, d.documentElement.outerHTML.slice(0, 160))
    assert.deepEqual(lib.rankChips(signals(d), can).slice(0, 2), ["similar", "watch"])
  }
  // A page with no offers at all isn't "free": the word is about offers that say so.
  assert.equal(lib.pageFree(doc("", "<p>Hello</p>")), false)
  assert.equal(lib.pageFree(doc('<script type="application/ld+json">{broken</script>')), false)
})

test("our own site's pages, as they are in the repo: no Watch the price, and in the first run Summarize leads", () => {
  for (const file of ["site/features.html", "site/index.html", "site/de/features.html", "site/ar/features.html", "site/ja/features.html"]) {
    const d = parseHTML(read(file)).document as unknown as Document
    const s = signals(d)
    const chips = lib.rankChips(s, can)
    assert.ok(!chips.includes("watch"), file)
    if (s.kind === "product") assert.equal(chips[0], "similar", `${file}: a product's page, as before`)
    // What the panel does for someone whose first run is to come (App.tsx show()).
    const first = lib.chipFirst(chips, "summarize")
    assert.equal(first[0], "summarize", file)
    assert.equal(first.length, chips.length)
  }
  // The row the director saw on context-flow.app/features: the page is a product's by its markup.
  const features = parseHTML(read("site/features.html")).document as unknown as Document
  assert.equal(lib.pageKind(features, "https://context-flow.app/features"), "product")
  assert.equal(lib.pageFree(features), true)
})
