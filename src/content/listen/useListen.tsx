// Read aloud (2.6, Ultra): one thing at a time (an answer or the page). On a Mac it plays in the panel; on iPhone and
// iPad the app plays it (WebKit stops a page's audio when the screen locks), so Listen hands the text to the app.

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { isUltra, type Plan } from "../../shared/plan"
import { needsScript, speechParts, speechSeconds, speechText } from "../../shared/speech"
import type { Platform, Usage } from "../../shared/types"
import type { SpeakIn, SpeakOut } from "../../background/speak"
import { SPEEDS, speedLabel, type Speed } from "../../shared/stretch"
import { isTouch } from "../page"
import { listenSpeed, setListenSpeed } from "../store"
import { clock, PcmPlayer } from "./player"

export type ListenState =
  | { at: "idle" }
  | { at: "loading"; key: string }
  | { at: "playing" | "paused"; key: string; position: number; total: number }
  | { at: "handoff"; key: string }
  | { at: "error"; key: string; code: string; usage?: Usage | null }
  // Build 91: fewer minutes left this week than the text takes, said before it starts.
  | { at: "low"; key: string; left: number; need: number; item: ListenWhat }

export interface ListenWhat {
  // An answer's Markdown, or the page's text.
  text: string
  what: "answer" | "page"
  lang: string
  title: string
  url: string
}

export function useListen({ platform, plan, speakLeft, onUltra, follow, send }: {
  platform: Platform
  plan: Plan
  // Seconds of this week's listening left (the status's), null when not known.
  speakLeft?: number | null
  // Without Ultra: what Ultra adds (the plans sheet on Ultra).
  onUltra: () => void
  // Opens a contextflow:// link from the page (iPhone and iPad).
  follow: (url: string) => void
  send: <T>(message: Record<string, unknown>) => Promise<T | null>
}) {
  const [state, setState] = useState<ListenState>({ at: "idle" })
  // iPhone and iPad: when the last hand-off to the app started (a tap again meanwhile does nothing).
  const handing = useRef(0)
  // Seconds of listening left this week: the status's, then each part's count (shown in the bar, build 91).
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    if (typeof speakLeft === "number") setLeft(speakLeft)
  }, [speakLeft])
  // 1×, 1.2×, 1.5×, 2×: the last one chosen (build 90).
  const [speed, setSpeedState] = useState<Speed>(1)
  useEffect(() => void listenSpeed().then(setSpeedState), [])
  const run = useRef<{ port: chrome.runtime.Port; player: PcmPlayer; timer: ReturnType<typeof setInterval>; ended: boolean; key: string; total: number; told: number } | null>(null)

  const stop = useCallback(() => {
    const current = run.current
    run.current = null
    if (current) {
      clearInterval(current.timer)
      try {
        current.port.postMessage({ type: "stop" } satisfies SpeakIn)
        current.port.disconnect()
      } catch {
        // Already gone.
      }
      current.player.stop()
    }
    setState({ at: "idle" })
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async (key: string, item: ListenWhat, anyway = false) => {
    stop()
    const step = (a: string) => void send({ type: "useEvent", f: "listen", a, what: item.what })
    if (!isUltra(plan)) {
      step("ultra")
      return onUltra()
    }
    const text = item.what === "answer" ? speechText(item.text) : item.text.replace(/\s+\n/g, "\n").trim()
    const parts = speechParts(text)
    if (!parts.length) return

    // iPhone and iPad always listen in the app (WebKit stops a page's sound when the screen locks; the app keeps
    // playing, in headphones too). The link is followed during the tap itself, before anything is awaited: Safari
    // asks "Open in ContextFlow?" only for a tap's own navigation (build 90 followed it after a round trip to the
    // app, so the question never came, and the panel tried to play by itself). The text goes to the app meanwhile;
    // the app waits a moment for it. Once per tap: a tap again during the hand-off does nothing.
    if (isTouch(platform)) {
      if (Date.now() - handing.current < 6000) return
      handing.current = Date.now()
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
      setState({ at: "handoff", key })
      follow(`contextflow://listen?id=${encodeURIComponent(id)}`)
      step("app")
      // The app writes it for the ear itself (as the background does here); the parts are its way when it can't.
      const script = item.what === "page" || needsScript(item.text)
      void send({ type: "listenInApp", id, parts, text: item.text.slice(0, 24_000), script, lang: item.lang, what: item.what, title: item.title, url: item.url })
      setTimeout(() => {
        handing.current = 0
        setState((s) => (s.at === "handoff" && s.key === key ? { at: "idle" } : s))
      }, 6000)
      return
    }

    // Fewer minutes left than this takes: said first (none left: the server says so).
    const need = speechSeconds(text)
    if (!anyway && typeof left === "number" && left > 0 && left < need) {
      setState({ at: "low", key, left, need, item })
      return
    }

    step("start")
    const player = new PcmPlayer(await listenSpeed())
    await player.unlock()
    const port = chrome.runtime.connect({ name: "speak" })
    const total = speechSeconds(text)
    const current = { port, player, ended: false, key, total, told: -1, timer: setInterval(() => tick(), 250) }
    run.current = current
    setState({ at: "loading", key })

    function tick() {
      if (run.current !== current) return
      const part = player.part
      if (part > current.told) {
        current.told = part
        port.postMessage({ type: "playing", part } satisfies SpeakIn)
      }
      if (current.ended && player.drained && player.received > 0) {
        stop()
        return
      }
      if (player.received === 0) return
      // Waiting for more audio shows as loading only before the first sound.
      const position = player.position
      setState({ at: player.paused ? "paused" : "playing", key, position, total: Math.max(current.total, player.received) })
    }

    port.onMessage.addListener((raw: unknown) => {
      if (run.current !== current) return
      const message = raw as SpeakOut
      if (message.type === "usage" && message.usage) setLeft(Math.max(0, message.usage.limit - message.usage.used))
      else if (message.type === "chunk") player.push(message.part, message.data)
      else if (message.type === "aac") player.pushAac(message.part, message.data)
      else if (message.type === "end") {
        current.ended = true
        player.end()
      }
      else if (message.type === "error") {
        // A part that failed after others played: what was heard stays heard, the rest stops.
        clearInterval(current.timer)
        player.stop()
        run.current = null
        try {
          port.disconnect()
        } catch {
          // Already gone.
        }
        if (message.code === "ULTRA_ONLY") {
          setState({ at: "idle" })
          onUltra()
        } else {
          step(message.code === "LIMIT_REACHED" ? "limit" : "error")
          setState({ at: "error", key, code: message.code, usage: message.usage ?? null })
        }
      }
    })
    port.onDisconnect.addListener(() => {
      if (run.current === current && !current.ended) current.ended = true
    })
    port.postMessage({ type: "play", text: item.text, lang: item.lang, what: item.what } satisfies SpeakIn)
  }, [plan, platform, onUltra, follow, send, stop, left])

  const toggle = useCallback(() => {
    const current = run.current
    if (!current) return
    if (current.player.paused) current.player.resume()
    else current.player.pause()
  }, [])

  /** The next speed (1× → 1.2× → 1.5× → 2× → 1×), kept for next time; what's playing changes at once. */
  const cycleSpeed = useCallback(() => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeedState(next)
    void setListenSpeed(next)
    run.current?.player.setSpeed(next)
  }, [speed])

  /** "Listen anyway" after the few-minutes-left note. */
  const stateRef = useRef(state)
  stateRef.current = state
  const anyway = useCallback(() => {
    const s = stateRef.current
    if (s.at === "low") void start(s.key, s.item, true)
  }, [start])

  return { state, start, stop, toggle, speed, cycleSpeed, left, anyway }
}

