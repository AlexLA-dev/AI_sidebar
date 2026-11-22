// Spaces (2.7, src/shared/spaces.ts): the owner (14 Nov) «задумка хорошая, главное её реализовать не громоздко и понятно
// для пользователя»; «Давай сделаем Пространства выключаемой опцией в настройках». Migration (nothing to rewrite), the
// list's sync between devices and the app, chats in a space, the switch off and on, and where the panel opens on a page.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  addSpace, bindSite, boundSpace, canAddSpace, chatsInSpace, currentSpace, deleteSpace, editSpace, emptySpaces, FIRST_SPACE, FREE_SPACES, hasSpaces, liveSpaces,
  mergeSpaces, nextColor, resolveSpace, sameSpaces, siteKey, spaceCount, spaceOfChat, spacesChange, spacesForCloud, spacesFromCloud, SPACES_RECORD,
  takeSpaces, type SpaceList, type StoredSpaces
} from "../src/shared/spaces.ts"
import { applyRemote, chatList, moveEntries, savedThread, threadForCloud, threadFromCloud, withMessages, type Thread, type Threads } from "../src/shared/threads.ts"
import { FEATURES, useFields } from "../src/shared/usage.ts"
import { DEFAULT_SETTINGS } from "../src/shared/types.ts"

const q = (url: string, t: number, content = "What is this?") => ({ role: "user" as const, content, t, id: `q${t}`, page: { url, title: "Page", hash: "h", at: t } })
const a = (t: number) => ({ role: "assistant" as const, content: "An answer.", t, id: `a${t}` })
const chat = (id: string, at: number, url: string, sp?: string): Thread => ({ id, u: at, a: at, m: [q(url, at - 100), a(at - 50)], ...(sp ? { sp } : {}) })

/** A list with a "work" space (green) and a "shop" space, as made on one device. */
function twoSpaces(): SpaceList {
  let list = emptySpaces()
  list = addSpace(list, "work", "Work", "green", 1_000)
  list = addSpace(list, "shop", "Shopping", "orange", 2_000)
  return list
}

test("before a second space nothing shows: every chat of 2.6 is in the first space, nothing is rewritten", () => {
  const list = emptySpaces()
  assert.deepEqual(liveSpaces(list, "Personal"), [{ id: FIRST_SPACE, name: "Personal", color: "blue", order: 0 }])
  assert.equal(hasSpaces(list), false)
  assert.equal(spaceCount(list), 1)
  // A chat stored before 2.7 has no space: it's in the first, and its iCloud copy stays as it was.
  const old = chat("old", 5_000, "https://news.example/a")
  assert.equal(spaceOfChat(list, old), FIRST_SPACE)
  assert.equal(threadForCloud(old).includes("\"sp\""), false)
  // One space: the list is every chat, whatever their `sp`.
  const chats = [old, chat("w", 6_000, "https://work.example", "work")]
  assert.deepEqual(chatsInSpace(chats, list, FIRST_SPACE, true), chats)
})

test("a space is a name and a colour; the first can be renamed, never deleted; a deleted space's chats are in the first", () => {
  let list = twoSpaces()
  assert.deepEqual(liveSpaces(list, "Personal").map((x) => [x.id, x.name, x.color]), [[FIRST_SPACE, "Personal", "blue"], ["work", "Work", "green"], ["shop", "Shopping", "orange"]])
  assert.equal(hasSpaces(list), true)
  list = editSpace(list, FIRST_SPACE, "  Home   life ", "pink", 3_000)
  assert.deepEqual(liveSpaces(list, "Personal")[0], { id: FIRST_SPACE, name: "Home life", color: "pink", order: 0 })
  assert.equal(deleteSpace(list, FIRST_SPACE, 4_000), list)
  const w = chat("w", 6_000, "https://work.example", "work")
  list = bindSite(list, "work.example", "work", 4_500)
  list = deleteSpace(list, "work", 5_000)
  assert.deepEqual(liveSpaces(list, "Personal").map((x) => x.id), [FIRST_SPACE, "shop"])
  assert.equal(spaceOfChat(list, w), FIRST_SPACE)
  assert.equal(resolveSpace(list, "work"), FIRST_SPACE)
  // Its sites open as any other again.
  assert.equal(boundSpace(list, "work.example"), null)
  // A deleted space can't be edited back to life.
  assert.equal(editSpace(list, "work", "Work again", "green", 6_000), list)
})

