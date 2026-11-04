import { test } from "node:test"
import assert from "node:assert/strict"
import { parseHTML } from "linkedom"

import { parseVtt } from "../src/content/captions.ts"
import { composePage, pageForModel, readsMedia } from "../src/shared/attachments.ts"
import { findPdfs, isPdfUrl, pdfName } from "../src/content/pdf.ts"
import { clock, formatTranscript, parseClock, parseJson3, readTranscript, youtubeVideoId, type PageEnv } from "../src/content/youtube.ts"
import { MAX_MEDIA_PAGE_CHARS, MAX_PAGE_CHARS, pageLimit, systemPrompt } from "../src/shared/prompt.ts"

const VIDEO = "aircAruvnKk"
const TIMEDTEXT = `https://www.youtube.com/api/timedtext?v=${VIDEO}&caps=asr&lang=en&pot=TOKEN&fmt=json3`
const JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: "This is a 3." }] },
    { tStartMs: 1200, segs: [{ utf8: "\n" }] },
    { tStartMs: 2500, segs: [{ utf8: "It's sloppily " }, { utf8: "written" }] },
    { tStartMs: 65_000, segs: [{ utf8: "Neurons hold numbers." }] }
  ]
})

/**
 * A YouTube page for the transcript reader: `html` is its markup, `player` how its caption button
 * behaves, `fetch` what the caption address answers. Time is simulated: waiting costs nothing.
 */
function page(html: string, opts: { loaded?: string[]; player?: "requests" | "silent"; fetch?: (url: string) => string | null | Promise<string | null>; panelSegments?: string } = {}) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  let now = 0
  const resources = [...(opts.loaded ?? [])]
  const watchers = new Set<(url: string) => void>()
  const env: PageEnv = {
    doc: document as unknown as Document,
    resources: () => resources,
    watchResources: (cb) => {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    fetchText: async (url) => (opts.fetch ? opts.fetch(url) : url.includes("/api/timedtext") ? JSON3 : null),
    sleep: async (ms) => {
      now += Math.max(ms, 1)
    },
    now: () => now
  }
  const cc = document.querySelector(".ytp-subtitles-button, ytm-closed-captioning-button button")
  cc?.addEventListener("click", () => {
    const on = cc.getAttribute("aria-pressed") !== "true"
    cc.setAttribute("aria-pressed", String(on))
    if (on && (opts.player ?? "requests") === "requests") {
      resources.push(TIMEDTEXT.replace("&fmt=json3", "&fmt=srv3"))
      for (const w of watchers) w(resources[resources.length - 1])
    }
  })
  const open = document.querySelector("ytd-video-description-transcript-section-renderer button")
  open?.addEventListener("click", () => {
    if (opts.panelSegments !== undefined) document.querySelector("#segments")!.innerHTML = opts.panelSegments
  })
  return { env, document, cc, elapsed: () => now }
}

const DESKTOP_PLAYER = (pressed = false) => `<div id="movie_player"><button class="ytp-subtitles-button" aria-pressed="${pressed}"></button></div>`
const PANEL = `<ytd-video-description-transcript-section-renderer><button>Show transcript</button></ytd-video-description-transcript-section-renderer><div id="segments"></div>`
const SEGMENTS = `
  <ytd-transcript-segment-renderer><div class="segment-timestamp">0:00</div><div class="segment-text">This is a 3.</div></ytd-transcript-segment-renderer>
  <ytd-transcript-segment-renderer><div class="segment-timestamp">1:05</div><div class="segment-text">Neurons hold numbers.</div></ytd-transcript-segment-renderer>`

test("youtubeVideoId: watch, live, shorts and mobile pages; nothing else", () => {
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${VIDEO}&t=42`), VIDEO)
  assert.equal(youtubeVideoId(`https://m.youtube.com/watch?v=${VIDEO}`), VIDEO)
  assert.equal(youtubeVideoId(`https://www.youtube.com/live/${VIDEO}`), VIDEO)
  assert.equal(youtubeVideoId(`https://youtube.com/shorts/${VIDEO}`), VIDEO)
  assert.equal(youtubeVideoId("https://www.youtube.com/"), null)
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=short"), null)
  assert.equal(youtubeVideoId(`https://music.youtube.com/watch?v=${VIDEO}`), null)
  assert.equal(youtubeVideoId(`https://notyoutube.com/watch?v=${VIDEO}`), null)
  assert.equal(youtubeVideoId("not a url"), null)
})

