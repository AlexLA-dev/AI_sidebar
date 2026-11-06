// Recently Deleted (2.5 (83), the owner: «надо сделать … Trash, где до 30 дней пусть хранятся удаленные чаты»): a deleted
// chat waits 30 days, hidden everywhere, then goes for good on every device; restored, it's back in its old place.
import assert from "node:assert/strict"
import { test } from "node:test"

import type { Entry } from "../src/shared/conversation.ts"
import {
  allTags,
  applyAppChanges,
  applyRemote,
  chatDigests,
  chatList,
  groupByTag,
  liveThreads,
  markSent,
  MAX_THREADS,
  mirrorChanges,
  moveEntries,
  pendingChanges,
  prune,
  purgeTrash,
  restoreThread,
  savedThread,
  searchThreads,
  shownThread,
  storedThreads,
  threadForCloud,
  threadFromCloud,
  TRASH_DAYS,
  trashDaysLeft,
  trashedThreads,
  trashThread,
  withMessages,
  type Thread,
  type Threads
} from "../src/shared/threads.ts"
import { reminderRows } from "../src/content/ux/reminderList.ts"

const NOW = Date.UTC(2026, 10, 6, 12, 0)
const DAY = 86_400_000
const page = { url: "https://news.example/rome", title: "Rome in three days" }
const chat = (id: string, a: number, words: string, extra: Partial<Thread> = {}): Thread => ({
  id, u: a, a,
  m: [
    { role: "user", content: `Tell me about ${words}`, page: { url: `https://${id}.example/`, title: words }, id: `${id}-q`, t: a },
    { role: "assistant", content: `${words} is worth a long answer, with enough text for the digests to keep it.`, id: `${id}-a`, t: a }
  ],
  ...extra
})

const sample = (): Threads => ({
  rome: chat("rome", NOW - 3 * DAY, "Rome", { title: "Trip to Rome", tags: ["Travel"] }),
  pasta: chat("pasta", NOW - 2 * DAY, "pasta", { tags: ["Food"] }),
  pinned: chat("pinned", NOW - 10 * DAY, "pinned stuff", { pin: 0 }),
  news: chat("news", NOW - DAY, "the news")
})

test("deleting a chat moves it to Recently Deleted; restoring puts it back in its old place, not on top", () => {
  const threads = sample()
  const before = chatList(threads).map((t) => t.id)
  assert.deepEqual(before, ["pinned", "news", "pasta", "rome"])

  const trashed = trashThread(threads, "pasta", NOW)!
  assert.equal(trashed.pasta.trashed, NOW)
  // Its time is bumped (iCloud takes it to the other devices), its place by last message stays.
  assert.ok(trashed.pasta.u > threads.pasta.u)
  assert.equal(trashed.pasta.a, threads.pasta.a)
  assert.deepEqual(trashed.pasta.m, threads.pasta.m)
  assert.deepEqual(trashed.pasta.tags, ["Food"])
  assert.deepEqual(chatList(trashed).map((t) => t.id), ["pinned", "news", "rome"])
  assert.deepEqual(trashedThreads(trashed).map((t) => t.id), ["pasta"])
  // Only once, and not for what isn't there.
  assert.equal(trashThread(trashed, "pasta", NOW + 1), null)
  assert.equal(trashThread(trashed, "missing", NOW), null)
  assert.equal(trashThread({ gone: { id: "gone", u: 1, m: [], deleted: true } }, "gone", NOW), null)

  // Restored a day later: where it was, though its `u` is the newest of all.
  const back = restoreThread(trashed, "pasta", NOW + DAY)!
  assert.equal(back.pasta.trashed, undefined)
  assert.ok(!("trashed" in back.pasta))
  assert.ok(back.pasta.u > trashed.pasta.u)
  assert.equal(back.pasta.a, threads.pasta.a)
  assert.deepEqual(chatList(back).map((t) => t.id), before)
  assert.equal(restoreThread(back, "pasta", NOW), null)

  // A chat without `a` (its last change was a message): the one it had is kept, so it doesn't jump either.
  const plain: Threads = { old: { id: "old", u: 100, m: threads.rome.m }, newer: { id: "newer", u: 200, m: threads.news.m } }
  const round = restoreThread(trashThread(plain, "old", 1_000)!, "old", 2_000)!
  assert.equal(round.old.a, 100)
  assert.deepEqual(liveThreads(round).map((t) => t.id), ["newer", "old"])

  // A pinned chat comes back pinned, in its place among the pinned.
  const pin = restoreThread(trashThread(threads, "pinned", NOW)!, "pinned", NOW + 1)!
  assert.equal(pin.pinned.pin, 0)
  assert.equal(chatList(pin)[0].id, "pinned")
})

