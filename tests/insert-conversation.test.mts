// "Fill from the page" and the rewrite in a conversation read the conversation around the reply box, not the page with
// its list of other conversations. Found for any site by roles, live regions, the times messages were sent, and labels
// in the app's 14 languages, never one site's class names (src/content/insert/conversation.ts). One fixture per
// messenger, built the way its page is built (simplified, with made-up people), plus pages that aren't conversations.
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
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

/** The conversation as the AI gets it: the title, and whether a text is in it or not. */
function check(field: any, title: string, has: RegExp[], hasNot: RegExp[] = []) {
  const c = C.conversationAround(field)
  assert.ok(c, "a conversation is found")
  assert.equal(c.title, title)
  for (const r of has) assert.match(c.text, r)
  for (const r of hasNot) assert.doesNotMatch(c.text, r)
  return c
}

test("Gmail: a thread's subject and its messages; the reply box after them", () => {
  const at = page(`<div role="navigation"><div role="list"><div role="listitem">Inbox 12</div><div role="listitem">Sent</div></div></div>
<div role="main">
  <div class="nH"><h2 class="hP">Venue for the spring offsite</h2></div>
  <div role="list">
    <div role="listitem"><span class="gD" name="Priya Shah">Priya Shah</span><span class="g3" title="Wed, Nov 5, 2026, 3:38 PM">3:38 PM</span><div class="a3s">Could we hold it at the lake house? It fits forty people.</div></div>
    <div role="listitem"><span class="gD">Me</span><span class="g3">4:02 PM</span><div class="a3s">Sounds good, let me check the dates.</div></div>
  </div>
  <div class="ip"><div class="Am editable" role="textbox" aria-label="Message Body" contenteditable="true" id="reply"></div></div>
</div>`)
  check(at("reply"), "Venue for the spring offsite", [/lake house/, /check the dates/], [/Inbox 12/])
})

test("Gmail, the reply box inside the thread's list, under the last message: the rest of the thread", () => {
  const at = page(`<div role="main"><h2>Invoice 4417</h2><div role="list">
  <div role="listitem"><b>Ken Ito</b> <span>09:12</span><p>The invoice is attached.</p></div>
  <div role="listitem"><b>Ken Ito</b> <span>09:40</span><p>Please confirm the amount.</p>
    <div class="ip"><div role="textbox" contenteditable="true" id="reply"></div></div></div>
</div></div>`)
  check(at("reply"), "Invoice 4417", [/invoice is attached/])
})

test("WhatsApp Web: the open chat's name in its header, its messages; never the chat list on the side", () => {
  const at = page(`<div id="app">
  <div id="side"><div aria-label="Chat list" role="grid">
    <div role="listitem" aria-selected="false"><span title="Diego Ruiz" dir="auto">Diego Ruiz</span><span>Hey, are we still on?</span><span>18:20</span></div>
    <div role="listitem" aria-selected="true"><span title="Lena Vogel" dir="auto">Lena Vogel</span><span>Great, see you then</span><span>15:47</span></div>
  </div></div>
  <div id="main">
    <header><div class="avatar">LV</div><div><span dir="auto" title="Lena Vogel">Lena Vogel</span></div><div><span>click here for contact info</span></div></header>
    <div class="copyable-area"><div role="application" aria-label="Message list. Press right arrow key on a message to open message context menu." tabindex="-1">
      <div role="row"><div class="message-in"><span class="selectable-text">Is the workshop on Thursday?</span><span>15:38</span></div></div>
      <div role="row"><div class="message-out"><span class="selectable-text">Yes, at ten.</span><span>15:46</span></div></div>
      <div role="row"><div class="message-in"><span class="selectable-text">Great, see you then</span><span>15:47</span></div></div>
    </div></div>
    <footer><div contenteditable="true" role="textbox" aria-label="Type a message" title="Type a message" id="reply"><p></p></div></footer>
  </div>
</div>`)
  check(at("reply"), "Lena Vogel", [/workshop on Thursday/, /see you then/], [/Diego|are we still on/])
})

