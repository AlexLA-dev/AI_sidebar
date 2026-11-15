// The pill by the ✦ circle on a page in another language (2.7, plan section 11, the owner's decisions of 13–14
// November): «Перевести на русский?» with «Перевести» and ×. × hides it on this site. Once translated it becomes
// «Оригинал», which puts the page back. When the free answers of the day are used up it offers Pro. The first
// translation asks the one AI consent, as the first answer does (the page's text goes to the server, as for answers).
//
// Build 107 (the owner's test): the pill offers itself only when the page's main content is in another language
// (decide.ts judgeShares, by letters, not the page's first menus); a smaller part in another language, and the pill
// closed with ×, leave a small entry by the circle instead, which opens the pill (with «Greek: 12% of the page» for a
// part); a small control on the pill picks another language than the person's own, remembered per site.
//
// It sits beside the circle on the circle's side (left or right, plan section 9), at the circle's height. Never while
// the panel is open, while the selection's buttons show, while the person types, or in the first moment of a page.
// Page hints (plan section 6) use this pill on a page in another language instead of their own reply: they read
// pageTranslateOffer().

import type { VNode } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { baseLanguage, languageName } from "../translateTarget"
import { t, uiLang, uiLanguage } from "../../shared/i18n"
import { targetCode, type TranslateStep } from "../../shared/translate"
import { ConsentCard } from "../Consent"
import { giveConsent, loadConsent } from "../store"
import { judgeShares } from "./decide"
import { PageTranslator, type EngineState } from "./engine"
import { keepLanguage, keptLanguage, languageChoices, shortMark, targetName } from "./languages"
import { portAsk, storageCache } from "./port"
import { pageShares } from "./share"

const HIDDEN_KEY = "cf:trHidden"
const SITES_KEPT = 500

let engine: PageTranslator | null = null

/** One translator per page. */
export function pageTranslator(): PageTranslator {
  engine ??= new PageTranslator({ doc: document, url: () => location.href, ask: portAsk(), cache: storageCache })
  return engine
}

export interface PageOffer {
  // The page's language and the one it would be translated into (targetCode).
  from: string
  to: string
}

let offerNow: PageOffer | null = null
let foreignNow = false

/** The page is in another language and the pill offers to translate it (plan section 6 reads it). */
export function pageTranslateOffer(): PageOffer | null {
  return offerNow
}

/** The page is in another language, whether or not the pill is hidden on this site: page hints never show there. */
export function pageIsForeign(): boolean {
  return foreignNow
}

const site = () => location.hostname.replace(/^www\./, "")

async function hiddenHere(): Promise<boolean> {
  const list = (await chrome.storage.local.get(HIDDEN_KEY).catch(() => ({} as Record<string, unknown>)))[HIDDEN_KEY]
  return Array.isArray(list) && list.includes(site())
}

async function hideHere(): Promise<void> {
  const list = ((await chrome.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY] as string[] | undefined) ?? []
  await chrome.storage.local.set({ [HIDDEN_KEY]: [site(), ...list.filter((s) => s !== site())].slice(0, SITES_KEPT) })
}

const step = (a: TranslateStep["a"]) => {
  try {
    chrome.runtime.sendMessage({ type: "trEvent", a } satisfies TranslateStep, () => void chrome.runtime.lastError)
  } catch {
    // the extension was reloaded
  }
}

/** A smaller part of the page in another language: its language and its share of the page's words. */
export interface PagePart {
  lang: string
  share: number
}

interface Judgement {
  offer: PageOffer | null
  part: PagePart | null
}

/** The page's languages against the person's, by the letters of what it shows (share.ts, decide.ts). */
function judge(to: string): Judgement {
  if (!document.body) return { offer: null, part: null }
  const own = targetCode(uiLanguage())
  const shares = pageShares(document)
  const { from, part } = judgeShares(shares.main, shares.page, own, document.documentElement.lang || "")
  return { offer: from ? { from, to } : null, part }
}

interface Offered {
  offer: PageOffer | null
  part: PagePart | null
  // × was tapped on this site before: the pill waits behind the entry.
  hidden: boolean
  to: string
  setTo: (to: string) => void
  hide: () => void
}

