// A panel left on a page by the extension as it was before an update (2.7, the owner on TestFlight 107: Listen asked
// about notifications that were on, opened the app, and the app said the text was no longer there, round and round).
//
// When the app is updated, Safari loads the new extension; a tab that stayed open keeps the old panel, and that panel's
// link to the extension is dead: nothing it sends is answered. Its chats still open (they're in its memory), so it looks
// alive. Listen then read "no answer" about notifications as "off", and its text never left for the app.
//
// Two things mend it. The new extension gives such a tab the panel again (src/background/revive.ts), and the new panel
// hides the old one (retireOrphans). And a panel that finds its own link dead says so, once, with Reload (gone).

/** What hides a host: it can't be taken out of the page (the old panel puts its host back when it's removed). */
interface Host {
  setAttribute(name: string, value: string): void
  style: { setProperty(name: string, value: string, priority?: string): void }
}

/**
 * Hides every panel host already in the page: this script runs once in its own world, so a host that's there before it
 * mounts was put there by the extension as it was before an update. Returns how many there were.
 */
export function retireOrphans(doc: { querySelectorAll(selector: string): ArrayLike<unknown> }, tag: string): number {
  const old = Array.from(doc.querySelectorAll(tag)) as Host[]
  for (const host of old) {
    host.setAttribute("data-cf-retired", "")
    host.style.setProperty("display", "none", "important")
  }
  return old.length
}

/** Whether this panel's link to the extension is gone for sure, told without asking (the runtime has no id any more, or
 *  can't be reached at all). False doesn't promise it's alive: `alive` asks. */
export function gone(runtime: { id?: string } | undefined = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime): boolean {
  try {
    return !runtime?.id
  } catch {
    return true
  }
}

/**
 * Whether the extension answers this panel: asked twice a moment apart before it's taken as gone (a background that is
 * just starting answers the second time). `send` is the panel's way to the background (null: no answer).
 */
export async function alive(send: (message: { type: "alive" }) => Promise<{ ok?: boolean } | null>, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<boolean> {
  if (gone()) return false
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await wait(400)
    const reply = await send({ type: "alive" }).catch(() => null)
    if (reply?.ok === true) return true
  }
  return false
}