test("WhatsApp Web in Japanese: the list is named in Japanese (and its times say the rest)", () => {
  const at = page(`<div id="main"><header><span dir="auto" title="佐藤 花子">佐藤 花子</span></header>
  <div role="application" aria-label="メッセージリスト"><div role="row">明日の会議は何時ですか？</div><div role="row">十時です。</div></div>
  <footer><div contenteditable="true" role="textbox" aria-label="メッセージを入力" id="reply"></div></footer></div>`)
  check(at("reply"), "佐藤 花子", [/明日の会議/])
})

test("Telegram Web: no roles on the bubbles; their times and the header's title say it", () => {
  const at = page(`<div id="column-left"><ul class="chatlist"><li class="chatlist-chat"><span class="peer-title">Omar Haddad</span><span class="message">Thanks!</span><span>12:01</span></li>
  <li class="chatlist-chat active"><span class="peer-title">Mila Novak</span><span>OK</span><span>15:47</span></li></ul></div>
<div id="column-center"><div class="chat">
  <div class="sidebar-header topbar"><div class="chat-info"><div class="avatar">MN</div><div class="content"><div class="top"><span class="peer-title" dir="auto">Mila Novak</span></div><div class="bottom"><span>online</span></div></div></div></div>
  <div class="bubbles"><div class="scrollable"><div class="bubbles-inner"><section class="bubbles-date-group">
    <div class="bubble"><div class="message">Can you send the slides?<span class="time"><span class="i18n">15:38</span></span></div></div>
    <div class="bubble is-out"><div class="message">Sure, in a minute.<span class="time"><span class="i18n">15:40</span></span></div></div>
  </section></div></div></div>
  <div class="chat-input"><div class="input-message-container"><div class="input-message-input" contenteditable="true" data-placeholder="Message" id="reply"></div></div></div>
</div></div>`)
  check(at("reply"), "Mila Novak", [/send the slides/, /in a minute/], [/Omar|Thanks!/])
})

test("Slack: a list of messages with their times, the channel or person in the view's header", () => {
  const at = page(`<div class="p-channel_sidebar" role="tree" aria-label="Channels and direct messages">
  <div role="treeitem" aria-selected="false">general</div><div role="treeitem" aria-selected="true">Noah Kim</div><div role="treeitem" aria-selected="false">design</div></div>
<div class="p-workspace__primary_view">
  <div class="p-view_header"><button class="p-view_header__channel_title"><span>Noah Kim</span></button></div>
  <div class="p-message_pane"><div role="list" aria-label="Noah Kim (direct message)">
    <div role="listitem"><a class="c-message__sender_link">Noah Kim</a><a class="c-timestamp" aria-label="Nov 5th at 3:38:12 PM"><span>3:38 PM</span></a><div class="p-rich_text_section">The build is green, can you review?</div></div>
    <div role="listitem"><a class="c-message__sender_link">Noah Kim</a><a class="c-timestamp"><span>3:41 PM</span></a><div class="p-rich_text_section">It's PR 212.</div></div>
  </div></div>
  <div class="p-message_pane_input"><div class="ql-editor" contenteditable="true" role="textbox" aria-label="Message Noah Kim" id="reply"></div></div>
</div>`)
  check(at("reply"), "Noah Kim", [/build is green/, /PR 212/], [/general|design/])
})

test("Messenger in German: the messages' grid is named in German; the heading names the person", () => {
  const at = page(`<div role="navigation" aria-label="Chats"><div role="grid"><div role="row" aria-selected="false">Jan Berg</div><div role="row" aria-selected="true">Ana Costa</div></div></div>
<div role="main" aria-label="Unterhaltung mit Ana Costa">
  <div><h2><span>Ana Costa</span></h2><span>Aktiv</span></div>
  <div role="grid" aria-label="Nachrichten in der Unterhaltung mit Ana Costa">
    <div role="row"><div role="gridcell"><div dir="auto">Hast du morgen Zeit?</div></div></div>
    <div role="row"><div role="gridcell"><div dir="auto">Ja, ab zwei.</div></div></div>
  </div>
  <div role="textbox" contenteditable="true" aria-label="Nachricht" id="reply"></div>
</div>`)
  check(at("reply"), "Ana Costa", [/morgen Zeit/, /ab zwei/], [/Jan Berg/])
})

