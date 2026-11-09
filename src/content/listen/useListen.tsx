// Read aloud (2.6, Ultra): one thing at a time (an answer or the page). On a Mac it plays in the panel. On iPhone and
// iPad it plays in the panel too when notifications are on: WebKit stops a page's audio when the page goes away (another
// app, the screen locks), so then a notification carries it on in the app from the same second. Without notifications
// Listen hands the text to the app (build 91), after one question a day about turning them on.

import type { VNode } from "preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { isUltra, type Plan } from "../../shared/plan"
import { needsScript, speechParts, speechSeconds, speechText } from "../../shared/speech"
import type { Platform, Usage } from "../../shared/types"
import type { SpeakIn, SpeakOut } from "../../background/speak"
import { SPEEDS, speedLabel, type Speed } from "../../shared/stretch"
import { isTouch } from "../page"
import { listenNotifyLater, listenNotifyLaterNow, listenSpeed, setListenSpeed } from "../store"
import { clock, PcmPlayer } from "./player"

export type ListenState =
  | { at: "idle" }
  | { at: "loading"; key: string }
  | { at: "playing" | "paused"; key: string; position: number; total: number }
  | { at: "handoff"; key: string }
  | { at: "error"; key: string; code: string; usage?: Usage | null }
  // Build 91: fewer minutes left this week than the text takes, said before it starts.
  | { at: "low"; key: string; left: number; need: number; item: ListenWhat }
  // iPhone, iPad without notifications (2.6): turn them on (in the app), or not now (the app plays it).
  | { at: "notify"; key: string; item: ListenWhat }
  // The app carried it on (its notification was tapped): it isn't played here again.
  | { at: "taken"; key: string }

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
  const run = useRef<{
    port: chrome.runtime.Port; player: PcmPlayer; timer: ReturnType<typeof setInterval>; ended: boolean; key: string; total: number; told: number
    // iPhone and iPad with notifications: leaving the page, coming back, and what the app is told meanwhile.
    cleanup?: () => void
    handoff?: { parts: (parts: string[], complete: boolean) => void; tick: () => void; paused: () => void; resumed: () => void }
  } | null>(null)
  const speedRef = useRef<Speed>(1)
  speedRef.current = speed

  // iPhone and iPad: whether notifications are on for ContextFlow (asked again whenever the page comes back: the user
  // may have just turned them on), and whether "Not now" holds today.
  const notifyOn = useRef(false)
  const notifyLater = useRef(false)
  // Build 92: asked when Listen starts (and on coming back while the card asks to turn them on), not on every page and
  // every tab switch: each ask is a native message, which wakes the app's extension on iPhone and iPad.
  const askNotify = useCallback(async () => {
    const [r, later] = await Promise.all([send<{ status?: string }>({ type: "notifStatus" }), listenNotifyLaterNow()])
    notifyOn.current = ["authorized", "provisional", "ephemeral"].includes(r?.status ?? "")
    notifyLater.current = later
  }, [send])
  const asking = state.at === "notify"
  useEffect(() => {
    if (!isTouch(platform) || !asking) return
    const onVisible = () => { if (document.visibilityState === "visible") void askNotify() }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [platform, asking, askNotify])

  const stop = useCallback(() => {
    const current = run.current
    run.current = null
    if (current) {
      current.cleanup?.()
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

  /** The app plays it: the link is followed during the tap itself, before anything is awaited (Safari asks "Open in
   *  ContextFlow?" only for a tap's own navigation); the text goes to the app meanwhile, and the app waits a moment for
   *  it. Once per tap: a tap again during the hand-off does nothing. `notifications`: the app asks about them first. */
  const handOff = useCallback((key: string, item: ListenWhat, parts: string[], to: "listen" | "notifications") => {
    if (Date.now() - handing.current < 6000) return
    handing.current = Date.now()
    const id = newId()
    setState({ at: "handoff", key })
    follow(to === "listen" ? `contextflow://listen?id=${encodeURIComponent(id)}` : `contextflow://notifications?listen=${encodeURIComponent(id)}`)
    void send({ type: "useEvent", f: "listen", a: to === "listen" ? "app" : "notify_on", what: item.what })
    // The app writes it for the ear itself (as the background does here); the parts are its way when it can't.
    const script = item.what === "page" || needsScript(item.text)
    void send({ type: "listenInApp", id, parts, text: item.text.slice(0, 24_000), script, lang: item.lang, what: item.what, title: item.title, url: item.url })
    setTimeout(() => {
      handing.current = 0
      setState((s) => (s.at === "handoff" && s.key === key ? { at: "idle" } : s))
    }, 6000)
  }, [follow, send])

  const start = useCallback(async (key: string, item: ListenWhat, anyway = false) => {
    stop()
    const step = (a: string) => void send({ type: "useEvent", f: "listen", a, what: item.what })
    if (!isUltra(plan)) {
      step("ultra")
      return onUltra()
    }
    const text = plainText(item)
    const parts = speechParts(text)
    if (!parts.length) return

    // iPhone and iPad without notifications: the app plays it (WebKit stops a page's sound when the page goes away;
    // the app keeps playing, screen locked and in headphones too), after asking once a day to turn them on.
    if (isTouch(platform)) await askNotify()
    if (isTouch(platform) && !notifyOn.current) {
      if (notifyLater.current) return handOff(key, item, parts, "listen")
      step("notify")
      setState({ at: "notify", key, item })
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
    const current: NonNullable<typeof run.current> = { port, player, ended: false, key, total, told: -1, timer: setInterval(() => tick(), 250) }
    run.current = current
    setState({ at: "loading", key })

    // iPhone and iPad with notifications (2.6): the app is told what's playing as it plays, so when the page goes away
    // the notification can carry it on from the same second, with the same parts (nothing made or charged twice).
    // Each update also moves a notification waiting a few seconds ahead (the extension's): if Safari stops before it
    // can say the page went away, that one still comes.
    const away = isTouch(platform) ? { id: newId(), parts: [] as string[], complete: false, sent: "", last: 0, gone: false, held: false } : null
    if (away) {
      void send({ type: "listenInApp", id: away.id, parts, text: item.text.slice(0, 24_000), script: item.what === "page" || needsScript(item.text), lang: item.lang, what: item.what, title: item.title, url: item.url })
      const body = () => t("listenAway", clock(player.position))
      const tell = (op: "state" | "away") => {
        away.last = Date.now()
        const known = `${away.parts.length}|${away.complete}`
        const parts = known !== away.sent ? { parts: away.parts, complete: away.complete } : {}
        away.sent = known
        void send({ type: "listenHandoff", op, id: away.id, at: player.position, starts: player.starts, ...parts, speed: speedRef.current, title: item.title, body: body() })
      }
      const hide = (event: Event) => {
        // Paused by the user: nothing to carry on. (iOS may already have interrupted the audio itself: that still counts.)
        if (run.current !== current || away.gone || away.held || player.received === 0) return
        if (event.type === "visibilitychange" && document.visibilityState === "visible") return
        away.gone = true
        player.pause()
        tell("away")
      }
      const show = () => {
        if (run.current !== current || !away.gone || document.visibilityState !== "visible") return
        away.gone = false
        void send<{ taken?: boolean }>({ type: "listenHandoff", op: "back", id: away.id }).then((r) => {
          if (run.current !== current) return
          if (r?.taken) {
            stop()
            setState({ at: "taken", key })
          } else {
            player.resume()
            away.last = 0
          }
        })
      }
      const visibility = (event: Event) => (document.visibilityState === "visible" ? show() : hide(event))
      document.addEventListener("visibilitychange", visibility)
      window.addEventListener("pagehide", hide)
      current.cleanup = () => {
        document.removeEventListener("visibilitychange", visibility)
        window.removeEventListener("pagehide", hide)
        void send({ type: "listenHandoff", op: "stop", id: away.id })
      }
      current.handoff = { parts: (p, complete) => { away.parts = p; away.complete = complete }, tick: () => {
        if (!away.gone && !away.held && player.received > 0 && document.visibilityState === "visible" && Date.now() - away.last > 4000) tell("state")
      }, paused: () => {
        away.held = true
        void send({ type: "listenHandoff", op: "stop", id: away.id })
      }, resumed: () => {
        away.held = false
        away.last = 0
      } }
    }

    function tick() {
      if (run.current !== current) return
      current.handoff?.tick()
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
      else if (message.type === "parts") current.handoff?.parts(message.parts, message.complete)
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
  }, [plan, platform, onUltra, send, stop, left, handOff, askNotify])

  const toggle = useCallback(() => {
    const current = run.current
    if (!current) return
    if (current.player.paused) {
      current.player.resume()
      current.handoff?.resumed()
    } else {
      // Paused: leaving the page then doesn't bring a notification.
      current.player.pause()
      current.handoff?.paused()
    }
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

  /** Without notifications: "Turn on notifications" opens the app (only it can ask), which then plays the text. */
  const notifyTurnOn = useCallback(() => {
    const s = stateRef.current
    if (s.at === "notify") handOff(s.key, s.item, speechParts(plainText(s.item)), "notifications")
  }, [handOff])

  /** "Not now": the app plays it, and Listen doesn't ask again until tomorrow. */
  const notifyNotNow = useCallback(() => {
    const s = stateRef.current
    if (s.at !== "notify") return
    notifyLater.current = true
    void listenNotifyLater()
    void send({ type: "useEvent", f: "listen", a: "notify_later", what: s.item.what })
    handOff(s.key, s.item, speechParts(plainText(s.item)), "listen")
  }, [handOff, send])

  return { state, start, stop, toggle, speed, cycleSpeed, left, anyway, notifyTurnOn, notifyNotNow }
}

/** What's read: an answer's words without its Markdown, or the page's text. */
function plainText(item: ListenWhat): string {
  return item.what === "answer" ? speechText(item.text) : item.text.replace(/\s+\n/g, "\n").trim()
}

function newId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/** The bar over the question field while something is read aloud (or why it isn't). */
export function ListenBar({ state, speed, left, onSpeed, onAnyway, onNotifyOn, onNotifyLater, onToggle, onStop, onPlans }: {
  state: ListenState
  speed: number
  // Seconds of listening left this week (null: not known).
  left?: number | null
  onSpeed: () => void
  onAnyway?: () => void
  // iPhone, iPad without notifications: turn them on (in the app), or not now.
  onNotifyOn?: () => void
  onNotifyLater?: () => void
  onToggle: () => void
  onStop: () => void
  onPlans: () => void
}): VNode | null {
  if (state.at === "idle") return null
  if (state.at === "handoff") return <div class="cf-listen" role="status"><SpeakerIcon /> <span class="cf-listen-text">{t("listenInApp")}</span></div>
  if (state.at === "notify") {
    return (
      <div class="cf-listen low" role="alert">
        <span class="cf-listen-text">{t("listenNotifyAsk")}</span>
        <button type="button" class="cf-link" onClick={onNotifyOn}>{t("listenNotifyOn")}</button>
        <button type="button" class="cf-link" onClick={onNotifyLater}>{t("listenNotifyLater")}</button>
        <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("close")}>×</button>
      </div>
    )
  }
  if (state.at === "taken") {
    return (
      <div class="cf-listen" role="status">
        <SpeakerIcon /> <span class="cf-listen-text">{t("listenTaken")}</span>
        <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("close")}>×</button>
      </div>
    )
  }
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
