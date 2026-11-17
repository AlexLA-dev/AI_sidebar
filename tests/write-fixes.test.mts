// 2.7 (107), the owner's test of Check / Rewrite / underlines on an iPhone and an iPad mini:
// - the list of fixes: each fix with its sentence (any script), where the list goes by touch (never over a chat's box
//   on the keyboard, a thumb's reach otherwise), «Исправить все»;
// - a check or a rewrite always ends: within its deadline, or the page stops waiting and says so; Cancel stops it;
// - the request knows where in a thread the reply sits: the conversation up to the reply, the later messages apart.
import assert from "node:assert/strict"
import { mock, test } from "node:test"

import { fixesMaxHeight, fixesSpot } from "../src/content/insert/spot.ts"
import { askWriteWith, ExtensionGone, inTime, PAGE_MARGIN_MS, STORE_WAIT_MS } from "../src/content/insert/writeAsk.ts"
import { afterAll, applyEdits, clipAsk, clipPage, diffWords, snippetOf, WRITE_LIMITS, WRITE_SERVER_MARGIN_MS, writeDeadline, type WriteAsk, type WriteReply } from "../src/shared/writing.ts"

const fix = (para: string, right: string, n = 0) => {
  const e = diffWords(para, right)[n]
  return { e, s: snippetOf(para, e) }
}
const shown = (s: ReturnType<typeof snippetOf>) => `${s.cutBefore ? "…" : ""}${s.before}[${s.was}→${s.now}]${s.after}${s.cutAfter ? "…" : ""}`

test("a fix with its sentence: the words around it, cut at a word; never the neighbouring sentences", () => {
  const para = "Thanks for the call. I will recieve the slides tommorow and send them to the whole team before lunch. Talk soon."
  const first = fix(para, para.replace("recieve", "receive").replace("tommorow", "tomorrow"), 0)
  assert.equal(shown(first.s), "I will [recieve→receive] the slides tommorow and send…")
  const second = fix(para, para.replace("recieve", "receive").replace("tommorow", "tomorrow"), 1)
  assert.equal(shown(second.s), "I will recieve the slides [tommorow→tomorrow] and send them to the whole team…")
  // Only something added (a comma), only something taken away.
  assert.equal(shown(fix("Hi Anna thanks for the notes.", "Hi Anna, thanks for the notes.").s), "Hi Anna[→,] thanks for the notes.")
  assert.equal(shown(fix("It is is ready.", "It is ready.").s), "It is [is →]ready.")
})

test("the same in Russian, Japanese (no spaces: cut by characters, each counting double) and Arabic", () => {
  assert.equal(shown(fix("Спасибо за звонок. Вобщем я прийду завтра и расчитываю успеть.", "Спасибо за звонок. В общем я прийду завтра и расчитываю успеть.").s), "[Вобщем→В общем] я прийду завтра и расчитываю…")
  const ja = "昨日はありがとうございました。こんにちわ、昨日は学校に行きました。図書館で本を読みましたが、とても静かで集中できましたので、また行きたいと思います。"
  const j = snippetOf(ja, { from: ja.indexOf("こんにちわ"), to: ja.indexOf("こんにちわ") + 5, text: "こんにちは" })
  assert.equal(j.before, "", "the sentence starts at the fix")
  assert.equal(j.after, "、昨日は学校に行きました。")
  const long = "図書館で本を読みましたが".repeat(4)
  const l = snippetOf(long, { from: 0, to: 3, text: "図書室" })
  assert.equal(Array.from(l.after).length, 17, "34 units of width: 17 characters")
  assert.equal(l.cutAfter, true)
  const ar = "شكرا لك. لاكن لا أستطيع الحضور غدا. ذالك بسبب السفر."
  const a = snippetOf(ar, { from: ar.indexOf("لاكن"), to: ar.indexOf("لاكن") + 4, text: "لكن" })
  assert.equal(shown(a), "[لاكن→لكن] لا أستطيع الحضور غدا.")
  // A pair of surrogates (an emoji) is never cut in two.
  const emoji = snippetOf(`${"😀".repeat(40)} teh end`, { from: 81, to: 84, text: "the" })
  assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(emoji.before))
})

test("«Исправить все»: a paragraph's new text, with every change made", () => {
  const para = "i will recieve teh slides"
  const edits = diffWords(para, "I will receive the slides")
  assert.equal(afterAll(para, [...edits].reverse()), "I will receive the slides")
  assert.equal(applyEdits(para, edits), "I will receive the slides")
})

test("where the list of fixes goes by touch", () => {
  // An iPhone, the keyboard up: 400 pt visible. A chat's box sits right on the keyboard: the list goes above it.
  assert.deepEqual(fixesSpot({ top: 330, bottom: 392 }, 400, 180), { top: 142, at: "above" })
  // A comment box in the middle, room under it: the bottom of what's visible, where a thumb is.
  assert.deepEqual(fixesSpot({ top: 60, bottom: 150 }, 400, 180), { top: 212, at: "bottom" })
  // A mail's body filling the screen: over its bottom part (its words are brought out from under it).
  assert.deepEqual(fixesSpot({ top: 20, bottom: 900 }, 400, 180), { top: 212, at: "bottom" })
  // The keyboard down, the field up the page: the bottom. The field out of sight or gone: the bottom.
  assert.deepEqual(fixesSpot({ top: 120, bottom: 220 }, 760, 220), { top: 532, at: "bottom" })
  assert.deepEqual(fixesSpot({ top: -300, bottom: -200 }, 760, 220), { top: 532, at: "bottom" })
  assert.deepEqual(fixesSpot(null, 760, 220), { top: 532, at: "bottom" })
  // An iPad mini in portrait with the keyboard up (about 700 pt visible): the same rules.
  assert.deepEqual(fixesSpot({ top: 560, bottom: 690 }, 700, 240), { top: 312, at: "above" })
  // Never taller than about half of what's visible, never less than a row and its head.
  assert.equal(fixesMaxHeight(400), 192)
  assert.equal(fixesMaxHeight(1000), 320)
  assert.equal(fixesMaxHeight(240), 150)
})

