// 2.7, the owner on TestFlight 107: Listen asked about notifications that were on, opened the app, the app said «This
// text is no longer here», and round again. A tab left open across an update keeps the old panel, whose link to the
// extension is dead: nothing it asks is answered. The new extension gives such a tab the panel again, the new panel
// hides the old one, and a panel that finds its own link dead says so once, with Reload.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { reviveTab, reviving } from "../src/shared/revive.ts"
import { alive, gone, retireOrphans } from "../src/content/orphan.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const g = globalThis as unknown as { chrome?: { runtime?: { id?: string } } }

test("the new panel hides the one an update left behind (it can't be removed: it puts itself back)", () => {
  const made = () => {
    const attrs: Record<string, string> = {}
    const style: Record<string, string> = {}
    return { attrs, style, host: { setAttribute: (n: string, v: string) => { attrs[n] = v }, style: { setProperty: (n: string, v: string, p?: string) => { style[n] = `${v}${p ? ` !${p}` : ""}` } } } }
  }
  const a = made()
  const b = made()
  const asked: string[] = []
  const doc = { querySelectorAll: (selector: string) => { asked.push(selector); return [a.host, b.host] } }
  assert.equal(retireOrphans(doc, "contextflow-root"), 2)
  assert.deepEqual(asked, ["contextflow-root"])
  for (const one of [a, b]) {
    assert.equal(one.style.display, "none !important")
    assert.equal(one.attrs["data-cf-retired"], "")
  }
  assert.equal(retireOrphans({ querySelectorAll: () => [] }, "contextflow-root"), 0)
})

test("a panel knows its link is gone: at once when the runtime has no id, else when two asks get no answer", async () => {
  assert.equal(gone({ id: "abc" }), false)
  assert.equal(gone({}), true)
  assert.equal(gone(undefined), true)
  const noWait = () => Promise.resolve()
  g.chrome = { runtime: { id: "abc" } }
  try {
    let asks = 0
    assert.equal(await alive(async () => { asks++; return { ok: true } }, noWait), true)
    assert.equal(asks, 1)
    // A background that is just starting: the second ask is answered.
    asks = 0
    assert.equal(await alive(async () => (++asks === 1 ? null : { ok: true }), noWait), true)
    assert.equal(asks, 2)
    // No answer at all, or a send that throws (the context is invalidated): gone.
    asks = 0
    assert.equal(await alive(async () => { asks++; return null }, noWait), false)
    assert.equal(asks, 2)
    assert.equal(await alive(async () => { throw new Error("Extension context invalidated") }, noWait), false)
    // The runtime itself is gone: nothing is even asked.
    g.chrome = { runtime: {} }
    asks = 0
    assert.equal(await alive(async () => { asks++; return { ok: true } }, noWait), false)
    assert.equal(asks, 0)
  } finally {
    delete g.chrome
  }
})

test("after an update a tab is asked first: a live panel stays, a silent one gets the panel again, a page that refuses is left", async () => {
  const log: string[] = []
  const deps = (ask: () => Promise<{ ok?: boolean } | null>, inject: () => Promise<unknown>) => ({
    ask: async (id: number) => { log.push(`ask ${id}`); return ask() },
    inject: async (id: number) => { log.push(`inject ${id}`); return inject() }
  })
  assert.equal(await reviveTab(7, deps(async () => ({ ok: true }), async () => undefined)), "alive")
  assert.deepEqual(log, ["ask 7"])
  log.length = 0
  assert.equal(await reviveTab(7, deps(async () => { throw new Error("timeout") }, async () => undefined)), "injected")
  assert.deepEqual(log, ["ask 7", "inject 7"])
  // An answer that isn't the panel's (an empty reply) counts as none.
  assert.equal(await reviveTab(7, deps(async () => null, async () => undefined)), "injected")
  assert.equal(await reviveTab(7, deps(async () => { throw new Error("timeout") }, async () => { throw new Error("cannot access") })), "refused")
})

test("only for a day after an update", () => {
  const now = 1_800_000_000_000
  assert.equal(reviving(now + 1000, now), true)
  assert.equal(reviving(now - 1, now), false)
  assert.equal(reviving(undefined, now), false)
  assert.equal(reviving("soon", now), false)
})

test("wired: the panel answers and takes over, the background asks after an update, Listen says it once", () => {
  const index = read("../src/content/index.tsx")
  assert.match(index, /if \(message\?\.type === "alive"\) sendResponse\(\{ ok: true \}\)/)
  assert.match(index, /const mount = \(\) => \{[\s\S]{0,700}?retireOrphans\(document, HOST_TAG\)\n\s+const host = document\.createElement\(HOST_TAG\)/)
  assert.doesNotMatch(index, /if \(document\.querySelector\(HOST_TAG\)\) return/)
  const background = read("../src/background/index.ts")
  assert.match(background, /case "alive":[\s\S]{0,200}?sendResponse\(\{ ok: true \}\)\n\s+return false/)
  assert.match(background, /details\.reason === "update"\) \{[\s\S]{0,300}?revive\.updated\(\)/)
  const listen = read("../src/content/listen/useListen.tsx")
  assert.match(listen, /if \(gone\(\)\) return void setState\(\{ at: "error", key, code: "RELOAD" \}\)/)
  assert.match(listen, /state\.code === "RELOAD" \? t\("listenReload"\)/)
  assert.match(listen, /onClick=\{\(\) => location\.reload\(\)\}>\{t\("reloadPage"\)\}/)
  // Every language has the two new lines.
  for (const lang of ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "pt_BR", "ru", "tr", "uk", "vi", "zh_CN", "zh_TW"]) {
    const messages = JSON.parse(read(`../src/locales/${lang}.json`)) as Record<string, string>
    assert.ok(messages.listenReload?.includes("ContextFlow"), `${lang}: listenReload`)
    assert.ok(messages.reloadPage, `${lang}: reloadPage`)
  }
})