test("Recently Deleted lists the last deleted first, each with the days it has left", () => {
  let threads = sample()
  threads = trashThread(threads, "rome", NOW - 5 * DAY)!
  threads = trashThread(threads, "news", NOW - DAY)!
  assert.deepEqual(trashedThreads(threads).map((t) => t.id), ["news", "rome"])
  assert.equal(trashDaysLeft(threads.news, NOW), 29)
  assert.equal(trashDaysLeft(threads.rome, NOW), 25)
  assert.equal(trashDaysLeft(threads.rome, NOW - 5 * DAY), TRASH_DAYS)
  assert.equal(trashDaysLeft(threads.rome, NOW - 5 * DAY + 1), TRASH_DAYS)
  // The last day says 1, never 0.
  assert.equal(trashDaysLeft(threads.rome, NOW + 24 * DAY + 1), 1)
  assert.equal(trashDaysLeft(threads.rome, NOW + 26 * DAY), 1)
  // Both still stored (they go to iCloud and the app), neither live.
  assert.deepEqual(storedThreads(threads).map((t) => t.id).sort(), ["news", "pasta", "pinned", "rome"])
  assert.deepEqual(liveThreads(threads).map((t) => t.id), ["pasta", "pinned"])
})

test("a chat in Recently Deleted is hidden from the list, pinned chats, search, Ask your chats, tags, folders and reminders", () => {
  const threads = trashThread(trashThread(sample(), "rome", NOW)!, "pinned", NOW)!
  const list = chatList(threads)
  assert.deepEqual(list.map((t) => t.id), ["news", "pasta"])
  assert.ok(!list.some((t) => t.pin !== undefined))
  // Search goes over the list.
  assert.deepEqual(searchThreads(list, "rome"), [])
  assert.deepEqual(searchThreads(list, "pasta").map((r) => r.thread.id), ["pasta"])
  // "Ask your chats" and AI search take every stored chat: those in Recently Deleted stay out.
  assert.deepEqual(chatDigests(Object.values(threads), { perChat: 600, perAnswer: 200, total: 10_000 }).map((d) => d.id), ["news", "pasta"])
  // Tags and folders count only what's listed.
  assert.deepEqual(allTags(list), [{ tag: "Food", count: 1 }])
  assert.deepEqual(groupByTag(list).map((g) => g.tag), ["Food", null])
  // Its reminders don't show (and don't ring here: the panel cancels them as it deletes the chat).
  const reminded: Threads = {
    ...threads,
    rome: { ...threads.rome, m: threads.rome.m.map((e, i) => (i === 1 ? { ...e, remind: { at: NOW + DAY } } : e)) },
    news: { ...threads.news, m: threads.news.m.map((e, i) => (i === 1 ? { ...e, remind: { at: NOW + DAY } } : e)) }
  }
  assert.deepEqual(reminderRows(reminded, undefined, NOW, String, String).map((r) => r.id.split(":")[1]), ["news"])
})

test("the chat shown here, deleted on another device, isn't opened again (nor its id written over)", () => {
  const threads = trashThread(sample(), "news", NOW)!
  const shown = shownThread(threads, { id: "news", at: NOW + 1 })
  assert.notEqual(shown.id, "news")
  assert.deepEqual(shown.m, [])
  // The latest chat continued elsewhere since still takes over, as before.
  const continued = { ...threads, pasta: { ...threads.pasta, a: NOW + 5, u: NOW + 5 } }
  assert.equal(shownThread(continued, { id: "news", at: NOW + 1 }).id, "pasta")
  // A live chat that's newest isn't one in Recently Deleted.
  assert.equal(shownThread(threads, { id: "fresh", at: 0 }).id, "pasta")
})

