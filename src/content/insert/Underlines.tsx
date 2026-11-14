// Live underlines, as in Grammarly (2.7, plan section 13; Pro and Ultra). After a pause in typing, each paragraph changed
// since the field got the focus is checked on its own (with the page and the person's style, as a tap's check), and
// what would change is underlined in our colour, not the system's red. Pointing at an underline on a Mac (a tap on
// iPhone and iPad) shows the fix with «Исправить» and «Пропустить»; a fix lands on those words only and can be undone.
// Not counted as answers; a hidden cap per subscription a day: when it runs out, the underlines stop without a word.

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { afterFix, diffWords, issueKey, liveIssues, LIVE, paragraphs, toCheck, type Edit, type Issue, type WriteReply } from "../../shared/writing"
import { isControl, isOwnHost, updateCaret, type Field } from "./field"
import { caretOf, domRange, readText, workRange, type FieldText } from "./fieldtext"
import { sendBackground } from "./store"
import { controlRects, pageRect, rangeRects, viewport } from "./watch"
import { askFor, makeEdits, writeStep, type Undo } from "./Write"

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

/** Where an underline's words are (fixed coordinates), clipped to the field's visible box. */
function rectsOf(field: Field, ft: FieldText, issue: Issue, touch: boolean): DOMRect[] {
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
  const vp = viewport(touch)
  return rects
    .filter((r) => r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right)
    .map((r) => {
      const left = Math.max(r.left, box.left)
      return new DOMRect(left + vp.dx, r.top + vp.dy, Math.min(r.right, box.right) - left, r.height)
    })
}

interface Props {
  field: Field
  host: string
  touch: boolean
  // A fix made: the toast offers to take it back.
  onFixed: (undo: Undo) => void
}

export function Underlines({ field, host, touch, onFixed }: Props): VNode | null {
  const el = field.el
  const mem = remember(el)
  const [, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)
  const [open, setOpen] = useState<{ issue: Issue; rect: DOMRect } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const busy = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shownRef = useRef<Array<{ issue: Issue; rects: DOMRect[] }>>([])

  // ------------------------------------------------------------ a check after a pause in typing
  const check = async () => {
    if (stopped || busy.current || !el.isConnected) return
    const now = updateCaret(field)
    const ft = readText(el)
    const part = workRange(now, ft, true)
    const todo = toCheck(paragraphs(ft.text, part.from, part.to), mem.before, mem.checked, caretOf(now, ft))
    if (!todo.length) return
    busy.current = true
    try {
      for (const p of todo) {
        const ask = await askFor(now, { action: "check", via: "circle" }, p.text, host)
        const reply = await sendBackground<WriteReply>({ type: "qiWrite", ask: { ...ask, live: true } })
        if (!reply) break
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
        bump()
      }
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    const onInput = () => {
      setOpen(null)
      bump()
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
    return () => {
      clearTimeout(timer.current)
      clearTimeout(hoverTimer.current)
      el.removeEventListener("input", onInput)
      el.removeEventListener("scroll", move)
      window.removeEventListener("scroll", move, true)
      window.removeEventListener("resize", move)
      window.visualViewport?.removeEventListener("resize", move)
      window.visualViewport?.removeEventListener("scroll", move)
      grow.disconnect()
    }
  }, [el])

  // ------------------------------------------------------------ pointing at one (a Mac), tapping one (iPhone and iPad)
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
      const hit = at(e)
      clearTimeout(hoverTimer.current)
      if (hit) {
        hoverTimer.current = setTimeout(() => setOpen((cur) => {
          if (cur?.issue.key === hit.issue.key) return cur
          writeStep("live_shown", "underline")
          return hit
        }), 220)
      } else hoverTimer.current = setTimeout(() => setOpen(null), 350)
    }
    const onTap = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return
      const hit = at(e)
      if (hit) writeStep("live_shown", "underline")
      setOpen(hit)
    }
    doc.addEventListener("pointermove", onMove, true)
    el.addEventListener("pointerup", onTap as EventListener)
    return () => {
      doc.removeEventListener("pointermove", onMove, true)
      el.removeEventListener("pointerup", onTap as EventListener)
    }
  }, [el, touch])

  // ------------------------------------------------------------ what's underlined now
  const ft = el.isConnected ? readText(el) : null
  const part = ft ? workRange(updateCaret(field), ft, true) : null
  const issues = ft && part
    ? liveIssues(mem.checked, paragraphs(ft.text, part.from, part.to), mem.ignored).filter((i) => !ft.frozen.some((f) => i.from < f.to && i.to > f.from))
    : []
  const shown = ft ? issues.map((issue) => ({ issue, rects: rectsOf(field, ft, issue, touch) })).filter((s) => s.rects.length) : []
  shownRef.current = shown
  // The card's underline went (typed over): the card goes too.
  useLayoutEffect(() => {
    if (open && !issues.some((i) => i.key === open.issue.key)) setOpen(null)
  })

  const fix = async (issue: Issue) => {
    setOpen(null)
    const before = readText(el).text
    if (before.slice(issue.from, issue.to) !== issue.para.slice(issue.rel.from, issue.rel.to)) return
    const result = await makeEdits(el, [{ from: issue.from, to: issue.to, text: issue.text }])
    if (!result.back.length) return writeStep("live_failed", "underline")
    // The paragraph's other underlines stay, moved by what this one changed; its new text isn't checked again for it.
    const next = afterFix(issue.para, mem.checked.get(issue.para) ?? [], issue.rel)
    mem.checked.delete(issue.para)
    mem.checked.set(next.para, next.edits)
    writeStep("live_fixed", "underline")
    onFixed({ el, after: result.after, back: result.back })
    bump()
  }
  const skip = (issue: Issue) => {
    mem.ignored.add(issueKey(issue.para, issue.rel))
    writeStep("live_ignored", "underline")
    setOpen(null)
  }

  if (!shown.length) return null
  const card = open ? placeCard(open.rect, viewport(touch)) : null
  const was = open ? open.issue.para.slice(open.issue.rel.from, open.issue.rel.to) : ""
  return (
    <>
      <div class="cf-ul-layer" aria-hidden="true">
        {shown.flatMap((s) => s.rects.map((r) => (
          <div class={`cf-ul ${open?.issue.key === s.issue.key ? "on" : ""}`} style={{ left: `${r.left}px`, top: `${r.bottom - 1}px`, width: `${Math.max(6, r.width)}px` }} />
        )))}
      </div>
      {open && card && (
        <div
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
            <button type="button" class="cf-link" onClick={() => skip(open.issue)}>{t("writeSkip")}</button>
          </div>
        </div>
      )}
    </>
  )
}

/** The card under the underlined words, or above them near the bottom of what's visible; kept on screen. */
function placeCard(r: DOMRect, vp: { width: number; height: number; dx: number; dy: number }): { left: number; top: number } {
  const w = 240
  const h = 96
  const left = Math.max(vp.dx + 8, Math.min(r.left - 12, vp.dx + vp.width - w - 8))
  const below = r.bottom + 6
  const top = below + h > vp.dy + vp.height - 8 ? r.top - h - 6 : below
  return { left, top: Math.max(vp.dy + 8, top) }
}
