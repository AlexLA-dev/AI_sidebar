// Build 110, the director's hands-on pass: on a new install the «ContextFlow is ready» tab came up over the page the
// app's «Open Safari» had opened, at the person's first tap on ✦ (the tap woke the background, the background's
// install handler opened the tab in front). The tab is now only for a person with no panel in front of them.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { WELCOME_LOADING_MS, WELCOME_LOOKS, welcomeOnInstall, type FrontTab } from "../src/shared/welcomeTab.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

/** A Safari to ask: what is in front at each look, and in which tabs the panel answers. */
function safari(fronts: Array<FrontTab | null | "throws">, panels: number[] = []) {
  const log: string[] = []
  let look = 0
  let opened = 0
  let waited = 0
  return {
    log,
    get opened() {
      return opened
    },
    get waited() {
      return waited
    },
    deps: {
      front: async () => {
        const tab = fronts[Math.min(look++, fronts.length - 1)]
        if (tab === "throws") throw new Error("no tabs")
        return tab
      },
      panelIn: async (id: number) => {
        log.push(`ask ${id}`)
        return panels.includes(id)
      },
      open: async () => {
        opened++
        log.push("open")
      },
      wait: async (ms: number) => {
        waited += ms
        log.push(`wait ${ms}`)
      }
    }
  }
}

test("the panel answers in the front tab: no welcome tab, and nothing waits (the first tap on ✦ woke the background)", async () => {
  const s = safari([{ id: 7, url: "https://context-flow.app/features?utm_source=app", status: "complete" }], [7])
  assert.equal(await welcomeOnInstall(s.deps), "panel")
  assert.equal(s.opened, 0)
  assert.deepEqual(s.log, ["ask 7"])
})

test("Safari started from the app: its old tab is in front first, our page with the panel a moment later", async () => {
  const s = safari([{ id: 1, url: "", status: "complete" }, { id: 2, url: "https://context-flow.app/features", status: "loading" }, { id: 2, url: "https://context-flow.app/features", status: "complete" }], [])
  // The panel's script runs once the page is idle: it answers at the third look.
  let asked = 0
  s.deps.panelIn = async (id) => id === 2 && ++asked >= 2
  assert.equal(await welcomeOnInstall(s.deps), "panel")
  assert.equal(s.opened, 0)
  assert.equal(s.waited, WELCOME_LOOKS[0] + WELCOME_LOOKS[1])
})

test("no panel in front (the start page, a site ContextFlow isn't allowed on): the tab opens after the looks, once", async () => {
  for (const front of [{ id: 1, url: "", status: "complete" }, { id: 1, status: "complete" }, { id: 3, url: "https://example.com/", status: "complete" }, null, "throws"] as const) {
    const s = safari([front])
    assert.equal(await welcomeOnInstall(s.deps), "opened")
    assert.equal(s.opened, 1)
    assert.equal(s.waited, WELCOME_LOOKS.reduce((a, b) => a + b, 0), "a few seconds at most, however the tab looks")
    assert.equal(s.log.at(-1), "open")
  }
})

test("a page still loading in front is waited for, up to a limit; then the tab opens", async () => {
  const loading = { id: 4, url: "https://context-flow.app/de/features", status: "loading" }
  const comes = safari([loading, loading, loading, loading, loading, loading, { ...loading, status: "complete" }])
  let looks = 0
  comes.deps.panelIn = async () => ++looks >= 7
  assert.equal(await welcomeOnInstall(comes.deps), "panel")
  assert.equal(comes.opened, 0)

  const never = safari([loading])
  assert.equal(await welcomeOnInstall(never.deps), "opened")
  assert.equal(never.opened, 1)
  assert.ok(never.waited >= WELCOME_LOADING_MS && never.waited <= WELCOME_LOADING_MS + 1000, `waited ${never.waited}`)
})

test("a tab that can't be asked (an error from Safari) counts as no panel, not as a failure", async () => {
  const s = safari([{ id: 9, url: "https://example.com/", status: "complete" }])
  s.deps.panelIn = async () => {
    throw new Error("Could not establish connection")
  }
  assert.equal(await welcomeOnInstall(s.deps), "opened")
  assert.equal(s.opened, 1)
})

test("the background: the install handler keeps its other work and opens the tab only through the check", () => {
  const src = read("src/background/index.ts")
  const handler = src.slice(src.indexOf("chrome.runtime.onInstalled.addListener"), src.indexOf("watchSettings()"))
  assert.match(handler, /details\.reason === "install"/)
  // What an install must have, whatever happens to the tab: the install's id, no «New in 2.7», the "switched on" report.
  assert.match(handler, /void installId\(\)/)
  assert.match(handler, /void markNewSeen\(\)/)
  assert.match(handler, /STORAGE\.extOnPending\]: false \}\)\.then\(reportSwitchedOn\)/)
  for (const line of ["void installId()", "void markNewSeen()", "STORAGE.extOnPending"]) {
    assert.ok(handler.indexOf(line) < handler.indexOf("welcomeOnInstall("), `${line} doesn't wait for the tab's check`)
  }
  assert.match(handler, /void welcomeOnInstall\(\{/)
  assert.equal(handler.match(/welcome\.html/g)?.length, 1, "one way to the tab")
  assert.match(handler, /open: async \(\) => void \(await chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\("welcome\.html"\) \}\)\)/)
  assert.match(handler, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/)
  assert.match(handler, /chrome\.tabs\.sendMessage\(tabId, \{ type: "here" \}/)
  // The toolbar button on a page that takes no scripts still opens the tab itself (the person asked).
  assert.match(src, /welcome\.html\?restricted=1/)
})

test("the panel's script answers «here» and opens nothing for it", () => {
  const src = read("src/content/index.tsx")
  const listener = src.slice(src.indexOf("chrome.runtime.onMessage.addListener"), src.indexOf("const mount"))
  assert.match(listener, /if \(message\?\.type === "here"\) sendResponse\(\{ ok: true \}\)/)
  const here = listener.slice(listener.indexOf('"here"'))
  assert.doesNotMatch(here, /dispatchEvent/)
  // The listener is set before the panel mounts, so a page answers as soon as its script runs.
  assert.ok(src.indexOf("chrome.runtime.onMessage.addListener") < src.indexOf("const mount"))
  assert.match(read("src/shared/types.ts"), /export type ContentRequest = .*\| \{ type: "here" \}/)
})

test("the built extension carries both sides", () => {
  const dist = "ContextFlow/Shared (Extension)/Resources/dist"
  assert.match(read(`${dist}/background.js`), /type:\s*"here"/)
  assert.match(read(`${dist}/content.js`), /"here"/)
})
