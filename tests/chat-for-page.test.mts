// 2.6 (98), the owner on TestFlight 97: «Когда я нахожусь на странице, которую уже обсуждал в чатах, при нажатии на
// кружочек сайдбара нужно открывать чат последний, где обсуждалась эта страница (или домен)».
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { chatForPage, type Threads } from "../src/shared/threads.ts"

const q = (url: string, t: number) => ({ role: "user" as const, content: "What is this?", t, page: { url, title: "Page", hash: "h", at: t } })
const a = (t: number) => ({ role: "assistant" as const, content: "An answer.", t })
const chat = (id: string, at: number, ...urls: string[]) => ({ id, u: at, a: at, m: urls.flatMap((u, i) => [q(u, at - 100 + i), a(at - 50 + i)]) })

const threads: Threads = {
  old: chat("old", 1_000, "https://shop.example/desk?utm_source=mail#reviews"),
  newer: chat("newer", 5_000, "https://news.example/a", "https://shop.example/desk"),
  site: chat("site", 9_000, "https://www.shop.example/chair"),
  latest: chat("latest", 20_000, "https://other.example/b")
}

test("the circle on a page already talked about opens its latest chat, whatever chat is newest", () => {
  assert.equal(chatForPage(threads, "https://shop.example/desk"), "newer")
  // The same page with a hash or tracking words.
  assert.equal(chatForPage(threads, "https://shop.example/desk#top"), "newer")
  assert.equal(chatForPage(threads, "https://shop.example/desk?utm_campaign=x"), "newer")
})

test("else the site's latest chat (www. or not); else none, and the panel opens as before", () => {
  assert.equal(chatForPage(threads, "https://shop.example/lamp"), "site")
  assert.equal(chatForPage(threads, "https://www.shop.example/lamp"), "site")
  assert.equal(chatForPage(threads, "https://unknown.example/"), null)
  assert.equal(chatForPage({}, "https://shop.example/desk"), null)
})

test("chats in Recently Deleted, deleted ones, empty ones and \"Ask your chats\" aren't about a page", () => {
  const more: Threads = {
    ...threads,
    trashed: { ...chat("trashed", 50_000, "https://shop.example/desk"), trashed: 49_000 },
    gone: { id: "gone", u: 60_000, m: [], deleted: true },
    history: { ...chat("history", 70_000, "https://shop.example/desk"), kind: "history" as const }
  }
  assert.equal(chatForPage(more, "https://shop.example/desk"), "newer")
})

test("only the circle and Safari's toolbar button pick it; Ask AI on a selection, links and notifications don't", () => {
  const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
  assert.match(app, /const onToggle = \(\) => \(open \? hide\(\) : show\(undefined, \{ pageChat: true \}\)\)/)
  assert.match(app, /const onOpen = \(\) => show\(undefined, \{ pageChat: true \}\)/)
  assert.match(app, /\} else \{\n\s*show\(undefined, \{ pageChat: true \}\)\n\s*\}/)
  assert.match(app, /pageChatRef\.current = Boolean\(how\?\.pageChat && !captured\)/)
  // 2.7: chatForPage inside the space the panel is in, or the site's bound space (pageChatPlace, tests/spaces.test.mts).
  assert.match(app, /const place = pageChat \? pageChatPlace\(threads, was, key, await loadSpaces\(\), settingsRef\.current\.spaces !== false\) : null/)
  assert.match(app, /const found = place \? place\.chat \?\? newThreadId\(\) : null/)
  // Stored before the sync reads which chat is open.
  assert.match(app, /if \(active !== was\) await setActiveThread\(active\.id, place\?\.space\)/)
  assert.equal((app.match(/pageChat: true/g) ?? []).length, 3)
})
