// 2.6 (100), the owner on build 100: «при обнаружении в чате предложения по структурированию чат перескакивает вверх,
// в начало, что неудобно и дергано». In the panel, two causes:
//   1. The bars at the top of the list: when the suggestions bar came, the list's first child turned from the pinned
//      bar (a component) into the box of both bars (a div), and Preact matched that div with a div further down (the
//      "now on this page" divider), then took every message out and put it back in. In Safari the list was at its
//      start after that (measured in WebKit: scrollTop 8037 → 0).
//   2. Safari has no scroll anchoring: a bar or a suggestion's row coming or going above the place being read moved
//      the text by its height (44–98 px in WebKit).
// The bars have a place of their own now (one box, kept by its key), and the place being read is noted before such a
// change and put back after it (readingPlace.ts).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { before, test } from "node:test"

import { parseHTML } from "linkedom"

let h: typeof import("preact").h
let render: typeof import("preact").render
let readingPlace: typeof import("../src/content/readingPlace.ts").readingPlace
let keepReadingPlace: typeof import("../src/content/readingPlace.ts").keepReadingPlace
let document: Document

before(async () => {
  const dom = parseHTML("<!doctype html><html><body><div id=root></div></body></html>")
  document = dom.document as unknown as Document
  Object.assign(globalThis as Record<string, unknown>, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })
  ;({ h, render } = await import("preact"))
  ;({ readingPlace, keepReadingPlace } = await import("../src/content/readingPlace.ts"))
})

const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")

// ---------------------------------------------------------------- 1. the bars' place in the list

// The bars as components, as App has them (the pinned bar is one even when nothing is pinned: it draws nothing then).
const Strip = ({ pins }: { pins: boolean }) => (pins ? h("div", { class: "cf-pinbar" }, "pinned") : null)
const Bar = ({ bar }: { bar: boolean }) => (bar ? h("div", { class: "cf-sugbar" }, "Suggested · 1") : null)

/** The chat's list as App renders it: the bars, the empty states (not shown), the messages (an array, each keyed by
 * its index), the "now on this page" divider. `kept`: the bars in their box with its key (2.6 (100)); else as in
 * build 100. */
function list({ bar, pins, kept }: { bar: boolean; pins: boolean; kept: boolean }) {
  const box = () => h("div", { key: kept ? "topbars" : undefined, class: "cf-topbars" }, h(Strip, { pins }), h(Bar, { bar }))
  const bars = kept ? (pins || bar) && box() : bar ? box() : h(Strip, { pins })
  const messages = Array.from({ length: 12 }, (_, i) => h("div", { key: i, class: "cf-msg", "data-index": i }, `message ${i}`))
  return h("div", { class: "cf-messages" }, bars, false, false, messages, h("div", { class: "cf-newpage" }, "Now on this page"))
}

/** Renders `from`, then `to`; how many times a message was put into the list again in between. */
function messagesPutBack(from: Parameters<typeof list>[0], to: Parameters<typeof list>[0]): number {
  const root = document.getElementById("root")!
  render(null, root)
  render(list(from), root)
  const box = root.firstElementChild!
  let n = 0
  const insert = box.insertBefore.bind(box)
  const append = box.appendChild.bind(box)
  const counted = (node: Node) => { if ((node as Element).getAttribute?.("data-index") !== null && (node as Element).getAttribute?.("data-index") !== undefined) n++ }
  box.insertBefore = ((node: Node, ref: Node | null) => { counted(node); return insert(node, ref) }) as typeof box.insertBefore
  box.appendChild = ((node: Node) => { counted(node); return append(node) }) as typeof box.appendChild
  render(list(to), root)
  return n
}

test("build 100's markup put every message back into the list when the suggestions bar came (the jump to the start)", () => {
  assert.ok(messagesPutBack({ bar: false, pins: false, kept: false }, { bar: true, pins: false, kept: false }) >= 12)
})

