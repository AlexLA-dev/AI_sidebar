// Round 145, the director's decision 19: the device finds the plan's service across the whole page — the rows naming
// it with their own choose controls, up to five, those controls mapped wherever they are; none — the page's groups; a
// second read of an unchanged part is answered with that, not with the same part again.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { parseHTML } from "linkedom"

import { DEFAULT_RULES } from "../src/shared/agent/rules.ts"
import { drive, newState, servicePage, type AgentState, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { MapItem, PageMap, ToolCall } from "../src/shared/agent/types.ts"

let lib: { buildMap: (d: Document, o?: object) => PageMap; rowsOn: (d: Document, t: string[]) => { rows: Array<{ text: string; id: string; label: string }>; groups: string[] } }

function dom(html: string): Document {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
  const loc = new URL("https://salon.example/venue")
  Object.defineProperty(document, "location", { configurable: true, get: () => loc })
  Object.defineProperty(document, "baseURI", { configurable: true, get: () => loc.href })
  ;(window as any).getComputedStyle = (el: Element) => {
    const inline = el.getAttribute("style") ?? ""
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`).exec(inline)?.[1]?.trim()
    return { display: "block", visibility: "visible", contentVisibility: "visible", opacity: "1", pointerEvents: "auto", cursor: get("cursor") ?? "auto", textDecorationLine: "none", color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)", ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].flatMap((s) => [[`border${s}Width`, "0px"], [`border${s}Style`, "none"]])) }
  }
  Object.assign(globalThis as any, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement })
  if ((document as any).defaultView !== window) Object.defineProperty(document, "defaultView", { configurable: true, get: () => window })
  for (const el of document.querySelectorAll("*")) {
    const top = Number(el.closest("[data-top]")?.getAttribute("data-top") ?? 100)
    ;(el as any).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 10, right: 300, width: 290, height: 40 })
  }
  return document as unknown as Document
}

/** A venue's service list of 200 rows in four groups, «Choose» drawn as a pointer box, one row named `name` at `at`. */
function list(name: string, at: number, choose = "Choose", group = "Group"): string {
  const rows = Array.from({ length: 200 }, (_, i) => {
    const title = i === at ? name : `Service number ${i + 1}`
    const head = i % 50 === 0 ? `<h3>${group} ${i / 50 + 1}</h3>` : ""
    return `${head}<div class="row" data-top="${100 + i * 60}"><span>${title}</span><span>30 min</span><span>€${20 + (i % 9)}</span><div style="cursor:pointer">${choose}</div></div>`
  })
  return `<h1>Salon Example</h1>${rows.join("")}`
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-rows-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export { buildMap } from "${new URL("../src/content/agent/map.ts", import.meta.url).pathname}"\nexport { rowsOn } from "${new URL("../src/content/agent/hands.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "lib.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", define: { __TARGET__: '"safari"', __API_BASE__: '""', __TEST_PLAN__: '""' } })
  lib = await import(pathToFileURL(out).href)
})

test("19: a 200-row list, the named service in its third part — found with its own control, mapped though far below (four scripts)", () => {
  for (const [name, term, choose] of [["Men's haircut", "men's haircut", "Choose"], ["Мужская стрижка", "мужская стрижка", "Выбрать"], ["メンズカット", "メンズカット", "選択"], ["قص شعر رجالي", "قص شعر رجالي", "اختر"], ["Coupe Homme", "coupe homme", "Choisir"]]) {
    const doc = dom(list(name, 150, choose))
    const found = lib.rowsOn(doc, [term])
    assert.equal(found.rows.length, 1, `${name}: ${JSON.stringify(found.rows)}`)
    assert.match(found.rows[0].text, new RegExp(name))
    assert.equal(found.rows[0].label, choose)
    const map = lib.buildMap(doc, { size: 10_000 })
    const item = map.items.find((i) => i.id === found.rows[0].id)
    assert.equal(item?.role, "button", `${name}: the row's control is in the map`)
  }
})

test("19: no row names the service — none, and the page's groups", () => {
  const doc = dom(list("Service number 151", 150))
  const found = lib.rowsOn(doc, ["men's haircut"])
  assert.deepEqual(found.rows, [])
  assert.deepEqual(found.groups.slice(0, 3), ["Salon Example", "Group 1", "Group 2"])
})

test("19: at most five rows", () => {
  const doc = dom(Array.from({ length: 8 }, (_, i) => `<div><span>Men's haircut ${i}</span><span>30 min</span><button>Book</button></div>`).join(""))
  assert.equal(lib.rowsOn(doc, ["men's haircut"]).rows.length, 5)
})

