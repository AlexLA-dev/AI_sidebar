// The control a step was classed on, and the control the hands find (2.7.1, the security review: a step was classed on
// an old map and run on the live element, which React could have relabelled «Continue» → «Pay now» meanwhile).
// Plain data, so the tests load it.

import type { Lock, Role, ToolCall } from "./types.ts"

const plain = (t: string) => t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()

/** Why the live control isn't the one the step was classed on (another role, a press with other words, a field turned
 *  secret), or null when it is. */
export function controlChanged(call: Pick<ToolCall, "tool" | "expect">, now: { role: Role | null; label: string; lock: Lock | null }): string | null {
  const want = call.expect
  if (!want) return null
  if (now.role && now.role !== want.role) return `the control changed since the page was read (now a ${now.role}): read the page again`
  if (want.lock !== "secret" && now.lock === "secret") return "the control is a secret field now: the agent never touches it"
  if ((call.tool === "click" || call.tool === "go" || call.tool === "select") && now.role && plain(now.label) !== plain(want.label)) {
    return `the control changed since the page was read (now "${now.label.slice(0, 60)}"): read the page again`
  }
  return null
}