test("the bars' box with its key: the bar coming, changing or going leaves the messages where they are", () => {
  for (const [from, to] of [
    [{ bar: false, pins: false }, { bar: true, pins: false }],
    [{ bar: true, pins: false }, { bar: false, pins: false }],
    [{ bar: false, pins: true }, { bar: true, pins: true }],
    [{ bar: true, pins: true }, { bar: false, pins: true }],
    [{ bar: false, pins: false }, { bar: false, pins: true }]
  ] as const) {
    assert.equal(messagesPutBack({ ...from, kept: true }, { ...to, kept: true }), 0, `${JSON.stringify(from)} → ${JSON.stringify(to)}`)
  }
})

test("the pinned bar stays the same element when the suggestions bar joins it", () => {
  const root = document.getElementById("root")!
  render(null, root)
  render(list({ bar: false, pins: true, kept: true }), root)
  const pinned = root.querySelector(".cf-pinbar")
  render(list({ bar: true, pins: true, kept: true }), root)
  // (Compared by identity: a failed deepEqual on DOM nodes would try to print the whole document.)
  assert.ok(pinned && root.querySelector(".cf-pinbar") === pinned)
  assert.ok(root.querySelector(".cf-topbars > .cf-sugbar"))
})

test("App renders the bars in that box, kept by its key, whenever either bar is there", () => {
  assert.match(app, /\{!picked && \(pinnedCount > 0 \|\| barItems\.length > 0\) && \(\s*<div key="topbars" class=\{`cf-topbars\$\{pinnedCount && barItems\.length \? " both" : ""\}`\}>\s*\{ux\.strip\}\s*<SuggestionsBar /)
  assert.doesNotMatch(app, /: ux\.strip\)\}/)
})

// ---------------------------------------------------------------- 2. the place being read

/** A list laid out by hand (linkedom has no layout): the list's top at `TOP`, its children stacked by their heights,
 * scrolled by `scrollTop`. */
const TOP = 100
const VIEW = 400
function laidOut(heights: Array<[string, number]>) {
  const listEl = document.createElement("div")
  let scrollTop = 0
  Object.defineProperty(listEl, "scrollTop", { get: () => scrollTop, set: (v: number) => { scrollTop = Math.max(0, v) } })
  const layout = () => {
    let y = 0
    for (const child of [...listEl.children] as HTMLElement[]) {
      const height = Number(child.dataset.h)
      const sticky = child.classList.contains("cf-topbars")
      const top = sticky ? TOP : TOP + y - scrollTop
      child.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) })
      y += height
    }
  }
  listEl.getBoundingClientRect = () => { layout(); return { top: TOP, bottom: TOP + VIEW, height: VIEW, left: 0, right: 300, width: 300, x: 0, y: TOP, toJSON: () => ({}) } }
  const set = (rows: Array<[string, number]>) => {
    listEl.replaceChildren(...rows.map(([what, height]) => {
      const el = document.createElement("div")
      if (what === "bars") el.className = "cf-topbars"
      else {
        el.className = "cf-msg"
        el.dataset.index = what
      }
      el.dataset.h = String(height)
      return el
    }))
    layout()
  }
  set(heights)
  return { list: listEl as HTMLElement, set, top: (index: number) => { layout(); return listEl.querySelector<HTMLElement>(`[data-index="${index}"]`)!.getBoundingClientRect().top - TOP } }
}

const keys = ["a", "b", "c", "d", "e", "f", "g", "h"]
const rows = (heights: number[]): Array<[string, number]> => heights.map((height, i) => [String(i), height])

test("a bar and a row coming above the place being read: the message read stays where it was", () => {
  const view = laidOut(rows([300, 300, 300, 300, 300, 300]))
  view.list.scrollTop = 750
  const before = view.top(2)
  const place = readingPlace(view.list, (i) => keys[i])
  assert.equal(place?.at[0].key, "c")
  // The bar at the top, and message 1 with a suggestion's row under it (44 px taller).
  view.set([["bars", 56], ...rows([300, 344, 300, 300, 300, 300])])
  keepReadingPlace(view.list, place!, (key) => keys.indexOf(key))
  assert.equal(view.top(2), before)
  assert.equal(view.list.scrollTop, 750 + 56 + 44)
})