test("LinkedIn, a wide messaging page: the open conversation, never the list of conversations on the left", () => {
  const at = page(`<div class="desk">
  <aside class="msg-conversations-container" aria-label="Conversation list"><ul class="msg-conversations-container__conversations-list">
    <li class="msg-conversation-listitem"><h3>Tom Becker</h3><p>Tom: Hey, quick question about the role</p><time>6:20 PM</time></li>
    <li class="msg-conversation-listitem active"><h3>Maria Keller</h3><p>Maria: Got it, thank you!</p><time>3:47 PM</time></li>
    <li class="msg-conversation-listitem"><h3>Sven Ahl</h3><p>Sven: Hope all is well!</p><time>Oct 29</time></li>
  </ul></aside>
  <section class="msg-convo-wrapper">
    <div class="msg-title-bar"><h2 class="msg-entity-lockup__entity-title">Maria Keller</h2><div>Events Manager</div></div>
    <ul class="msg-s-message-list-content">
      <li><b>Maria Keller</b> <time>3:38 PM</time><p>Would a workshop venue in March work for your team?</p></li>
      <li><b>You</b> <time>3:46 PM</time><p>Sounds interesting, but it isn't relevant for us right now.</p></li>
      <li><b>Maria Keller</b> <time>3:47 PM</time><p>Got it, thank you!</p></li>
    </ul>
    <form class="msg-form"><div class="msg-form__contenteditable" id="reply" contenteditable="true"><p></p></div><button type="submit">Send</button></form>
  </section>
</div>`)
  const c = check(at("reply"), "Maria Keller", [/workshop venue/, /Got it, thank you!/], [/Tom Becker|Sven|Hope all is well/])
  assert.match(C.conversationText(c), /^Conversation: Maria Keller\n\n/)
})

test("LinkedIn's messages window in an open shadow root, with suggested replies right above the box", () => {
  const at = page(`<div id="interop-outlet"></div><p>Feed: Tom Becker shared a post.</p>`)
  const root = at("interop-outlet").attachShadow({ mode: "open" })
  root.innerHTML = `<aside class="msg-overlay-conversation-bubble">
  <header><span class="avatar"></span><b class="msg-overlay-bubble-header__title">Ravi Patel</b><button>⋯</button></header>
  <div class="msg-s-message-list"><div><b>Ravi Patel</b> <time>10:07</time><p>Could you send me the agenda before then?</p></div><div><b>You</b> <time>10:09</time><p>Will do.</p></div></div>
  <div class="msg-s-smart-replies" role="list"><button>Sounds good!</button><button>Thanks</button></div>
  <form class="msg-form"><div class="msg-form__contenteditable" id="overlay-reply" contenteditable="true"></div></form>
</aside>`
  check(root.getElementById("overlay-reply"), "Ravi Patel", [/send me the agenda/], [/Tom Becker|Sounds good!/])
})

test("a chat log by its role, its title from aria-labelledby", () => {
  const at = page(`<main><p id="who">Support · Order 4417</p><div role="log" aria-labelledby="who"><p>Agent: Your parcel left the warehouse.</p></div>
<div><textarea id="box"></textarea></div></main>`)
  check(at("box"), "Support · Order 4417", [/parcel left the warehouse/])
})

test("not a conversation: a form, a post of one's own, a contact form under a list of questions get the page (null)", () => {
  const at = page(`<h1>Contact us</h1><form><label for="name">Name</label><input id="name"><textarea id="msg"></textarea></form>
<section class="feed"><div class="share-box"><div id="post" contenteditable="true"></div></div><article><p>Tom Becker: a post</p></article></section>
<section><h2>Questions</h2><ul><li>How do I return an item?</li><li>Where is my order?</li><li>Can I change my address?</li></ul>
<form><textarea id="question"></textarea></form></section>`)
  assert.equal(C.conversationAround(at("msg")), null)
  assert.equal(C.conversationAround(at("post")), null)
  assert.equal(C.conversationAround(at("question")), null)
})

test("the label words cover every language the app speaks", () => {
  const locales = readdirSync(new URL("../src/locales", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort()
  assert.deepEqual(Object.keys(C.CONVERSATION_WORDS).sort(), locales)
  for (const [lang, words] of Object.entries(C.CONVERSATION_WORDS)) assert.ok(words.length >= 3, lang)
  // Every site entry needs a reason (and a fixture above).
  for (const site of C.SITE_SIGNS) assert.ok(site.why.length > 10)
})
