// The coordinator in the panel (2.8, В3.1): one per tab. The panel says which prompts fit right now (`pick`, each
// render, plus `want` from prompts that decide inside their own components); it gets back the one that may show, and
// tells what happened to it. A hint counts as shown once it has been up for a second on this page; its events go out
// as `hint.*` with its rung and the day (events-2.8.md §3).

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"

import { sendBackground } from "../insert/store"
import {
  afterAnswer, afterCopy, afterDismissed, afterDone, afterLimit, afterPanelOpen, afterShown, allowed, choose, dayNumber, HINTS, rungOf, touch,
  type CoachHint, type CoachState, type Rung
} from "./rules"
import { changeCoach, loadCoach, onCoachChanged } from "./state"

/** On screen this long before it counts as shown. */
export const SHOWN_MS = 1_000

export interface Coach {
  // The state read (null until then: nothing shows before it's known).
  ready: boolean
  rung: Rung
  day: number
  // The facts the rest of the panel reads.
  panelOpens: number
  answers: number
  own: boolean
  /** The one prompt that may show now, from those that fit (stable while it still fits). `flow`: something the person
   *  is in the middle of (the consent, the first-open guide or questions, the plans at the limit, their agent task)
   *  holds every hint. */
  pick: (wanting: Iterable<CoachHint>, flow: boolean) => CoachHint | null
  /** Whether a prompt could show at all now (its rung, day and budget), before it counts a show of its own. */
  may: (id: CoachHint) => boolean
  /** For a prompt that decides inside its own component: it fits now, or no longer. */
  want: (id: CoachHint, on: boolean) => void
  tap: (id: CoachHint) => void
  dismiss: (id: CoachHint) => void
  done: (id: CoachHint) => void
  panelOpened: () => void
  answered: (own: boolean) => void
  limited: () => void
  copied: () => void
  copies: number
}

const send = (a: string, what: CoachHint, rung: Rung, day: number) =>
  void sendBackground({ type: "useEvent", f: "hint", a, what, rung, day })

export function useCoach({ consent, paid }: { consent: boolean; paid: boolean }): Coach & { slot: CoachHint | null } {
  const [state, setState] = useState<CoachState | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const [wanted, setWanted] = useState<ReadonlySet<CoachHint>>(new Set())
  const current = useRef<CoachHint | null>(null)
  const here = useRef(new Set<CoachHint>())
  const [slot, setSlot] = useState<CoachHint | null>(null)

  useEffect(() => {
    void loadCoach(Date.now()).then((s) => setState(touch(s, Date.now())))
    return onCoachChanged(setState)
  }, [])

  const change = useCallback((fn: (s: CoachState) => CoachState) => {
    const now = Date.now()
    if (stateRef.current) setState(fn(stateRef.current))
    void changeCoach(fn, now).then(setState)
  }, [])

  const rung = state ? rungOf(state, consent, paid) : 7
  const day = state ? dayNumber(state.first, Date.now()) : 1
  const rungRef = useRef(rung)
  rungRef.current = rung
  const dayRef = useRef(day)
  dayRef.current = day

  const pick = useCallback((wanting: Iterable<CoachHint>, flow: boolean): CoachHint | null => {
    const s = stateRef.current
    if (!s) return null
    const all = new Set([...wanting, ...wanted])
    const next = choose(s, all, { now: Date.now(), rung: rungRef.current, flow, current: current.current, here: here.current })
    current.current = next
    return next
  }, [wanted])

  // What the panel picked this render, committed after it (the shown count waits a second on screen).
  const commit = useCallback((id: CoachHint | null) => setSlot((was) => (was === id ? was : id)), [])

  useEffect(() => {
    if (!slot || here.current.has(slot)) return
    const id = slot
    const timer = setTimeout(() => {
      if (current.current !== id || here.current.has(id)) return
      here.current.add(id)
      change((s) => afterShown(s, id, Date.now()))
      if (HINTS[id].kind !== "notice") send("shown", id, rungRef.current, dayRef.current)
    }, SHOWN_MS)
    return () => clearTimeout(timer)
  }, [slot])

  const may = useCallback((id: CoachHint): boolean => {
    const s = stateRef.current
    return !!s && allowed(s, id, { now: Date.now(), rung: rungRef.current, flow: false, current: null, here: here.current })
  }, [])

  const want = useCallback((id: CoachHint, on: boolean) => {
    setWanted((was) => {
      if (was.has(id) === on) return was
      const next = new Set(was)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const tap = useCallback((id: CoachHint) => {
    if (HINTS[id].kind !== "notice") send("tap", id, rungRef.current, dayRef.current)
  }, [])
  const dismiss = useCallback((id: CoachHint) => {
    if (HINTS[id].kind !== "notice") send("dismiss", id, rungRef.current, dayRef.current)
    if (current.current === id) current.current = null
    change((s) => afterDismissed(s, id, Date.now()))
  }, [change])
  const done = useCallback((id: CoachHint) => {
    const s = stateRef.current
    const c = s?.hints[id]
    if (HINTS[id].kind === "hint" && c?.done) return
    // Used without the hint ever showing (asked for by hand): retired quietly, no event.
    if (HINTS[id].kind !== "notice" && (here.current.has(id) || (c?.shown ?? 0) > 0)) send("done", id, rungRef.current, dayRef.current)
    if (current.current === id) current.current = null
    change((st) => afterDone(st, id, Date.now()))
  }, [change])

  const panelOpened = useCallback(() => change((s) => afterPanelOpen(s, Date.now())), [change])
  const answered = useCallback((own: boolean) => change((s) => afterAnswer(s, Date.now(), own)), [change])
  const limited = useCallback(() => change((s) => afterLimit(s, Date.now())), [change])
  const copied = useCallback(() => change((s) => afterCopy(s, Date.now())), [change])

  return useMemo(() => ({
    ready: state !== null,
    rung,
    day,
    panelOpens: state?.panelOpens ?? 0,
    answers: state?.answers ?? 0,
    own: state?.own ?? false,
    copies: state?.copies ?? 0,
    slot,
    pick: (wanting: Iterable<CoachHint>, flow: boolean) => {
      const id = pick(wanting, flow)
      // Committed after this render (setState in render is only for this component's own next render).
      queueMicrotask(() => commit(id))
      return id
    },
    may, want, tap, dismiss, done, panelOpened, answered, limited, copied
  }), [state, rung, day, slot, pick, commit, may, want, tap, dismiss, done, panelOpened, answered, limited, copied])
}