/** The bar over the question field while something is read aloud (or why it isn't). */
export function ListenBar({ state, speed, left, onSpeed, onAnyway, onToggle, onStop, onPlans }: {
  state: ListenState
  speed: number
  // Seconds of listening left this week (null: not known).
  left?: number | null
  onSpeed: () => void
  onAnyway?: () => void
  onToggle: () => void
  onStop: () => void
  onPlans: () => void
}): VNode | null {
  if (state.at === "idle") return null
  if (state.at === "handoff") return <div class="cf-listen" role="status"><SpeakerIcon /> <span class="cf-listen-text">{t("listenInApp")}</span></div>
  if (state.at === "low") {
    return (
      <div class="cf-listen low" role="alert">
        <span class="cf-listen-text">{t("listenLow", String(Math.max(1, Math.floor(state.left / 60))), String(Math.max(1, Math.ceil(state.need / 60))))}</span>
        <button type="button" class="cf-link" onClick={onAnyway}>{t("listenAnyway")}</button>
        <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("close")}>×</button>
      </div>
    )
  }
  if (state.at === "error") {
    const resets = state.usage?.resetsAt ? new Date(state.usage.resetsAt).toLocaleDateString(undefined, { weekday: "long" }) : ""
    const text = state.code === "LIMIT_REACHED"
      ? t("listenLimit", String(Math.round((state.usage?.limit ?? 0) / 60)), resets)
      : state.code === "NETWORK" ? t("listenOffline") : t("listenFailed")
    return (
      <div class="cf-listen error" role="alert">
        <span class="cf-listen-text">{text}</span>
        {state.code === "LIMIT_REACHED" && <button type="button" class="cf-link" onClick={onPlans}>{t("plansCompare")}</button>}
        <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("close")}>×</button>
      </div>
    )
  }
  const loading = state.at === "loading"
  return (
    <div class="cf-listen" role="group" aria-label={t("listen")}>
      <button type="button" class="cf-listen-play" disabled={loading} onClick={onToggle} aria-label={state.at === "playing" ? t("listenPause") : t("listenPlay")}>
        {state.at === "playing" ? <PauseIcon /> : <PlayIcon />}
      </button>
      {loading ? (
        <span class="cf-listen-text">{t("listenLoading")}</span>
      ) : (
        <>
          <span class="cf-listen-time">{clock(state.position)} / {clock(state.total)}</span>
          <div class="cf-listen-track" aria-hidden="true"><div style={{ width: `${Math.min(100, (state.position / Math.max(1, state.total)) * 100)}%` }} /></div>
        </>
      )}
      {typeof left === "number" && !loading && <span class="cf-listen-left" title={t("listenMinLeftTitle", String(Math.floor(left / 60)))}>{t("listenMinLeft", String(Math.floor(left / 60)))}</span>}
      <button type="button" class="cf-listen-speed" onClick={onSpeed} aria-label={t("listenSpeed", speedLabel(speed))} title={t("listenSpeed", speedLabel(speed))}>{speedLabel(speed)}</button>
      <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("listenStop")}><StopIcon /></button>
    </div>
  )
}

export function SpeakerIcon({ size = 16 }: { size?: number }): VNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  )
}

function PlayIcon(): VNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
}

function PauseIcon(): VNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>
}

function StopIcon(): VNode {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
}