/** When to look: once the page has loaded and settled, and again after a site that fills itself in late. */
function useOffer(): Offered {
  const own = targetCode(uiLanguage())
  const [judged, setJudged] = useState<Judgement>({ offer: null, part: null })
  const [hidden, setHidden] = useState(false)
  const [to, setToNow] = useState(own)
  const toRef = useRef(own)
  useEffect(() => {
    let alive = true
    let url = location.href
    const look = async () => {
      if (!alive) return
      const kept = await keptLanguage()
      if (kept && kept !== toRef.current) {
        toRef.current = kept
        setToNow(kept)
      }
      const found = judge(toRef.current)
      foreignNow = found.offer !== null
      const off = found.offer || found.part ? await hiddenHere() : false
      if (!alive) return
      setHidden(off)
      setJudged(found)
    }
    const timers = [1_500, 5_000].map((ms) => setTimeout(() => void look(), ms))
    // A site that changes its address itself (a new page without loading one).
    const poll = setInterval(() => {
      if (location.href === url) return
      url = location.href
      setTimeout(() => void look(), 1_500)
    }, 1_000)
    return () => {
      alive = false
      timers.forEach(clearTimeout)
      clearInterval(poll)
    }
  }, [])
  const offer = judged.offer ? { ...judged.offer, to } : null
  offerNow = hidden ? null : offer
  return {
    offer,
    part: judged.part,
    hidden,
    to,
    setTo: (code: string) => {
      toRef.current = code
      setToNow(code)
      void keepLanguage(code, own)
    },
    hide: () => setHidden(true)
  }
}

/** True while the person types in a field or an editor on the page. */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const editable = (el: EventTarget | null) => {
      const e = el as HTMLElement | null
      return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName ?? ""))
    }
    const on = (ev: FocusEvent) => setTyping(editable(ev.target))
    const off = () => setTyping(false)
    document.addEventListener("focusin", on, true)
    document.addEventListener("focusout", off, true)
    return () => {
      document.removeEventListener("focusin", on, true)
      document.removeEventListener("focusout", off, true)
    }
  }, [])
  return typing
}

function useEngine(): EngineState {
  const [state, setState] = useState<EngineState>(() => engine?.state() ?? { at: "off" })
  useEffect(() => pageTranslator().subscribe(setState), [])
  return state
}

const TranslateIcon = ({ size = 15 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
  </svg>
)
const Close = (): VNode => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

export interface TranslatePillProps {
  side: "left" | "right"
  // The circle's height on screen (its CSS top: "72%", "412px").
  top: string
  // The circle shows: the panel is closed, the circle isn't hidden here, no selection buttons.
  show: boolean
  free: boolean
  // Out of free answers: the plans sheet on Pro (the panel opens with it).
  onPlans: () => void
}

const Chevron = (): VNode => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
)