test("after 30 days a chat in Recently Deleted goes for good, through the usual deletion", () => {
  let threads = sample()
  threads = trashThread(threads, "rome", NOW)!
  threads = trashThread(threads, "pasta", NOW + DAY)!
  const synced = Object.fromEntries(Object.values(threads).map((t) => [t.id, t.u]))

  // Not yet.
  assert.deepEqual(purgeTrash(threads, synced, NOW + TRASH_DAYS * DAY - 1).purged, [])
  assert.equal(purgeTrash(threads, synced, NOW + TRASH_DAYS * DAY - 1).threads, threads)

  // Day 30: "rome" goes. iCloud has it: a tombstone, sent as a deletion, then forgotten.
  const at = NOW + TRASH_DAYS * DAY
  const { threads: purged, purged: ids } = purgeTrash(threads, synced, at)
  assert.deepEqual(ids, ["rome"])
  assert.deepEqual(purged.rome, { id: "rome", u: at, m: [], deleted: true })
  assert.equal(purged.pasta.trashed, NOW + DAY)
  const sent = pendingChanges(purged, synced)
  assert.deepEqual(sent, [{ id: "rome", deleted: true }])
  const after = markSent(purged, synced, sent)
  assert.equal(after.threads.rome, undefined)
  assert.equal(after.synced.rome, undefined)

  // Never synced (iCloud sync off): just gone.
  assert.equal(purgeTrash(threads, {}, at).threads.rome, undefined)

  // Delete Now / Delete All: whatever their age, only chats in Recently Deleted.
  const now = purgeTrash(threads, synced, NOW + 2 * DAY, ["pasta", "news"])
  assert.deepEqual(now.purged, ["pasta"])
  assert.equal(now.threads.pasta.deleted, true)
  assert.equal(now.threads.news.deleted, undefined)
  assert.equal(now.threads.rome.trashed, NOW)
})

test("prune keeps Recently Deleted outside the 50 chats, its page texts last", () => {
  const many: Threads = {}
  for (let i = 0; i < MAX_THREADS; i++) many[`t${i}`] = chat(`t${i}`, NOW - (100 - i) * 1000, `${i}`)
  many.old = chat("old", NOW - 400 * DAY, "old")
  const trashed = trashThread(many, "old", NOW)!
  const kept = prune(trashed, NOW)
  assert.equal(kept.old.deleted, undefined)
  assert.equal(kept.old.trashed, NOW)
  assert.equal(liveThreads(kept).length, MAX_THREADS)

  const withText = (t: Thread, chars: number): Thread => ({ ...t, m: t.m.map((e, i) => (i === 0 ? { ...e, page: { ...page, hash: t.id, text: "x".repeat(chars) } } : e)) })
  const texts = trashThread({ live: withText(chat("live", 1, "live"), 600), bin: withText(chat("bin", 2, "bin"), 600) }, "bin", NOW)!
  const out = prune(texts, NOW, 1_000)
  assert.equal(out.live.m[0].page?.text?.length, 600)
  assert.equal(out.bin.m[0].page?.text, undefined)
  assert.equal(out.bin.trashed, NOW)
})

test("iCloud: a chat in Recently Deleted goes up and comes down in Recently Deleted; a newer copy decides", () => {
  // The iPad deletes "pasta".
  const ipad = trashThread(sample(), "pasta", NOW)!
  const synced = { rome: NOW - 3 * DAY, pinned: NOW - 10 * DAY, news: NOW - DAY, pasta: NOW - 2 * DAY }
  const sent = pendingChanges(ipad, synced)
  assert.deepEqual(sent.map((c) => c.id), ["pasta"])
  const up = sent[0] as { id: string; updatedAt: number; data: string }
  assert.equal(JSON.parse(up.data).trashed, NOW)
  assert.equal(JSON.parse(up.data).a, NOW - 2 * DAY)

  // The Mac had the old copy: now it's in Recently Deleted there too, in the same place.
  const mac = sample()
  const merged = applyRemote(mac, synced, [up], [], NOW + 10)
  assert.equal(merged.changed, true)
  assert.equal(merged.threads.pasta.trashed, NOW)
  assert.equal(merged.threads.pasta.a, NOW - 2 * DAY)
  assert.deepEqual(merged.threads.pasta.tags, ["Food"])
  assert.deepEqual(chatList(merged.threads).map((t) => t.id), ["pinned", "news", "rome"])
  // Nothing to send back.
  assert.deepEqual(pendingChanges(merged.threads, merged.synced), [])

  // Restored on the Mac: the iPad gets it back in its place.
  const restored = restoreThread(merged.threads, "pasta", NOW + DAY)!
  const [again] = pendingChanges(restored, merged.synced) as Array<{ id: string; updatedAt: number; data: string }>
  assert.equal(JSON.parse(again.data).trashed, undefined)
  const ipadBack = applyRemote(ipad, {}, [again], [], NOW + DAY + 10)
  assert.equal(ipadBack.threads.pasta.trashed, undefined)
  assert.deepEqual(chatList(ipadBack.threads).map((t) => t.id), ["pinned", "news", "pasta", "rome"])

  // Continued on the iPhone after the delete (or on 2.4, which drops the field it doesn't know): that newer copy
  // wins and the chat is back; an older one doesn't undo the delete.
  const continued = { id: "pasta", updatedAt: NOW + 5, data: JSON.stringify({ a: NOW + 5, m: [...ipad.pasta.m, { role: "user", content: "More pasta" }] }) }
  assert.equal(applyRemote(ipad, {}, [continued], [], NOW + 6).threads.pasta.trashed, undefined)
  const stale = { id: "pasta", updatedAt: NOW - 1, data: JSON.stringify({ m: ipad.pasta.m }) }
  assert.equal(applyRemote(ipad, {}, [stale], [], NOW + 6).threads.pasta.trashed, NOW)

  // Purged on one device: the deletion removes it everywhere.
  assert.equal(applyRemote(merged.threads, merged.synced, [], ["pasta"]).threads.pasta, undefined)
})