test("Free has FREE_SPACES (the first counts), Pro and Ultra as many as they like; the next colour is one not used", () => {
  assert.equal(FREE_SPACES, 2)
  const one = addSpace(emptySpaces(), "work", "Work", "green", 1)
  assert.equal(canAddSpace(emptySpaces(), false), true)
  assert.equal(canAddSpace(one, false), false)
  assert.equal(canAddSpace(one, true), true)
  assert.equal(nextColor(emptySpaces()), "green")
  assert.equal(nextColor(one), "orange")
})

test("a chat carries its space through iCloud and the app; an older version keeps it, a new chat gets the space it was started in", () => {
  const w = chat("w", 6_000, "https://work.example", "work")
  const back = threadFromCloud(threadForCloud(w))
  assert.equal(back?.sp, "work")
  // 2.6 keeps fields it doesn't know (`x`) and sends them back: as 2.6 reads it, without `sp` in its fields.
  const asOld = JSON.parse(threadForCloud(w)) as Record<string, unknown>
  assert.equal(asOld.sp, "work")
  // Saving keeps a chat's space, whatever space the device is in now.
  const next = savedThread(w, "w", [...w.m, q("https://work.example/2", 7_000)], 7_100, undefined, "shop")
  assert.equal(next?.sp, "work")
  // A new chat goes into the space it was started in; in the first, it has none.
  assert.equal(withMessages(undefined, "n", [q("https://x.example", 1)], 2, undefined, "shop").sp, "shop")
  assert.equal("sp" in withMessages(undefined, "n", [q("https://x.example", 1)], 2), false)
  // Messages moved out to a new chat stay in their space.
  const moved = moveEntries({ w: { ...w, m: [...w.m, q("https://other.example", 6_500), a(6_600)] } }, {}, "w", 2, 3, "new", 8_000)
  assert.equal(moved?.threads.new.sp, "work")
})

test("the list in iCloud: a record next to the chats that 2.6 skips (it isn't a chat)", () => {
  const list = twoSpaces()
  const data = spacesForCloud(list)
  assert.equal(threadFromCloud(data), null)
  // 2.6's applyRemote leaves its chats alone.
  const threads: Threads = { c: chat("c", 1_000, "https://a.example") }
  const after = applyRemote(threads, {}, [{ id: SPACES_RECORD, updatedAt: 9_000, data }], [])
  assert.deepEqual(after.threads, threads)
  assert.equal(after.changed, false)
  // Read back as it was, whatever order it was built in.
  assert.ok(sameSpaces(spacesFromCloud(data)!, list))
  assert.equal(spacesForCloud({ s: [...list.s].reverse(), b: list.b }), data)
  assert.equal(spacesFromCloud("not json"), null)
  assert.equal(spacesFromCloud(JSON.stringify({ m: [] })), null)
})

test("two devices making spaces at once both keep both; a deletion or an unbinding is never undone by an older copy", () => {
  const base = addSpace(emptySpaces(), "work", "Work", "green", 1_000)
  const iphone = addSpace(base, "shop", "Shopping", "orange", 2_000)
  const mac = bindSite(addSpace(base, "study", "Study", "violet", 2_100), "notion.so", "work", 2_200)
  const merged = mergeSpaces(iphone, mac)
  assert.deepEqual(liveSpaces(merged, "P").map((x) => x.id).sort(), [FIRST_SPACE, "shop", "study", "work"])
  assert.equal(boundSpace(merged, "notion.so"), "work")
  // Either way round, the same.
  assert.ok(sameSpaces(merged, mergeSpaces(mac, iphone)))
  // Deleted on the iPhone after the Mac renamed it: deleted.
  const deleted = deleteSpace(iphone, "work", 3_000)
  const renamed = editSpace(base, "work", "Job", "green", 2_500)
  assert.equal(liveSpaces(mergeSpaces(deleted, renamed), "P").some((x) => x.id === "work"), false)
  // Unbound later than bound: unbound.
  const unbound = bindSite(mac, "notion.so", null, 3_000)
  assert.equal(boundSpace(mergeSpaces(mac, unbound), "notion.so"), null)
  // The same time on both: the same pick on every device.
  const x = editSpace(base, "work", "A", "green", 5_000)
  const y = editSpace(base, "work", "B", "green", 5_000)
  assert.ok(sameSpaces(mergeSpaces(x, y), mergeSpaces(y, x)))
})

