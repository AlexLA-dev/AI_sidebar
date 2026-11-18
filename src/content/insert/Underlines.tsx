// Live underlines, as in Grammarly (2.7, plan section 13; Pro and Ultra). After a pause in typing, each paragraph changed
// since the field got the focus is checked on its own (with the page and the person's style, as a tap's check), and
// what would change is underlined in our colour, not the system's red.
// - The underlines stay while the mistake is there, with the focus in the field or out of it (2.7 (107), the owner: they
//   went with the focus, and nothing said how many there were). A line and a faint tint in our gradient; a light runs
//   along each in the selection ring's rhythm while it's in sight (2.7 (108), the owner: «переливающимся в нашем стиле»,
//   then «бегает регулярно как при выделении текста»). Still with Reduce Motion.
// - With a pointer (a Mac, an iPad's trackpad), pointing at one shows the fix with «Исправить» and «Пропустить».
// - By touch nothing opens on the word (2.7 (107): the card came up one tap in ten, under the system's menu and our
//   selection buttons, and behind the keyboard on an iPad mini). The field's button carries the count and opens the list
//   of fixes (Fixes.tsx), clear of the word; a tap that puts the caret in an underlined word opens that list at its fix.
// - A fix lands on those words only and can be undone. Not counted as answers; a hidden cap per subscription a day:
//   when it runs out, the underlines stop without a word.

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { afterAll, afterFix, diffWords, issueKey, liveIssues, LIVE, paragraphs, toCheck, type Edit, type Issue } from "../../shared/writing"
import { activeIn, hasFocus, isControl, isOwnHost, readField, updateCaret, type Field } from "./field"
import { caretOf, domRange, readText, workRange, type FieldText } from "./fieldtext"
import { fieldGround } from "./ground"
import { cardTop } from "./spot"
import { controlRects, pageRect, rangeRects, viewport } from "./watch"
import { askFor, askWrite, makeEdits, writeStep, type Undo } from "./Write"

/** Per field, kept while the page lives (the field may lose and get back the focus): its paragraphs when it was first
 * met, its checked paragraphs and their changes, the underlines set aside. */
interface FieldMemory {
  before: Set<string>
  checked: Map<string, Edit[]>
  ignored: Set<string>
}
const memory = new WeakMap<Element, FieldMemory>()
// A cap ran out, the plan isn't Pro, or there's no consent: no more live checks on this page.
let stopped = false

function remember(el: Element): FieldMemory {
  let m = memory.get(el)
  if (!m) {
    m = { before: new Set(paragraphs(readText(el as Field["el"]).text).map((p) => p.text)), checked: new Map(), ignored: new Set() }
    memory.set(el, m)
  }
  return m
}

/**
 * A field met: its paragraphs as they are now are the ones not checked (what was there before, a draft). Called when it
 * gets the focus, before any typing (2.7 (107)): met later, on the first render with underlines on, a sentence typed fast
 * or pasted in one go was already in it, counted as old, and never underlined.
 */
export function meetField(el: Element): void {
  remember(el)
}

// ------------------------------------------------------------ what's underlined, for the layer, the button and the list

const watchers = new Set<() => void>()
/** The underlines changed (a check came back, a fix was made, one was set aside): everything showing them draws again. */
function changed(): void {
  for (const w of watchers) w()
}

/** Draws the caller again whenever the underlines change. */
export function useLiveChanges(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    watchers.add(bump)
    return () => void watchers.delete(bump)
  }, [])
}

/** The field's text and its underlines as they are now: the checked paragraphs still in it, each change at its place. */
export function liveState(field: Field): { ft: FieldText; issues: Issue[] } | null {
  const el = field.el
  if (!el.isConnected) return null
  const mem = remember(el)
  const ft = readText(el)
  const part = workRange(updateCaret(field), ft, true)
  const issues = liveIssues(mem.checked, paragraphs(ft.text, part.from, part.to), mem.ignored).filter((i) => !ft.frozen.some((f) => i.from < f.to && i.to > f.from))
  return { ft, issues }
}

/**
 * `work` changes the field's text, which takes the focus. When the field didn't have it (a fix made from the list with
 * the keyboard down, 2.7 (107)), it's given back afterwards, and no keyboard comes up for that moment.
 */
