// Tabs left open across an update get the panel again (2.7; src/content/orphan.ts says why). The extension's new
// background asks the tab in front whether its panel hears it ("alive"); one put there before the update can't answer,
// so the panel is put in again, and it hides the old one. For a day after an update, each tab as it comes to the front;
// on other days nothing here runs. A tab that was never given the panel (a page that can't be scripted, a site the
// extension isn't allowed on) refuses the script, and stays as it is.

import { reviveTab, reviving, type Deps } from "../shared/revive"

const KEY = "cf:revivedUntil"
const DAY_MS = 24 * 3_600_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
}

const deps: Deps = {
  ask: (tabId) => withTimeout(chrome.tabs.sendMessage(tabId, { type: "alive" }) as Promise<{ ok?: boolean } | null>, 1500),
  inject: (tabId) => withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ["dist/content.js"] }), 5000)
}

async function reviveFront(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true })
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? null : reviveTab(tab.id, deps))))
}

/**
 * Wires it: after an update, the tabs in front now, then every tab as it comes to the front, for a day.
 * `updated`: call it from runtime.onInstalled when the reason is "update".
 */
export function startRevive(): { updated: () => void } {
  chrome.tabs.onActivated?.addListener((info) => {
    void chrome.storage.local.get(KEY).then((stored) => {
      if (reviving(stored[KEY], Date.now())) void reviveTab(info.tabId, deps)
    }, () => undefined)
  })
  return {
    updated: () => {
      void chrome.storage.local.set({ [KEY]: Date.now() + DAY_MS }).catch(() => undefined)
      void reviveFront().catch(() => undefined)
    }
  }
}
