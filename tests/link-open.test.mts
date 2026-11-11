// 2.6 (98), the owner on TestFlight 97: «Если новая страница открывается по клику/тапу в расширении или приложении - надо
// чтобы сайдбар открывался там сразу и на том чате и месте, где кликнули на страницу». Find similar's notification did it
// first (#cf-similar); now every link in a chat, in the panel and in the app.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { chatMark, linkOpen, messageAt, messageRef, takesLinkOpen } from "../src/shared/linkOpen.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const T = 1_800_000_000_000

test("a link in the panel leaves a note the page that opens from it takes: the page, or its site just after (a redirect)", () => {
  const note = linkOpen("https://www.shop.example/desk?utm_source=x#specs", "chat_1", "m42", T)!
  assert.deepEqual(note, { key: "https://www.shop.example/desk", host: "shop.example", chat: "chat_1", at: "m42", t: T })
  assert.equal(takesLinkOpen(note, "https://www.shop.example/desk", T + 5_000), true)
  assert.equal(takesLinkOpen(note, "https://www.shop.example/desk#reviews", T + 100_000), true)
  assert.equal(takesLinkOpen(note, "https://www.shop.example/desk", T + 130_000), false, "too late")
  // Through a redirect: the same site, soon after.
  assert.equal(takesLinkOpen(note, "https://shop.example/en/desk", T + 10_000), true)
  assert.equal(takesLinkOpen(note, "https://shop.example/en/desk", T + 40_000), false)
  assert.equal(takesLinkOpen(note, "https://other.example/desk", T + 1_000), false)
  assert.equal(takesLinkOpen(null, "https://www.shop.example/desk", T), false)
  assert.equal(linkOpen("chat:abc", "chat_1", undefined, T), null)
  assert.equal(linkOpen("javascript:alert(1)", "chat_1", undefined, T), null)
})

test("a message's place: its id, else its index; found again by either", () => {
  const m = [{ role: "user" as const, content: "Q" }, { role: "assistant" as const, content: "A", id: "abc123" }]
  assert.equal(messageRef(m, 0), "i0")
  assert.equal(messageRef(m, 1), "abc123")
  assert.equal(messageRef(m, 5), undefined)
  assert.equal(messageAt(m, "abc123"), 1)
  assert.equal(messageAt(m, "i0"), 0)
  assert.equal(messageAt(m, "i9"), undefined)
  assert.equal(messageAt(m, "gone"), undefined)
  assert.equal(messageAt(m, undefined), undefined)
})

test("the app's links name the chat and message in the address; Find similar's mark still read; the page's own fragment stays", () => {
  assert.deepEqual(chatMark("#cf-chat=chat_1&cf-at=m42"), { chat: "chat_1", at: "m42", similar: false, rest: "" })
  assert.deepEqual(chatMark("#cf-similar=5f2c9e1a"), { chat: "5f2c9e1a", similar: true, rest: "" })
  assert.deepEqual(chatMark("#reviews&cf-chat=c&cf-at=i3"), { chat: "c", at: "i3", similar: false, rest: "#reviews" })
  assert.equal(chatMark("#reviews"), null)
  assert.equal(chatMark("#cf-chat=../../etc"), null)
  assert.equal(chatMark(""), null)
})

test("the panel: every link clicked notes its chat and message; a page opened through the background too", () => {
  const app = read("../src/content/App.tsx")
  assert.match(app, /class=\{`cf-panel \$\{visible \? "in" : ""\}`\}\s*onClickCapture=\{noteLinkClick\}/)
  assert.match(app, /const row = a\.closest<HTMLElement>\("\[data-index\]"\)/)
  assert.match(app, /type: "openPage", url, chat: chat \?\? threadRef\.current/)
  assert.match(app, /<PageDivider entries=\{messages\} index=\{idx\} onOpen=\{\(url\) => openPage\(url, threadRef\.current, messageRef\(messages, idx\)\)\} \/>/)
  // The page that opens takes the note (or the app's mark, or the message from the background) and opens at the message.
  assert.match(app, /if \(!takesLinkOpen\(note, location\.href, Date\.now\(\)\)\) return\s*void chrome\.storage\.local\.remove\(LINK_OPEN_KEY\)/)
  assert.match(app, /bus\.addEventListener\("openChat", told\)/)
  assert.match(app, /const at = messageAt\(entries, openAtRef\.current\)/)
  const bg = read("../src/background/index.ts")
  assert.match(bg, /if \(note\) await chrome\.storage\.local\.set\(\{ \[LINK_OPEN_KEY\]: note \}\)/)
  assert.match(bg, /chrome\.tabs\.sendMessage\(tab\.id, \{ type: "openChat", chat/)
  assert.match(read("../src/content/index.tsx"), /new CustomEvent\("openChat", \{ detail: \{ chat: message\.chat, at: message\.at \} \}\)/)
  assert.match(read("../src/content/Threads.tsx"), /onOpenPage\(page\.url, thread\.id\)/)
})

test("the app: every link in a message opens its page with the chat and message in the address", () => {
  const away = read("../ContextFlow/Shared (Extension)/SimilarAway.swift")
  assert.match(away, /static func pageOpening\(_ page: URL, thread: String, at: String\? = nil, mark: String = "cf-similar"\) -> URL/)
  assert.match(away, /parts\.fragment = "\\\(mark\)=\\\(thread\)\\\(place\)"/)
  assert.match(read("../ContextFlow/Shared (App)/Chats.swift"), /if let chat \{ link = SimilarAway\.pageOpening\(link, thread: chat, at: at, mark: "cf-chat"\) \}/)
  const view = read("../ContextFlow/Shared (App)/ChatsView.swift")
  assert.match(view, /\.environment\(\\\.openURL, pageLinks\(thread, index\)\)/)
  assert.match(view, /library\.open\(page\.url, chat: thread\.id, at: thread\.entries\[index\]\.id \?\? "i\\\(index\)"\)/)
  const ux = read("../ContextFlow/Shared (App)/ChatUX.swift")
  // The answers' own text views (iPhone and iPad, Mac) send their links the same way.
  assert.match(ux, /func textView\(_ textView: UITextView, primaryActionFor textItem: UITextItem/)
  assert.match(ux, /func textView\(_ textView: UITextView, shouldInteractWith url: URL/)
  assert.match(ux, /func textView\(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int\) -> Bool/)
  assert.equal((ux.match(/context\.coordinator\.openURL = context\.environment\.openURL/g) ?? []).length, 2)
})
