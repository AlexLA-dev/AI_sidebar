// Tabs left open across an update of the app get a notice to reload (2.7; src/shared/staleTabs.ts says why). The new
// background asks the tab in front whether its panel hears it ("alive"); one from before the update can't answer, and
// the tab is given the panel's script with a mark, which shows the notice when the person next touches our button or
// panel there (src/content/stale.ts). For a day after an update, each tab as it comes to the front; on other days
// nothing here runs. Never a reload by itself: a form on the page may be half filled.

import { t, uiDirection } from "../shared/i18n"
import { changedSince, checkTab, watching, type Deps, type StaleWords } from "../shared/staleTabs"
import { STORAGE } from "../shared/types"

const KEY = "cf:staleUntil"
const BUILD_KEY = "cf:staleBuild"
const DAY_MS = 24 * 3_600_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
}

const deps: Deps = {
  ask: (tabId) => withTimeout(chrome.tabs.sendMessage(tabId, { type: "alive" }) as Promise<{ ok?: boolean } | null>, 1500),
  // The words first, in this background's language (the tab's own way to its strings may be dead as well), then the
  // panel's script, which finds them and only watches for a touch.
  tell: (tabId) => {
    const words: StaleWords = { text: t("updatedReload"), reload: t("writeReload"), close: t("close"), dir: uiDirection() }
    return withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: (w: StaleWords) => { (window as unknown as { __contextflowStale?: StaleWords }).__contextflowStale = w }, args: [words] })
        .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ["dist/content.js"] })),
      5000
    )
  }
}

// One check per tab at a time, and one per tab while this background lives (the tab's script also knows it was told).
const checked = new Map<number, Promise<unknown>>()

function check(tabId: number): void {
  if (checked.has(tabId)) return
  checked.set(tabId, checkTab(tabId, deps).then((result) => {
    // A tab that answered may be loaded again later with nothing to say; one that was told stays told.
    if (result !== "told") checked.delete(tabId)
  }))
}

async function checkFront(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true })
  for (const tab of tabs) if (tab.id !== undefined) check(tab.id)
}

/**
 * Wires it: after an update, the tabs in front now, then every tab as it comes to the front, for a day.
 * `updated`: call it from runtime.onInstalled when the reason is "update". Safari doesn't always say so, so the app's
 * build (`appBuild`, from the native side) is compared with the one kept here as well.
 */
export function watchStaleTabs(appBuild: () => Promise<string>): { updated: () => void } {
  // Read before this background writes anything: what an earlier ContextFlow left.
  const before = chrome.storage.local.get([BUILD_KEY, STORAGE.installId])
  chrome.tabs.onActivated?.addListener((info) => {
    void chrome.storage.local.get(KEY).then((stored) => {
      if (watching(stored[KEY], Date.now())) check(info.tabId)
    }, () => undefined)
  })
  // A tab loaded again has the new panel: it's asked anew if it ever comes up.
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.status === "loading") checked.delete(tabId)
  })
  const updated = () => {
    void chrome.storage.local.set({ [KEY]: Date.now() + DAY_MS }).catch(() => undefined)
    void checkFront().catch(() => undefined)
  }
  // This background starts many times in that day (Safari puts it to sleep): each time, the tab in front is asked, so
  // a start that Safari didn't call an update, with the same build as before, still reaches it.
  void chrome.storage.local.get(KEY).then((stored) => {
    if (watching(stored[KEY], Date.now())) void checkFront().catch(() => undefined)
  }, () => undefined)
  void Promise.all([before, appBuild()]).then(([kept, build]) => {
    if (!build) return
    if (kept[BUILD_KEY] !== build) void chrome.storage.local.set({ [BUILD_KEY]: build }).catch(() => undefined)
    if (changedSince(kept[BUILD_KEY], build, typeof kept[STORAGE.installId] === "string")) updated()
  }, () => undefined)
  return { updated }
}