test("clock and parseClock", () => {
  assert.equal(clock(0), "0:00")
  assert.equal(clock(65_000), "1:05")
  assert.equal(clock(3_723_000), "1:02:03")
  assert.equal(parseClock("1:05"), 65_000)
  assert.equal(parseClock("1:02:03"), 3_723_000)
  assert.ok(Number.isNaN(parseClock("Intro")))
})

test("parseJson3 keeps text events; formatTranscript makes timed paragraphs", () => {
  const segments = parseJson3(JSON3)
  assert.deepEqual(segments.map((s) => s.text), ["This is a 3.", "It's sloppily written", "Neurons hold numbers."])
  assert.equal(formatTranscript(segments), "[0:00] This is a 3. It's sloppily written\n[1:05] Neurons hold numbers.")
  assert.deepEqual(parseJson3("<html>"), [])
  assert.deepEqual(parseJson3(""), [])
  assert.deepEqual(parseJson3(JSON.stringify({ events: "nope" })), [])
})

test("transcript: captions the player already loaded", async () => {
  const { env } = page(DESKTOP_PLAYER(true), { loaded: [TIMEDTEXT] })
  const result = await readTranscript(env, VIDEO)
  assert.equal(result.status, "ok")
  assert.match(result.status === "ok" ? result.text : "", /\[1:05\] Neurons hold numbers\./)
})

test("transcript: captions off → switched on for a moment, then off again", async () => {
  const { env, cc } = page(DESKTOP_PLAYER(false))
  const result = await readTranscript(env, VIDEO)
  assert.equal(result.status, "ok")
  assert.equal(cc!.getAttribute("aria-pressed"), "false")
})

test("transcript: captions on → off and on again, left on", async () => {
  const fetched: string[] = []
  const { env, cc } = page(DESKTOP_PLAYER(true), { fetch: (url) => (fetched.push(url), JSON3) })
  const result = await readTranscript(env, VIDEO)
  assert.equal(result.status, "ok")
  assert.equal(cc!.getAttribute("aria-pressed"), "true")
  assert.ok(fetched[0].includes("fmt=json3") && fetched[0].includes("pot=TOKEN"))
})

test("transcript: m.youtube.com shows its player buttons first", async () => {
  const { document } = parseHTML("<div></div>")
  void document
  const html = `<ytm-watch-player-controls><button class="ytmA11yStylesHiddenButton">Show player controls</button></ytm-watch-player-controls><div id="controls"></div>`
  const p = page(html)
  p.document.querySelector("ytm-watch-player-controls button")!.addEventListener("click", () => {
    p.document.querySelector("#controls")!.innerHTML = `<ytm-closed-captioning-button><button aria-pressed="false"></button></ytm-closed-captioning-button>`
    const cc = p.document.querySelector("ytm-closed-captioning-button button")!
    cc.addEventListener("click", () => {
      const on = cc.getAttribute("aria-pressed") !== "true"
      cc.setAttribute("aria-pressed", String(on))
      if (on) {
        const url = TIMEDTEXT.replace("www.youtube.com", "m.youtube.com")
        ;(p.env.resources() as string[]).push(url)
      }
    })
  })
  const result = await readTranscript(p.env, VIDEO)
  assert.equal(result.status, "ok")
})

test("transcript: caption file needs a token we lack → the transcript panel", async () => {
  const { env } = page(DESKTOP_PLAYER(false) + PANEL, { fetch: () => "", panelSegments: SEGMENTS })
  const result = await readTranscript(env, VIDEO)
  assert.equal(result.status, "ok")
  assert.equal(result.status === "ok" ? result.text : "", "[0:00] This is a 3.\n[1:05] Neurons hold numbers.")
})

test("broken markup: no player buttons, no transcript section → failed, quickly, without throwing", async () => {
  const p = page(`<div class="something-new">A redesigned page</div>`)
  const result = await readTranscript(p.env, VIDEO)
  assert.equal(result.status, "failed")
  assert.ok(p.elapsed() < 9_000, `took ${p.elapsed()} ms`)
})