async function keepingFocus<T>(el: Field["el"], work: () => Promise<T>): Promise<T> {
  if (hasFocus(el)) return work()
  const before = activeIn(el.ownerDocument) as HTMLElement | null
  const had = el.getAttribute("inputmode")
  el.setAttribute("inputmode", "none")
  try {
    return await work()
  } finally {
    if (had === null) el.removeAttribute("inputmode")
    else el.setAttribute("inputmode", had)
    if (hasFocus(el)) {
      ;(el as HTMLElement).blur()
      if (before && before !== el && before.isConnected && before !== el.ownerDocument.body && !isOwnHost(before)) before.focus?.({ preventScroll: true })
    }
  }
}

/** Makes one fix; what takes it back, or null when the field didn't take it (or the words have changed since). */
export async function fixIssue(el: Field["el"], issue: Issue): Promise<Undo | null> {
  const mem = remember(el)
  const before = readText(el).text
  if (before.slice(issue.from, issue.to) !== issue.para.slice(issue.rel.from, issue.rel.to)) return null
  // The paragraph's other underlines stay, moved by what this one changed; its new text isn't checked again for it.
  // The old text keeps its underlines too: an Undo brings them back at once. Known before the edit: a render while it
  // goes in (the field's input event) would otherwise find the new text unchecked, with no underlines, and the list
  // of fixes would close after its first fix.
  const next = afterFix(issue.para, mem.checked.get(issue.para) ?? [], issue.rel)
  const known = mem.checked.has(next.para)
  if (!known) mem.checked.set(next.para, next.edits)
  const result = await keepingFocus(el, () => makeEdits(el, [{ from: issue.from, to: issue.to, text: issue.text }]))
  if (!result.back.length) {
    if (!known) mem.checked.delete(next.para)
    writeStep("live_failed", "underline")
    return null
  }
  mem.checked.set(next.para, next.edits)
  writeStep("live_fixed", "underline")
  changed()
  return { el, after: result.after, back: result.back }
}

/** Makes every fix at once (the list's «Исправить все»): one Undo takes them all back. */
export async function fixIssues(el: Field["el"], issues: Issue[]): Promise<{ undo: Undo | null; failed: number }> {
  const mem = remember(el)
  const now = readText(el).text
  const ready = issues.filter((i) => now.slice(i.from, i.to) === i.para.slice(i.rel.from, i.rel.to)).sort((a, b) => a.from - b.from)
  if (!ready.length) return { undo: null, failed: issues.length }
  const result = await keepingFocus(el, () => makeEdits(el, ready.map((i) => ({ from: i.from, to: i.to, text: i.text }))))
  if (!result.back.length) {
    writeStep("live_failed", "underline")
    return { undo: null, failed: issues.length }
  }
  // Each paragraph's new text is known clean; one where a fix didn't go in is checked again after the next pause.
  if (result.failed === 0) {
    for (const para of new Set(ready.map((i) => i.para))) mem.checked.set(afterAll(para, ready.filter((i) => i.para === para).map((i) => i.rel)), [])
  }
  writeStep("live_fixed_all", "underline", String(Math.min(ready.length, 9)))
  changed()
  return { undo: { el, after: result.after, back: result.back }, failed: result.failed + (issues.length - ready.length) }
}

/** Sets an underline aside for good (this field, this page). */
export function skipIssue(el: Field["el"], issue: Issue): void {
  remember(el).ignored.add(issueKey(issue.para, issue.rel))
  writeStep("live_ignored", "underline")
  changed()
}

/** Takes a fix back (the field keeps the focus, or the lack of it, it had). */
export function undoFix(u: Undo): Promise<boolean> {
  return keepingFocus(u.el, async () => {
    if (!u.el.isConnected || readText(u.el).text !== u.after) return false
    return (await makeEdits(u.el, u.back)).failed === 0
  }).then((ok) => {
    changed()
    return ok
  })
}

/**
 * Where an underline's words are (fixed coordinates), clipped to the field's visible box; none where the page has
 * something over the field (a sticky header it scrolled under, a window opened over it): the lines stay on the page
 * with or without the focus, so they mustn't float over what covers their words.
 */
