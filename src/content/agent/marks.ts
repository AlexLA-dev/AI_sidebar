// Deferred agent tasks in the page's address (2.7.1): a notification's tap opens the page with #cf-task=<id>
// (AgentTasks.swift); the panel takes the mark out at once and offers «Начать». Sites where the person switched that
// tap off («На этом сайте начинать сразу», the owner: «как с переводом») start the task right away; the list is in
// the settings, where each can be switched back on. «Сделать?» and the person's own steps still ask there.

export const AGENT_AUTO_KEY = "cf:agentAutoStart"
const MARK = /(^#|&)cf-task=([A-Za-z0-9_-]{1,80})(?=&|$)/

/** The task id the address carries, taken out of the address (the page's own fragment kept). */
export function takeTaskMark(loc: Location = location, hist: History = history): string | null {
  const m = MARK.exec(loc.hash)
  if (!m) return null
  const rest = loc.hash.replace(MARK, "").replace(/^#&/, "#").replace(/^#$/, "")
  try {
    hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}${rest}`)
  } catch {
    try {
      hist.replaceState(null, "", `${loc.pathname}${loc.search}${rest}`)
    } catch {
      // the mark stays; it's read once
    }
  }
  return m[2]
}

const host = (h: string) => h.toLowerCase().replace(/^www\./, "")

export async function autoStartSites(): Promise<string[]> {
  return ((await chrome.storage.local.get(AGENT_AUTO_KEY))[AGENT_AUTO_KEY] as string[] | undefined) ?? []
}

export async function autoStartHere(hostname: string): Promise<boolean> {
  return (await autoStartSites()).includes(host(hostname))
}

export async function setAutoStart(hostname: string, on: boolean): Promise<void> {
  const h = host(hostname)
  const list = (await autoStartSites()).filter((x) => x !== h)
  await chrome.storage.local.set({ [AGENT_AUTO_KEY]: on ? [h, ...list].slice(0, 300) : list })
}
