// The AI consent where the action is (the owner on 2.5 (81): "several times I couldn't tell why something didn't
// work, and it was the consent; I didn't see it until I opened the panel"). Every AI action outside the panel without
// the consent shows the one card right there: marking a template, Fill, the rewrite (which opens the panel only once
// agreed), Find by meaning, page watch's words. Agreed there, it's the one consent, stored once.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { parseHTML } from "linkedom"

let M: any
let window: any
let document: any
const sent: any[] = []
let stored: Record<string, unknown> = {}

before(async () => {
  ;({ window, document } = parseHTML(`<!doctype html><html><head><title>Messages</title></head><body><div id="at"></div></body></html>`))
  Object.assign(globalThis as any, {
    window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, ShadowRoot: window.ShadowRoot,
    location: { href: "https://chat.example/c/1", hostname: "chat.example", pathname: "/c/1" },
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ overflowY: "visible" })
  })
  window.visualViewport = { width: 390, height: 700, offsetLeft: 0, offsetTop: 0, addEventListener() {}, removeEventListener() {} }
  ;(globalThis as any).chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    runtime: {
      lastError: undefined,
      sendMessage: (m: any, cb?: (r: unknown) => void) => {
        sent.push(m)
        const reply = m.type === "qiFill" || m.type === "qiMark" ? { ok: false, code: "CONSENT" } : { ok: true }
        if (cb) cb(reply)
        return Promise.resolve(reply)
      }
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key]
          return Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))
        },
        set: async (v: Record<string, unknown>) => void Object.assign(stored, v)
      },
      onChanged: { addListener() {}, removeListener() {} }
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "cf-consent-place-"))
  const out = join(dir, "forms.mjs")
  await build({
    stdin: {
      contents: `export { FillForm } from "./src/content/insert/FillForm"; export { TemplateEditor } from "./src/content/insert/TemplateEditor"; export { WatchSection } from "./src/content/watch/WatchSection"; export { h, render } from "preact"`,
      resolveDir: new URL("..", import.meta.url).pathname, loader: "ts"
    },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".tsx": "tsx", ".css": "text" }, mainFields: ["module", "main"], define: { __API_BASE__: '"https://api.test"', __VERSION__: '"2.5.0"', __TARGET__: '"safari"' }
  })
  M = await import(pathToFileURL(out).href)
})

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const at = () => document.getElementById("at")
const card = () => at().querySelector(".cf-card.consent")
const click = (el: any) => el.dispatchEvent(new window.Event("click", { bubbles: true }))
const template = { id: "t4", title: "Polite decline", keywords: [], text: "Hi {Name},\nnot for us right now.", createdAt: 1, updatedAt: 1 }

test("the rewrite without the consent: the card in the form, the panel isn't opened; agreed there, then the rewrite", async () => {
  stored = {}
  const adapted: string[] = []
  let agreed = 0
  M.render(M.h(M.FillForm, {
    template, touch: true, sheet: true, field: null, copied: [], consent: "none", free: false,
    onConsent: async () => { agreed++; stored["cf:consent"] = 3 }, onUpgrade() {}, onClose() {}, onInsert() {},
    onAdapt: (text: string) => adapted.push(text)
  }), at())
  await tick()
  click(at().querySelector(".cf-qi-fill-row .cf-link"))
  await tick()
  assert.ok(card(), "the card, right in the form")
  assert.equal(adapted.length, 0, "nothing goes to the panel before the consent")
  click(card().querySelector(".cf-primary"))
  await tick(30)
  assert.equal(agreed, 1)
  assert.equal(adapted.length, 1, "agreed: the rewrite goes on")
  M.render(null, at())
})

test("Fill without the consent: the card in the form (the background said CONSENT), never a silent nothing", async () => {
  stored = {}
  M.render(M.h(M.FillForm, {
    template, touch: true, sheet: true, field: null, copied: [], consent: "none", free: false,
    onConsent: async () => undefined, onUpgrade() {}, onClose() {}, onInsert() {}, onAdapt() {}
  }), at())
  await tick()
  click(at().querySelector(".cf-qi-fill-row .cf-secondary"))
  await tick(30)
  assert.ok(card())
  M.render(null, at())
})

test("a template from a selection without the consent: the card at once, not a plain editor with nothing marked", async () => {
  stored = {}
  sent.length = 0
  M.render(M.h(M.TemplateEditor, { start: { text: "Hi Olga, thanks for the invitation to 12 November.", from: "selection" }, touch: true, consent: "none", onConsent: async () => undefined, host: "chat.example", onDone() {} }), at())
  // Preact runs effects after a frame, or 100 ms without requestAnimationFrame (as here).
  await tick(160)
  assert.ok(card())
  assert.equal(sent.filter((m) => m.type === "qiMark").length, 0, "nothing sent")
  M.render(null, at())
})

test("page watch: Watch without the consent shows the card in the section; nothing is prepared until agreed", async () => {
  stored = {}
  sent.length = 0
  M.render(M.h(M.WatchSection, { url: "https://shop.example/mug", title: "Mug", selection: "40 EUR", how: "bubble", close() {} }), at())
  await tick()
  click(at().querySelector(".cf-sheet-actions .cf-primary"))
  await tick(30)
  assert.ok(card())
  assert.equal(sent.filter((m) => m.type === "watchPrepare").length, 0)
  // "Not now": back to the words, nothing sent.
  click(card().querySelector(".cf-card-actions .cf-link"))
  await tick()
  assert.equal(card(), null)
  M.render(null, at())
})

// "Fit to the message" was unclear (the owner). It isn't "Fill again" (that refills the blanks): it rewrites the whole
// text with the panel's AI. Named for what it does, for this chat or this page, and told apart in one line under the
// buttons the first time the form shows (and on hover).
test("the rewrite's name: for this chat in a conversation, for this page elsewhere; the line telling it from Fill once", async () => {
  stored = {}
  const fill = (field: any) => M.h(M.FillForm, {
    template, touch: true, sheet: true, field, copied: [], consent: "ok", free: false,
    onConsent: async () => undefined, onUpgrade() {}, onClose() {}, onInsert() {}, onAdapt() {}
  })
  document.body.insertAdjacentHTML("beforeend", `<section id="convo" class="msg-convo-wrapper"><h2 class="msg-entity-lockup__entity-title">Olga Lobova</h2>
<ul class="msg-s-message-list-content"><li>Olga Lobova: Got it, thank you!</li></ul><form class="msg-form"><div id="reply" contenteditable="true"></div></form></section>`)
  M.render(fill({ el: document.getElementById("reply") }), at())
  await tick(160)
  const link = () => at().querySelector(".cf-qi-fill-row .cf-link")
  assert.equal(link().textContent, "Rewrite for this chat")
  assert.match(link().getAttribute("title"), /fills in only the blanks/)
  assert.ok([...at().querySelectorAll(".cf-qi-note")].some((n: any) => /fills in only the blanks/.test(n.textContent)), "the line, the first time")
  assert.equal(stored["cf:insertRewriteHintSeen"], true)
  M.render(null, at())
  document.getElementById("convo").remove()
  M.render(fill(null), at())
  await tick(160)
  assert.equal(link().textContent, "Rewrite for this page")
  assert.ok(![...at().querySelectorAll(".cf-qi-note")].some((n: any) => /fills in only the blanks/.test(n.textContent)), "not again")
  M.render(null, at())
})