export function issueRects(field: Field, ft: FieldText, issue: Issue, touch: boolean): DOMRect[] {
  const el = field.el
  // A change that only adds (a missing comma): the character before it is underlined.
  const from = issue.to > issue.from ? issue.from : Math.max(0, issue.from - 1)
  const to = issue.to > issue.from ? issue.to : issue.from
  let rects: DOMRect[] = []
  if (isControl(el)) rects = controlRects(el as HTMLInputElement, from, to)
  else {
    const range = domRange(el, ft, from, to)
    if (range) rects = rangeRects(el, range)
  }
  const box = pageRect(el)
  const own = el.getBoundingClientRect()
  const vp = viewport(touch)
  return rects
    .filter((r) => r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right)
    .filter((r) => uncovered(el, (r.left + r.right) / 2 - (box.left - own.left), (r.top + r.bottom) / 2 - (box.top - own.top)))
    .map((r) => {
      const left = Math.max(r.left, box.left)
      return new DOMRect(left + vp.dx, r.top + vp.dy, Math.min(r.right, box.right) - left, r.height)
    })
}

/** Whether the field itself is what's at this point of its document (or our own layers, which the lines sit under). */
function uncovered(el: Element, x: number, y: number): boolean {
  const doc = el.ownerDocument
  const win = doc.defaultView
  if (!win || x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) return true
  let hit: Element | null = doc.elementFromPoint(x, y)
  for (let n = 0; hit && hit.shadowRoot && !isOwnHost(hit) && n < 16; n++) {
    const inner: Element | null = hit.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === hit) break
    hit = inner
  }
  if (!hit || isOwnHost(hit)) return true
  for (let node: Node | null = hit; node; node = node.parentNode ?? (node as ShadowRoot).host ?? null) if (node === el) return true
  return el.contains(hit)
}

interface Props {
  field: Field
  host: string
  touch: boolean
  // The underline whose fix the list is on: lit.
  lit: string | null
  // Our other layers are up (the list of fixes, the selection's buttons): no card on the word.
  quiet: boolean
  // The selection's buttons are up: a tap opens nothing either.
  taps: boolean
  // A fix made from the word's card: the toast offers to take it back.
  onFixed: (undo: Undo) => void
  // By touch: the caret was put in an underlined word (a tap on it).
  onTap: (key: string) => void
}

