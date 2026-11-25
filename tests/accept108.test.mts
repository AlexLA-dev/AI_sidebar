// The director's acceptance of 2.7 (108): the slips found by hand on iPhone and iPad (shots in the director's
// accept108/findings). Each fix's rule, checked where it can be without a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { coversPageControl, inOverlay, OVERLAY, pageControlAt } from "../src/content/translate/pageControls.ts"

const src = (path: string) => readFileSync(new URL(`../src/content/${path}`, import.meta.url), "utf8")

/** A stand-in element: a control or not, a dialog or not, its CSS position, its parent. */
interface Fake { tag: string; control?: boolean; dialog?: boolean; pos?: string; parent?: Fake }

/** A page whose elementsFromPoint answers from boxes (each box's innermost element, its ancestors by `parent`). */
function pageWith(boxes: Array<{ x: [number, number]; y: [number, number]; el: Fake }>, host: object) {
  const body = { tagName: "BODY", closest: () => null }
  const doc: Record<string, unknown> = { body, documentElement: { tagName: "HTML" } }
  const live = new Map<Fake, Element>()
  const make = (f: Fake): Element => {
    if (live.has(f)) return live.get(f) as Element
    const el = {
      tagName: f.tag,
      ownerDocument: doc,
      get parentElement() {
        return f.parent ? make(f.parent) : body
      },
      closest(sel: string) {
        for (let at: Fake | undefined = f; at; at = at.parent) if (sel === OVERLAY ? at.dialog : at.control) return make(at)
        return null
      },
      _pos: f.pos ?? "static"
    } as unknown as Element
    live.set(f, el)
    return el
  }
  doc.defaultView = { getComputedStyle: (e: { _pos?: string }) => ({ position: e._pos ?? "static" }) }
  doc.elementsFromPoint = (x: number, y: number) => {
    const box = boxes.find((b) => x >= b.x[0] && x <= b.x[1] && y >= b.y[0] && y <= b.y[1])
    return [host, ...(box ? [make(box.el)] : [body])]
  }
  return doc as unknown as Document
}

test("4. the offer gives way only to a page's control in an overlay (a consent dialog), not to the page's own flow", () => {
  const host = { contains: () => false } as unknown as Element
  const pill = { left: 330, top: 810, width: 300, height: 40 }
  const under = (el: Fake) => pageWith([{ x: [400, 640], y: [800, 860], el }], host)
  // hurriyet.com.tr on iPad: «İzin ver» in the consent dialog (a fixed layer, or a dialog element): gives way.
  const fixedLayer: Fake = { tag: "DIV", pos: "fixed" }
  assert.equal(coversPageControl(under({ tag: "BUTTON", control: true, parent: { tag: "DIV", parent: fixedLayer } }), pill, host), true)
  assert.equal(coversPageControl(under({ tag: "BUTTON", control: true, parent: { tag: "DIALOG", dialog: true } }), pill, host), true)
  // A sticky header's link where the pill really lies on it: counts.
  assert.equal(coversPageControl(under({ tag: "A", control: true, parent: { tag: "HEADER", pos: "sticky" } }), pill, host), true)
  // es.wikipedia.org on iPhone: the row of icons (bookmark, edit, share) and the links of the text, in the page's own
  // flow: the offer stays.
  assert.equal(coversPageControl(under({ tag: "BUTTON", control: true, parent: { tag: "NAV", parent: { tag: "MAIN" } } }), pill, host), false)
  assert.equal(coversPageControl(under({ tag: "A", control: true, parent: { tag: "P" } }), pill, host), false)
  // Plain text: nothing; our own host on top is looked through.
  const plain = pageWith([{ x: [0, 1000], y: [0, 1000], el: { tag: "P" } }], host)
  assert.equal(coversPageControl(plain, pill, host), false)
  assert.equal(pageControlAt(plain, 10, 10, host), null)
  // The overlay test by itself.
  const fake = pageWith([{ x: [0, 1], y: [0, 1], el: { tag: "BUTTON", control: true, parent: { tag: "DIV", pos: "sticky" } } }], host)
  assert.equal(inOverlay((fake.elementsFromPoint(0, 0) as Element[])[1]), true)
  // The pill: the entry instead while it would cover one, until it's tapped (then the pill, asked for).
  const pillSrc = src("translate/TranslatePill.tsx")
  assert.match(pillSrc, /opened \|\| \(byItself && !hidden && !overPage && offerOk\)/)
  assert.match(pillSrc, /<div ref=\{offerRef\} class=\{cls\} style=\{style\}>/)
  // The small entry over such a control (the iPhone pass: by the circle on «İzin ver») steps aside while it's there,
  // not on a translated page (the way back to the original).
  assert.match(pillSrc, /useOverPageControls<HTMLButtonElement>\(visible && !pill && state\.at === "off", false\)/)
  assert.match(pillSrc, /entryOver && state\.at === "off" \? \{ \.\.\.style, visibility: "hidden", pointerEvents: "none" \}/)
})

test("4b. a page already translated: the panel's «Translate page» chip isn't offered again", () => {
  assert.match(src("quiet/signals.ts"), /foreign: pageForeignOffer\(\) !== null && !pageTranslatedNow\(\)/)
  assert.match(src("translate/TranslatePill.tsx"), /return engine !== null && engine\.state\(\)\.at !== "off"/)
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
  // Our selection drops it only once it was seen; before that the tip just waits (the iPad pass: dropped unseen).
  assert.match(qi, /if \(tip && selectionShown && tipWasShown\.current\) dropTipRef\.current\(\)/)
  assert.match(qi, /const bottom = vp\.dy \+ vp\.height - TIP_FOOT/)
  // One hint at a time: the tip waits while the page's hint line («Reply with a template?») is up.
  assert.match(src("App.tsx"), /hintUp=\{\(slot !== null && slot !== "write_tip"\) \|\| !coach\.may\("write_tip"\)\}/)
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