test("the bar and a row going: the message read stays where it was", () => {
  const view = laidOut([["bars", 56], ...rows([300, 344, 300, 300, 300, 300])])
  view.list.scrollTop = 900
  const place = readingPlace(view.list, (i) => keys[i])
  const at = place!.at[0]
  view.set(rows([300, 300, 300, 300, 300, 300]))
  keepReadingPlace(view.list, place!, (key) => keys.indexOf(key))
  assert.equal(view.top(keys.indexOf(at.key)), at.top)
})

test("the message read is found by its key after a move took messages above it", () => {
  const view = laidOut(rows([300, 300, 300, 300, 300, 300, 300, 300]))
  view.list.scrollTop = 1650
  const place = readingPlace(view.list, (i) => keys[i])
  assert.equal(place?.at[0].key, "f")
  const before = place!.at[0].top
  // Messages 1–3 went to another chat: "f" is message 2 now.
  const left = keys.filter((_, i) => i < 1 || i > 3)
  view.set(rows([300, 300, 300, 300, 300]))
  keepReadingPlace(view.list, place!, (key) => left.indexOf(key))
  assert.equal(view.top(2), before)
})

test("the message read went with a move: the next one in view keeps its place", () => {
  const view = laidOut(rows([300, 300, 300, 300, 300, 300, 300, 300]))
  view.list.scrollTop = 1450
  const place = readingPlace(view.list, (i) => keys[i])
  assert.deepEqual(place!.at.map((x) => x.key), ["e", "f", "g"])
  const next = place!.at[1]
  const left = keys.filter((key) => key !== "e")
  view.set(rows([300, 300, 300, 300, 300, 300, 300]))
  keepReadingPlace(view.list, place!, (key) => left.indexOf(key))
  assert.equal(view.top(left.indexOf("f")), next.top)
})

test("App notes the place before the render reaches the list and puts it back after; a move taken or undone here doesn't scroll to the end", () => {
  assert.match(app, /if \(placeRef\.current\.key !== placeKey\) \{\s*const list = listRef\.current\s*placeRef\.current = \{ key: placeKey, place: list \? readingPlace\(list, /)
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*shownRef\.current = messages\s*const \{ place \} = placeRef\.current\s*placeRef\.current\.place = null\s*const list = listRef\.current\s*if \(place && list\) keepReadingPlace\(/)
  // What changes the chat above the place: the bars, the rows, the tags, a move.
  assert.match(app, /const placeKey = \[\s*picked \? "picking" : "", pinnedCount, barItems\.length, rowsKey,\s*messages\.map\(\(m\) => \(m\.tags \?\? \[\]\)\.join\(","\)\)\.join\(";"\),\s*keepPlaceFor\.current === messages\.length \? messages\.length : ""\s*\]\.join\("\|"\)/)
  assert.match(app, /const keep = keepPlaceFor\.current === messages\.length\s*keepPlaceFor\.current = -1\s*if \(keep\) return\s*list\.scrollTop = list\.scrollHeight/)
  // Taken (it stays in this chat), undone here, and an older chat joining this one and its Undo.
  assert.match(app, /if \(stays\) \{\s*keepPlaceFor\.current = stays\.m\.length\s*setMessages\(stays\.m\)/)
  assert.match(app, /if \(show === here\) keepPlaceFor\.current = threads\[here\]\?\.m\.length \?\? -1\s*showChat\(show, threads\)/)
  assert.match(app, /if \(moved\.threads\[here\]\) \{\s*keepPlaceFor\.current = moved\.threads\[here\]\.m\.length\s*setMessages\(moved\.threads\[here\]\.m\)/)
  assert.match(app, /if \(threadRef\.current === here && threads\[here\]\) \{\s*keepPlaceFor\.current = threads\[here\]\.m\.length\s*setMessages\(threads\[here\]\.m\)/)
})
