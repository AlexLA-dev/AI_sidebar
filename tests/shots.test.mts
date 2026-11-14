// «Снимок страницы в заметке» (2.7): the whole page screen by screen (what each screen adds, a sticky header once, at
// most 10 screens), the picture's size caps, the crop frame (kept inside, dragged, shown), and which pictures made on
// this device can go (no note has had them for a week).
import assert from "node:assert/strict"
import { test } from "node:test"

import { chunks, cleanCrop, cropView, dragCrop, fitSize, newShotId, orphanShots, SHOT_LIMITS, shotsInUse, stitchPlan, validShotId } from "../src/shared/shots.ts"

test("a page screen by screen: each screen adds what the one before didn't show; the last scrolls only to the end", () => {
  const { steps, height, cut } = stitchPlan(3000, 800)
  assert.deepEqual(steps.map((s) => [s.scrollY, s.from, s.to, s.height]), [[0, 0, 0, 800], [800, 0, 800, 800], [1600, 0, 1600, 800], [2200, 200, 2400, 600]])
  assert.equal(height, 3000)
  assert.equal(cut, false)
  // Every page row once, in order.
  let at = 0
  for (const s of steps) {
    assert.equal(s.to, at)
    assert.equal(s.scrollY + s.from, s.to, "the screen's part is the page at its place")
    at += s.height
  }
})

test("a sticky header: in the first screen only; later screens add what's under it", () => {
  const { steps, height } = stitchPlan(2000, 800, 10, 60)
  for (const s of steps.slice(1)) {
    assert.ok(s.from >= 60, "below the header")
    assert.equal(s.scrollY + s.from, s.to)
  }
  assert.equal(height, 2000)
})

test("at most 10 screens: a longer page is cut; a short one is one screen", () => {
  const long = stitchPlan(50_000, 800)
  assert.equal(long.steps.length, SHOT_LIMITS.screens)
  assert.equal(long.cut, true)
  assert.equal(long.height, 8000)
  const short = stitchPlan(500, 800)
  assert.deepEqual([short.steps.length, short.height, short.cut], [1, 800, false])
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
