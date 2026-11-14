// The pill by the ✦ circle on a page in another language (2.7, plan section 11, the owner's decisions of 13–14
// November): «Перевести на русский?» with «Перевести» and ×. × hides it on this site. Once translated it becomes
// «Оригинал», which puts the page back. When the free answers of the day are used up it offers Pro. The first
// translation asks the one AI consent, as the first answer does (the page's text goes to the server, as for answers).
//
// It sits beside the circle on the circle's side (left or right, plan section 9), at the circle's height. Never while
// the panel is open, while the selection's buttons show, while the person types, or in the first moment of a page.
// Page hints (plan section 6) use this pill on a page in another language instead of their own reply: they read
// pageTranslateOffer().

import type { VNode } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { baseLanguage, languageName } from "../translateTarget"
import { t, uiLang, uiLanguage } from "../../shared/i18n"
import { plainText, targetCode, type TranslateStep } from "../../shared/translate"
import { ConsentCard } from "../Consent"
import { giveConsent, loadConsent } from "../store"
import { collectBlocks } from "./blocks"
import { MIN_LETTERS, offerFor, pageLanguage } from "./decide"
import { PageTranslator, type EngineState } from "./engine"
import { portAsk, storageCache } from "./port"

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

/** The page is in another language and the pill offers to translate it (plan section 6 reads it). */
export function pageTranslateOffer(): PageOffer | null {
  return offerNow
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

/** The page's words for judging its language: its headings, paragraphs and list items first (a quick query on every
 *  page, most of which are in the person's own language); a page built of bare divs is read block by block. */
function sample(): { text: string; letters: number } {
  let text = ""
  for (const el of Array.from(document.body.querySelectorAll("h1,h2,h3,p,li,td,dd,blockquote,figcaption")).slice(0, 120)) {
    if (el.closest("nav,header,footer,[role=navigation],[aria-hidden=true],contextflow-root")) continue
    text += `${el.textContent ?? ""} `
    if (text.length > 4000) break
  }
  let letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters >= MIN_LETTERS) return { text: text.slice(0, 4000), letters }
  text = ""
  letters = 0
  for (const b of collectBlocks(document.body)) {
    const words = plainText(b.text)
    letters += words.match(/\p{L}/gu)?.length ?? 0
    text += `${words} `
    if (text.length > 4000) break
  }
  return { text: text.slice(0, 4000), letters }
}

/** The page's language against the person's, from its markup and its words. */
function judge(): PageOffer | null {
  if (!document.body) return null
  const { text, letters } = sample()
  const to = targetCode(uiLanguage())
  const from = pageLanguage(document.documentElement.lang || "", text)
  return from && offerFor(from, baseLanguage(to), letters) ? { from, to } : null
}

/** When to look: once the page has loaded and settled, and again after a site that fills itself in late. */
function useOffer(): [PageOffer | null, () => void] {
  const [offer, setOffer] = useState<PageOffer | null>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    let alive = true
    let url = location.href
    const look = async () => {
      if (!alive) return
      const found = judge()
      const off = found ? await hiddenHere() : false
      if (!alive) return
      setHidden(off)
      setOffer(found)
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
  const shown = hidden ? null : offer
  offerNow = shown
  return [shown, () => setHidden(true)]
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

export function TranslatePill({ side, top, show, free, onPlans }: TranslatePillProps): VNode | null {
  const [offer, hide] = useOffer()
  const typing = useTyping()
  const state = useEngine()
  const [consent, setConsent] = useState<"ok" | "old" | "none" | null>(null)
  const [closed, setClosed] = useState(false)
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

  const visible = show && !closed && (offer !== null || state.at !== "off") && !(typing && state.at === "off")
  useEffect(() => {
    if (visible && state.at === "off" && !shownOnce.current) {
      shownOnce.current = true
      step("shown")
    }
  }, [visible, state.at])

  const label = useMemo(() => {
    if (!offer) return ""
    if (baseLanguage(offer.to) === baseLanguage(uiLang())) return t("trOffer")
    // Mid-sentence, a language's name is a common noun in most of the panel's languages («на язык: английский»);
    // Safari's names may come capitalized. German keeps its capital.
    const name = languageName(offer.to, uiLang())
    return t("trOfferTo", /^(de|ja|ko|zh|ar)/.test(uiLang()) ? name : name.charAt(0).toLocaleLowerCase(uiLang()) + name.slice(1))
  }, [offer])

  if (!visible && consent === null) return null

  const go = async () => {
    const target = offer ?? asked.current
    if (!target) return
    asked.current = target
    tapped.current = true
    step("tap")
    const status = await loadConsent()
    if (status !== "ok") {
      setConsent(status)
      step("consent")
      return
    }
    void pageTranslator().start(target.to, target.from)
  }
  const accept = async () => {
    await giveConsent()
    setConsent(null)
    const target = asked.current ?? offer
    if (target) void pageTranslator().start(target.to, target.from)
  }
  const original = () => {
    step("original")
    pageTranslator().original()
  }
  const dismiss = () => {
    step("dismiss")
    setClosed(true)
    hide()
    void hideHere()
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

  const x = (
    <button type="button" class="cf-tr-x" aria-label={t("trHide")} title={t("trHide")} onClick={dismiss}><Close /></button>
  )

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
      <button type="button" class="cf-tr-btn" onClick={() => void go()}>{t("actTranslate")}</button>
      {x}
    </div>
  )
}