test("the app's copy has Recently Deleted too, and the app's delete, restore and Delete Now come back", () => {
  const threads = trashThread(sample(), "rome", NOW)!
  const out = mirrorChanges(threads, {}) as Array<{ id: string; updatedAt: number; data: string }>
  const rome = out.find((c) => c.id === "rome")!
  assert.equal(JSON.parse(rome.data).trashed, NOW)
  // Moved to Recently Deleted in the app (it edits the JSON) …
  const inApp = { id: "pasta", updatedAt: NOW + 1, data: JSON.stringify({ ...JSON.parse(threadForCloud(threads.pasta)), a: threads.pasta.a, trashed: NOW + 1 }) }
  const applied = applyAppChanges(threads, {}, [inApp], NOW + 2)
  assert.equal(applied.threads.pasta.trashed, NOW + 1)
  assert.equal(applied.threads.pasta.a, threads.pasta.a)
  // … restored there, and Delete Now (the usual deletion).
  const back = applyAppChanges(applied.threads, {}, [{ id: "rome", updatedAt: NOW + 3, data: JSON.stringify({ a: threads.rome.a, title: "Trip to Rome", m: threads.rome.m }) }], NOW + 4)
  assert.equal(back.threads.rome.trashed, undefined)
  assert.equal(applyAppChanges(back.threads, { pasta: NOW }, [{ id: "pasta", deleted: true }], NOW + 5).threads.pasta.deleted, true)
})

test("fields a newer version wrote are kept through iCloud, the app and a new message", () => {
  const data = JSON.stringify({ m: sample().rome.m, title: "Trip", trashed: NOW, future: { x: 1 }, z: [2] })
  const read = threadFromCloud(data)!
  assert.equal(read.trashed, NOW)
  assert.deepEqual(read.x, { future: { x: 1 }, z: [2] })
  const thread: Thread = { id: "r", u: NOW, ...read }
  const again = JSON.parse(threadForCloud(thread))
  assert.deepEqual(again.future, { x: 1 })
  assert.deepEqual(again.z, [2])
  assert.equal(again.trashed, NOW)
  // A known field always wins over a stray copy in `x`.
  assert.equal(JSON.parse(threadForCloud({ ...thread, x: { ...thread.x, title: "old" } })).title, "Trip")
  // Written in again: out of Recently Deleted (as on 2.4), the unknown fields still there.
  const next = withMessages(thread, "r", [...thread.m, { role: "user", content: "One more" } as Entry], NOW + 1)
  assert.equal(next.trashed, undefined)
  assert.deepEqual(next.x, { future: { x: 1 }, z: [2] })
  // Only read back unchanged: nothing stored, still in Recently Deleted.
  assert.equal(savedThread(thread, "r", thread.m, NOW + 2), null)
  // No unknown fields: no `x`.
  assert.equal("x" in threadFromCloud(JSON.stringify({ m: thread.m }))!, false)
})

test("messages aren't moved out of or into a chat in Recently Deleted", () => {
  const threads = trashThread(sample(), "rome", NOW)!
  assert.equal(moveEntries(threads, {}, "rome", 0, 1, "news", NOW), null)
  assert.equal(moveEntries(threads, {}, "news", 0, 1, "rome", NOW), null)
  assert.ok(moveEntries(threads, {}, "news", 0, 1, "pasta", NOW))
})
