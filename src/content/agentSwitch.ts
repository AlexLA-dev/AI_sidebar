// 2.8 (the director): the server's agent switch as this device last heard it (src/shared/agentSwitch.ts), for the
// panel's surfaces. The background keeps it (every status, and the agent's own call answered OFF); every change comes
// here at once, and it's read again whenever `tick` (the panel's status) changes.
import { useEffect, useState } from "preact/hooks"

import { AGENT_SWITCH_KEY, keptSwitch, type AgentSwitch } from "../shared/agentSwitch"

export async function agentSwitchNow(): Promise<AgentSwitch> {
  try {
    return keptSwitch((await chrome.storage.local.get(AGENT_SWITCH_KEY))[AGENT_SWITCH_KEY])
  } catch {
    return "unknown"
  }
}

export function useAgentSwitch(tick?: unknown): AgentSwitch {
  const [now, setNow] = useState<AgentSwitch>("unknown")
  useEffect(() => {
    let live = true
    void agentSwitchNow().then((s) => live && setNow(s))
    return () => {
      live = false
    }
  }, [tick])
  useEffect(() => {
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && AGENT_SWITCH_KEY in changes) setNow(keptSwitch(changes[AGENT_SWITCH_KEY].newValue))
    }
    try {
      chrome.storage.onChanged.addListener(onChange)
    } catch {
      return
    }
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])
  return now
}
