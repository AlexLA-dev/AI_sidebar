// Round 142, the director's decision 9: a checkout funnel's address («/checkout/», «/kasse/») with no payment sign isn't a
// payment page; its forward presses are carded, choices, counts and fields go free; a payment sign makes every press pay.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

import { classify } from "../src/shared/agent/classify.ts"
import type { MapItem, PageMap } from "../src/shared/agent/types.ts"

const items: MapItem[] = [
  { id: "d", role: "button", label: "SAT 28 €10" }, { id: "d2", role: "button", label: "SUN 29 €10" }, { id: "d3", role: "button", label: "MON 30 €10" }, { id: "d4", role: "button", label: "TUE 1 €10" },
  { id: "t", role: "button", label: "10:00" },
  { id: "add", role: "button", label: "Add ticket" }, { id: "plus", role: "button", label: "+" }, { id: "n", role: "textbox", type: "number", label: "Adults", value: "1" },
  { id: "o", role: "option", label: "Standard entry" }, { id: "tab", role: "tab", label: "Adults" },
  { id: "bd", role: "button", label: "Booking details" }, { id: "c", role: "button", label: "Continue" }, { id: "nx", role: "button", label: "Next" },
  { id: "w", role: "button", label: "Weiter" }, { id: "f", role: "textbox", label: "First name" }
] as MapItem[]
const map = (url: string, extra: Partial<PageMap> = {}): PageMap => ({ url, title: "", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "Total: €-.--", items, ...extra }) as PageMap
const cls = (m: PageMap, id: string, tool = "click") => classify({ tool, id, why: "", text: "Alex", expect: { label: items.find((i) => i.id === id)!.label, role: items.find((i) => i.id === id)!.role } } as never, { map: m, startHost: new URL(m.url).hostname, request: "Get 2 adult tickets for 28 Nov", confirmedHere: false, policy: {} } as never)

let takesPayment: (d: Document) => boolean
let funnelPath: (d: Document) => boolean
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-funnel-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `export { funnelPath, takesPayment } from "${new URL("../src/content/agent/map.ts", import.meta.url).pathname}"\n`)
  const out = join(dir, "map.mjs")
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", define: { __TARGET__: '"safari"', __API_BASE__: '""', __TEST_PLAN__: '""' } })
  ;({ funnelPath, takesPayment } = await import(pathToFileURL(out).href))
})

const doc = (pathname: string, card = false) => ({ location: { pathname, href: `https://x.example${pathname}` }, querySelector: (q: string) => (card && /cc-number/.test(q) ? {} : null), querySelectorAll: () => [] }) as unknown as Document

test("the address alone: «checkout» and «kasse» are a funnel, the payment words stay a payment page", () => {
  for (const p of ["/en/checkout/tickets-p1/booking_details/", "/de/kasse/schritt-1", "/checkout"]) {
    assert.equal(takesPayment(doc(p)), false, p)
    assert.equal(funnelPath(doc(p)), true, p)
  }
  for (const p of ["/payment/", "/billing", "/zahlung/", "/order-confirm", "/ko/결제", "/pay"]) assert.equal(takesPayment(doc(p)), true, p)
  assert.equal(takesPayment(doc("/en/checkout/x", true)), true, "a card field makes the funnel a payment page")
})

test("inside a funnel with no payment sign: day chips, a time, a counter's plus, an option, a tab and fields go free", () => {
  const m = map("https://x.example/en/checkout/tickets/booking_details/", { funnel: true })
  for (const id of ["d", "t", "add", "plus", "o", "tab"]) assert.equal(cls(m, id).cls, "free", id)
  assert.equal(cls(m, "f", "type").cls, "free")
})

test("inside a funnel with no payment sign: a forward press is carded (checkout_step)", () => {
  const m = map("https://x.example/de/kasse/schritt-1", { funnel: true })
  for (const id of ["bd", "c", "nx", "w"]) assert.deepEqual(cls(m, id), { cls: "confirm", reason: "checkout_step" }, id)
})

test("a payment sign on the funnel page: every press is the person's own", () => {
  const m = map("https://x.example/en/checkout/tickets/booking_details/", { pay: true })
  for (const id of ["d", "add", "bd", "plus", "t"]) assert.deepEqual(cls(m, id), { cls: "self", reason: "pay" }, id)
})