/** The language control: its short mark, and the system's own list to pick from (a tap opens it). */
function LanguagePick({ to, from, onPick }: { to: string; from: string | null; onPick: (code: string) => void }): VNode {
  const ui = uiLang()
  const choices = useMemo(() => languageChoices(targetCode(uiLanguage()), navigator.languages ?? [], ui, from), [from, ui])
  return (
    <label class="cf-tr-lang" title={targetName(to, ui)}>
      <span aria-hidden="true">{shortMark(to)}</span>
      <Chevron />
      <select aria-label={t("trLangPick")} value={to} onChange={(e) => onPick(e.currentTarget.value)}>
        {choices.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
    </label>
  )
}

export function TranslatePill({ side, top, show, free, onPlans }: TranslatePillProps): VNode | null {
  const { offer, part, hidden, to, setTo, hide } = useOffer()
  const typing = useTyping()
  const state = useEngine()
  const [consent, setConsent] = useState<"ok" | "old" | "none" | null>(null)
  const [closed, setClosed] = useState(false)
  // The entry by the circle was tapped: the pill shows until × (or the page is translated and put back).
  const [opened, setOpened] = useState(false)
  const tapped = useRef(false)
  const shownOnce = useRef(false)
  // The offer the person tapped (Try again uses it, whatever the page has done since).
  const asked = useRef<PageOffer | null>(null)
  const prev = useRef(state.at)

  // A translation asked for here came out: counted once per tap.
  useEffect(() => {
    if (tapped.current && prev.current === "working" && state.at === "on") step("done")
    if (state.at === "limit") step("limit")
    if (state.at === "error" && state.code !== "CONSENT") step("error")
    if (state.at === "error" && state.code === "CONSENT") setConsent("none")
    prev.current = state.at
  }, [state])

  // What the pill would translate: the main content's language, else the part's.
  const target: PageOffer | null = offer ?? (part ? { from: part.lang, to } : null)
  // The pill by itself only for a page in another language, not closed here; else the entry, which opens it.
  const pill = state.at !== "off" ? !closed : !closed && (opened || (!!offer && !hidden))
  const entry = !pill && (state.at !== "off" || target !== null)
  const visible = show && !(typing && state.at === "off") && (pill ? (target !== null || state.at !== "off") : entry)
  useEffect(() => {
    if (visible && pill && state.at === "off" && !shownOnce.current) {
      shownOnce.current = true
      step("shown")
    }
  }, [visible, pill, state.at])

  const label = useMemo(() => {
    if (!target) return ""
    // A smaller part of the page: which language and how much («Греческий: 12% страницы»).
    if (!offer && part) return t("trPart", targetName(part.lang, uiLang()), String(Math.max(1, Math.round(part.share * 100))))
    if (baseLanguage(target.to) === baseLanguage(uiLang())) return t("trOffer")
    // Mid-sentence, a language's name is a common noun in most of the panel's languages («на язык: английский»);
    // Safari's names may come capitalized. German, English and Turkish keep the capital («Almanca»; English is also the
    // interface for every language the panel doesn't speak: «Translate to Turkish?», 2.7, the director's audit).
    const name = languageName(target.to, uiLang())
    return t("trOfferTo", /^(de|en|ja|ko|zh|ar|tr)/.test(uiLang()) ? name : name.charAt(0).toLocaleLowerCase(uiLang()) + name.slice(1))
  }, [offer, part, target?.to])

  if (!visible && consent === null) return null

  const start = (goal: PageOffer) => void pageTranslator().start(goal.to, goal.from)
  const go = async () => {
    const goal = target ?? asked.current
    if (!goal) return
    asked.current = goal
    tapped.current = true
    step("tap")
    const status = await loadConsent()
    if (status !== "ok") {
      setConsent(status)
      step("consent")
      return
    }
    start(goal)
  }
  const accept = async () => {
    await giveConsent()
    setConsent(null)
    const goal = asked.current ?? target
    if (goal) start(goal)
  }
  const original = () => {
    step("original")
    pageTranslator().original()
  }
  const dismiss = () => {
    step("dismiss")
    setClosed(true)
    setOpened(false)
    hide()
    void hideHere()
  }
  const open = () => {
    step("entry")
    setClosed(false)
    setOpened(true)
  }
  // Another language: remembered here; a translated page is translated again into it (a new translation).
  const pick = (code: string) => {
    if (code === to) return
    step("lang")
    setTo(code)
    const from = asked.current?.from ?? target?.from ?? null
    if (state.at !== "off" && from) {
      pageTranslator().original()
      asked.current = { from, to: code }
      start({ from, to: code })
    }
  }

  const style = { top }
  const cls = `cf-tr ${side}`

  if (consent !== null && consent !== "ok") {
    // Above the circle when it's in the lower half of the screen, below it otherwise.
    const at = Number.parseFloat(top)
    const low = top.endsWith("%") ? at >= 50 : at >= window.innerHeight / 2
    return (
      <div class={`cf-tr-consent ${side}${low ? "" : " below"}`} style={style}>
        <ConsentCard again={consent === "old"} onAccept={() => void accept()} onDecline={() => setConsent(null)} />
      </div>
    )
  }

  if (!pill) {
    // The way back to the translation on the page itself: a small button by the circle, only where there's something
    // to translate (or a translation to put back).
    const said = state.at !== "off" ? t("trOriginal") : label || t("trEntry")
    return (
      <button type="button" class={`cf-tr-entry ${side}${state.at !== "off" ? " on" : ""}`} style={style} aria-label={said} title={said} onClick={open}>
        <TranslateIcon size={16} />
      </button>
    )
  }

  const x = (
    <button type="button" class="cf-tr-x" aria-label={t("trHide")} title={t("trHide")} onClick={dismiss}><Close /></button>
  )
  const lang = <LanguagePick to={asked.current && state.at !== "off" ? asked.current.to : to} from={target?.from ?? asked.current?.from ?? null} onPick={pick} />

  if (state.at === "working") {
    return (
      <div class={cls} style={style} role="status">
        <span class="cf-tr-spin" aria-hidden="true" />
        <span class="cf-tr-label">{t("trWorking")}</span>
        <button type="button" class="cf-tr-btn quiet" onClick={original}>{t("trOriginal")}</button>
      </div>
    )
  }
  if (state.at === "on") {
    return (
      <div class={cls} style={style}>
        <button type="button" class="cf-tr-btn quiet" onClick={original}><TranslateIcon size={14} /> {t("trOriginal")}</button>
        {lang}
        {x}
      </div>
    )
  }
  if (state.at === "limit") {
    return (
      <div class={cls} style={style} role="status">
        <span class="cf-tr-label">{t(free ? "limitFreeTitle" : "limitProTitle")}</span>
        {free && (
          <button type="button" class="cf-tr-btn" onClick={() => {
            step("plans")
            onPlans()
          }}>{t("tryPro")}</button>
        )}
        {x}
      </div>
    )
  }
  if (state.at === "error") {
    return (
      <div class={cls} style={style} role="status">
        <span class="cf-tr-label">{t("trFailed")}</span>
        <button type="button" class="cf-tr-btn" onClick={() => void go()}>{t("retry")}</button>
        {x}
      </div>
    )
  }
  return (
    <div class={cls} style={style}>
      <TranslateIcon />
      <span class="cf-tr-label">{label}</span>
      {lang}
      <button type="button" class="cf-tr-btn" onClick={() => void go()}>{t("actTranslate")}</button>
      {x}
    </div>
  )
}
