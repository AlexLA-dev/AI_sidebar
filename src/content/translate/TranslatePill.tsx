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
// Build 109 (the owner's test of 108): while anything is being translated (the page, then a pop-up, an opened menu,
// what a view loads later) the pill's contour shimmers; after the first translation on a site comes out the pill
// asks once whether to translate every page of it (autoSites.ts), and its site button turns that off again.
//
// It sits beside the circle on the circle's side (left or right, plan section 9), at the circle's height. Never while
// the panel is open, while the selection's buttons show, while the person types, or in the first moment of a page.
// Page hints (plan section 6) use this pill on a page in another language instead of their own reply: they read
// pageTranslateOffer().

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"

import { baseLanguage, languageName } from "../translateTarget"
import { t, uiLang, uiLanguage } from "../../shared/i18n"
import { type TranslateStep } from "../../shared/translate"
import { readerLanguage } from "../answerLanguage"
import { ConsentCard } from "../Consent"
import { giveConsent, loadConsent } from "../store"
import { urlKey } from "../../shared/conversation"
import { askOnce, autoOn, clearAuto, limitedToday, LIMIT_KEY, setAuto, type AutoSite } from "./autoSites"
import { judgeControls, judgeShares, type ControlsJudged } from "./decide"
import { PageTranslator, type EngineState } from "./engine"
import { keepLanguage, keptLanguage, languageChoices, shortMark, targetName } from "./languages"
import { hiddenOn, hideOn, showOn, tellsAt, TOLD_KEY, type SiteStore } from "./hiddenSites"
import { coversPageControl } from "./pageControls"
import { portAsk, storageCache } from "./port"
import { controlLabels, pageShares, type Shares } from "./share"

/** The reader's own language, as a target: from the languages they read, never the region of the device's locale
 *  (answerLanguage.ts readerLanguage). */
const ownLanguage = () => readerLanguage(navigator, uiLanguage(), uiLang())


let engine: PageTranslator | null = null

/** One translator per page. */
export function pageTranslator(): PageTranslator {
  engine ??= new PageTranslator({ doc: document, url: () => location.href, site: () => site(), ask: portAsk(), cache: storageCache })
  return engine
}

export interface PageOffer {
  // The page's language and the one it would be translated into (targetCode).
  from: string
  to: string
  // Only the page's controls (buttons, menus, labels): its words are in the reader's language.
  only?: "controls"
}

let offerNow: PageOffer | null = null
let foreignNow = false
// The page's own offer, hidden on this site or not, and the pill's way to start it: the panel's «Translate page» chip
// (2.7, quiet/signals.ts) reads the first and calls the second.
let foundNow: PageOffer | null = null
let starter: ((offer: PageOffer) => void) | null = null

/** The page is in another language and the pill offers to translate it (plan section 6 reads it). */
export function pageTranslateOffer(): PageOffer | null {
  return offerNow
}

/** The page is in another language, whether or not the pill is hidden on this site: page hints never show there. */
export function pageIsForeign(): boolean {
  return foreignNow
}

/** The page is translated now (or being translated): the panel's «Translate page» chip has nothing to offer. */
export function pageTranslatedNow(): boolean {
  return engine !== null && engine.state().at !== "off"
}

/** What the page would be translated from and into, whether or not the pill is hidden on this site. */
export function pageForeignOffer(): PageOffer | null {
  return foundNow
}

/** Starts the page's translation as the pill's own «Translate» does (the consent, the limit, «Original» after it); the
 *  pill comes back for it on a site it was hidden on. False when there's nothing to translate or no pill here. */
export function translatePageNow(): boolean {
  if (!foundNow || !starter) return false
  starter(foundNow)
  return true
}

const site = () => location.hostname.replace(/^www\./, "")

// The sites the offer was dismissed on (hiddenSites.ts): × hides it on the site, a translation started by hand there
// brings it back.
const sites: SiteStore = {
  get: (key) => chrome.storage.local.get(key).catch(() => ({} as Record<string, unknown>)),
  set: (items) => chrome.storage.local.set(items)
}
const hiddenHere = () => hiddenOn(sites, site())
const hideHere = () => hideOn(sites, site()).catch(() => false)
const showHere = () => showOn(sites, site()).catch(() => false)
// The sites translated whole (autoSites.ts).
const autoHere = () => autoOn(sites, site()).catch(() => null)

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
  // The page's controls are in another language while its words aren't (judged on their own, whatever their share).
  controls: ControlsJudged | null
  // The language most of the page is in (the reader's own, usually): what a translation asked for by hand goes from.
  pageLang: string | null
}

