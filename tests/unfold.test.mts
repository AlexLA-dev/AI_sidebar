import { test } from "node:test"
import assert from "node:assert/strict"
import { parseHTML } from "linkedom"
import { Readability } from "@mozilla/readability"

import { unfoldCollapsed } from "../src/content/unfold.ts"

const para = (words: string) => `<p>${words} ${"The researchers followed the group for two years and wrote down what changed. ".repeat(4)}</p>`

// The shape of a mobile Wikipedia article (sections folded under their headings), with a site menu and a search
// dialog that fold the same way, and a FAQ in closed <details>.
const PAGE = `<!doctype html><html><head><title>Procrastination</title></head><body>
<header><button aria-expanded="false" aria-controls="search">Search</button>
  <div id="search" role="dialog" hidden><p>Search Wikipedia for articles, pictures and more. ${"Type a word. ".repeat(20)}</p></div></header>
<nav><button aria-expanded="false" aria-controls="menu">Menu</button>
  <ul id="menu" hidden>${Array.from({ length: 12 }, (_, i) => `<li><a href="/p${i}">Portal number ${i} of the encyclopedia</a></li>`).join("")}</ul>
  <details class="dropdown"><summary>Languages</summary><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/l${i}">Language ${i}</a></li>`).join("")}</ul></details></nav>
<main><h1>Procrastination</h1>
  ${para("Procrastination is the act of unnecessarily delaying a task.")}
  <div class="mw-heading" aria-expanded="false" aria-controls="mf-section-1"><h2>Causes</h2></div>
  <section id="mf-section-1" hidden="until-found">${para("Causes include fear of failure.")}</section>
  <div class="mw-heading" aria-expanded="false" aria-controls="mf-section-2"><h2>Treatment</h2></div>
  <section id="mf-section-2" hidden="until-found">${para("Cognitive behavioral therapy is the usual treatment.")}</section>
  <details><summary>Is it a disorder?</summary>${para("Not by itself, the FAQ says.")}</details>
  <div aria-expanded="false" aria-controls="share"><span>Share</span></div>
  <ul id="share" hidden><li><a href="/x">Share on X</a></li><li><a href="/m">Share by mail</a></li></ul>
</main></body></html>`

test("folded sections, until-found content and closed details are unfolded; menus and dialogs stay folded", () => {
  const { document } = parseHTML(PAGE)
  assert.equal(unfoldCollapsed(document), 3)
  assert.equal(document.getElementById("mf-section-1")!.hasAttribute("hidden"), false)
  assert.equal(document.getElementById("mf-section-2")!.hasAttribute("hidden"), false)
  assert.equal(document.querySelector("main details")!.hasAttribute("open"), true)
  assert.equal(document.getElementById("menu")!.hasAttribute("hidden"), true)
  assert.equal(document.getElementById("search")!.hasAttribute("hidden"), true)
  assert.equal(document.querySelector("nav details")!.hasAttribute("open"), false)
  assert.equal(document.getElementById("share")!.hasAttribute("hidden"), true)
})

test("Readability then reads the folded sections, and no menu", () => {
  const before = new Readability(parseHTML(PAGE).document as unknown as Document).parse()?.textContent ?? ""
  assert.ok(!before.includes("Cognitive behavioral therapy"), "without unfolding, the folded section is dropped")
  const { document } = parseHTML(PAGE)
  unfoldCollapsed(document)
  const after = new Readability(document as unknown as Document).parse()?.textContent ?? ""
  assert.ok(after.includes("Causes include fear of failure"))
  assert.ok(after.includes("Cognitive behavioral therapy"))
  assert.ok(!after.includes("Portal number"))
  assert.ok(!after.includes("Search Wikipedia"))
})

test("inline display:none on a folded section goes too", () => {
  const { document } = parseHTML(`<main><button aria-expanded="false" aria-controls="a">More</button><div id="a" style="display:none">${para("The rest of the story.")}</div></main>`)
  assert.equal(unfoldCollapsed(document), 1)
  assert.doesNotMatch(document.getElementById("a")!.getAttribute("style") ?? "", /display\s*:\s*none/)
})