// ---- the runner's side

const venue = (items: MapItem[] = []): PageMap => ({ url: "https://salon.example/venue", title: "Salon", lang: "en", more: 0, part: 1, parts: 1, forms: [],
  text: "Salon Example\nService 1 30 min €20\nService 2 45 min €30\nService 3 60 min €40", items: [{ id: "1", role: "button", label: "Reviews" }, ...items] }) as PageMap

function io(calls: Array<Record<string, unknown>>, rows: Array<{ text: string; id: string; label: string }>, groups: string[] = []) {
  const acts: ToolCall[] = []
  const sentMaps: PageMap[] = []
  const refusals: string[] = []
  const replies = calls.map((c) => ({ ok: true, call: { why: "", ...c } as unknown as ToolCall, verdict: { cls: "free", reason: c.tool === "click" ? "click" : "read" } }))
  const x = {
    map: async () => venue(), waitPage: async () => {},
    act: async (c: ToolCall) => { acts.push(c); return c.tool === "rows" ? { ok: true, note: "rows", data: JSON.stringify({ rows, groups }) } : { ok: true, note: "the page went on" } },
    ask: async (req: { map: PageMap; refused?: string }) => { sentMaps.push(req.map); refusals.push(req.refused ?? ""); return replies.shift() ?? { ok: true, call: { tool: "done", summary: "x", why: "" }, verdict: { cls: "free", reason: "read" } } },
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 6, planning: false,
    device: async () => ({ reminders: "yes", calendar: "none" }), rules: async () => DEFAULT_RULES, playbook: { get: async () => null, put: async () => {} }
  } as unknown as RunnerIO
  return { x, acts, sentMaps, refusals }
}
const planned = (): AgentState => {
  const st = newState("rw", "Book a men's haircut next week.", "en", "https://salon.example/venue")
  st.plan = { steps: [], questions: [], perms: [], self: [], prices: [], approved: true, booking: { kind: "appointment", date: "2026-12-04", personal: false, from: "09:00", until: "21:00", minutes: 45, serviceNamed: "Men's haircut", match: ["haircut"] } } as never
  return st
}

test("19 (runner): the rows go to the model once, their controls in the map; a pressed row's control is the map's", async () => {
  const t = io([{ tool: "click", id: "f150" }], [{ text: "Men's haircut 30 min €25 Choose", id: "f150", label: "Choose" }])
  const st = await drive(planned(), t.x)
  assert.equal(t.acts.filter((a) => a.tool === "rows").length, 1)
  assert.deepEqual(t.acts.find((a) => a.tool === "rows")?.words, ["Men's haircut", "haircut"])
  assert.match(t.refusals[0], /looked through the whole page for «Men's haircut»: «Men's haircut 30 min €25 Choose» — its button #f150/)
  assert.ok(t.sentMaps[0].items.some((i) => i.id === "f150" && i.role === "button"))
  assert.ok(t.acts.some((a) => a.tool === "click" && a.id === "f150"), st.log.map((l) => l.result).join(" | "))
})

test("19 (runner): none found — one line with the page's groups", async () => {
  const t = io([], [], ["Women", "Men", "Children"])
  await drive(planned(), t.x)
  assert.match(t.refusals[0], /no row names it\. The page's groups: «Women», «Men», «Children»/)
})

test("19 (runner): a second read of the same part, unchanged, is answered with the rows — the part isn't read again", async () => {
  const t = io([{ tool: "read_page", part: 1 }, { tool: "read_page", part: 1 }], [{ text: "Men's haircut 30 min €25 Choose", id: "f150", label: "Choose" }])
  const st = await drive(planned(), t.x)
  assert.equal(t.acts.filter((a) => a.tool === "read_page").length, 1, "one read reached the page")
  assert.ok(st.log.some((l) => /^the page hasn't changed since you read this part: the device looked through the whole page/.test(l.result ?? "")))
})

test("19: a venue's page is told by its durations or prices; a list of places isn't one; no service named — no search", async () => {
  assert.equal(servicePage(venue()), true)
  assert.equal(servicePage({ ...venue(), text: "Welcome" } as PageMap), false)
  const st = planned()
  st.plan!.booking = { ...st.plan!.booking!, serviceNamed: undefined, match: [] }
  const t = io([], [])
  await drive(st, t.x)
  assert.equal(t.acts.filter((a) => a.tool === "rows").length, 0)
})