test("a copy from iCloud or the app is merged in; what only this device has goes back up, newer than both", () => {
  const mine: StoredSpaces = { u: 2_000, list: addSpace(emptySpaces(), "work", "Work", "green", 2_000) }
  const theirs = { updatedAt: 3_000, data: spacesForCloud(addSpace(emptySpaces(), "shop", "Shopping", "orange", 3_000)) }
  const taken = takeSpaces(mine, theirs)!
  assert.deepEqual(liveSpaces(taken.list, "P").map((x) => x.id).sort(), [FIRST_SPACE, "shop", "work"])
  assert.equal(taken.u, 3_001)
  // Newer than what iCloud has: sent with the next sync.
  assert.deepEqual(spacesChange(taken, 3_000), { id: SPACES_RECORD, updatedAt: 3_001, data: spacesForCloud(taken.list) })
  // Their copy has everything: kept as theirs, nothing to send back.
  const all = takeSpaces(taken, { updatedAt: 4_000, data: spacesForCloud(taken.list) })!
  assert.equal(all.u, 4_000)
  assert.equal(spacesChange(all, 4_000), null)
  // An older copy with nothing new: nothing changes.
  assert.equal(takeSpaces(all, { updatedAt: 3_500, data: spacesForCloud(mine.list) }), null)
  // The first copy on this device: taken as it is.
  assert.deepEqual(takeSpaces(undefined, theirs), { u: 3_000, list: spacesFromCloud(theirs.data) })
  // Not a list: ignored.
  assert.equal(takeSpaces(mine, { updatedAt: 9_000, data: "{}" }), null)
})

test("the time of the list never goes back (the app is sent what's newer than it was last sent)", () => {
  const list = addSpace(emptySpaces(), "work", "Work", "green", 1_000)
  const mine: StoredSpaces = { u: 9_000, list }
  const newer = editSpace(list, "work", "Job", "green", 5_000)
  const taken = takeSpaces(mine, { updatedAt: 6_000, data: spacesForCloud(newer) })!
  assert.equal(liveSpaces(taken.list, "P")[1].name, "Job")
  assert.ok(taken.u >= 9_000)
})

test("the chats list, matching and organizing stay inside a space; switched off, every chat is in one list again", () => {
  const list = twoSpaces()
  const p = chat("p", 1_000, "https://news.example/a")
  const w = chat("w", 2_000, "https://work.example/a", "work")
  const s = chat("s", 3_000, "https://shop.example/a", "shop")
  const gone = chat("g", 4_000, "https://x.example/a", "deleted-space")
  const all = [p, w, s, gone]
  assert.deepEqual(chatsInSpace(all, list, FIRST_SPACE, true).map((x) => x.id), ["p", "g"])
  assert.deepEqual(chatsInSpace(all, list, "work", true).map((x) => x.id), ["w"])
  // Off: one list, and the spaces and which chat is in which stay as they were (nothing is written).
  assert.deepEqual(chatsInSpace(all, list, "work", false).map((x) => x.id), ["p", "w", "s", "g"])
  assert.equal(w.sp, "work")
  // On again: as before.
  assert.deepEqual(chatsInSpace(all, list, "shop", true).map((x) => x.id), ["s"])
  // Settings: on by default.
  assert.equal(DEFAULT_SETTINGS.spaces, true)
  // The space the device is in: the shown chat's; a new chat's own; the first with Spaces off.
  assert.equal(currentSpace(list, w, { sp: "shop" }, true), "work")
  assert.equal(currentSpace(list, undefined, { sp: "shop" }, true), "shop")
  assert.equal(currentSpace(list, w, { sp: "shop" }, false), FIRST_SPACE)
})

