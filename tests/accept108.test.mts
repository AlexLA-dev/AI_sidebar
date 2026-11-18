// The director's acceptance of 2.7 (108): the slips found by hand on iPhone and iPad (shots in the director's
// accept108/findings). Each fix's rule, checked where it can be without a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { coversPageControl, pageControlAt } from "../src/content/translate/pageControls.ts"

const src = (path: string) => readFileSync(new URL(`../src/content/${path}`, import.meta.url), "utf8")

/** A page whose elementsFromPoint answers from boxes: each box's elements from the top down. */
function pageWith(boxes: Array<{ x: [number, number]; y: [number, number]; els: Array<{ tag: string; control?: boolean }> }>, host: object) {
  const make = (e: { tag: string; control?: boolean }) => ({ tagName: e.tag, closest: () => (e.control ? { tagName: e.tag } : null) })
  return {
    elementsFromPoint: (x: number, y: number) => {
      const box = boxes.find((b) => x >= b.x[0] && x <= b.x[1] && y >= b.y[0] && y <= b.y[1])
      return [host, ...(box ? box.els.map(make) : [{ tagName: "BODY", closest: () => null }])]
    }
  } as unknown as Document
}

test("4. the translate offer over a page's button gives way (hurriyet.com.tr's consent dialog on iPad)", () => {
  const host = { contains: () => false } as unknown as Element
  // The site's «İzin ver» button under the right half of the pill.
  const doc = pageWith([{ x: [400, 640], y: [800, 860], els: [{ tag: "BUTTON", control: true }, { tag: "DIV" }] }], host)
  const pill = { left: 330, top: 810, width: 300, height: 40 }
  assert.equal(coversPageControl(doc, pill, host), true)
  assert.ok(pageControlAt(doc, 500, 830, host))
  // Over the page's plain text (no control under it): the offer stays.
  const plain = pageWith([{ x: [0, 1000], y: [0, 1000], els: [{ tag: "P" }, { tag: "BODY" }] }], host)
  assert.equal(coversPageControl(plain, pill, host), false)
  // Our own host on top is looked through, not counted.
  assert.equal(pageControlAt(plain, 10, 10, host), null)
  // A link in running text (20 px tall) doesn't count; a link drawn as a button (44 px) does.
  const link = (h: number) => ({ elementsFromPoint: () => [host, { tagName: "A", closest: () => ({ tagName: "A", matches: () => false, getBoundingClientRect: () => ({ height: h }) }) }] }) as unknown as Document
  assert.equal(pageControlAt(link(20), 1, 1, host), null)
  assert.ok(pageControlAt(link(44), 1, 1, host))
  // The pill: the entry instead while it would cover one, until it's tapped (then the pill, asked for).
  const pillSrc = src("translate/TranslatePill.tsx")
  assert.match(pillSrc, /opened \|\| \(byItself && !hidden && !overPage\)/)
  assert.match(pillSrc, /<div ref=\{offerRef\} class=\{cls\} style=\{style\}>/)
})

test("2. the notifications ask under Listen: the text across the bar, the actions on a line under it", () => {
  const listen = src("listen/useListen.tsx")
  const from = listen.indexOf('<div class="cf-listen low ask"')
  const ask = listen.slice(from, listen.indexOf('if (state.at === "taken")', from))
  assert.ok(ask.indexOf('t("listenNotifyAsk")') < ask.indexOf('class="cf-listen-acts"'))
  assert.match(ask, /<div class="cf-listen-acts">\s*<button[^>]*onNotifyOn[\s\S]*onNotifyLater/)
  const css = src("listen/listen.css")
  assert.match(css, /\.cf-listen-acts \{ flex: 1 0 100%;/)
  assert.match(css, /\.cf-listen\.ask \.cf-listen-text \{ flex: 1 1 0;/)
})

test("3 and 6. quick insert's tip: goes after a few seconds or at the first touch, waits for the circle's hint, clear of the bottom bars", () => {
  const qi = src("insert/QuickInsert.tsx")
  assert.match(qi, /export const TIP_MS = 6_000/)
  assert.match(qi, /const tipShown = Boolean\(buttonPos && tip && field && !fixCount && !props\.hintUp && !selectionShown\)/)
  assert.match(qi, /setTimeout\(\(\) => dropTipRef\.current\(\), TIP_MS\)/)
  assert.match(qi, /document\.addEventListener\("pointerdown", touched, true\)/)
  assert.match(qi, /if \(tip && selectionShown\) dropTipRef\.current\(\)/)
  assert.match(qi, /const bottom = vp\.dy \+ vp\.height - TIP_FOOT/)
  // One hint at a time: the tip waits while the page's hint line («Reply with a template?») is up.
  assert.match(src("App.tsx"), /hintUp=\{Boolean\(pageHints\.line && fabVisible\)\}/)
})

test("5. the hints that show at the chat's end after the tour are scrolled into sight", () => {
  const app = src("App.tsx")
  assert.equal((app.match(/<Hint reveal\n/g) ?? []).length, 3)
  assert.match(src("Hint.tsx"), /ref=\{reveal \? revealHint : undefined\}/)
  // Only the chat's list scrolls (scrollIntoView moved the panel's own fixed frame down the screen).
  assert.doesNotMatch(src("Hint.tsx") + src("hintReveal.ts"), /\.scrollIntoView\(/)
  assert.doesNotMatch(src("pagehints/PageHints.tsx"), /\.scrollIntoView\(/)
})

test("5. revealBy: how far the chat scrolls to show a hint", async () => {
  const { revealBy } = await import("../src/content/hintReveal.ts")
  assert.equal(revealBy({ top: 100, bottom: 200 }, { top: 0, bottom: 400 }), 0)
  // Below the list's end: its bottom to the list's (+ 8).
  assert.equal(revealBy({ top: 380, bottom: 460 }, { top: 0, bottom: 400 }), 68)
  // Taller than the list: its top to the list's (− 8).
  assert.equal(revealBy({ top: 350, bottom: 800 }, { top: 0, bottom: 400 }), 342)
})
