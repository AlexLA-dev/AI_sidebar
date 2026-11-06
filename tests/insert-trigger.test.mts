import assert from "node:assert/strict"
import { test } from "node:test"

import { signFor, siteHasSlashMenu, typedPhrase } from "../src/content/insert/trigger.ts"

test("a phrase after the sign at the start, after a space or a line break", () => {
  assert.deepEqual(typedPhrase("/перен", "/"), { phrase: "перен", length: 6 })
  assert.deepEqual(typedPhrase("Hi /thx", "/"), { phrase: "thx", length: 4 })
  assert.deepEqual(typedPhrase("Line\n/wifi", "/"), { phrase: "wifi", length: 5 })
  assert.deepEqual(typedPhrase("Hi /thx", "/"), { phrase: "thx", length: 4 })
  // Right after the sign: the list may show the site's templates, the caller decides.
  assert.deepEqual(typedPhrase("Hi /", "/"), { phrase: "", length: 1 })
  // A phrase of a few words ("созвон перенести").
  assert.deepEqual(typedPhrase("/созвон перен", "/"), { phrase: "созвон перен", length: 13 })
  // Korean and Chinese after composition.
  assert.deepEqual(typedPhrase("/회의", "/"), { phrase: "회의", length: 3 })
  assert.deepEqual(typedPhrase("/会议", "/"), { phrase: "会议", length: 3 })
})

test("ordinary text never opens the list", () => {
  assert.equal(typedPhrase("и/или", "/"), null)
  assert.equal(typedPhrase("03/11", "/"), null)
  assert.equal(typedPhrase("see https://example.com/path", "/"), null)
  assert.equal(typedPhrase("https://", "/"), null)
  assert.equal(typedPhrase("a // comment", "/"), null)
  assert.equal(typedPhrase("/ space", "/"), null)
  assert.equal(typedPhrase("/usr/local", "/"), null)
  assert.equal(typedPhrase("no sign here", "/"), null)
  assert.equal(typedPhrase(`/${"x".repeat(41)}`, "/"), null)
})

test("sites with their own / menu use //", () => {
  assert.equal(siteHasSlashMenu("www.notion.so"), true)
  assert.equal(siteHasSlashMenu("acme.slack.com"), true)
  assert.equal(siteHasSlashMenu("docs.google.com"), true)
  assert.equal(siteHasSlashMenu("acme.atlassian.net"), true)
  assert.equal(siteHasSlashMenu("mail.google.com"), false)
  assert.equal(signFor("app.slack.com", "/"), "//")
  assert.equal(signFor("airbnb.com", "/"), "/")
  // A sign the user chose stays as it is everywhere.
  assert.equal(signFor("app.slack.com", ";;"), ";;")
  assert.deepEqual(typedPhrase("Hi //thx", "//"), { phrase: "thx", length: 5 })
  assert.equal(typedPhrase("Hi /thx", "//"), null)
  assert.equal(typedPhrase("https://x", "//"), null)
  assert.equal(typedPhrase("///thx", "//"), null)
  assert.deepEqual(typedPhrase(";;thx", ";;"), { phrase: "thx", length: 5 })
})

// The director's 2.5 audit: "/" on ordinary typing.
import { codeField, phraseWorthLooking } from "../src/content/insert/trigger.ts"
import { searchTemplates, titleStarts } from "../src/shared/templates.ts"
import { parseHTML } from "linkedom"

const worth = (before: string) => {
  const typed = typedPhrase(before, "/")
  return Boolean(typed && typed.phrase && phraseWorthLooking(typed.phrase, before))
}

test("ordinary typing with a slash doesn't look anything up", () => {
  assert.equal(worth("/* see the docs"), false)
  assert.equal(worth("Totally a great idea /s"), false)
  assert.equal(worth("cd /u"), false)
  assert.equal(worth("cd /us"), false)
  assert.equal(worth("sudo vim /etc"), false)
  assert.equal(worth("git add -A /src"), false)
  assert.equal(worth("Hi /1x"), false)
  // A phrase of two letters or more, after ordinary words, still does.
  assert.equal(worth("Hi /th"), true)
  assert.equal(worth("/перен"), true)
  assert.equal(worth("Line\n/wifi"), true)
  assert.equal(worth("/会议"), true)
})

test("code editors and code blocks: a slash is code", () => {
  const { document } = parseHTML(`<div class="cm-editor"><div id="a" contenteditable="true"></div></div><pre><code id="b"></code></pre><textarea id="c"></textarea>`)
  assert.equal(codeField(document.getElementById("a")!), true)
  assert.equal(codeField(document.getElementById("b")!), true)
  assert.equal(codeField(document.getElementById("c")!), false)
})

test("more sites with their own / menu: GitHub, GitLab, WordPress, Teams", () => {
  for (const host of ["github.com", "gitlab.com", "gitlab.acme.org", "wordpress.com", "teams.microsoft.com"]) assert.equal(siteHasSlashMenu(host), true, host)
  assert.equal(siteHasSlashMenu("blog.acme.org", "/wp-admin/post.php"), true)
  assert.equal(signFor("blog.acme.org", "/", "/wp-admin/post-new.php"), "//")
  assert.equal(signFor("blog.acme.org", "/", "/2026/11/hello"), "/")
})

const tpl = (id: string, title: string, keywords: string[], text: string) =>
  ({ id, title, keywords, text, createdAt: 1, updatedAt: 1 }) as any
const LIST = [tpl("a", "Thanks for your order", ["shipping"], "Hi {Name}, thanks! It ships on {date}."), tpl("b", "Early check-in", ["hotel"], "Sure, see you at {time}.")]
const ctx = { host: "x.com", use: {}, now: 2 }

test("a typed phrase finds templates by title and keywords, not by a word of their text", () => {
  assert.deepEqual(searchTemplates(LIST, "see", ctx, 5, true).map((t) => t.id), [])
  assert.deepEqual(searchTemplates(LIST, "see", ctx, 5).map((t) => t.id), ["b"], "the list's own search still reads the text")
  assert.deepEqual(searchTemplates(LIST, "ship", ctx, 5, true).map((t) => t.id), ["a"])
  assert.deepEqual(searchTemplates(LIST, "ear", ctx, 5, true).map((t) => t.id), ["b"])
})

test("a phrase that starts the title stands chosen (Tab takes it); a keyword match doesn't", () => {
  assert.equal(titleStarts(LIST[1], "ear"), true)
  assert.equal(titleStarts(LIST[1], "early ch"), true)
  assert.equal(titleStarts(LIST[0], "ship"), false)
  assert.equal(titleStarts(LIST[0], ""), false)
})