const NOTHING: Judgement = { offer: null, part: null, controls: null, pageLang: null }

const mostOf = (s: Shares): string | null => {
  let best: string | null = null
  let most = 0
  for (const [lang, n] of s.langs) {
    if (lang !== "?" && n > most) {
      most = n
      best = lang
    }
  }
  return best
}

/** The page's languages against the person's: its main content and its parts by the letters of what it shows
 *  (share.ts, decide.ts judgeShares), its controls on their own (judgeControls). */
function judge(to: string): Judgement {
  if (!document.body) return NOTHING
  const own = ownLanguage()
  const markup = document.documentElement.lang || ""
  const shares = pageShares(document)
  const { from, part } = judgeShares(shares.main, shares.page, own, markup)
  // One thing at a time: a page in another language is offered as a whole, its controls with it.
  const controls = from ? null : judgeControls(controlLabels(document), own, markup)
  return { offer: from ? { from, to } : null, part, controls, pageLang: mostOf(shares.main) ?? mostOf(shares.page) }
}

interface Offered {
  offer: PageOffer | null
  part: PagePart | null
  controls: ControlsJudged | null
  pageLang: string | null
  // × was tapped on this site before: the pill waits behind the entry.
  hidden: boolean
  // The site is translated whole (the person said yes to the pill's question): its pages start by themselves.
  auto: AutoSite | null
  setAuto: (auto: AutoSite | null) => void
  // The page was looked at (the first time takes a moment after it loads).
  looked: number
  to: string
  setTo: (to: string) => void
  hide: () => void
  unhide: () => void
}

/** When to look: once the page has loaded and settled, and again after a site that fills itself in late. */
function useOffer(): Offered {
  const own = ownLanguage()
  const [judged, setJudged] = useState<Judgement>(NOTHING)
  const [hidden, setHidden] = useState(false)
  const [auto, setAutoNow] = useState<AutoSite | null>(null)
  const [looked, setLooked] = useState(0)
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
      // The pill has something to say by itself (the page, or its controls): page hints keep quiet (one thing at a time).
      foreignNow = found.offer !== null || found.controls?.offer === true
      foundNow = found.offer
      const [off, whole] = found.offer || found.part || found.controls ? await Promise.all([hiddenHere(), autoHere()]) : [false, null]
      if (!alive) return
      setHidden(off)
      setAutoNow(whole)
      setJudged(found)
      setLooked((n) => n + 1)
    }
    const timers = [1_500, 5_000].map((ms) => setTimeout(() => void look(), ms))
    // A site translated whole: looked at sooner, so its page doesn't stand in its own language for long.
    void autoHere().then((whole) => {
      if (whole && alive) timers.push(setTimeout(() => void look(), document.readyState === "loading" ? 600 : 250))
    })
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
    controls: judged.controls,
    pageLang: judged.pageLang,
    hidden,
    auto,
    setAuto: setAutoNow,
    looked,
    to,
    setTo: (code: string) => {
      toRef.current = code
      setToNow(code)
      void keepLanguage(code, own)
    },
    hide: () => setHidden(true),
    unhide: () => setHidden(false)
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
/** The whole site (a globe). */
const SiteIcon = (): VNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.300 6.400-3.900 9c-2.600-2.600-3.900-5.600-3.900-9S9.400 5.600 12 3z" />
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
  // Counts the times the circle was held down: each opens the pill by hand, on any page (build 107).
  held?: number
}

const Chevron = (): VNode => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
)

