// A fake page's answer to the device's «dial» (decision 15f) in the runner tests: the choice phone.ts makes, from the
// control's own options (or the list a button opens), carried out as the fake page understands it (a select, or the
// option's click).
import { chooseDial } from "../../src/shared/agent/phone.ts"
import type { RunnerIO } from "../../src/shared/agent/runner.ts"
import type { ToolCall } from "../../src/shared/agent/types.ts"

export function withDial(io: RunnerIO): RunnerIO {
  const act = io.act.bind(io)
  return {
    ...io,
    act: async (c: ToolCall) => {
      if (c.tool !== "dial") return act(c)
      let map = await io.map({})
      const item = map?.items.find((i) => i.id === c.id)
      let opts = item?.options?.length ? item.options : null
      if (!opts && item?.role === "button") {
        await act({ tool: "click", id: c.id, why: "" })
        map = await io.map({})
        opts = map?.items.filter((i) => i.role === "option").map((i) => i.label) ?? []
      }
      const pick = chooseDial((opts ?? []).map((label) => ({ label })), item?.value, (c.codes ?? [])[0] ?? "", c.names ?? [], c.keep === true, [...(c.avoid ?? []), ...(c.option ? [c.option] : [])])
      if (!pick) return { ok: false, note: "no option carries the code" }
      if (item?.role === "button") {
        const o = map!.items.find((i) => i.role === "option" && i.label === pick.chosen)
        await act({ tool: "click", id: o!.id, why: "" })
      } else if (pick.chosen !== item?.value) await act({ tool: "select", id: c.id!, option: pick.chosen, why: "" })
      return { ok: true, note: `chose "${pick.chosen}"`, data: JSON.stringify(pick) }
    }
  } as RunnerIO
}