// Where the panel opens on a page, inside a space and in a bound site's space: tests/match.test.mts (2.7 «Подходящий чат»).

test("moving a chat to another space is an edit: newer, its place in the list kept", () => {
  const store = readFileSync(new URL("../src/content/store.ts", import.meta.url), "utf8")
  assert.match(store, /export async function moveChatToSpace\(id: string, space: string\): Promise<void> \{[\s\S]*?const next: Thread = \{ \.\.\.stored, u: Math\.max\(Date\.now\(\), stored\.u \+ 1\), a: activity\(stored\) \}\s*if \(space === FIRST_SPACE\) delete next\.sp\s*else next\.sp = space/)
  // The list order goes by the last message (`a`), so a moved chat stays where it was in its new space.
  const w = chat("w", 2_000, "https://work.example/a")
  const moved: Thread = { ...w, u: 9_000, a: 2_000, sp: "work" }
  assert.deepEqual(chatList({ w: moved, x: chat("x", 5_000, "https://x.example") }).map((t) => t.id), ["x", "w"])
})

test("the usage events: counts only, never a name, colour or site", () => {
  const spec = FEATURES.space
  assert.equal(spec.since, "2.7")
  for (const a of ["create", "switch", "move", "bind", "toggle"]) assert.ok(spec.actions.includes(a), a)
  assert.deepEqual(useFields({ f: "space", a: "switch", via: "site", spaces: 3, name: "Work", site: "notion.so" }), { f: "space", a: "switch", via: "site", spaces: 3 })
  assert.deepEqual(useFields({ f: "space", a: "bind", val: "on" }), { f: "space", a: "bind", val: "on" })
  assert.ok((FEATURES.settings.fields?.key as readonly string[]).includes("spaces"))
})

test("the background syncs the list with the chats and keeps it apart from them", () => {
  const sync = readFileSync(new URL("../src/background/sync.ts", import.meta.url), "utf8")
  // iCloud: sent with the chats' changes, taken from what comes back, never into the chats.
  assert.match(sync, /changes: \[\.\.\.sent, \.\.\.\(spacesSent \? \[spacesSent\] : \[\]\), \.\.\.collectionsSent\]/)
  assert.match(sync, /function sideRecord\(id: string\): boolean \{\s*return id === SPACES_RECORD \|\| isCollectionId\(id\)/)
  assert.match(sync, /applyRemote\(afterSend\.threads, afterSend\.synced, changes\.filter\(\(c\) => !sideRecord\(c\.id\)\)/)
  // The app: mirrored with the chats, its changes merged in.
  assert.match(sync, /applyAppChanges\(now, synced, reply\.appChanges\.filter\(\(c\) => !sideRecord\(c\.id\)\)\)/)
  assert.match(sync, /const taken = takeSpaces\(current, appSpaces\)/)
  // Organizing compares a chat with its own space's chats only.
  const organize = readFileSync(new URL("../src/background/organize.ts", import.meta.url), "utf8")
  assert.match(organize, /const live = spacePeers\(stored\)\(chat, all\)/)
  assert.match(organize, /suggestMove\(chat, peers\(chat, live\), vectors\.vectorOf, org\.config\)/)
})

test("a space's toggle reaches the server with its val and spaces (the background forwards every field of a step)", () => {
  // The panel sends them (Settings' switch).
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /sendBackground\(\{ type: "useEvent", f: "space", a: "toggle", via: "settings", val: patch\.spaces \? "on" : "off", spaces: spaces\.count\(\) \}\)/)
  // The background passes the whole step on, only its message type left out.
  const bg = readFileSync(new URL("../src/background/index.ts", import.meta.url), "utf8")
  assert.match(bg, /function useStep\([^)]*\)[^{]*\{\s*const \{ type: _type, \.\.\.fields \} = message\s*return fields\s*\}/)
  assert.match(bg, /body: JSON\.stringify\(\{ \.\.\.useStep\(message\), kind: "use", installId: id, client, s: "panel" \}\)/)
  // The server keeps them.
  assert.deepEqual(useFields({ f: "space", a: "toggle", via: "settings", val: "off", spaces: 3 }), { f: "space", a: "toggle", via: "settings", val: "off", spaces: 3 })
})

test("107: on the iPhone's sheet the header is one tinted piece from the sheet's edge, the grabber included", () => {
  const css = readFileSync(new URL("../src/content/spaces.css", import.meta.url), "utf8")
  // Side panel (iPad, Mac): the header's tint and its stripe on top, as before.
  assert.match(css, /\.cf-panel\[data-space\] \.cf-header \{ background: var\(--space-soft\); box-shadow: inset 0 3px 0 var\(--space\); \}/)
  // Sheet: the grabber takes the same tint and the stripe (the sheet's top edge); the header under it has no stripe.
  assert.match(css, /\.cf\[data-layout="sheet"\] \.cf-panel\[data-space\] \.cf-grabber \{ background: var\(--space-soft\); box-shadow: inset 0 3px 0 var\(--space\); \}/)
  assert.match(css, /\.cf\[data-layout="sheet"\] \.cf-panel\[data-space\] \.cf-header \{ box-shadow: none; \}/)
  // The grabber is the sheet's first child, right above the header.
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /\{layout === "sheet" && <div class="cf-grabber" onClick=\{hide\} \/>\}\s*<header class="cf-header"/)
})

test("109–110: a switch to the matching chat's space is plain to see over the header, with the way back there", () => {
  const spaces = readFileSync(new URL("../src/content/Spaces.tsx", import.meta.url), "utf8")
  // 109, the owner didn't notice it: «You're in “…”» over the header, as a bound site's switch shows its own. 110: the
  // space it was in comes along, for «‹ <space>» in that line (the chat's bar keeps nothing of it).
  assert.match(spaces, /followMatch: \(space: string, from: string\) => \{\s*setActiveSp\(space\)\s*show\(\{ space, kind: "in", from \}\)\s*deps\.report\("switch", \{ via: "match" \}\)/)
  // Long enough to reach for, held under a finger or the pointer, fading once let go; a plain line as before.
  assert.match(spaces, /const FLASH_MS = 1900\s*const FLASH_BACK_MS = 5000/)
  assert.match(spaces, /setTimeout\(\(\) => setFlash\(null\), next\.from \? FLASH_BACK_MS : FLASH_MS\)/)
  assert.match(spaces, /hold: \(on: boolean\) => \{\s*if \(!flash\?\.from\) return/)
  // Only a space that's still there and isn't the one it went into.
  assert.match(spaces, /back: flash\.from \? spaces\.find\(\(x\) => x\.id === flash\.from && x\.id !== flash\.space\) : undefined/)
  assert.match(spaces, /<button type="button" class="cf-space-toast-back" aria-label=\{t\("matchBackTo", back\.name\)\}/)
  const css = readFileSync(new URL("../src/content/spaces.css", import.meta.url), "utf8")
  assert.match(css, /\.cf-space-toast\.act\.run \{ animation-duration: 5s; \}/)
  assert.match(css, /\.cf-space-toast\.act\.held \{ animation: none; opacity: 1; \}/)
})

test("2.7.1: the ✦ circle is always our blue; its space glows around it as a halo, once brighter as it changes", async () => {
  const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  const insert = readFileSync(new URL("../src/content/insert/insert.css", import.meta.url), "utf8")
  const spacesTsx = readFileSync(new URL("../src/content/Spaces.tsx", import.meta.url), "utf8")
  const { fabHalo, HALO_ON_FIRST, HALO_STRENGTH, HALO_ALPHAS, COLOR_NAMES } = await import("../src/shared/spaces.ts")
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`)
    assert.ok(at >= 0, sel)
    return css.slice(at, css.indexOf("}", at))
  }
  // The fill: our blue, whatever the space (no space variable in it).
  const fab = rule(".cf-fab")
  assert.match(fab, /background: linear-gradient\(135deg, #38bdf8 0%, #2563eb 100%\) !important;/)
  assert.doesNotMatch(fab, /var\(--space/)
  // The halo is a glow, not a border (the owner: «свечение легкое, как ореол»): three blurred layers, no solid ring,
  // no white gap; from the space's colours (its base close in, its light colour further out) at one strength.
  const halo = rule(".cf-fab[data-halo]")
  assert.match(halo, /box-shadow: 0 0 6px 1px var\(--halo-1\), 0 0 16px 4px var\(--halo-2\), 0 0 34px 10px var\(--halo-3\)/)
  for (const shadow of halo.slice(halo.indexOf("box-shadow:") + 11).split(/,(?![^(]*\))/)) {
    const blur = shadow.trim().split(/\s+/)[2]
    assert.ok(blur && parseFloat(blur) > 0, `every layer is blurred: ${shadow.trim()}`)
  }
  assert.doesNotMatch(halo, /rgba\(255, 255, 255/)
  assert.match(spacesTsx, /const \[h1, h2, h3\] = HALO_ALPHAS\[HALO_STRENGTH\]/)
  assert.match(spacesTsx, /"--halo-1": `\$\{base\}\$\{h1\}`, "--halo-2": `\$\{base\}\$\{h2\}`, "--halo-3": `\$\{light\}\$\{h3\}`/)
  // The owner picked the strong glow on #235 («Сделай сильное свечение»), then medium after 113 on his device («Сейчас
  // свечение слишком яркое. Давай попробуем среднее»), then soft after 114 («Я бы сделал свечение ещё меньше»).
  assert.equal(HALO_STRENGTH, 1)
  for (const k of [1, 2, 3] as const) assert.ok(HALO_ALPHAS[k].every((a) => /^[0-9a-f]{2}$/.test(a)))
  // Shadows only: no size, margin, padding, outline, inset or transform, so the tap target and the drag stay.
  assert.doesNotMatch(halo, /width|height|margin|padding|outline|inset|transform/)
  // None outside spaces and none in the blue (first) space unless the one switch says so; every other colour has one.
  assert.equal(HALO_ON_FIRST, false)
  assert.equal(fabHalo(undefined), false)
  assert.equal(fabHalo("blue"), false)
  for (const c of COLOR_NAMES.filter((x) => x !== "blue")) assert.equal(fabHalo(c), true)
  assert.match(app, /data-halo=\{halo \? spaces\.fabSpace\?\.color : undefined\}/)
  // Brighter once as the space changes, then still: a single run, none with Reduce Motion, nothing that keeps running.
  assert.match(css, /\.cf-fab\[data-halo\]\.flash \{ animation: cf-fab-halo 1\.1s ease-out 1; \}/)
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.cf-fab\[data-halo\]\.flash \{ animation: none; \} \}/)
  assert.doesNotMatch(css, /cf-fab-halo[^;]*infinite/)
  assert.match(app, /if \(!haloNow \|\| was === null \|\| was === haloNow\) return\s*setHaloFlash\(true\)/)
  // Quick insert's and Write's small circle: the same blue; a small glow in the circle's space only while the page tint is
  // on (off since 2.7.1, the next test).
  assert.match(insert, /\.cf-qi-btn \{[^}]*linear-gradient\(135deg, #38bdf8 0%, #2563eb 100%\) !important;/)
  const small = insert.slice(insert.indexOf(".cf[data-tint] .cf-qi-btn {"), insert.indexOf("}", insert.indexOf(".cf[data-tint] .cf-qi-btn {")))
  assert.match(small, /var\(--tint\)/)
  assert.doesNotMatch(small, /0 0 0 /)
})

test("2.7.1: the panel's send button glows in its space's colours, weaker than the ✦ circle; still blue, off when empty", async () => {
  const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  const spacesTsx = readFileSync(new URL("../src/content/Spaces.tsx", import.meta.url), "utf8")
  const { HALO_ALPHAS, HALO_STRENGTH, SEND_GLOW_ALPHAS } = await import("../src/shared/spaces.ts")
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`)
    assert.ok(at >= 0, sel)
    return css.slice(at, css.indexOf("}", at))
  }
  // The fill stays the panel's accent (our blue: the panel keeps its blue in every space).
  assert.match(rule(".cf-send"), /background: var\(--accent\) !important;/)
  // A glow, not a ring: every layer blurred, no spread-only stroke, no white.
  const glow = rule(".cf-send[data-halo]:not(:disabled):not(.note)")
  const layers = glow.slice(glow.indexOf("box-shadow:") + 11).split(/,(?![^(]*\))/)
  assert.equal(layers.length, 2)
  for (const shadow of layers) {
    const blur = shadow.trim().split(/\s+/)[2]
    assert.ok(blur && parseFloat(blur) > 0, `every layer is blurred: ${shadow.trim()}`)
  }
  assert.match(glow, /var\(--glow-1\)/)
  assert.match(glow, /var\(--glow-2\)/)
  assert.doesNotMatch(glow, /rgba\(255, 255, 255|width|height|margin|padding|outline|transform/)
  // Weaker than the circle's: fainter at every layer and a shorter reach. A halo, not an edge hugging the button (the
  // director on 664465de): its outer layer reaches about a third of the 32 px button past the edge (blur/2 + spread).
  const [c1, c2] = HALO_ALPHAS[HALO_STRENGTH]
  const [g1, g2] = SEND_GLOW_ALPHAS
  assert.ok(parseInt(g1, 16) < parseInt(c1, 16) && parseInt(g2, 16) < parseInt(c2, 16))
  assert.match(css, /\.cf-fab\[data-halo\] \{\s*box-shadow: 0 0 6px 1px var\(--halo-1\), 0 0 16px 4px/)
  assert.match(glow, /box-shadow: 0 0 8px 2px var\(--glow-1\), 0 0 20px 6px var\(--glow-2\);/)
  const [, outer] = layers.map((l) => l.trim().split(/\s+/).slice(2, 4).map(parseFloat))
  const reach = outer[0] / 2 + outer[1]
  assert.ok(reach >= 32 / 3 && reach < 34 / 2 + 10, `about a third of the button past its edge, less than the circle's: ${reach}`)
  for (const [blur] of layers.map((l) => l.trim().split(/\s+/).slice(2, 4).map(parseFloat))) assert.ok(blur >= 8, "no tight edge")
  assert.match(spacesTsx, /"--glow-1": `\$\{base\}\$\{g1\}`, "--glow-2": `\$\{light\}\$\{g2\}`/)
  // The panel's own space (its variables are on the panel), by the circle's rule: none outside spaces or in the blue one.
  assert.match(app, /const sendHalo = spaces\.multi && fabHalo\(spaces\.current\.color\)/)
  assert.match(app, /class=\{`cf-send \$\{noteMode \? "note" : ""\}`\}\s*data-halo=\{sendHalo \? spaces\.current\.color : undefined\}\s*disabled=\{!draft\.trim\(\)\}/)
  // An empty field: the grey, disabled button with no glow (the :not(:disabled) above); Stop is another button.
  assert.match(css, /\.cf-send:disabled \{ background: var\(--bg-3\) !important;/)
  assert.doesNotMatch(app, /class="cf-send stop"[^>]*data-halo/)
})

test("109: the page's own controls can take the ✦ circle's space colour, paler, through one switch (off since 2.7.1); text stays readable", () => {
  const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  const spaces = readFileSync(new URL("../src/content/Spaces.tsx", import.meta.url), "utf8")
  // One switch, and none for the first (blue) colour: the page looks as it always did there. Off since 2.7.1 (the owner
  // on #235: «Сделай всегда синим»): the page's buttons are our blue in every space.
  assert.match(spaces, /export const PAGE_TINT = false/)
  assert.match(spaces, /if \(!PAGE_TINT \|\| !color \|\| color === "blue"\) return null/)
  // The circle's space (a bound site's, else the panel's), on the root, so every control on the page has it.
  assert.match(app, /const tint = pageTint\(spaces\.fabSpace\?\.color\)/)
  // The root's style carries the tint (and, since 2.7.1, the system text scale beside it: systemText.ts).
  assert.match(app, /<div class="cf" [^>]*data-tint=\{tint \? spaces\.fabSpace\?\.color : undefined\}[^>]*style=\{rootStyle\}/)
  assert.match(app, /const rootStyle = uiScale !== 1 \? \{ \.\.\.\(tint \?\? \{\}\), "--ui": String\(uiScale\) \} : tint \?\? undefined/)
  // The accent variables the page's controls use, everywhere but in the panel (it keeps its blue); light and dark.
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`)
    assert.ok(at >= 0, sel)
    return css.slice(at, css.indexOf("}", at))
  }
  const light = rule(".cf[data-tint] > :not(.cf-panel)")
  const dark = rule('.cf[data-tint][data-theme="dark"] > :not(.cf-panel)')
  const auto = rule(".cf[data-tint]:not([data-theme]) > :not(.cf-panel)")
  for (const v of ["--accent", "--accent-soft", "--accent-text", "--snack-action"]) for (const r of [light, dark, auto]) assert.match(r, new RegExp(`${v}: `))
  // The circle's pair for the page's solid buttons and glows: the blue it always was, a paler pair of the space's with one.
  assert.match(css, /--accent-from: #38bdf8;\s*--accent-to: #2563eb;/)
  assert.match(light, /--accent-from: color-mix\(in srgb, var\(--tint-2\) \d+%, #ffffff\);\s*--accent-to: color-mix\(in srgb, var\(--tint\) \d+%, #ffffff\);/)
  // «Ask AI» on the selection bar, its chips and the selection's glow take it; no blue left there. (Quick insert's circle
  // stays blue with a halo since 2.7.1, as the ✦ circle: the test after this one.)
  assert.match(css, /\.cf-bubble\.touch button\.primary \{[^}]*linear-gradient\(135deg, var\(--accent-from\), var\(--accent-to\)\)/)
  assert.match(css, /\.cf-sel-glow \{[^}]*var\(--accent-from\)/)
  const bubble = css.slice(css.indexOf(".cf-bubble.touch button.cf-sel-chip {"), css.indexOf("@keyframes cf-pop"))
  assert.doesNotMatch(bubble, /37, 99, 235|#2563eb|#38bdf8/)
  const insert = readFileSync(new URL("../src/content/insert/insert.css", import.meta.url), "utf8")
  assert.doesNotMatch(insert, /\.cf-qi-btn \{[^}]*var\(--accent-from\)/)
  // The system's dark appearance is the dark theme's.
  const decls = (r: string) => r.match(/--[\w-]+: [^;]+;/g)!.join(" ")
  assert.equal(decls(auto), decls(dark))
  // The text on the page and on the soft background, 4.5:1 or more for every space colour in both themes.
  const pct = (r: string, v: string) => Number(new RegExp(`${v}: color-mix\\(in srgb, var\\(--tint(?:-2)?\\) (\\d+)%`).exec(r)![1]) / 100
  const COLORS = { blue: ["#38bdf8", "#2563eb"], green: ["#4ade80", "#16a34a"], orange: ["#fdba74", "#ea580c"], pink: ["#f9a8d4", "#db2777"], violet: ["#c4b5fd", "#7c3aed"], graphite: ["#94a3b8", "#475569"] }
  const hex = (x: string) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255)
  const mix = (a: number[], b: number[], p: number) => a.map((x, i) => p * x + (1 - p) * b[i])
  const lum = (c: number[]) => c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  for (const [theme, r, bg, text] of [["light", light, "#ffffff", "#17151c"], ["dark", dark, "#1c1b21", "#f3f2f7"]] as const) {
    for (const [name, [l, base]] of Object.entries(COLORS)) {
      const own = hex(theme === "light" ? base : l)
      const t = mix(own, hex(text), pct(r, "--accent-text"))
      const soft = mix(own, hex(bg), pct(r, "--accent-soft"))
      assert.ok(ratio(t, hex(bg)) >= 4.5, `${theme} ${name} on the background`)
      assert.ok(ratio(t, soft) >= 4.5, `${theme} ${name} on its soft tint`)
    }
  }
})
