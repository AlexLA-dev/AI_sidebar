// 2.6.1, filmed for X on build 100: on RTINGS' "best robot vacuums" the panel answered that the page had no list of
// the five models. Readability keeps a page's densest block: each pick there is a list item with a paragraph or two,
// and the one long FAQ outscored every pick, so only the FAQ was read. When Readability's text holds too little of the
// page's prose, the smallest part of the page holding most of it is read instead (src/content/proseCover.ts). Nothing
// knows any site: a made-up page of the same shape, the page itself (rendered in WebKit, trimmed), and an ordinary
// article that must read as before.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { Readability } from "@mozilla/readability"
import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { proseBlocks, proseCover } from "../src/content/proseCover.ts"

let extractPage: (max: number, page: Document) => { title: string; text: string }

before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-page-prose-")), "page.mjs")
  await build({
    entryPoints: [new URL("../src/content/page.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.6.1"', __TARGET__: '"safari"' }
  })
  extractPage = (await import(pathToFileURL(out).href)).extractPage
})

const doc = (html: string) => parseHTML(html).document as unknown as Document
const readability = (html: string): string => new Readability(doc(html), { charThreshold: 300 }).parse()?.textContent ?? ""
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed} sentence ${i + 1} says something useful about how it cleans.`).join(" ")

const PICKS = ["Aurora One", "Breeze Two", "Comet Three", "Delta Four", "Echo Five"]

// A "best of" page: a short intro, five picks (a name, a price button, a picture, one paragraph each), then one long
// FAQ, as review sites build them.
const BEST_OF = `<!doctype html><html><head><title>The 5 Best Widgets</title></head><body>
<header><nav><a href="/">Home</a> <a href="/best">Best</a> <a href="/reviews">Reviews</a></nav></header>
<main><div class="page"><div class="content">
  <div class="section intro"><h1>The 5 Best Widgets</h1><p>${words("Intro", 3)}</p></div>
  <div class="section picks"><ol>
    ${PICKS.map((name, i) => `<li class="pick"><h2>${name}</h2><a class="btn" href="/buy/${i}">See price</a><img src="/w${i}.jpg" alt="">
      <div class="desc"><p>The ${name} is our pick for its job. ${words(name, 4)}</p></div></li>`).join("\n")}
  </ol></div>
  <div class="section faq"><div class="rich"><h2>FAQ</h2>
    ${Array.from({ length: 8 }, (_, i) => `<p><strong>Question ${i + 1}?</strong></p><p>${words(`Answer ${i + 1}`, 3)}</p>`).join("\n")}
  </div></div>
</div></div></main>
<footer><p>${words("Footer", 2)}</p></footer></body></html>`

test("Readability's text with the FAQ only: the part of the page with the picks and the FAQ is read instead", () => {
  const page = doc(BEST_OF)
  const prose = (sel: string) => [...page.querySelectorAll(sel)].map((p) => p.textContent).join("\n")
  // What Readability kept on RTINGS: the FAQ alone.
  const cover = proseCover(page, prose(".faq p"), "contextflow-root")
  assert.ok(cover, "too little of the prose")
  assert.equal(cover.className, "content", "the smallest part holding most of it: intro, picks and FAQ, no footer")
  // Readability's text with the picks in it: it stands.
  assert.equal(proseCover(page, prose("main p"), "contextflow-root"), null)
  const { text } = extractPage(Infinity, doc(BEST_OF))
  for (const name of PICKS) assert.ok(text.includes(`The ${name} is our pick`), name)
  assert.ok(text.includes("Answer 8 sentence"), "the FAQ")
})

// An article Readability reads well: its text as before, without the menu, the side column's teasers or the footer.
const ARTICLE = `<!doctype html><html><head><title>Why trains save energy</title></head><body>
<nav><a href="/">News</a> <a href="/tech">Tech</a></nav>
<main><article><h1>Why trains save energy</h1>
  ${Array.from({ length: 8 }, (_, i) => `<p>${words(`Article ${i + 1}`, 4)}</p>`).join("\n")}
</article>
<aside><h2>Related</h2><ul>${Array.from({ length: 4 }, (_, i) => `<li><p>${words(`Teaser ${i + 1}`, 2)}</p></li>`).join("")}</ul></aside></main>
<footer><p>${words("Footer", 2)}</p></footer></body></html>`

test("an article Readability reads well reads as before", () => {
  const page = doc(ARTICLE)
  assert.equal(proseCover(page, readability(ARTICLE), "contextflow-root"), null, "Readability's text stands")
  const { text } = extractPage(Infinity, doc(ARTICLE))
  assert.ok(text.includes("Article 8 sentence 4"))
  assert.ok(!text.includes("Teaser 1 sentence"), "no side column")
  assert.ok(!text.includes("Footer sentence"), "no footer")
})

test("a shop's script inside a list item is code, not prose", () => {
  const page = doc(`<!doctype html><html><body><ul><li>Cart 0 <script>${"$(function(){ cart.update(); }); ".repeat(40)}</script></li></ul></body></html>`)
  assert.deepEqual(proseBlocks(page.body), [])
})

test("RTINGS' best robot vacuums (rendered in WebKit, trimmed): the five picks and the FAQ", () => {
  const html = gunzipSync(readFileSync(new URL("./fixtures/page-rtings-best-robot.html.gz", import.meta.url))).toString("utf8")
  const picks = ["MOVA P50 Pro Ultra is the best", "MOVA P10 Pro Ultra is the best", "Roborock Q7 M5", "DEEBOT X8", "Saros 20"]
  const kept = readability(html)
  assert.ok(kept.includes("Can a robot vacuum fully replace"), "Readability keeps the FAQ")
  assert.ok(!kept.includes(picks[0]), "and loses the picks, as the panel did on build 100")
  const { title, text } = extractPage(Infinity, doc(html))
  assert.equal(title, "The 5 Best Robot Vacuums of 2026")
  for (const pick of picks) assert.ok(text.includes(pick), pick)
  assert.ok(text.includes("Can a robot vacuum fully replace"), "the FAQ stays")
})