test("broken markup: the player stops asking for captions and the panel never fills → failed by the deadline", async () => {
  const p = page(DESKTOP_PLAYER(false) + PANEL, { player: "silent", panelSegments: "" })
  const result = await readTranscript(p.env, VIDEO, 9_000)
  assert.equal(result.status, "failed")
  assert.ok(p.elapsed() <= 9_500, `took ${p.elapsed()} ms`)
  assert.equal(p.cc!.getAttribute("aria-pressed"), "false")
})

test("broken markup: transcript rows without the classes we read → failed (not an empty answer)", async () => {
  const rows = `<ytd-transcript-segment-renderer><span>0:00</span><span>Text in new markup</span></ytd-transcript-segment-renderer>`
  const p = page(PANEL, { panelSegments: rows })
  const result = await readTranscript(p.env, VIDEO)
  assert.equal(result.status, "failed")
})

test("broken markup: fetching the captions throws → handled", async () => {
  const p = page(DESKTOP_PLAYER(false), { fetch: () => Promise.reject(new Error("offline")) })
  const result = await readTranscript(p.env, VIDEO, 5_000)
  assert.equal(result.status, "failed")
})

test("a video without captions → none", async () => {
  const p = page(`<div id="movie_player"><button class="ytp-subtitles-button" aria-disabled="true" aria-pressed="false"></button></div>`)
  const result = await readTranscript(p.env, VIDEO)
  assert.equal(result.status, "none")
})

test("parseVtt: cues without tags, repeats dropped; SRT works too", () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Anna>Hello &amp; welcome</v>\n\n00:00:03.000 --> 00:00:05.000\nHello &amp; welcome\n\n1:05.500 --> 1:07.000\nNext <b>part</b>\n"
  assert.deepEqual(parseVtt(vtt), [{ start: 1000, text: "Hello & welcome" }, { start: 65_500, text: "Next part" }])
  const srt = "1\n00:00:02,000 --> 00:00:04,000\nFirst line\nsecond line\n"
  assert.deepEqual(parseVtt(srt), [{ start: 2000, text: "First line second line" }])
  assert.deepEqual(parseVtt("not captions"), [])
})

test("findPdfs: embedded first, viewers unwrapped, links only from the content", () => {
  const { document } = parseHTML(`<html><body>
    <nav><a href="/menu.pdf">Menu</a></nav>
    <main>
      <embed type="application/pdf" src="/files/report.pdf" title="Annual report">
      <iframe src="https://viewer.example.com/web/viewer.html?file=https%3A%2F%2Fcdn.example.com%2Fslides.pdf"></iframe>
      <a href="/files/report.pdf">Annual report (PDF)</a>
      <a href="https://arxiv.org/pdf/2401.12345">View PDF</a>
    </main>
    <footer><a href="/terms.pdf">Terms</a></footer>
  </body></html>`)
  const found = findPdfs(document as unknown as Document, "https://example.com/page")
  assert.deepEqual(found.map((f) => [f.url, f.embedded, f.sure]), [
    ["https://example.com/files/report.pdf", true, true],
    ["https://cdn.example.com/slides.pdf", true, true]
  ])
  assert.equal(found[0].name, "Annual report")
})

test("findPdfs: a few links in the content are read; a list of documents isn't", () => {
  const few = parseHTML(`<main><a href="/a.pdf">Guide</a><a href="https://arxiv.org/pdf/2401.12345">View PDF</a></main>`)
  assert.deepEqual(findPdfs(few.document as unknown as Document, "https://example.com/").map((f) => [f.url, f.sure]), [
    ["https://example.com/a.pdf", true],
    ["https://arxiv.org/pdf/2401.12345", false]
  ])
  const many = parseHTML(`<main>${[1, 2, 3, 4, 5].map((i) => `<a href="/doc${i}.pdf">Doc ${i}</a>`).join("")}</main>`)
  assert.deepEqual(findPdfs(many.document as unknown as Document, "https://example.com/"), [])
})

test("isPdfUrl and pdfName", () => {
  assert.ok(isPdfUrl("https://example.com/a/Report%202024.PDF?dl=1"))
  assert.ok(!isPdfUrl("https://example.com/report"))
  assert.ok(!isPdfUrl("file:///Users/me/a.pdf"))
  assert.equal(pdfName("https://example.com/a/Report%202024.pdf", "PDF"), "Report 2024.pdf")
  assert.equal(pdfName("https://example.com/a.pdf", "Quarterly results"), "Quarterly results")
})

