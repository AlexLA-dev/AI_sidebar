// Build 110, the owner: a question asked on a selection shows the selected text as a quote, like a note on it.
import assert from "node:assert/strict"
import { test } from "node:test"

import { askedCite, citedNote, selectionCite, selectionNote, type Entry } from "../src/shared/conversation.ts"
import { chatShareText } from "../src/shared/share.ts"

const page = { url: "https://example.com/a", title: "A", at: 1 }
const labels = { you: "You", note: "Note", sources: "Sources", source: "Source", madeWith: "Made with ContextFlow" }
const links = { page: "https://here.example", app: "https://apps.apple.com/app/id1" }

test("a question keeps its selection as a quote; notes and older questions don't", () => {
  const asked: Entry = { role: "user", content: "Explain the selection simply…", label: "Explain simply", cite: "Suite consists of well-integrated", page }
  assert.equal(askedCite(asked), "Suite consists of well-integrated")
  // Never read as a cited note, even when its words start with the quote.
  assert.equal(citedNote({ ...asked, content: "Suite consists of well-integrated — what?" }), null)
  assert.equal(askedCite({ role: "user", content: "What is this?", page }), undefined)
  const note = selectionNote("Suite consists of well-integrated", "mine", page)
  assert.equal(askedCite(note), undefined)
  assert.deepEqual(citedNote(note), { cite: "Suite consists of well-integrated", note: "mine" })
  assert.equal(askedCite({ role: "assistant", content: "x", cite: "y" }), undefined)
})

test("the quote is the selection tidied, as a note's: spaces, blank lines, at most 3,000 characters", () => {
  assert.equal(selectionCite("  one   two\t three \n\n\n\n four  "), "one two three\n\nfour")
  const long = selectionCite("word ".repeat(1000))
  assert.ok(long.length <= 3001)
  assert.ok(long.endsWith("…"))
})

test("a shared chat gives the question's quote before the question, in the chat's quotes", () => {
  const entries: Entry[] = [
    { role: "user", content: "Explain simply prompt", label: "Explain simply", cite: "Suite consists of well-integrated", page },
    { role: "assistant", content: "It means the tools fit together." },
    { role: "user", content: "And this?", page }
  ]
  const text = chatShareText(entries, "", labels, links)
  assert.ok(text.startsWith("You — “Suite consists of well-integrated”\nExplain simply\nContextFlow: It means the tools fit together.\n\nYou: And this?"), text)
  const ru = chatShareText(entries, "", { ...labels, you: "Вы", quote: "«{0}»" }, links)
  assert.ok(ru.startsWith("Вы: «Suite consists of well-integrated»\nExplain simply"), ru)
  // $ in the quote stays as it is.
  assert.match(chatShareText([{ role: "user", content: "q", cite: "costs $1 and $&" }], "", labels, links), /“costs \$1 and \$&”\nq/)
})
