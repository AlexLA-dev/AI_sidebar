// «Start as a new user» (2.7, TestFlight and debug builds of the app): the panel's own first run starts over once for
// each start, and nothing of the person's goes: chats, settings, spaces, collections, templates, the plan.
import assert from "node:assert/strict"
import { test } from "node:test"

import { FIRST_RUN_KEYS, FIRST_RUN_STAMP, firstRunAgain, type KeyStore } from "../src/shared/firstRun.ts"
import { INSERT_STORAGE } from "../src/shared/insert.ts"
import { STORAGE } from "../src/shared/types.ts"

function storeOf(items: Record<string, unknown>): KeyStore & { items: Record<string, unknown> } {
  return {
    items,
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    remove: async (keys) => {
      for (const key of keys) delete items[key]
    },
    set: async (more) => {
      Object.assign(items, more)
    }
  }
}

const used = () => ({
  [STORAGE.tourSeen]: true,
  [STORAGE.consent]: 3,
  [STORAGE.hintsSeen]: ["chats", "video", "side", "new27"],
  [STORAGE.noteHint]: -1,
  [STORAGE.selHint]: 4,
  "cf:pageHints": { start: 1, shown: {} },
  [INSERT_STORAGE.tipSeen]: true,
  [INSERT_STORAGE.rewriteHintSeen]: true,
  [STORAGE.threads]: { t1: { m: [{ role: "user", content: "Why?" }] } },
  [STORAGE.settings]: { textSize: "large" },
  [STORAGE.spaces]: { u: 1, list: [{ id: "s1", name: "Work" }] },
  [STORAGE.collections]: { c1: { u: 1, rec: {} } },
  [INSERT_STORAGE.templates]: { a: { title: "Hello" } },
  [STORAGE.installId]: "0000aaaa-bbbb-cccc-dddd-eeeeffff0001",
  [STORAGE.lastEntitlement]: { value: { active: true }, at: 1 },
  [STORAGE.voiced]: { abc: 1 }
})

test("a start in the app starts the panel's first run over, and keeps what the person has", async () => {
  const store = storeOf(used())
  assert.equal(await firstRunAgain(1_800_000_000_000, store), true)
  for (const key of FIRST_RUN_KEYS) assert.equal(key in store.items, false, key)
  // As a new install: the tour and the consent are ahead, no «New in 2.7» card, the other hints not shown yet.
  assert.deepEqual(store.items[STORAGE.hintsSeen], ["new27"])
  assert.equal(store.items[FIRST_RUN_STAMP], 1_800_000_000_000)
  const before = used()
  for (const key of [STORAGE.threads, STORAGE.settings, STORAGE.spaces, STORAGE.collections, INSERT_STORAGE.templates, STORAGE.installId, STORAGE.lastEntitlement, STORAGE.voiced]) {
    assert.deepEqual(store.items[key], before[key], key)
  }
})

test("once for each start: the same stamp again, or an older one, changes nothing", async () => {
  const store = storeOf(used())
  await firstRunAgain(2_000, store)
  store.items[STORAGE.tourSeen] = true
  store.items[STORAGE.hintsSeen] = ["new27", "chats"]
  assert.equal(await firstRunAgain(2_000, store), false)
  assert.equal(await firstRunAgain(1_000, store), false)
  assert.equal(store.items[STORAGE.tourSeen], true)
  assert.deepEqual(store.items[STORAGE.hintsSeen], ["new27", "chats"])
  // The next start does it again.
  assert.equal(await firstRunAgain(3_000, store), true)
  assert.equal(STORAGE.tourSeen in store.items, false)
})

test("the App Store's app sends no stamp: nothing happens", async () => {
  for (const stamp of [undefined, null, 0, -5, "1800000000000", Number.NaN, Number.POSITIVE_INFINITY]) {
    const store = storeOf(used())
    assert.equal(await firstRunAgain(stamp, store), false)
    assert.deepEqual(store.items, used())
  }
})

test("only first-run marks are on the list, never the person's data", () => {
  const data: string[] = [
    STORAGE.threads, STORAGE.activeThread, STORAGE.settings, STORAGE.installId, STORAGE.spaces, STORAGE.collections, STORAGE.syncToken, STORAGE.syncedThreads,
    STORAGE.mirroredThreads, STORAGE.lastEntitlement, STORAGE.ownKey, STORAGE.voiced, STORAGE.pageTexts, INSERT_STORAGE.templates, INSERT_STORAGE.copied,
    INSERT_STORAGE.settings, INSERT_STORAGE.samples, STORAGE.extOnPending
  ]
  for (const key of FIRST_RUN_KEYS) assert.equal(data.includes(key), false, key)
  assert.equal(new Set(FIRST_RUN_KEYS).size, FIRST_RUN_KEYS.length)
})
