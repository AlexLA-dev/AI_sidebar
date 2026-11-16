// Tabs left open across an update get the panel again: the parts that don't touch the browser (2.7;
// src/background/revive.ts wires them, src/content/orphan.ts says why).

export interface Deps {
  /** Asks the tab's panel; resolves to its answer, rejects or resolves empty when there's none. */
  ask: (tabId: number) => Promise<{ ok?: boolean } | null | undefined>
  inject: (tabId: number) => Promise<unknown>
}

/** The tab's panel answered, or was put in again ("injected"), or couldn't be ("refused"). */
export async function reviveTab(tabId: number, deps: Deps): Promise<"alive" | "injected" | "refused"> {
  try {
    if ((await deps.ask(tabId))?.ok === true) return "alive"
  } catch {
    // No answer: no panel there, or one that can't hear.
  }
  try {
    await deps.inject(tabId)
    return "injected"
  } catch {
    return "refused"
  }
}

/** Whether an update was within the last day (kept on the device: the background doesn't live that long). */
export function reviving(until: unknown, now: number): boolean {
  return typeof until === "number" && now < until
}

