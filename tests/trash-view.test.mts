// Recently Deleted in the panel (2.5 (83)): its row at the end of the chat list, and its screen, rendered in a DOM.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

import type { Thread } from "../src/shared/threads.ts"

const DAY = 86_400_000
const chat = (id: string, name: string, extra: Partial<Thread> = {}): Thread => ({
  id, u: 1, a: 1, title: name,
  m: [{ role: "user", content: name }, { role: "assistant", content: `About ${name}` }],
  ...extra
})

let harness: any
let dom: any
before(async () => {
  dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>")
  Object.assign(globalThis, { window: dom.window, document: dom.document, ShadowRoot: dom.window.ShadowRoot, Node: dom.window.Node, Element: dom.window.Element })
  const dir = mkdtempSync(join(tmpdir(), "cf-trash-"))
  const src = (file: string) => JSON.stringify(new URL(`../src/content/${file}`, import.meta.url).pathname)
  writeFileSync(join(dir, "entry.ts"), `
    import { h, render } from "preact"
    import { TrashView } from ${src("Trash.tsx")}
    import { ThreadsView } from ${src("Threads.tsx")}
    export function trash(container: Element, props: any) { render(h(TrashView, props), container) }
    export function list(container: Element, props: any) {
      const noop = () => {}
      render(h(ThreadsView, {
        activeId: "", onOpen: noop, onRename: noop, onDelete: noop, onNew: noop, onPin: noop, onMove: noop, onOpenPage: noop,
        pro: false, onAskHistory: noop, onFind: async () => ({ ok: false, code: "NETWORK" }), onUpsell: noop, findError: String,
        onTags: noop, grouped: false, onGrouped: noop, ...props
      }), container)
    }
    export function clear(container: Element) { render(null, container) }
  `)
  const out = join(dir, "entry.mjs")
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [new URL("../node_modules", import.meta.url).pathname],
    loader: { ".css": "empty" }
  })
  harness = await import(pathToFileURL(out).href)
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const root = () => {
  const el = dom.document.getElementById("root")
  harness.clear(el)
  return el
}
const click = (el: Element) => el.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
const buttons = (el: Element, text: string) => [...el.querySelectorAll("button")].filter((b: Element) => b.textContent?.trim() === text)

test("Recently Deleted: each chat with its days left, Restore and Delete Now; Delete All asks first", async () => {
  const el = root()
  const calls: string[] = []
  const now = Date.now()
  harness.trash(el, {
    threads: [chat("b", "Pasta night", { trashed: now - DAY - 1000 }), chat("a", "Trip to Rome", { trashed: now - 29.5 * DAY })],
    onRestore: (id: string) => calls.push(`restore ${id}`),
    onDelete: (id: string) => calls.push(`delete ${id}`),
    onDeleteAll: () => calls.push("all")
  })
  const rows = [...el.querySelectorAll(".cf-trash-item")]
  assert.deepEqual(rows.map((r: Element) => r.querySelector(".cf-thread-title")?.textContent), ["Pasta night", "Trip to Rome"])
  assert.deepEqual(rows.map((r: Element) => r.querySelector(".cf-thread-when")?.textContent), ["29 days", "1 day"])
  assert.match(el.querySelector(".cf-trash-note").textContent, /30 days/)

  click(buttons(rows[1], "Restore")[0])
  click(buttons(rows[0], "Delete Now")[0])
  assert.deepEqual(calls, ["restore a", "delete b"])

  // Delete All: a question first; Cancel leaves everything, the second Delete All deletes.
  click(buttons(el, "Delete All")[0])
  await tick()
  assert.ok(el.querySelector(".cf-trash-confirm"))
  assert.deepEqual(calls, ["restore a", "delete b"])
  click(buttons(el, "Cancel")[0])
  await tick()
  assert.equal(el.querySelector(".cf-trash-confirm"), null)
  click(buttons(el, "Delete All")[0])
  await tick()
  click(buttons(el.querySelector(".cf-trash-confirm"), "Delete All")[0])
  await tick()
  assert.deepEqual(calls, ["restore a", "delete b", "all"])
})

test("the chat list ends with Recently Deleted · N while it has chats, also when every chat is there", async () => {
  const el = root()
  let opened = 0
  const threads = [chat("x", "Kept chat", { tags: ["Work"] }), chat("y", "Another")]
  harness.list(el, { threads, trashCount: 2, onOpenTrash: () => opened++ })
  const items = [...el.querySelectorAll('[role="list"] > [role="listitem"]')]
  const last = items.at(-1) as Element
  assert.ok(last.classList.contains("cf-trash-row"))
  assert.equal(last.textContent?.trim(), "Recently Deleted · 2")
  click(last.querySelector(".cf-thread-main"))
  assert.equal(opened, 1)

  // None there: no row.
  harness.list(root(), { threads, trashCount: 0, onOpenTrash: () => opened++ })
  assert.equal(dom.document.querySelector(".cf-trash-row"), null)

  // Every chat in Recently Deleted: the empty list still leads there.
  const empty = root()
  harness.list(empty, { threads: [], trashCount: 3, onOpenTrash: () => opened++ })
  assert.ok(empty.querySelector(".cf-empty"))
  assert.equal(empty.querySelector(".cf-trash-row")?.textContent?.trim(), "Recently Deleted · 3")
})

test("Recently Deleted has its words in every language, the days in each plural form", () => {
  const dir = new URL("../src/locales/", import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  assert.equal(files.length, 11)
  for (const file of files) {
    const s = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>
    for (const key of ["trashTitle", "trashRow", "trashNote", "trashRestore", "trashDeleteNow", "trashDeleteAll", "trashDeleteAllAsk", "trashDays_one", "trashDays_few", "trashDays_many", "trashDays_other"]) {
      assert.ok(s[key]?.trim(), `${file}: ${key}`)
    }
    assert.ok(s.trashRow.startsWith(s.trashTitle), `${file}: the row is the screen's name`)
    assert.match(s.trashRow, /\{0\}/, file)
    for (const form of ["one", "few", "many", "other"]) assert.match(s[`trashDays_${form}`], /\{0\}/, `${file}: trashDays_${form}`)
    assert.match(s.trashNote, /30/, file)
  }
})
