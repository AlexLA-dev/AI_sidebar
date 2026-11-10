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
import { voicedId } from "../../shared/voiced"
import { isTouch } from "../page"
import { listenBackNow, listenNotifyLater, listenNotifyLaterNow, listenSpeed, notifyKnown, setListenBack, setListenSpeed, setNotifyKnown } from "../store"
import { clock, PcmPlayer } from "./player"

export type ListenState =
  | { at: "idle" }
  | { at: "loading"; key: string }
  | { at: "playing" | "paused"; key: string; position: number; total: number; received?: number }
  | { at: "handoff"; key: string }
  // Build 95: the text too, for "Retry" (promised on 90: a break offers to try again, as the app's "Try again").
  | { at: "error"; key: string; code: string; usage?: Usage | null; item?: ListenWhat }
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

export function useListen({ platform, plan, speakLeft, onUltra, follow, send, panelOpen, reopen }: {
  platform: Platform
  plan: Plan
  // Seconds of this week's listening left (the status's), null when not known.
  speakLeft?: number | null
  // Without Ultra: what Ultra adds (the plans sheet on Ultra).
  onUltra: () => void
  // Opens a contextflow:// link from the page (iPhone and iPad).
  follow: (url: string) => void
  send: <T>(message: Record<string, unknown>) => Promise<T | null>
  // iPhone and iPad (build 93): whether the panel is open, and opening it again. A hand-off to the app is kept with it,
  // so coming back from the app ("Back to Safari") brings the panel back as it was.
  panelOpen?: () => boolean
  reopen?: () => void
}) {
  const panel = useRef({ panelOpen, reopen })
  panel.current = { panelOpen, reopen }
  const [state, setState] = useState<ListenState>({ at: "idle" })
  // What plays, for the bar (build 94, the owner: going from chat to chat, it should say what plays and from where).
  const [title, setTitle] = useState("")
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
    // The audio received when the next part was last asked for (build 92: asked for only when it runs short), and whether
    // a part is still coming (its pieces make what's in hand look short: no "more" until it has all come).
    more?: number
    fetching?: boolean
    // Seconds heard of each part (by index), the part being heard, and where the last tick was (build 92: the week's
    // minutes count what's heard).
    heard?: Record<number, number>
    heardPart?: number
    lastPos?: number
    // iPhone and iPad with notifications: leaving the page, coming back, and what the app is told meanwhile.
    cleanup?: () => void
    handoff?: { parts: (parts: string[], complete: boolean) => void; tick: () => void; paused: () => void; resumed: () => void; moved: () => void }
    // The clock (4 times a second) runs only while it plays (build 92: a paused player kept it going for good).
    clock?: (on: boolean) => void
    // What the bar shows now (the tick sets it only when it changes).
    shown?: { at: "playing" | "paused"; position: number; total: number; received: number }
    // Started without a tap (back from the app, build 93): WebKit keeps it silent until Play, and the clock waits too.
    waitTap?: boolean
    // Build 94: how far it has been heard, whether a part was skipped ahead (a seek past what was heard), and the text's
    // id: heard to its end with nothing skipped, it's "already voiced" (replaying costs no minutes).
    reached?: number
    skipped?: boolean
    voiced?: string
  } | null>(null)
  const speedRef = useRef<Speed>(1)
  speedRef.current = speed

  // iPhone and iPad: whether notifications are on for ContextFlow (asked again whenever the page comes back: the user
  // may have just turned them on), and whether "Not now" holds today.
  const notifyOn = useRef(false)
  const notifyLater = useRef(false)
  // Build 92: asked after Listen (and on coming back while the card asks to turn them on), not on every page and every
  // tab switch: each ask is a native message, which wakes the app's extension on iPhone and iPad. Listen itself decides
  // from the last answer (kept in the extension's storage, read without a native message): what it does has to happen
  // inside the tap (the link to the app, the sound), and an ask first would come after it (build 90's bug).
  const askNotify = useCallback(async () => {
    const [r, later] = await Promise.all([send<{ status?: string; later?: number }>({ type: "notifStatus" }), listenNotifyLaterNow()])
    notifyOn.current = ["authorized", "provisional", "ephemeral"].includes(r?.status ?? "")
    // "Not now" said in the app (build 95): not asked here again that day either.
    const appLater = typeof r?.later === "number" && r.later > Date.now()
    if (appLater && !later) void listenNotifyLater()
    notifyLater.current = later || appLater
    void setNotifyKnown(notifyOn.current)
  }, [send])
  useEffect(() => {
    if (!isTouch(platform)) return
    void Promise.all([notifyKnown(), listenNotifyLaterNow()]).then(([on, later]) => {
      notifyOn.current = on
      notifyLater.current = later
    })
  }, [platform])
  const asking = state.at === "notify"
  useEffect(() => {
    if (!isTouch(platform) || !asking) return
    const onVisible = () => { if (document.visibilityState === "visible") void askNotify() }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [platform, asking, askNotify])

  // A hand-off to the app (build 93): kept with the page and whether the panel was open, so coming back from the app
  // brings the panel back as it was; `play`: after "Turn on notifications", the text plays here once they're on.
  const noteBack = useCallback((id: string, key: string, item: ListenWhat, play: boolean) => {
    if (!isTouch(platform)) return
    void setListenBack({ id, url: item.url, panel: panel.current.panelOpen?.() ?? false, at: Date.now(), key, title: item.title, ...(play ? { item } : {}) })
  }, [platform])
  // The player "Turn on notifications" unlocked in its tap: the text plays with it on coming back, if this page is
  // still the one (WebKit starts a page's sound only from a tap).
  const unlocked = useRef<PcmPlayer | null>(null)

  const stop = useCallback(() => {
    const current = run.current
    run.current = null
    if (current) {
      current.cleanup?.()
      clearInterval(current.timer)
      try {
        // What was heard of each part, then the stop (the background sends it to the server).
        if (current.heard) current.port.postMessage({ type: "heard", heard: { ...current.heard } } satisfies SpeakIn)
        current.port.postMessage({ type: "stop", heard: current.player.position } satisfies SpeakIn)
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
    setTitle(item.title)
    setState({ at: "handoff", key })
    // Kept for coming back (build 93): the panel as it was, and after "Turn on notifications", the text to play here.
    noteBack(id, key, item, to === "notifications")
    follow(to === "listen" ? `contextflow://listen?id=${encodeURIComponent(id)}` : `contextflow://notifications?listen=${encodeURIComponent(id)}`)
    void send({ type: "useEvent", f: "listen", a: to === "listen" ? "app" : "notify_on", what: item.what })
    // The app writes it for the ear itself (as the background does here); the parts are its way when it can't.
    const script = item.what === "page" || needsScript(item.text)
    void send({ type: "listenInApp", id, parts, text: item.text.slice(0, 24_000), script, lang: item.lang, what: item.what, title: item.title, url: item.url })
    setTimeout(() => {
      handing.current = 0
      setState((s) => (s.at === "handoff" && s.key === key ? { at: "idle" } : s))
    }, 6000)
  }, [follow, send, noteBack])

  /** `back`: started on coming back from the app after turning notifications on (build 93), not from a tap here: with
   *  the player an earlier tap unlocked, if this page still has it. */
  const start = useCallback(async (key: string, item: ListenWhat, anyway = false, back?: { player: PcmPlayer | null }) => {
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
    // Decided now, in the tap, from the last answer; the answer is refreshed for next time.
    if (isTouch(platform)) void askNotify()
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
    // In the tap itself, before anything is awaited: WebKit lets a page's sound start only from the tap (the speed is
    // already known; build 92 read it from storage first).
    const given = back?.player ?? null
    const player = given ?? new PcmPlayer(speedRef.current)
    if (given && given.speed !== speedRef.current) given.setSpeed(speedRef.current)
    await player.unlock()
    const port = chrome.runtime.connect({ name: "speak" })
    const total = speechSeconds(text)
    // The first part is asked for at once (it's coming until its end).
    const current: NonNullable<typeof run.current> = { port, player, ended: false, key, total, told: -1, timer: setInterval(() => tick(), 250), fetching: true, waitTap: Boolean(back), voiced: voicedId(item.what, item.text) }
    current.clock = (on) => {
      clearInterval(current.timer)
      if (on) current.timer = setInterval(() => tick(), 250)
    }
    run.current = current
    setTitle(item.title)
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
        void send({ type: "listenHandoff", op, id: away.id, at: player.position, starts: player.starts, ...parts, speed: speedRef.current, title: item.title, body: body(), ...(current.skipped ? { skipped: true } : {}) })
      }
      const hide = (event: Event) => {
        // Paused by the user: nothing to carry on. (iOS may already have interrupted the audio itself: that still counts.)
        if (run.current !== current || away.gone || away.held || current.waitTap || player.received === 0) return
        if (event.type === "visibilitychange" && document.visibilityState === "visible") return
        away.gone = true
        // Kept for coming back from the app (build 93): "Back to Safari" there opens the panel again if it was open.
        noteBack(away.id, key, item, false)
        player.pause()
        current.clock?.(false)
        // What was heard here so far (the app counts what it plays from this second).
        if (current.heard) port.postMessage({ type: "heard", heard: { ...current.heard } } satisfies SpeakIn)
        // The clock is off: the bar is told itself (it showed Pause while the page was away), and the next tick after
        // coming back tells it again (build 94: it kept showing Play until the clock had moved).
        setState((s) => (s.at === "playing" ? { ...s, at: "paused" } : s))
        current.shown = undefined
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
            current.clock?.(true)
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
      // The app is told on events only (build 92, energy: it was every 4 s while playing): the first sound, the parts as
      // they're written, pause and play, a seek; leaving the page sends the second it was at.
      const told = () => player.received > 0 && !away.gone && !away.held
      current.handoff = {
        parts: (p, complete) => {
          away.parts = p
          away.complete = complete
          if (told()) tell("state")
        },
        tick: () => {
          if (away.last === 0 && told()) tell("state")
        },
        paused: () => {
          away.held = true
          void send({ type: "listenHandoff", op: "stop", id: away.id })
        },
        resumed: () => {
          away.held = false
          away.last = 0
        },
        moved: () => {
          if (told()) tell("state")
        }
      }
    }

    function tick() {
      if (run.current !== current) return
      current.handoff?.tick()
      // Heard, part by part: the position moving on by about a tick's worth while it plays (a seek or a wait isn't).
      const pos = player.position
      const moved = pos - (current.lastPos ?? 0)
      current.lastPos = pos
      if (!player.paused && moved > 0 && moved <= 1.5 && player.received > 0) {
        current.reached = Math.max(current.reached ?? 0, pos)
        const heardPart = Math.max(0, player.part)
        current.heard = current.heard ?? {}
        current.heard[heardPart] = (current.heard[heardPart] ?? 0) + moved
        // A part heard to its end (the next one began): told now, so it counts even if the page goes.
        if (current.heardPart !== undefined && current.heardPart !== heardPart) port.postMessage({ type: "heard", heard: { ...current.heard } } satisfies SpeakIn)
        current.heardPart = heardPart
      }
      const part = player.part
      if (part > current.told) {
        current.told = part
        port.postMessage({ type: "playing", part } satisfies SpeakIn)
      }
      // The next part is asked for only when what's in hand runs short (about 8 s of listening left, at any speed): a
      // text stopped early never costs minutes for parts nobody heard (build 92).
      if (!current.ended && !current.fetching && !player.paused && player.received > 0 && player.received !== current.more
        && (player.received - player.position) < 8 * speedRef.current + 4) {
        current.more = player.received
        current.fetching = true
        port.postMessage({ type: "more" } satisfies SpeakIn)
      }
      if (current.ended && player.drained && player.received > 0) {
        // Heard to its end with nothing skipped (build 94): Listen shows it's voiced, here and in the app on this device.
        // Not marked: why, for the record (build 95: the owner saw no mark on 94).
        const gap = Math.max(0, player.received - (current.reached ?? 0))
        if (!current.skipped && current.voiced && gap <= 1.5) {
          void send({ type: "listenVoiced", id: current.voiced })
          step("voiced")
        } else {
          void send({ type: "useEvent", f: "listen", a: "unvoiced", what: item.what, why: current.skipped ? "skipped" : "short", gap_s: Math.round(gap) })
        }
        stop()
        return
      }
      if (player.received === 0) return
      // Waiting for more audio shows as loading only before the first sound. The bar moves by half seconds, and nothing
      // is set when nothing moved (build 92: paused, handed to the app or waiting, it re-drew the whole panel 4 times a
      // second, for as long as the bar stayed). What has come is shown too (the bar seeks within it).
      const at = player.paused ? "paused" : "playing"
      const position = Math.floor(player.position * 2) / 2
      const total = Math.max(current.total, player.received)
      const received = player.received
      const shown = current.shown
      if (shown && shown.at === at && shown.position === position && shown.total === total && shown.received === received) {
        // Silent without a tap (back from the app, build 93: WebKit starts a page's sound only from one): the clock waits
        // for Play instead of running.
        if (at === "paused" && current.waitTap) current.clock?.(false)
        return
      }
      current.shown = { at, position, total, received }
      setState({ at, key, position, total, received })
    }

    port.onMessage.addListener((raw: unknown) => {
      if (run.current !== current) return
      const message = raw as SpeakOut
      if (message.type === "usage" && message.usage) setLeft(Math.max(0, message.usage.limit - message.usage.used))
      else if (message.type === "chunk") player.push(message.part, message.data)
      else if (message.type === "aac") player.pushAac(message.part, message.data)
      else if (message.type === "parts") current.handoff?.parts(message.parts, message.complete)
      else if (message.type === "partEnd") current.fetching = false
      else if (message.type === "end") {
        current.ended = true
        player.end()
      }
      else if (message.type === "error") {
        // A part that failed after others played: what was heard stays heard, the rest stops. Nothing of it is left
        // running (build 95: the page's listeners stayed, and the app wasn't told it stopped).
        clearInterval(current.timer)
        player.stop()
        current.cleanup?.()
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
          setState({ at: "error", key, code: message.code, usage: message.usage ?? null, item })
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
      current.waitTap = false
      current.clock?.(true)
      current.handoff?.resumed()
    } else {
      // Paused: leaving the page then doesn't bring a notification, and nothing runs meanwhile.
      current.player.pause()
      current.clock?.(false)
      setState((s) => (s.at === "playing" ? { ...s, at: "paused" } : s))
      current.shown = undefined
      current.handoff?.paused()
    }
  }, [])

  /** The bar dragged or tapped (build 92): from that second, within what has come; the app is told where it is. */
  const seek = useCallback((seconds: number) => {
    const current = run.current
    if (!current) return
    current.player.seek(seconds)
    // A seek isn't heard; past what was heard, the text isn't heard to its end this time (build 94).
    current.lastPos = current.player.position
    if (current.player.position > (current.reached ?? 0) + 1) current.skipped = true
    current.handoff?.moved()
    const position = current.player.position
    setState((s) => (s.at === "playing" || s.at === "paused" ? { ...s, position } : s))
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

  /** After a break: the same text again, from its start (what was heard of it plays from this device, and isn't
   *  counted again). In the tap itself, as Listen. */
  const retry = useCallback(() => {
    const s = stateRef.current
    if (s.at !== "error" || !s.item) return
    void send({ type: "useEvent", f: "listen", a: "retry", what: s.item.what })
    void start(s.key, s.item)
  }, [start, send])

  /** Without notifications: "Turn on notifications" opens the app (only it can ask), which then plays the text. */
  const notifyTurnOn = useCallback(() => {
    const s = stateRef.current
    if (s.at !== "notify") return
    // Unlocked in this tap, for playing here once they're on (build 93).
    unlocked.current?.stop()
    unlocked.current = new PcmPlayer(speedRef.current)
    void unlocked.current.unlock()
    handOff(s.key, s.item, speechParts(plainText(s.item)), "notifications")
  }, [handOff])

  // Back on the page after a hand-off (build 93), on load or when the page shows again: if the app sent the person back
  // ("Back to Safari"), the panel opens again if it was open; after notifications were turned on there, the text plays
  // here (Play, if WebKit wants a tap); if the app plays it, the bar says so. One native message, only when a hand-off
  // from this page is on record.
  const startRef = useRef(start)
  startRef.current = start
  const checkReturn = useCallback(async () => {
    const back = await listenBackNow()
    if (!back) return
    if (Date.now() - back.at > 12 * 3_600_000) return void setListenBack(null)
    if (samePage(back.url, location.href) === false) return
    // Back from the app's question about notifications: what was answered there decides the next Listen (build 95:
    // after "Not now" there, the panel asked again the same day).
    if (back.item) void askNotify()
    const r = await send<{ back?: boolean; play?: boolean; taken?: boolean }>({ type: "listenReturn", id: back.id })
    // Back without the app's word (◀ Safari): what was on record goes, except while the app may still be asking about
    // notifications (ten minutes): its word to play it here can come after.
    if (!r?.back) {
      if (back.item && Date.now() - back.at < 600_000) return
      unlocked.current?.stop()
      unlocked.current = null
      return void setListenBack(null)
    }
    await setListenBack(null)
    const player = unlocked.current
    unlocked.current = null
    if (back.panel && !panel.current.panelOpen?.()) panel.current.reopen?.()
    if (r.play && back.item && back.key) {
      // Notifications are on now: it plays here.
      await askNotify()
      void send({ type: "useEvent", f: "listen", a: "back_play", what: back.item.what })
      void startRef.current(back.key, back.item, false, { player })
      return
    }
    player?.stop()
    if (r.taken) {
      if (back.title) setTitle(back.title)
      setState((s) => (s.at === "idle" || s.at === "handoff" ? { at: "taken", key: back.key ?? "" } : s))
    }
  }, [send, askNotify])
  const checkRef = useRef(checkReturn)
  checkRef.current = checkReturn
  useEffect(() => {
    if (!isTouch(platform)) return
    void checkRef.current()
    const onVisible = () => { if (document.visibilityState === "visible") void checkRef.current() }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [platform])

  /** "Not now": the app plays it, and Listen doesn't ask again until tomorrow. */
  const notifyNotNow = useCallback(() => {
    const s = stateRef.current
    if (s.at !== "notify") return
    notifyLater.current = true
    void listenNotifyLater()
    void send({ type: "useEvent", f: "listen", a: "notify_later", what: s.item.what })
    handOff(s.key, s.item, speechParts(plainText(s.item)), "listen")
  }, [handOff, send])

  return { state, title, start, stop, toggle, seek, speed, cycleSpeed, left, anyway, retry, notifyTurnOn, notifyNotNow }
}

/** What's read: an answer's words without its Markdown, or the page's text. */
function plainText(item: ListenWhat): string {
  return item.what === "answer" ? speechText(item.text) : item.text.replace(/\s+\n/g, "\n").trim()
}

/** The same page, its #fragment aside (the app opens the address the panel gave it). */
function samePage(a: string, b: string): boolean {
  return a.split("#")[0] === b.split("#")[0]
}

function newId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/** The bar over the question field while something is read aloud (or why it isn't). */
export function ListenBar({ state, title, onTitle, speed, left, onSpeed, onAnyway, onRetry, onNotifyOn, onNotifyLater, onToggle, onSeek, onStop, onPlans }: {
  state: ListenState
  // What plays (build 94), and a tap on it: back to the chat and the message it's from.
  title?: string
  onTitle?: () => void
  speed: number
  // Seconds of listening left this week (null: not known).
  left?: number | null
  onSpeed: () => void
  onAnyway?: () => void
  // After a break (build 95): the same text again.
  onRetry?: () => void
  // iPhone, iPad without notifications: turn them on (in the app), or not now.
  onNotifyOn?: () => void
  onNotifyLater?: () => void
  onToggle: () => void
  // The bar dragged or tapped: from that second (build 92).
  onSeek?: (seconds: number) => void
  onStop: () => void
  onPlans: () => void
}): VNode | null {
  if (state.at === "idle") return null
  const name = title ? (
    onTitle
      ? <button type="button" class="cf-listen-name" onClick={onTitle} title={t("listenGoTo")}>{title}</button>
      : <span class="cf-listen-name">{title}</span>
  ) : null
  if (state.at === "handoff") return <div class="cf-listen" role="status">{name}<SpeakerIcon /> <span class="cf-listen-text">{t("listenInApp")}</span></div>
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
        {name}
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
        {state.code !== "LIMIT_REACHED" && state.item && onRetry && <button type="button" class="cf-link cf-listen-retry" onClick={onRetry}>{t("retry")}</button>}
        <button type="button" class="cf-icon-btn" onClick={onStop} aria-label={t("close")}>×</button>
      </div>
    )
  }
  const loading = state.at === "loading"
  return (
    <div class="cf-listen" role="group" aria-label={t("listen")}>
      {name}
      <button type="button" class="cf-listen-play" disabled={loading} onClick={onToggle} aria-label={state.at === "playing" ? t("listenPause") : t("listenPlay")}>
        {state.at === "playing" ? <PauseIcon /> : <PlayIcon />}
      </button>
      {loading ? (
        <span class="cf-listen-text">{t("listenLoading")}</span>
      ) : (
        <>
          <span class="cf-listen-time">{clock(state.position)} / {clock(state.total)}</span>
          <SeekBar position={state.position} total={state.total} received={state.received ?? state.total} onSeek={onSeek} />
        </>
      )}
      {typeof left === "number" && !loading && <span class="cf-listen-left" title={t("listenMinLeftTitle", String(Math.floor(left / 60)))}>{t("listenMinLeft", String(Math.floor(left / 60)))}</span>}
      <button type="button" class="cf-listen-speed" onClick={onSpeed} aria-label={t("listenSpeed", speedLabel(speed))} title={t("listenSpeed", speedLabel(speed))}>{speedLabel(speed)}</button>
      {/* Build 93: one control that stops and closes, said so (a square read as "stop" and then the bar went). */}
      <button type="button" class="cf-icon-btn cf-listen-close" onClick={onStop} aria-label={t("listenClose")} title={t("listenClose")}>×</button>
    </div>
  )
}

/** The progress bar, dragged or tapped with a finger, a mouse or a trackpad, or moved with the arrow keys (±5 s): from
 *  that second, within what has come (the rest isn't made yet). While dragging it shows where it would go; letting go
 *  moves there once. */
function SeekBar({ position, total, received, onSeek }: { position: number; total: number; received: number; onSeek?: (seconds: number) => void }): VNode {
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const span = Math.max(1, total)
  const at = (clientX: number) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return position
    return Math.max(0, Math.min(received, ((clientX - box.left) / box.width) * span))
  }
  const shown = dragging ?? position
  return (
    <div
      ref={track}
      class={`cf-listen-track seek ${dragging !== null ? "dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label={t("listenSeek")}
      aria-valuemin={0}
      aria-valuemax={Math.round(span)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={clock(position)}
      onPointerDown={(e) => {
        if (!onSeek) return
        e.preventDefault()
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        setDragging(at(e.clientX))
      }}
      onPointerMove={(e) => {
        if (dragging !== null) setDragging(at(e.clientX))
      }}
      onPointerUp={(e) => {
        if (dragging === null) return
        const to = at(e.clientX)
        setDragging(null)
        onSeek?.(to)
      }}
      onPointerCancel={() => setDragging(null)}
      onKeyDown={(e) => {
        if (!onSeek || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return
        e.preventDefault()
        onSeek(Math.max(0, Math.min(received, position + (e.key === "ArrowRight" ? 5 : -5))))
      }}
    >
      <div class="cf-listen-buffered" style={{ width: `${Math.min(100, (received / span) * 100)}%` }} />
      <div class="cf-listen-done" style={{ width: `${Math.min(100, (shown / span) * 100)}%` }} />
      <span class="cf-listen-thumb" style={{ left: `${Math.min(100, (shown / span) * 100)}%` }} />
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

/** Build 94: by Listen when the text was heard to its end here (replaying costs no minutes): a small, quiet check. */
export function VoicedIcon(): VNode {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="m8 12.5 2.8 2.7L16.2 9.6" />
    </svg>
  )
}

function PlayIcon(): VNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
}

function PauseIcon(): VNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>
}

