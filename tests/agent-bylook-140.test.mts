// Round 140 (the director's «eyes», part 1b): controls found by look — a pointer-cursor box with no control in it, a
// short piece inside a pointer box that holds controls, a tab stop — within the screen and one screen around it, classed
// by their words as buttons are; and the map's style reads bounded by the screen, not by the page's length.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { parseHTML } from "linkedom"
import { classify } from "../src/shared/agent/classify.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

function domMap(html: string, opts: Record<string, unknown> = {}, url = "https://shop.example/page"): PageMap {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
  const loc = new URL(url)
  Object.defineProperty(document, "location", { configurable: true, get: () => loc })
  Object.defineProperty(document, "baseURI", { configurable: true, get: () => url })
  Object.defineProperty(window, "location", { configurable: true, get: () => loc })
  ;(globalThis as any).__styleReads = 0
  ;(window as any).getComputedStyle = (el: Element) => {
    ;(globalThis as any).__styleReads++
    const inline = el.getAttribute("style") ?? ""
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`).exec(inline)?.[1]?.trim()
    return { display: get("display") ?? "block", visibility: "visible", contentVisibility: "visible", opacity: "1", pointerEvents: "auto", cursor: get("cursor") ?? "auto", textDecorationLine: "none", color: "rgb(20, 20, 20)", backgroundColor: el.tagName === "BODY" ? "rgb(255, 255, 255)" : "rgba(0, 0, 0, 0)" }
  }
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  if ((document as any).defaultView !== window) Object.defineProperty(document, "defaultView", { configurable: true, get: () => window })
  // (data-top: where an element is against the screen; an element without one sits where its nearest placed parent does.)
  for (const el of document.querySelectorAll("*")) {
    const placed = el.closest("[data-top]")
    const top = Number(placed?.getAttribute("data-top") ?? 100)
    ;(el as any).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 10, right: 80, width: 70, height: 40 })
  }
  return (globalThis as any).__buildMap(document, opts)
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-bylook-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export { buildMap } from "${new URL("../src/content/agent/map.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "map.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", define: { __TARGET__: '"safari"', __API_BASE__: '""', __TEST_PLAN__: '""' } })
  ;(globalThis as any).__buildMap = (await import(pathToFileURL(out).href)).buildMap
})

const ctx = (map: PageMap) => ({ map, startHost: "shop.example", request: "Book a manicure", confirmedHere: false, policy: { amazon: false, block: [], allow: [] } })
const byLabel = (map: PageMap, label: string) => map.items.find((i) => i.label === label)

test("a pointer box with no control in it is one control, the largest; its pieces aren't controls of their own", () => {
  const map = domMap(`<div class="slot" style="cursor:pointer"><span style="cursor:pointer">18:30</span><span style="cursor:pointer">€35</span></div>`)
  const found = map.items.filter((i) => i.role === "button")
  assert.equal(found.length, 1, JSON.stringify(map.items))
  assert.match(found[0].label, /18:30.*€35/)
  assert.match(map.outline ?? "", /\[#\S+ button "18:30 ?€35"\]/)
})

test("inside a pointer box that holds a link, a short-worded piece is a control of its own (a master's «Записаться»)", () => {
  const map = domMap(`<div class="master" style="cursor:pointer"><a href="/master/anna">Анна, топ-мастер</a><div style="cursor:pointer">Записаться</div></div>`)
  assert.ok(map.items.some((i) => i.role === "link" && i.label.startsWith("Анна")), "the master's link")
  const sign = byLabel(map, "Записаться")
  assert.ok(sign && sign.role === "button", JSON.stringify(map.items))
})

test("a tab stop is a control; a label, the page, a box beyond a screen around the screen are not", () => {
  const map = domMap(`<span tabindex="0">Choose a time</span><label style="cursor:pointer">Remember me <input type="checkbox"></label>
    <div style="cursor:pointer" data-top="3000">Far away</div><span tabindex="-1">Not a stop</span>`)
  assert.ok(byLabel(map, "Choose a time"), "the tab stop")
  assert.ok(!map.items.some((i) => i.role === "button" && /Remember me/.test(i.label)), "a label stays its input's")
  assert.ok(!byLabel(map, "Far away"), "beyond the screen and one screen around it")
  assert.ok(!byLabel(map, "Not a stop"))
})

test("a control found by look is classed by its words exactly as a button with the same words", () => {
  const map = domMap(`<div style="cursor:pointer">Pay €35 now</div><div style="cursor:pointer">Записаться</div><div style="cursor:pointer">Confirm booking</div>
    <button>Pay €35 now</button><button>Записаться</button><button>Confirm booking</button>`)
  for (const label of ["Pay €35 now", "Записаться", "Confirm booking"]) {
    const [look, real] = map.items.filter((i) => i.label === label)
    assert.ok(look && real, label)
    const a = classify({ tool: "click", id: look.id, why: "" } as ToolCall, ctx(map))
    const b = classify({ tool: "click", id: real.id, why: "" } as ToolCall, ctx(map))
    assert.deepEqual(a, b, label)
  }
  assert.equal(classify({ tool: "click", id: map.items.find((i) => i.label === "Pay €35 now")!.id, why: "" } as ToolCall, ctx(map)).cls, "self")
})

test("the map's style reads grow with what's near the screen, not with the page's length", () => {
  const near = `<div><button>Book</button><a href="/a">About</a></div>`
  const far = (n: number) => Array.from({ length: n }, (_, i) => `<div data-top="${3000 + i * 50}" style="cursor:pointer"><span>Item ${i}</span><a href="/i${i}">Open ${i}</a></div>`).join("")
  const reads = (html: string) => {
    domMap(html)
    return (globalThis as any).__styleReads as number
  }
  const short = reads(near + far(20))
  const long = reads(near + far(400))
  // (The far controls are in the map, checked by their attributes; no style of theirs is read.)
  assert.ok(long - short < 40, `${short} → ${long}`)
  const map = domMap(near + far(400))
  assert.ok(map.items.some((i) => i.label === "Open 50"), "far links are still controls (the part holds 120)")
})
