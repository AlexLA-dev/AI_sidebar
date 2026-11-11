// 2.6 (98), the owner on TestFlight 97: «Не хватает кнопки Назад в шапке с названием чата (под главной шапкой) для
// перехода в меню чатов»; and «если я нахожусь на странице, чат по которой у меня открыт в сайдбаре, то мне не
// предлагаются быстрые чипы запросов… А нужно, чтобы и в первом случае были».
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const app = readFileSync(new URL("../src/content/App.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("../src/content/styles.css", import.meta.url), "utf8")

test("the chat's name bar has Back to the chats list", () => {
  const bar = app.slice(app.indexOf('<div class="cf-chat-bar">'), app.indexOf('<div class="cf-chat-bar">') + 500)
  assert.match(bar, /<button type="button" class="cf-icon cf-chat-back" onClick=\{\(\) => setView\("threads"\)\} aria-label=\{t\("allChats"\)\}/)
  assert.match(bar, /<span class="cf-chat-bar-name" dir="auto" title=\{headerName\}>\{headerName\}<\/span>/)
  assert.match(css, /\.cf-chat-bar \{[^}]*display: flex;/)
})

test("the quick chips at the end of a chat about this very page too, without the divider, however long the chat", () => {
  const same = app.slice(app.indexOf("!onNewPage && ("), app.indexOf("!onNewPage && (") + 700)
  assert.doesNotMatch(app, /!onNewPage && messages\.length < 3/)
  assert.match(same, /<div class="cf-actions follow">/)
  assert.doesNotMatch(same, /cf-divider/)
  // Less those already asked about this page (not the same chip asked on another page).
  assert.match(same, /m\.label === actionLabel\(a\) && m\.page\?\.url === pageUrl/)
  assert.match(same, /m.page\?\.url === pageUrl\)\), 4\)/)
})