test("the deadline: a few seconds for a short text, more for a long one; the server's is shorter than the device's", () => {
  assert.equal(writeDeadline("check", 11), 8_033)
  assert.equal(writeDeadline("check", 4_000), 20_000)
  assert.equal(writeDeadline("rewrite", 4_000), 30_000)
  assert.equal(writeDeadline("check", 1_500, true), 8_000, "a live check of a paragraph")
  assert.ok(writeDeadline("check", 11) - WRITE_SERVER_MARGIN_MS > 5_000)
})

const ASK: WriteAsk = { action: "check", text: "two words", page: { title: "", url: "", text: "", conversation: false }, field: "", style: { samples: [], templates: [] } }

test("a request the background never answers ends by itself: SLOW after the deadline, the request dropped", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: any[] = []
    // Safari put the background's page to sleep: no answer, ever.
    const send = <T,>(message: unknown) => {
      sent.push(message)
      return new Promise<T | null>(() => undefined)
    }
    const asked = askWriteWith(send, ASK)
    let reply: WriteReply | null = null
    void asked.reply.then((r) => (reply = r))
    mock.timers.tick(writeDeadline("check", ASK.text.length) + PAGE_MARGIN_MS - 1)
    await Promise.resolve()
    assert.equal(reply, null, "still waiting inside the deadline")
    mock.timers.tick(1)
    await asked.reply
    assert.deepEqual(reply, { ok: false, code: "SLOW" })
    assert.equal(sent[0].type, "qiWrite")
    assert.ok(sent[0].ask.id, "the request carries a name")
    assert.deepEqual(sent[1], { type: "qiWriteStop", id: sent[0].ask.id })
  } finally {
    mock.timers.reset()
  }
})

test("Cancel stops it at once and drops the request; an answer that comes is passed on; a late one changes nothing", async () => {
  const sent: any[] = []
  let answer: (r: WriteReply | null) => void = () => undefined
  const send = <T,>(message: unknown) => {
    sent.push(message)
    return new Promise<T | null>((resolve) => ((message as any).type === "qiWrite" ? (answer = resolve as any) : resolve(null)))
  }
  const cancelled = askWriteWith(send, ASK)
  cancelled.stop()
  assert.deepEqual(await cancelled.reply, { ok: false, code: "STOPPED" })
  assert.equal(sent[1].type, "qiWriteStop")
  answer({ ok: true, text: "late" })
  assert.deepEqual(await cancelled.reply, { ok: false, code: "STOPPED" })

  const fine = askWriteWith(send, ASK)
  answer({ ok: true, text: "Two words." })
  assert.deepEqual(await fine.reply, { ok: true, text: "Two words." })
  fine.stop()
  assert.equal(sent.filter((m) => m.type === "qiWriteStop").length, 1, "nothing to drop once it has ended")

  // The extension was reloaded under the page: no reply at all.
  const gone = askWriteWith(send, ASK)
  answer(null)
  assert.deepEqual(await gone.reply, { ok: false, code: "NETWORK" })
})

test("a tab left open across an update: storage that never answers ends the wait (the card asks for a reload)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    // The old page script's storage after an update: the read never comes back.
    const gone = inTime(new Promise<string>(() => undefined), STORE_WAIT_MS)
    const seen: { failed: unknown } = { failed: null }
    gone.catch((e: unknown) => (seen.failed = e))
    mock.timers.tick(STORE_WAIT_MS - 1)
    await Promise.resolve()
    assert.equal(seen.failed, null)
    mock.timers.tick(1)
    await new Promise((r) => setImmediate(r))
    assert.ok((seen.failed as object | null) instanceof ExtensionGone)
    // A live page answers at once, and its timer doesn't linger.
    assert.equal(await inTime(Promise.resolve("about me"), STORE_WAIT_MS), "about me")
  } finally {
    mock.timers.reset()
  }
  assert.ok(STORE_WAIT_MS <= 3_000, "a stale tab says so within seconds")
})

test("the request: a conversation keeps its end (the message being answered), a page its start; later messages apart", () => {
  const thread = `${"old ".repeat(3000)}THE ANSWERED MESSAGE`
  assert.ok(clipPage(thread, true, 200).endsWith("THE ANSWERED MESSAGE"))
  assert.ok(clipPage(thread, false, 200).startsWith("old old"))
  const clipped = clipAsk({ ...ASK, id: "x1", page: { title: "t", url: "u", text: thread, conversation: true, after: ` ${"later ".repeat(600)}` } })
  assert.equal(clipped.page.text.length, WRITE_LIMITS.page)
  assert.ok(clipped.page.text.endsWith("THE ANSWERED MESSAGE"))
  assert.equal(clipped.page.after!.length, WRITE_LIMITS.after)
  assert.equal("id" in clipped, false, "the device's own name for the request stays on the device")
  // Not a conversation: no later messages.
  assert.equal(clipAsk({ ...ASK, page: { title: "t", url: "u", text: "page", conversation: false, after: "x" } }).page.after, undefined)
})
