// 2.6 (97): the bar of a chat's open suggestions at its top (src/content/SuggestionsBar.tsx): in the chat's order, one
// line of the current one with "Suggested · 2/3", a tap opens it and moves on (after the last, the first), no
// suggestion no bar, one line beside the pinned bar; and the suggestion chips it scrolls to carry their kind.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let ui: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element })
  const dir = mkdtempSync(join(tmpdir(), "cf-sugbar-"))
  const bar = JSON.stringify(new URL("../src/content/SuggestionsBar.tsx", import.meta.url).pathname)
  const org = JSON.stringify(new URL("../src/content/Organize.tsx", import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { SuggestionsBar, inChatOrder, barLabel, preview } from ${bar}
    import { OrganizeRow, moveLine } from ${org}
    export { inChatOrder, barLabel, moveLine, preview }
    export function bar(container: Element, props: unknown) { render(h(SuggestionsBar, props as never), container) }
    export function row(container: Element, props: unknown) { render(h(OrganizeRow, props as never), container) }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname], loader: { ".css": "empty" }
  })
  ui = await import(pathToFileURL(out).href)
})

const tick = () => new Promise((r) => setTimeout(r, 150))
const click = async (el: any) => {
  el.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
  await tick()
}

test("the open suggestions in the chat's order: the earlier message first; under one message a tag, a move, a name", () => {
  const name = { kind: "name", key: "n", index: 9, text: "Name it" }
  const move = { kind: "move", key: "m", index: 9, text: "Bring here" }
  const tag = { kind: "tag", key: "t", index: 9, text: "#trips · How long" }
  const early = { kind: "move", key: "m2", index: 3, text: "2 messages to" }
  const earlyTag = { kind: "tag", key: "t2", index: 1, text: "#work · Notes" }
  assert.deepEqual(ui.inChatOrder([name, move, early, tag, earlyTag]).map((x: { key: string }) => x.key), ["t2", "m2", "t", "m", "n"])
  assert.equal(ui.preview("**Kyoto** in `autumn`:\n\n- temples, ---  gardens"), "Kyoto in autumn: - temples, gardens")
  assert.equal(ui.barLabel(0, 1), "Suggested · 1")
  assert.equal(ui.barLabel(1, 3), "Suggested · 2/3")
})

test("a move as one line, as its chip says it", () => {
  const base = { start: 2, end: 5, score: 0.8, current: 0.2, count: 2, toName: "Trips" }
  assert.equal(ui.moveLine({ ...base, to: "t1", why: "topic" }), "2 messages to “Trips”")
  assert.equal(ui.moveLine({ ...base, to: null, why: "apart" }), "To a new chat: “Trips”")
  assert.equal(ui.moveLine({ ...base, to: "t1", why: "merge" }), "Merge into “Trips”")
  assert.equal(ui.moveLine({ ...base, to: "here", from: "old", why: "merge" }), "Bring “Trips” here")
})

test("a tap opens the current one and moves on, from the last to the first; no suggestion, no bar", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  const opened: string[] = []
  const items = [{ kind: "move", key: "m", index: 3, text: "2 messages to “Trips”" }, { kind: "name", key: "n", index: 8, text: "Name it “Kyoto”" }]
  ui.bar(el, { items, onOpen: (x: { key: string }) => opened.push(x.key) })
  await tick()
  const main = () => el.querySelector(".cf-sugbar-main")
  assert.equal(el.querySelector(".cf-sugbar-label").textContent, "Suggested · 1/2")
  assert.equal(el.querySelector(".cf-sugbar-line").textContent, "2 messages to “Trips”")
  assert.equal(main().getAttribute("aria-label"), "Suggested · 1/2: 2 messages to “Trips”")
  assert.equal(el.querySelectorAll(".cf-sugbar-segments span").length, 2)
  await click(main())
  assert.equal(el.querySelector(".cf-sugbar-label").textContent, "Suggested · 2/2")
  assert.equal(el.querySelector(".cf-sugbar-line").textContent, "Name it “Kyoto”")
  await click(main())
  await click(main())
  assert.deepEqual(opened, ["m", "n", "m"])
  assert.equal(el.querySelector(".cf-sugbar-label").textContent, "Suggested · 2/2")
  // One taken: the bar shows the one left, from the start.
  ui.bar(el, { items: items.slice(1), onOpen: () => {} })
  await tick()
  assert.equal(el.querySelector(".cf-sugbar-label").textContent, "Suggested · 1")
  assert.equal(el.querySelector(".cf-sugbar-line").textContent, "Name it “Kyoto”")
  // None left: no bar.
  ui.bar(el, { items: [], onOpen: () => {} })
  await tick()
  assert.equal(el.querySelector(".cf-sugbar"), null)
  // Beside the pinned bar: one line.
  ui.bar(el, { items, compact: true, onOpen: () => {} })
  await tick()
  assert.ok(el.querySelector(".cf-sugbar").classList.contains("compact"))
})

test("the chips the bar scrolls to carry their kind", async () => {
  const el = dom.document.createElement("div")
  dom.document.body.appendChild(el)
  const noop = () => {}
  ui.row(el, { tag: "trips", move: { start: 0, end: 3, to: "t1", why: "topic", score: 0.8, current: 0.2, count: 2, toName: "Trips" }, name: "Kyoto", onTag: noop, onTagNo: noop, onMove: noop, onMoveNo: noop, onName: noop, onNameNo: noop })
  await tick()
  assert.equal(el.querySelectorAll("[data-sug=move]").length, 1)
  assert.equal(el.querySelectorAll("[data-sug=name]").length, 1)
  assert.equal(el.querySelectorAll("[data-sug=tag]").length, 1)
})