test("compose: a long transcript and PDFs stay within the media limit, the page's text kept", () => {
  const video = composePage("description ".repeat(2_000), [{ kind: "video", lead: true, heading: "Video: Neural networks\nLength: 18:40\n\nTranscript (timestamps in [m:ss]):", text: "x".repeat(300_000) }])
  assert.ok(video.length <= MAX_MEDIA_PAGE_CHARS, String(video.length))
  assert.match(video, /^Video: Neural networks\nLength: 18:40\n\nTranscript \(timestamps in \[m:ss\]\):\nxxx/)
  assert.match(video, /Page text \(description, comments\):\ndescription/)

  const page = "p".repeat(30_000)
  const both = composePage(page, [{ kind: "pdf", heading: "PDF A:", text: "a".repeat(90_000) }, { kind: "pdf", heading: "PDF B:", text: "b".repeat(10_000) }])
  assert.ok(both.length <= MAX_MEDIA_PAGE_CHARS, String(both.length))
  assert.ok(both.startsWith("p".repeat(MAX_PAGE_CHARS)))
  assert.ok(both.includes("PDF B:\n" + "b".repeat(10_000)), "the short PDF fits whole")
  assert.equal(composePage("just the page", []), "just the page")
})

test("videos and PDFs go to the model only with Pro (or the user's own key); otherwise they're named as skipped", () => {
  const page = { kind: "page" as const, title: "T", url: "https://x.example", text: "Page text", attachments: [{ kind: "pdf" as const, heading: "PDF A:", text: "pdf body" }] }
  const pro = pageForModel(page, true)
  assert.equal(pro.media, "pdf")
  assert.match(pro.text, /^Page text\n\nPDF A:\npdf body/)
  assert.equal(pro.attachments, undefined)
  const free = pageForModel(page, false)
  assert.deepEqual(free, { kind: "page", title: "T", url: "https://x.example", text: "Page text", skipped: ["pdf"] })
  assert.deepEqual(pageForModel({ ...page, attachments: undefined, skipped: ["video"] }, false).skipped, ["video"])
  assert.deepEqual(pageForModel({ ...page, attachments: undefined }, false), { kind: "page", title: "T", url: "https://x.example", text: "Page text" })

  // Who reads them in the panel: Pro; the own key on a paid plan (any key on Chrome); not free, not unknown.
  assert.equal(readsMedia({ plan: "pro", hasOwnKey: false }, "safari"), true)
  assert.equal(readsMedia({ plan: "free", hasOwnKey: false }, "safari"), false)
  assert.equal(readsMedia({ plan: "free", hasOwnKey: true }, "safari"), false)
  assert.equal(readsMedia({ plan: "byok", hasOwnKey: true }, "safari"), true)
  assert.equal(readsMedia({ plan: "byok", hasOwnKey: false }, "safari"), false)
  assert.equal(readsMedia({ plan: "free", hasOwnKey: true }, "chrome"), true)
  assert.equal(readsMedia(null, "safari"), false)
})

test("prompt: a page goes whole (2.5), video and PDF pages say how to cite them", () => {
  // Pages within their tokens (pagefit.ts); a transcript and PDFs keep their own limit in composePage.
  assert.equal(pageLimit({ kind: "page" }), Infinity)
  assert.equal(pageLimit({ kind: "page", media: "video" }), Infinity)
  assert.equal(pageLimit({ kind: "selection", media: "pdf" }), 12_000)
  const text = "t".repeat(60_000)
  const video = systemPrompt({ kind: "page", title: "V", url: "https://youtube.com/watch?v=x", text, media: "video" }, "", "en")
  assert.ok(video.includes(text) && !/\n\[…\]\nPAGE>>>/.test(video) && !/cut off/.test(video))
  assert.match(video, /\[m:ss\] timestamps/)
  const plain = systemPrompt({ kind: "page", title: "P", url: "https://example.com", text }, "", "en")
  assert.ok(plain.includes(text) && !/\n\[…\]\nPAGE>>>/.test(plain) && !/cut off/.test(plain))
  assert.doesNotMatch(plain, /timestamps/)
  const pdf = systemPrompt({ kind: "page", title: "D", url: "https://example.com/d.pdf", text: "[Page 1]\nHi", media: "pdf" }, "", "en")
  assert.match(pdf, /\[Page N\] marks/)
})
