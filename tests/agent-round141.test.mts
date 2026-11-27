// Round 141 (the director on report-140): «back» never leaves the task's pages; the other items of the round follow.
import assert from "node:assert/strict"
import { test } from "node:test"

import { drive, newState, type ActReply, type RunnerIO } from "../src/shared/agent/runner.ts"
import type { PageMap, ToolCall } from "../src/shared/agent/types.ts"

const step = (call: ToolCall, cls: "free" | "confirm" | "self", reason: string): ActReply => ({ ok: true, call, verdict: { cls, reason }, target: null })
const page = (url: string, items: PageMap["items"]): PageMap => ({ url, title: "Salon", lang: "en", forms: [], more: 0, part: 1, parts: 1, text: "A salon page", items }) as PageMap

test("«back» goes to a page this task was on, never past the task's first page (a second «back» left the site)", async () => {
  const first = page("https://salon.example/place/1", [{ id: "1", role: "link", label: "Services", href: "/place/1/services" }])
  const second = page("https://salon.example/place/1/services", [{ id: "2", role: "button", label: "Haircut" }])
  let at = first
  const replies: ActReply[] = [
    step({ tool: "go", id: "1", why: "Opening the services" }, "free", "go"),
    step({ tool: "back", why: "Back to the salon" }, "free", "read"),
    step({ tool: "back", why: "Back again" }, "free", "read"),
    step({ tool: "done", summary: "stopped", why: "" }, "free", "read")
  ]
  const acts: string[] = []
  const io: RunnerIO = {
    map: async () => at,
    act: async (c) => {
      acts.push(c.tool)
      if (c.tool === "go") at = second
      if (c.tool === "back") at = at === second ? first : page("about:blank", [])
      return { ok: true, note: c.tool === "back" ? "went back" : "the page went on", navigated: true }
    },
    waitPage: async () => {}, ask: async () => replies.shift() ?? step({ tool: "done", summary: "", why: "" }, "free", "read"),
    save: async () => {}, entries: async () => [], policy: { amazon: true }, maxSteps: 30
  }
  const st = await drive(newState("b141", "Book a haircut", "en", first.url), io)
  assert.deepEqual(acts, ["go", "back"], "only the first «back» reached the page")
  assert.ok(st.log.some((e) => e.call.tool === "back" && /^refused: «back» here would leave/.test(e.result)), JSON.stringify(st.log.map((e) => e.result)))
  assert.equal(st.ruleCounts?.back_floor, 1)
})
