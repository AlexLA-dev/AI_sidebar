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
