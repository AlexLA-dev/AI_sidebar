// "Fill from the page" in a conversation (the owner on 2.5 (81), LinkedIn's messages on an iPad: a conversation with
// Olga open, and "Fill" put in "Hi Nikola", a name from the list of conversations on the left; the whole page went to
// the AI). What goes now is the conversation around the field: its title and its messages. Stand:
// tools/preview/messaging.html ?layout=desk|overlay|page.
import assert from "node:assert/strict"
import { before, test } from "node:test"

import { parseHTML } from "linkedom"

let C: typeof import("../src/content/insert/conversation.ts")
let document: any

before(async () => {
  const dom = parseHTML(`<!doctype html><html><body></body></html>`)
  document = dom.document
  Object.assign(globalThis as any, { window: dom.window, document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })
  C = await import("../src/content/insert/conversation.ts")
})

const page = (html: string) => {
  document.body.innerHTML = html
  return (id: string) => document.getElementById(id)
}

test("a wide messaging page: the open conversation's name and messages, never the list of conversations", () => {
  const at = page(`<div class="desk">
  <aside class="msg-conversations-container" aria-label="Conversation list"><ul class="msg-conversations-container__conversations-list">
    <li class="msg-conversation-listitem"><h3 class="msg-conversation-listitem__participant-names">Niki Chen</h3><p>You: Hi Niki, Thanks for reaching out.</p></li>
    <li class="msg-conversation-listitem active"><h3 class="msg-conversation-listitem__participant-names">Olga Lobova</h3><p>Olga: Got it, thank you!</p></li>
    <li class="msg-conversation-listitem"><h3 class="msg-conversation-listitem__participant-names">Nikola Cavic</h3><p>Nikola: Hey Alexander, Hope all is well!</p></li>
  </ul></aside>
  <section class="msg-convo-wrapper">
    <div class="msg-title-bar"><h2 class="msg-entity-lockup__entity-title">Olga Lobova</h2><div>Events Manager | Corporate Events</div></div>
    <ul class="msg-s-message-list-content">
      <li><b>Olga Lobova</b> 3:38 PM<p>I thought golf might interest you as a venue for client events.</p></li>
      <li><b>Alexander Lubchenko</b> 3:46 PM<p>Sounds interesting, but it isn't relevant for us right now.</p></li>
      <li><b>Olga Lobova</b> 3:47 PM<p>Got it, thank you!</p></li>
    </ul>
    <form class="msg-form"><div class="msg-form__contenteditable" id="reply" contenteditable="true"><p></p></div><button type="submit">Send</button></form>
  </section>
</div>`)
  const c = C.conversationAround(at("reply"))
  assert.ok(c)
  assert.equal(c.title, "Olga Lobova")
  assert.match(c.text, /golf might interest you/)
  assert.match(c.text, /Got it, thank you!/)
  assert.doesNotMatch(c.text, /Nikola|Niki Chen|Hope all is well/, "nothing of the other conversations")
  assert.match(C.conversationText(c), /^Conversation with: Olga Lobova\n\n/)
})

test("the messages window in an open shadow root: its own title and messages", () => {
  const at = page(`<div id="interop-outlet"></div><p>Feed: Nikola Cavic shared a post.</p>`)
  const root = at("interop-outlet").attachShadow({ mode: "open" })
  root.innerHTML = `<aside class="msg-overlay-conversation-bubble">
  <header><span class="avatar"></span><b class="msg-overlay-bubble-header__title">Ben Ortiz</b><button>⋯</button></header>
  <div class="msg-s-message-list"><div class="msg-s-event"><b>Ben Ortiz</b><p>Could you send me the agenda before then?</p></div></div>
  <form class="msg-form"><div class="msg-form__msg-content-container"><div class="msg-form__contenteditable" id="overlay-reply" contenteditable="true"></div></div></form>
</aside>`
  const c = C.conversationAround(root.getElementById("overlay-reply"))
  assert.equal(c?.title, "Ben Ortiz")
  assert.match(c!.text, /send me the agenda/)
  assert.doesNotMatch(c!.text, /Nikola/)
})

test("a phone's messaging page: suggested replies right above the box aren't the conversation", () => {
  const at = page(`<div id="page">
  <div class="page-head"><button aria-label="Back">‹</button><b class="msg-thread__participant-name">Ben Ortiz</b></div>
  <div class="msg-s-message-list"><div class="msg-s-event"><b>Ben Ortiz</b><p>Great — could you send me the agenda and the address?</p></div></div>
  <div style="height:104px"></div>
  <div class="msg-s-smart-replies" role="list"><button>Sounds good!</button><button>Thanks, see you then</button></div>
  <form class="msg-form bar"><button class="plus">+</button><div class="msg-form__contenteditable" id="page-reply" contenteditable="true"></div><button>Send</button></form>
</div>`)
  const c = C.conversationAround(at("page-reply"))
  assert.equal(c?.title, "Ben Ortiz")
  assert.match(c!.text, /agenda and the address/)
  assert.doesNotMatch(c!.text, /Sounds good/)
})

test("a chat log by its role, the title from a heading above it", () => {
  const at = page(`<main><h1>Support chat · Order 4417</h1><div role="log"><p>Agent: Your parcel left the warehouse.</p></div>
<div><textarea id="box"></textarea></div></main>`)
  const c = C.conversationAround(at("box"))
  assert.equal(c?.title, "Support chat · Order 4417")
  assert.match(c!.text, /parcel left the warehouse/)
})

test("not a conversation: a form, a search, a post of one's own get the page as before (null)", () => {
  const at = page(`<h1>Contact us</h1><form><label for="name">Name</label><input id="name"><textarea id="msg"></textarea></form>
<section class="feed"><div class="share-box"><div id="post" contenteditable="true"></div></div><article><p>Nikola Cavic: a post</p></article></section>`)
  assert.equal(C.conversationAround(at("msg")), null)
  assert.equal(C.conversationAround(at("post")), null)
})
