// 2.8 (the director): the server can switch the agent off (AGENT=off; /api/v2/act then answers OFF). The status answer
// says so (`agent: {on}`), and the panel and the app go by it: nothing offers the agent while it's off.
//
// Three states on the device:
// - "on": the last status said on, or said nothing (an older server: as before the switch);
// - "off": the last status said off, or the agent's own call was answered OFF;
// - "unknown": no status heard yet on this device.
// The last one heard is kept on the device (the panel and the background read it before the first status comes).

export type AgentSwitch = "on" | "off" | "unknown"

/** chrome.storage.local: the last state a status (or the agent's own call) said. */
export const AGENT_SWITCH_KEY = "cf:agentSwitch"

/** The state a status answer says: off only when it says so. */
export function switchFromStatus(body: { agent?: { on?: unknown } | null } | null | undefined): "on" | "off" {
  return body?.agent?.on === false ? "off" : "on"
}

/** The state kept on the device ("unknown" when nothing was kept, or something else was). */
export function keptSwitch(value: unknown): AgentSwitch {
  return value === "on" || value === "off" ? value : "unknown"
}

/** Do, its chips, deferred tasks: as before unless a status said off. */
export function agentOffered(s: AgentSwitch | undefined): boolean {
  return s !== "off"
}

/** The plans and their galleries name the agent only when it's known to be on: a promise at purchase that isn't kept
 *  is the worst case. */
export function agentSold(s: AgentSwitch | undefined): boolean {
  return s === "on"
}
