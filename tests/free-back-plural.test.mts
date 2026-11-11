// Out of free answers (2.6): "N new free answers at 2:00, in 17 h" takes the form the number does in each language.
// The gate saw «1 бесплатных ответов снова будут» and "1 new free answers". The panel's own helper, built as the panel
// is, with each language's strings given to it the way Safari's chrome.i18n gives them.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"

const root = new URL("..", import.meta.url).pathname
const FORMS = ["one", "two", "few", "many", "other"]
const strings = (lang: string) => JSON.parse(readFileSync(`${root}src/locales/${lang}.json`, "utf8")) as Record<string, string>

let i18n: { freeAnswersBack: (count: number, at: string, until: string, lang?: string) => string }
before(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "cf-free-back-")), "i18n.mjs")
  await build({ entryPoints: [`${root}src/shared/i18n.ts`], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" })
  i18n = await import(pathToFileURL(out).href)
})

/** The text in `lang`, as the panel shows it there. */
function say(lang: string, count: number): string {
  const messages = strings(lang)
  ;(globalThis as { chrome?: unknown }).chrome = { i18n: { getMessage: (key: string) => messages[key] ?? "" } }
  try {
    return i18n.freeAnswersBack(count, "2:00", "17 h", lang)
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
}

test("each language has every form with the time and the wait, and the number (Arabic's one and two say it in words)", () => {
  for (const file of readdirSync(`${root}src/locales`)) {
    const messages = JSON.parse(readFileSync(`${root}src/locales/${file}`, "utf8")) as Record<string, string>
    assert.equal(messages.limitFreeBack, undefined, `${file}: the one-form key is gone`)
    for (const form of FORMS) {
      const text = messages[`limitFreeBack_${form}`]
      assert.ok(text, `${file}: limitFreeBack_${form}`)
      assert.match(text, /\{1\}/, `${file}: limitFreeBack_${form} has the time`)
      assert.match(text, /\{2\}/, `${file}: limitFreeBack_${form} has the wait`)
      if (!(file === "ar.json" && (form === "one" || form === "two"))) assert.match(text, /\{0\}/, `${file}: limitFreeBack_${form} has the number`)
    }
  }
})

test("Russian: 1 бесплатный ответ, 2 бесплатных ответа, 5 бесплатных ответов, 21 бесплатный ответ", () => {
  assert.deepEqual([1, 2, 5, 21].map((n) => say("ru", n)), [
    "1 бесплатный ответ снова будет в 2:00, через 17 h.",
    "2 бесплатных ответа снова будут в 2:00, через 17 h.",
    "5 бесплатных ответов снова будут в 2:00, через 17 h.",
    "21 бесплатный ответ снова будет в 2:00, через 17 h."
  ])
})

test("Ukrainian: 1 безкоштовна відповідь, 2 безкоштовні відповіді, 5 безкоштовних відповідей, 21 безкоштовна відповідь", () => {
  assert.deepEqual([1, 2, 5, 21].map((n) => say("uk", n)), [
    "1 безкоштовна відповідь знову буде о 2:00, через 17 h.",
    "2 безкоштовні відповіді знову будуть о 2:00, через 17 h.",
    "5 безкоштовних відповідей знову будуть о 2:00, через 17 h.",
    "21 безкоштовна відповідь знову буде о 2:00, через 17 h."
  ])
})

test("English: 1 new free answer, 2 new free answers", () => {
  assert.deepEqual([1, 2].map((n) => say("en", n)), [
    "1 new free answer at 2:00, in 17 h.",
    "2 new free answers at 2:00, in 17 h."
  ])
})

test("Arabic says one and two in words, then the number", () => {
  assert.deepEqual([1, 2, 3, 11].map((n) => say("ar", n)), [
    "تعود إجابة مجانية واحدة عند 2:00، بعد 17 h.",
    "تعود إجابتان مجانيتان عند 2:00، بعد 17 h.",
    "تعود 3 إجابات مجانية عند 2:00، بعد 17 h.",
    "تعود 11 إجابة مجانية عند 2:00، بعد 17 h."
  ])
})