/** The language control: its short mark, and the system's own list to pick from (a tap opens it). */
function LanguagePick({ to, from, onPick }: { to: string; from: string | null; onPick: (code: string) => void }): VNode {
  const ui = uiLang()
  const choices = useMemo(() => languageChoices(ownLanguage(), navigator.languages ?? [], ui, from), [from, ui])
  return (
    <label class="cf-tr-lang" title={targetName(to, ui)}>
      <span aria-hidden="true">{shortMark(to)}</span>
      <Chevron />
      <select aria-label={t("trLangPick")} value={to} onChange={(e) => onPick(e.currentTarget.value)}>
        {/* The page's own language isn't in the list; when it's the target still (a page in the reader's language,
            asked by hand), it stands as picked until another is chosen. */}
        {!choices.some((c) => c.code === to) && <option value={to} disabled>{targetName(to, ui)}</option>}
        {choices.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
    </label>
  )
}

export function TranslatePill({ side, top, show, free, onPlans, held = 0 }: TranslatePillProps): VNode | null {
  const { offer, part, controls, pageLang, hidden, auto, setAuto: setAutoSite, looked, to, setTo, hide, unhide } = useOffer()
  const typing = useTyping()
  const state = useEngine()
  const [consent, setConsent] = useState<"ok" | "old" | "none" | null>(null)
  const [closed, setClosed] = useState(false)
  // Right after ×: where the offer went, said in its place for a moment on the install's first dismissals, then the
  // pill folds into the entry by the circle (2.7, 108: × said «Hide on this site» only in a title a finger never sees).
  const [folding, setFolding] = useState<"told" | "fold" | null>(null)
  // Whether the next × gets the line, known before it's tapped (so the pill turns into the right thing at once).
  const tells = useRef(false)
  // What folds: the line, or (after the first dismissals) the offer's own words.
  const foldsTold = useRef(false)
  useEffect(() => {
    void sites.get(TOLD_KEY).then((got) => {
      tells.current = tellsAt(got[TOLD_KEY])
    })
  }, [])
  useEffect(() => {
    if (!folding) return
    const timer = setTimeout(() => setFolding(folding === "told" ? "fold" : null), folding === "told" ? TOLD_MS : FOLD_MS)
    return () => clearTimeout(timer)
  }, [folding])
  // The entry by the circle was tapped: the pill shows until × (or the page is translated and put back).
  const [opened, setOpened] = useState(false)
  const tapped = useRef(false)
  const shownOnce = useRef(false)
  // The offer the person tapped (Try again uses it, whatever the page has done since).
  const asked = useRef<PageOffer | null>(null)
  const prev = useRef(state.at)

  // A translation asked for here came out: counted once per tap. On a site the offer was hidden on, it comes by itself
  // again from now on (2.7, 108, the owner: × is often «not now»). Only one that came out counts: not the consent
  // declined, nor the day's limit, nor the pill opened and closed.
  useEffect(() => {
    if (tapped.current && prev.current === "working" && state.at === "on") {
      step("done")
      void showHere().then((was) => was && unhide())
      cameOut.current = true
    }
    if (state.at === "limit") step("limit")
    if (state.at === "error" && state.code !== "CONSENT") step("error")
    if (state.at === "error" && state.code === "CONSENT") setConsent("none")
    prev.current = state.at
  }, [state])

  // The site's row in the pill: the question after the first translation here («ask»), or what the site button
  // opens: the same question, or the way to turn it off on a site translated whole («manage»).
  const [siteRow, setSiteRow] = useState<"ask" | "manage" | null>(null)
  // A translation asked for here came out and the site isn't translated whole: asked once per site, a moment after
  // the page shows in the reader's language.
  const cameOut = useRef(false)
  useEffect(() => {
    if (state.at !== "on" || !cameOut.current || auto) return
    cameOut.current = false
    let alive = true
    const timer = setTimeout(() => {
      // Marked as asked only when it's about to show (a page left before that is asked on the next one).
      if (pageTranslator().state().at !== "on") return
      void askOnce(sites, site()).then((ask) => {
        if (!ask || !alive) return
        step("site_ask")
        setClosed(false)
        setSiteRow("ask")
      }, () => undefined)
    }, SITE_ASK_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [state.at, auto])
  useEffect(() => {
    if (state.at === "off") setSiteRow(null)
  }, [state.at])

  // A page of a site translated whole: started by itself, once per address (after «Original» it stays as it is).
  // Not when the day's answers ran out on such a page today (the person was told then): the offer comes as usual.
  const autoTried = useRef("")
  useEffect(() => {
    if (!auto || !looked || state.at !== "off") return
    const here = urlKey(location.href)
    if (autoTried.current === here) return
    const goal: PageOffer | null =
      offer && auto.only !== "controls" ? { from: offer.from, to: auto.to }
        : controls?.offer ? { from: controls.lang, to: auto.to, only: "controls" }
          : null
    if (!goal) return
    autoTried.current = here
    void (async () => {
      const [status, limit] = await Promise.all([loadConsent(), sites.get(LIMIT_KEY)])
      if (status !== "ok" || (!goal.only && limitedToday(limit[LIMIT_KEY])) || pageTranslator().state().at !== "off") return
      step("auto")
      asked.current = goal
      autoRun.current = true
      // Where × folded the pill on this site it stays folded: the entry by the circle says the page is translated.
      if (hidden) setClosed(true)
      void pageTranslator().start(goal.to, goal.from, goal.only ?? null)
    })()
  }, [auto, looked, state.at, offer?.from, controls?.offer])
  // The answers ran out on a page that started by itself: told now (the pill shows, also where it was folded), and
  // not again today.
  const autoRun = useRef(false)
  useEffect(() => {
    if (state.at !== "limit" || state.controls || !autoRun.current) return
    autoRun.current = false
    setClosed(false)
    void sites.set({ [LIMIT_KEY]: Date.now() }).catch(() => undefined)
  }, [state])

  // The circle held down: the pill by hand, on any page (a page in the reader's language into another, say).
  const [manual, setManual] = useState(false)
  const heldSeen = useRef(held)
  useEffect(() => {
    if (held === heldSeen.current) return
    heldSeen.current = held
    step("entry")
    setManual(true)
    setClosed(false)
    setOpened(true)
  }, [held])

  /** The translation of `goal`, asked for by the pill's button or the panel's «Translate page» chip: the consent first. */
  const startFor = async (goal: PageOffer) => {
    asked.current = goal
    tapped.current = true
    autoRun.current = false
    step("tap")
    const status = await loadConsent()
    if (status !== "ok") {
      setConsent(status)
      step("consent")
      return
    }
    void pageTranslator().start(goal.to, goal.from, goal.only ?? null)
  }
  // The panel's chip (quiet/signals.ts): the pill shows again (also where it was hidden) with the translation under way.
  useEffect(() => {
    starter = (goal) => {
      setClosed(false)
      setOpened(true)
      void startFor(goal)
    }
    return () => {
      starter = null
    }
  }, [])

  // What the pill would translate, one thing at a time: the page when its main content is in another language; else
  // its controls when they are (whatever their share of the page); else a part of it; by hand, the page as it is.
  const sameAsPage = !!pageLang && baseLanguage(pageLang) === baseLanguage(to)
  const target: PageOffer | null =
    offer ??
    (controls ? { from: controls.lang, to, only: "controls" } : null) ??
    (part ? { from: part.lang, to } : null) ??
    (manual && pageLang ? { from: pageLang, to } : null)
  // The pill by itself for a page in another language, or for enough controls in one, where it wasn't closed; else
  // the entry by the circle, which opens it.
  const byItself = !!offer || controls?.offer === true
  // 2.7 (the director's acceptance of 108, hurriyet.com.tr on iPad): the offer by itself lay over the site's consent
  // dialog and hid its main button. Where the page has a button or a link under the pill, the small entry shows
  // instead (until it's tapped: then the pill, asked for).
  const [offerRef, overPage] = useOverPageControls<HTMLDivElement>(state.at === "off" && !closed && !opened && byItself && !hidden && show)
  const pill = state.at !== "off" ? !closed : !closed && (opened || (byItself && !hidden && !overPage))
  const entry = !pill && (state.at !== "off" || (target !== null && !manual) || !!offer || !!controls || !!part)
  const visible = show && !(typing && state.at === "off") && (pill ? (target !== null || state.at !== "off") : entry)
  // The entry itself over a page's button (108, iPhone: by the circle it lay on the dialog's «İzin ver»): it steps
  // aside, unseen and untouchable, while the button is under it; the circle's panel still translates. Not on a
  // translated page: there it's the way back to the original.
  const [entryRef, entryOver] = useOverPageControls<HTMLButtonElement>(visible && !pill && state.at === "off", false)
  useEffect(() => {
    if (visible && pill && state.at === "off" && !shownOnce.current) {
      shownOnce.current = true
      step("shown")
    }
  }, [visible, pill, state.at])

  const label = useMemo(() => {
    if (!target) return ""
    const inSentence = (code: string) => {
      const name = languageName(code, uiLang())
      return /^(de|en|ja|ko|zh|ar|tr)/.test(uiLang()) ? name : name.charAt(0).toLocaleLowerCase(uiLang()) + name.slice(1)
    }
    // The page's controls: said as what it is («Кнопки и меню: греческий»).
    if (target.only === "controls") return t("trControls", inSentence(target.from))
    // A smaller part of the page: which language and how much («Греческий: 12% страницы»).
    if (!offer && part) return t("trPart", targetName(part.lang, uiLang()), String(Math.max(1, Math.round(part.share * 100))))
    // By hand on a page already in the language picked: another one first.
    if (!offer && sameAsPage) return t("trLangPick")
    if (baseLanguage(target.to) === baseLanguage(uiLang())) return t("trOffer")
    // Mid-sentence, a language's name is a common noun in most of the panel's languages («на язык: английский»);
    // Safari's names may come capitalized. German, English and Turkish keep the capital («Almanca»; English is also the
    // interface for every language the panel doesn't speak: «Translate to Turkish?», 2.7, the director's audit).
    const name = languageName(target.to, uiLang())
    return t("trOfferTo", /^(de|en|ja|ko|zh|ar|tr)/.test(uiLang()) ? name : name.charAt(0).toLocaleLowerCase(uiLang()) + name.slice(1))
  }, [offer, part, target?.to, target?.only, target?.from, sameAsPage])

  if (!visible && consent === null) return null

  const start = (goal: PageOffer) => void pageTranslator().start(goal.to, goal.from, goal.only ?? null)
  const go = async () => {
    const goal = target ?? asked.current
    if (goal) await startFor(goal)
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
    setManual(false)
    hide()
    foldsTold.current = tells.current
    setFolding(tells.current ? "told" : "fold")
    void hideHere().then(() => sites.get(TOLD_KEY)).then((got) => {
      tells.current = tellsAt(got[TOLD_KEY])
    })
  }
  const open = () => {
    step("entry")
    setFolding(null)
    setClosed(false)
    setOpened(true)
  }
  // Another language: remembered here; a translated page is translated again into it (a new translation).
  const pick = (code: string) => {
    if (code === to) return
    step("lang")
    setTo(code)
    // A site translated whole: into this language from now on.
    if (auto) {
      const next = { ...auto, to: code }
      setAutoSite(next)
      void setAuto(sites, next).catch(() => undefined)
    }
    const from = asked.current?.from ?? target?.from ?? null
    if (state.at !== "off" && from) {
      const only = asked.current?.only ?? target?.only
      pageTranslator().original()
      asked.current = { from, to: code, ...(only ? { only } : {}) }
      start(asked.current)
    }
  }

  // The whole site, yes: this language, and only the buttons and menus where that's what was translated.
  const siteYes = () => {
    const goal = asked.current ?? target
    if (!goal) return
    step("site_on")
    const next: AutoSite = { s: site(), to: goal.to, ...(goal.only ? { only: goal.only } : {}) }
    setAutoSite(next)
    setSiteRow(null)
    void setAuto(sites, next).catch(() => undefined)
  }
  const siteOff = () => {
    step("site_off")
    setAutoSite(null)
    setSiteRow(null)
    void clearAuto(sites, site()).catch(() => undefined)
  }

  const style = { top }
  // Something the reader can see is being translated: the contour shimmers.
  const busy = state.at === "working" || (state.at === "on" && state.busy === true)
  const cls = `cf-tr ${side}${busy ? " busy" : ""}`

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
    // Just after ×: the line where the pill was (a tap on it opens the pill again), then it folds into the entry.
    if (folding === "told") {
      return (
        <div class={`cf-tr told ${side}`} style={style} role="status" onClick={open}>
          <span class="cf-tr-label">{t("trHiddenTold")}</span>
          <TranslateIcon size={16} />
        </div>
      )
    }
    const entryEl = (
      <button
        ref={entryRef}
        type="button"
        class={`cf-tr-entry ${side}${state.at !== "off" ? " on" : ""}${busy ? " busy" : ""}`}
        style={entryOver && state.at === "off" ? { ...style, visibility: "hidden", pointerEvents: "none" } : style}
        aria-hidden={entryOver && state.at === "off" ? true : undefined}
        aria-label={said}
        title={said}
        onClick={open}
      >
        <TranslateIcon size={16} />
      </button>
    )
    return folding === "fold" && state.at === "off" ? (
      <>
        <div class={`cf-tr told fold ${side}`} style={style} aria-hidden="true">
          <span class="cf-tr-label">{foldsTold.current ? t("trHiddenTold") : label}</span>
          <TranslateIcon size={16} />
        </div>
        {entryEl}
      </>
    ) : entryEl
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
  if (state.at === "on" && siteRow === "ask") {
    // Every page of this site? Yes puts the site on the list; no leaves the pill as it was (asked once per site).
    return (
      <div class={`${cls} site`} style={style} role="group" aria-label={t("trSiteAsk")}>
        <span class="cf-tr-label">{t("trSiteAsk")}</span>
        <button type="button" class="cf-tr-btn" onClick={siteYes}>{t("trSiteYes")}</button>
        <button type="button" class="cf-tr-btn quiet" onClick={() => {
          step("site_no")
          setSiteRow(null)
        }}>{t("trSiteNo")}</button>
      </div>
    )
  }
  if (state.at === "on" && siteRow === "manage") {
    return (
      <div class={`${cls} site`} style={style} role="group" aria-label={t("trSiteOn")}>
        <span class="cf-tr-label">{t("trSiteOn")}</span>
        <button type="button" class="cf-tr-btn quiet" onClick={siteOff}>{t("trSiteOff")}</button>
        <button type="button" class="cf-tr-x" aria-label={t("close")} onClick={() => setSiteRow(null)}><Close /></button>
      </div>
    )
  }
  if (state.at === "on") {
    return (
      <div class={cls} style={style}>
        <button type="button" class="cf-tr-btn quiet" onClick={original}><TranslateIcon size={14} /> {t("trOriginal")}</button>
        {lang}
        <button
          type="button"
          class={`cf-tr-site${auto ? " on" : ""}`}
          aria-pressed={auto ? true : false}
          aria-label={t(auto ? "trSiteOn" : "trSiteAsk")}
          title={t(auto ? "trSiteOn" : "trSiteAsk")}
          onClick={() => setSiteRow(auto ? "manage" : "ask")}
        >
          <SiteIcon />
          {auto && <span class="cf-tr-site-word">{t("trSite")}</span>}
        </button>
        {x}
      </div>
    )
  }
  if (state.at === "limit" && state.controls) {
    // The day's free translations of buttons and menus are used up: said plainly, with the page's translation (one
    // answer) offered instead.
    const goal = asked.current ?? target
    return (
      <div class={cls} style={style} role="status">
        <span class="cf-tr-label">{t("trControlsCap")}</span>
        {goal && (
          <button type="button" class="cf-tr-btn" onClick={() => {
            step("tap")
            asked.current = { from: goal.from, to: goal.to }
            tapped.current = true
            start(asked.current)
          }}>{t("trEntry")}</button>
        )}
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
    <div ref={offerRef} class={cls} style={style}>
      <TranslateIcon />
      <span class="cf-tr-label">{label}</span>
      {lang}
      <button type="button" class="cf-tr-btn" disabled={!offer && !controls && !part && sameAsPage} onClick={() => void go()}>{t("actTranslate")}</button>
      {x}
    </div>
  )
}

/** How long after a translation comes out the pill asks about the whole site. */
const SITE_ASK_MS = 1_400

/** How long the line after × says where the offer went, and how long it takes to fold into the entry. */
export const TOLD_MS = 4_000
const FOLD_MS = 360

// ------------------------------------------------------------ the page's own controls under the offer

/**
 * While `active` (the offer shows by itself), whether it lies over a control of the page: looked at as it shows and
 * for a while after (a site's consent dialog comes a moment after the page). Once over one it stays so on this page.
 */
function useOverPageControls<E extends HTMLElement>(active: boolean, sticky = true): [{ current: E | null }, boolean] {
  const ref = useRef<E | null>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    if (!active) {
      if (!sticky) setOver(false)
      return
    }
    if (sticky && over) return
    let looks = 0
    let later = 0
    const look = () => {
      const el = ref.current
      if (!el) return
      const host = (el.getRootNode() as ShadowRoot).host ?? null
      const covers = coversPageControl(document, el.getBoundingClientRect(), host)
      if (covers || !sticky) setOver(covers)
    }
    // Not sticky (the small entry): looked at again after a tap, which may have closed the page's dialog.
    const tapped = () => {
      clearTimeout(later)
      later = window.setTimeout(look, 400)
    }
    look()
    const timer = setInterval(() => {
      look()
      if (++looks >= 20) clearInterval(timer)
    }, 1_000)
    window.addEventListener("scroll", look, { passive: true })
    window.addEventListener("resize", look)
    if (!sticky) document.addEventListener("click", tapped, true)
    return () => {
      clearInterval(timer)
      clearTimeout(later)
      window.removeEventListener("scroll", look)
      window.removeEventListener("resize", look)
      document.removeEventListener("click", tapped, true)
    }
  }, sticky ? [active, over] : [active])
  return [ref, over]
}
