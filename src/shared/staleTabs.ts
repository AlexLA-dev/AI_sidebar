// Tabs left open across an update of the app (2.7, the owner on TestFlight 107: Listen in a loop): the parts that
// don't touch the browser. src/background/staleTabs.ts wires them, src/content/stale.ts shows the notice.
//
// Safari keeps the old panel in such a tab, and the tab's link to the extension is dead: nothing the panel sends is
// answered, so questions hang, Listen never starts, the plan shows Free. A panel put there again is cut off the same
// way (tried on a device); only loading the page again mends it. The new background can still run a script in the
// tab, so it puts a notice there: «ContextFlow was updated. Reload this page» with Reload.

export interface Deps {
  /** Asks the tab's panel; resolves to its answer, rejects or resolves empty when there's none. */
  ask: (tabId: number) => Promise<{ ok?: boolean } | null | undefined>
  /** Puts the notice's script into the tab. */
  tell: (tabId: number) => Promise<unknown>
}

/** The tab's panel answered ("alive"), or the tab was given the notice's script ("told"), or refused it ("refused"). */
export async function checkTab(tabId: number, deps: Deps): Promise<"alive" | "told" | "refused"> {
  try {
    if ((await deps.ask(tabId))?.ok === true) return "alive"
  } catch {
    // No answer: no panel there, or one that can't hear.
  }
  try {
    await deps.tell(tabId)
    return "told"
  } catch {
    // A page that can't be scripted, a site the extension isn't allowed on: it stays as it is.
    return "refused"
  }
}

/**
 * Whether the app (and the extension with it) changed since this background last looked. `kept` is the app's build as
 * kept on the device, `build` the one the app reports now. Safari doesn't always say "update" (a build installed over
 * another from Xcode or TestFlight can come as "install", or as nothing at all), so the build itself is compared; with
 * none kept yet, an earlier ContextFlow's data on the device (`hadData`) says there was one before.
 */
export function changedSince(kept: unknown, build: string, hadData: boolean): boolean {
  if (!build) return false
  if (typeof kept === "string" && kept) return kept !== build
  return hadData
}

/** Whether an update was within the last day (kept on the device: the background doesn't live that long). */
export function watching(until: unknown, now: number): boolean {
  return typeof until === "number" && now < until
}

/** What the notice says, handed to the tab by the background (the tab's own way to the strings may be dead too). */
export interface StaleWords {
  text: string
  reload: string
  close: string
  dir: "rtl" | "ltr"
}

/**
 * Whether what's under a grid of points looks like our panel open: the round button and the selection buttons cover a
 * point or two of 25, an open panel a fifth of the screen or more.
 */
export function panelLooksOpen(hits: number, points: number): boolean {
  return points > 0 && hits / points >= 0.2
}

/** The visible part of the page, in the coordinates the notice is placed in. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where the notice goes: by the touch that asked for it (above it, below when there's no room), or at the top of what's
 * visible when nothing was touched (the panel was open when the update came). Always inside what's visible.
 */
export function noticePlace(touch: { x: number; y: number } | null, width: number, height: number, view: Box): { left: number; top: number } {
  const minLeft = view.left + 8
  const maxLeft = Math.max(minLeft, view.right - 8 - width)
  if (!touch) return { left: Math.max(minLeft, Math.min(maxLeft, (view.left + view.right - width) / 2)), top: view.top + 12 }
  const above = touch.y - 28 - height
  const top = above >= view.top + 8 ? above : touch.y + 28
  return {
    left: Math.max(minLeft, Math.min(maxLeft, touch.x - width / 2)),
    top: Math.max(view.top + 8, Math.min(view.bottom - 8 - height, top))
  }
}
