// «Снимок страницы в заметке» (2.7): the whole page screen by screen (what each screen adds, a sticky header once, at
// most 10 screens), the picture's size caps, the crop frame (kept inside, dragged, shown), and which pictures made on
// this device can go (no note has had them for a week).
import assert from "node:assert/strict"
import { test } from "node:test"

import { chunks, cleanCrop, cropView, dragCrop, fitSize, markedRows, MARK_RGB, newShotId, nextScreen, orphanShots, pageRows, SHOT_LIMITS, shotsInUse, validShotId } from "../src/shared/shots.ts"

test("a page screen by screen: each screen adds what the one before didn't show; the last scrolls only to the end", () => {
  const steps = []
  let shown = 0
  for (let s = nextScreen(shown, 3000, 800); s; s = nextScreen(shown, 3000, 800)) {
    steps.push([s.scrollY, s.from, s.height])
    shown += s.height
  }
  assert.deepEqual(steps, [[0, 0, 800], [800, 0, 800], [1600, 0, 800], [2200, 200, 600]])
  assert.equal(shown, 3000)
})

test("Safari's bars fold as the page scrolls (754 → 714 tall, the simulator): every row once, none missed", () => {
  const page = 4564
  const views = [754, 754, 714, 714, 714, 714, 714, 714]
  let shown = 0
  let i = 0
  for (let s = nextScreen(shown, page, views[0]); s; s = nextScreen(shown, page, views[++i] ?? 714)) {
    assert.equal(s.scrollY + s.from, shown, "the screen's part starts at the next unseen row")
    assert.ok(s.from + s.height <= (views[i] ?? 714))
    shown += s.height
  }
  assert.equal(shown, page)
  assert.equal(nextScreen(500, 500, 800), null)
})

test("where the page is in a capture: between the marks (iPhone: the status bar above, the toolbar below)", () => {
  const column = (height: number, marks: Array<[number, number]>) => {
    const px = new Uint8ClampedArray(height * 4)
    for (let y = 0; y < height; y++) px.set([20, 20, 20, 255], y * 4)
    for (const [from, to] of marks) for (let y = from; y < to; y++) px.set([...MARK_RGB, 255], y * 4)
    return px
  }
  // 2622 rows: status bar 186, the page 754×3 = 2262, the toolbar below.
  assert.deepEqual(markedRows(column(2622, [[186, 198], [2436, 2448]]), 2622), { top: 186, height: 2262 })
  // A Mac: the capture is the page.
  assert.deepEqual(markedRows(column(1600, [[0, 8], [1592, 1600]]), 1600), { top: 0, height: 1600 })
  // JPEG's slight smudge is fine; no marks, or one, isn't an answer.
  const smudged = column(1000, [[0, 8], [992, 1000]])
  smudged.set([240, 18, 220, 255], 0)
  assert.deepEqual(markedRows(smudged, 1000), { top: 0, height: 1000 })
  assert.equal(markedRows(column(1000, []), 1000), null)
  assert.equal(markedRows(column(1000, [[0, 8]]), 1000), null)
})

test("the picture's size: within the width and the pixels iOS allows", () => {
  assert.deepEqual(fitSize(2340, 1080 * 3, 1170), { w: 1170, h: 1620, scale: 0.5 })
  const tall = fitSize(1170, 2532 * 10, 900)
  assert.ok(tall.w * tall.h <= SHOT_LIMITS.pixels + 2000, `${tall.w}×${tall.h}`)
  assert.equal(fitSize(600, 400, 1170).scale, 1, "never enlarged")
})

test("a crop frame: kept inside, at least 5 % each way; the whole picture is no crop", () => {
  assert.equal(cleanCrop([0, 0, 1, 1]), undefined)
  assert.equal(cleanCrop(null), undefined)
  assert.deepEqual(cleanCrop([0.2, 0.3, 0.9, 0.9]), [0.2, 0.3, 0.8, 0.7])
  assert.deepEqual(cleanCrop([-1, 0.5, 0.01, 0.2]), [0, 0.5, 0.05, 0.2])
  assert.equal(cleanCrop([0, Number.NaN, 1, 1]), undefined)
})

test("dragging the frame: moved whole within the picture, or by a corner, never smaller than 5 %", () => {
  assert.deepEqual(dragCrop([0.1, 0.1, 0.5, 0.5], "move", 0.8, -0.5), [0.5, 0, 0.5, 0.5])
  const se = dragCrop([0.1, 0.1, 0.5, 0.5], "se", 0.2, 0.1)
  assert.deepEqual(se.map((v) => Math.round(v * 100) / 100), [0.1, 0.1, 0.7, 0.6])
  const squashed = dragCrop([0.1, 0.1, 0.5, 0.5], "nw", 0.9, 0.9)
  assert.ok(Math.abs(squashed[2] - 0.05) < 1e-9 && Math.abs(squashed[3] - 0.05) < 1e-9)
})

test("showing a crop: the image's width and offset in % of a box with the crop's proportions", () => {
  assert.equal(cropView(undefined), null)
  assert.deepEqual(cropView([0.25, 0.5, 0.5, 0.25]), { width: "200%", left: "-50%", top: "-200%", ratio: 2 })
})

test("which pictures made here can go: no note has them, for a week; Recently Deleted still counts", () => {
  const day = 24 * 3600_000
  const now = 100 * day
  const made = { s_kept: { at: 0, parts: 1 }, s_gone: { at: 0, parts: 2 }, s_fresh: { at: now - day, parts: 1 }, s_trash: { at: 0, parts: 1 } }
  const threads = {
    a: { m: [{ shot: { id: "s_kept", kind: "visible" as const, w: 1, h: 1, parts: 1, th: "" } }, {}] },
    b: { trashed: now - day, m: [{ shot: { id: "s_trash", kind: "full" as const, w: 1, h: 1, parts: 1, th: "" } }] }
  }
  const used = shotsInUse(threads)
  assert.deepEqual([...used].sort(), ["s_kept", "s_trash"])
  assert.deepEqual(orphanShots(made, used, now), ["s_gone"])
})

test("ids and parts", () => {
  assert.equal(validShotId(newShotId()), true)
  assert.equal(validShotId("../etc/passwd"), false)
  assert.deepEqual(chunks("abcdefg", 3), ["abc", "def", "g"])
  assert.deepEqual(chunks(""), [""])
})

test("iPhone's capture is the whole screen: the status bar's strip on top is left out; elsewhere all of it is the page", () => {
  // 402×874 pt at 3×, the page 402×812 (the status bar 62 pt above it).
  assert.deepEqual(pageRows({ width: 1206, height: 2622 }, { width: 402, height: 812 }), { top: 186, height: 2436 })
  assert.deepEqual(pageRows({ width: 2560, height: 1600 }, { width: 1280, height: 800 }), { top: 0, height: 1600 })
  // Off by a pixel or far off (a zoomed page): all of it.
  assert.deepEqual(pageRows({ width: 1000, height: 801 }, { width: 1000, height: 800 }), { top: 0, height: 801 })
  assert.deepEqual(pageRows({ width: 1000, height: 3000 }, { width: 1000, height: 800 }), { top: 0, height: 3000 })
})
