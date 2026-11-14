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
  assert.match(sync, /changes: spacesSent \? \[\.\.\.sent, spacesSent\] : sent/)
  assert.match(sync, /applyRemote\(afterSend\.threads, afterSend\.synced, changes\.filter\(\(c\) => c\.id !== SPACES_RECORD\)/)
  // The app: mirrored with the chats, its changes merged in.
  assert.match(sync, /applyAppChanges\(now, synced, reply\.appChanges\.filter\(\(c\) => c\.id !== SPACES_RECORD\)\)/)
  assert.match(sync, /const taken = takeSpaces\(current, appSpaces\)/)
  // Organizing compares a chat with its own space's chats only.
  const organize = readFileSync(new URL("../src/background/organize.ts", import.meta.url), "utf8")
  assert.match(organize, /const live = spacePeers\(stored\)\(chat, all\)/)
  assert.match(organize, /suggestMove\(chat, peers\(chat, live\), vectors\.vectorOf, org\.config\)/)
})
