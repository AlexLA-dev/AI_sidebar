// Page watch (2.5): a watched page the person opened is read here, from the live page, the same way the
// background reads a fetched one. That's how sites the background can't read (a script builds the page, a
// bot check) are still checked: when the person comes back to them. Only the values go to the background.

import { readPage, readValue } from "../../shared/watch/extract"
import type { WatchSpec } from "../../shared/watch/messages"

// Pages a script fills in late get a second look.
const FIRST_MS = 4_000
const AGAIN_MS = 10_000

function read(specs: WatchSpec[]): { values: Record<string, string | null>; text?: string } {
  const page = readPage(document.documentElement.outerHTML)
  const values: Record<string, string | null> = {}
  for (const s of specs) values[s.id] = readValue(page, s)
  return { values, ...(specs.some((s) => s.what === "page") ? { text: page.text } : {}) }
}

/** Once per page: is it watched here? If so, its values a little after it settles. */
export function startLiveWatch(): void {
  setTimeout(async () => {
    const specs = (await chrome.runtime.sendMessage({ type: "watchForUrl", url: location.href }).catch(() => [])) as WatchSpec[]
    if (!Array.isArray(specs) || !specs.length) return
    let got = read(specs)
    if (Object.values(got.values).some((v) => v === null)) {
      await new Promise((r) => setTimeout(r, AGAIN_MS - FIRST_MS))
      got = read(specs)
    }
    await chrome.runtime.sendMessage({ type: "watchLive", url: location.href, ...got }).catch(() => undefined)
  }, FIRST_MS)
}