export function Underlines({ field, host, touch, lit, quiet, taps, onFixed, onTap }: Props): VNode | null {
  const el = field.el
  const mem = remember(el)
  const [, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)
  const [open, setOpen] = useState<{ issue: Issue; rect: DOMRect } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const busy = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shownRef = useRef<Array<{ issue: Issue; rects: DOMRect[] }>>([])
  const popRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef(field)
  fieldRef.current = field
  const quietRef = useRef(quiet)
  quietRef.current = quiet
  const tapsRef = useRef(taps)
  tapsRef.current = taps
  const onTapRef = useRef(onTap)
  onTapRef.current = onTap
  useLiveChanges()

  // ------------------------------------------------------------ a check after a pause in typing
  const check = async () => {
    if (stopped || busy.current || !el.isConnected) return
    const now = updateCaret(fieldRef.current)
    const ft = readText(el)
    const part = workRange(now, ft, true)
    const todo = toCheck(paragraphs(ft.text, part.from, part.to), mem.before, mem.checked, caretOf(now, ft))
    if (!todo.length) return
    busy.current = true
    try {
      for (const p of todo) {
        const ask = await askFor(now, { action: "check", via: "circle" }, p.text, host).catch(() => null)
        // The extension behind the page was replaced (an update): nothing more is checked here until it's reloaded.
        if (!ask) {
          stopped = true
          break
        }
        const reply = await askWrite({ ...ask, live: true }).reply
        if (!reply.ok) {
          // The cap ran out, not Pro, no consent: quietly off for this page. A hiccup: the next pause tries again.
          if (["BUSY", "PRO_ONLY", "CONSENT", "LIMIT_REACHED", "UNAVAILABLE"].includes(reply.code)) {
            stopped = true
            if (reply.code === "BUSY") writeStep("live_cap", "underline")
          }
          break
        }
        mem.checked.set(p.text, diffWords(p.text, reply.text))
        // The oldest paragraphs go: the memory stays small.
        if (mem.checked.size > 200) mem.checked.delete(mem.checked.keys().next().value!)
        changed()
      }
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    const onInput = () => {
      setOpen(null)
      changed()
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void check(), LIVE.pauseMs)
    }
    // The underlines follow the text as the page and the field scroll, and as the window or the keyboard moves.
    const move = () => bump()
    el.addEventListener("input", onInput)
    el.addEventListener("scroll", move)
    window.addEventListener("scroll", move, true)
    window.addEventListener("resize", move)
    window.visualViewport?.addEventListener("resize", move)
    window.visualViewport?.addEventListener("scroll", move)
    const grow = new ResizeObserver(move)
    grow.observe(el)
    // The page may change the field's text itself (a message sent, the box emptied) without a word to us, or draw
    // something over it: looked at now and then while there's anything underlined.
    let last = ""
    const look = setInterval(() => {
      if (!shownRef.current.length && !last) return
      const text = el.isConnected ? (isControl(el) ? (el as HTMLInputElement).value : el.textContent ?? "") : ""
      const where = el.isConnected ? `${Math.round(el.getBoundingClientRect().top)}:${Math.round(el.getBoundingClientRect().left)}` : ""
      const now = `${where}:${text.length}:${text.slice(0, 40)}`
      if (now !== last) {
        last = now
        changed()
      } else if (shownRef.current.length) bump()
    }, 700)
    return () => {
      clearTimeout(timer.current)
      clearTimeout(hoverTimer.current)
      clearTimeout(tapTimer.current)
      clearInterval(look)
      el.removeEventListener("input", onInput)
      el.removeEventListener("scroll", move)
      window.removeEventListener("scroll", move, true)
      window.removeEventListener("resize", move)
      window.visualViewport?.removeEventListener("resize", move)
      window.visualViewport?.removeEventListener("scroll", move)
      grow.disconnect()
    }
  }, [el])

  // ------------------------------------------------------------ pointing at one (a pointer), the caret put in one (touch)
  useEffect(() => {
    const doc = el.ownerDocument
    const at = (e: MouseEvent) => {
      // The pointer in the top page's fixed coordinates (a frame's offset added), as the underlines are.
      const frame = pageRect(doc.body ?? el)
      const own = (doc.body ?? el).getBoundingClientRect()
      const vp = viewport(touch)
      const x = e.clientX + frame.left - own.left + vp.dx
      const y = e.clientY + frame.top - own.top + vp.dy
      for (const s of shownRef.current) {
        const r = s.rects.find((q) => x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 2 && y <= q.bottom + 3)
        if (r) return { issue: s.issue, rect: r }
      }
      return null
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      // Over our own card: it stays.
      if (isOwnHost(e.target)) return clearTimeout(hoverTimer.current)
      const hit = quietRef.current ? null : at(e)
      clearTimeout(hoverTimer.current)
      if (hit) {
        hoverTimer.current = setTimeout(() => setOpen((cur) => {
          if (cur?.issue.key === hit.issue.key) return cur
          writeStep("live_shown", "underline")
          return hit
        }), 220)
      } else hoverTimer.current = setTimeout(() => setOpen(null), 350)
    }
    // A finger's tap: once the caret has settled (a second tap would select the word: then nothing of ours opens, the
    // system's menu and the selection's buttons have the word), the underline it sits in, if any, goes to the list.
    const onTouch = (e: Event) => {
      if ((e as PointerEvent).pointerType === "mouse") return
      clearTimeout(tapTimer.current)
      tapTimer.current = setTimeout(() => {
        if (!tapsRef.current || !el.isConnected || !hasFocus(el)) return
        const now = readField(el)
        const collapsed = now.control ? now.start === now.end : Boolean(now.range?.collapsed)
        if (!collapsed) return
        const state = liveState(now)
        const caret = state ? caretOf(now, state.ft) : null
        if (!state || caret === null) return
        const hit = state.issues.find((i) => caret >= i.from && caret <= Math.max(i.to, i.from + 1))
        if (hit) {
          writeStep("live_shown", "underline")
          onTapRef.current(hit.key)
        }
      }, 320)
    }
    doc.addEventListener("pointermove", onMove, true)
    el.addEventListener("pointerup", onTouch)
    el.addEventListener("touchend", onTouch)
    return () => {
      doc.removeEventListener("pointermove", onMove, true)
      el.removeEventListener("pointerup", onTouch)
      el.removeEventListener("touchend", onTouch)
    }
  }, [el, touch])

  // ------------------------------------------------------------ what's underlined now
  const state = liveState(field)
  const issues = state?.issues ?? []
  const shown = state ? issues.map((issue) => ({ issue, rects: issueRects(field, state.ft, issue, touch) })).filter((s) => s.rects.length) : []
  shownRef.current = shown
  // The card's underline went (typed over), or another layer of ours came up: the card goes.
  useLayoutEffect(() => {
    if (open && (quiet || !issues.some((i) => i.key === open.issue.key))) setOpen(null)
  })
  // Placed once its height is known: below the words unless that runs off the bottom.
  useLayoutEffect(() => {
    const pop = popRef.current
    if (!pop || !open) return
    pop.style.top = `${cardTop(open.rect, pop.offsetHeight, viewport(touch), false)}px`
  })

  const fix = async (issue: Issue) => {
    setOpen(null)
    const undo = await fixIssue(el, issue)
    if (undo) onFixed(undo)
  }

  if (!shown.length) return null
  const view = viewport(touch)
  const card = open && !quiet ? placeCard(open.rect, viewport(touch)) : null
  const was = open ? open.issue.para.slice(open.issue.rel.from, open.issue.rel.to) : ""
  return (
    <>
      <div class="cf-ul-layer" data-ground={fieldGround(el)} aria-hidden="true">
        {shown.flatMap((s) => s.rects.map((r, i) => (
          <div
            // Its own element per mistake, so a light already running isn't restarted when the others change.
            key={`${s.issue.key}:${i}`}
            // Out of sight (scrolled away, under the keyboard): its light holds still until it's back.
            class={`cf-ul ${open?.issue.key === s.issue.key || lit === s.issue.key ? "on" : ""} ${inSight(r, view) ? "" : "off"}`}
            style={{ left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(6, r.width)}px`, height: `${r.height}px` }}
          />
        )))}
      </div>
      {open && card && (
        <div
          ref={popRef}
          class="cf-ul-pop"
          role="dialog"
          aria-label={t("writeCheck")}
          style={{ left: `${card.left}px`, top: `${card.top}px` }}
          // The field keeps the focus and its caret.
          onPointerDown={(e) => e.preventDefault()}
          onPointerEnter={() => clearTimeout(hoverTimer.current)}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return
            clearTimeout(hoverTimer.current)
            hoverTimer.current = setTimeout(() => setOpen(null), 350)
          }}
        >
          <div class="cf-ul-fix" dir="auto">
            {was && <del>{was}</del>}
            {open.issue.text && <ins>{open.issue.text}</ins>}
          </div>
          <div class="cf-ul-acts">
            <button type="button" class="cf-primary" onClick={() => void fix(open.issue)}>{t("writeFix")}</button>
            <button type="button" class="cf-link" onClick={() => {
              skipIssue(el, open.issue)
              setOpen(null)
            }}>{t("writeSkip")}</button>
          </div>
        </div>
      )}
    </>
  )
}

/** Whether an underline's rect (fixed coordinates) is within what's visible now. */
export function inSight(r: { top: number; bottom: number; left: number; right: number }, vp: { width: number; height: number; dx: number; dy: number }): boolean {
  return r.bottom > vp.dy && r.top < vp.dy + vp.height && r.right > vp.dx && r.left < vp.dx + vp.width
}

/** The card's first place (its top is set again once its height is known, cardTop); kept on screen sideways. */
function placeCard(r: DOMRect, vp: { width: number; height: number; dx: number; dy: number }): { left: number; top: number } {
  const w = 240
  return { left: Math.max(vp.dx + 8, Math.min(r.left - 12, vp.dx + vp.width - w - 8)), top: r.bottom + 8 }
}
