// What the paid plans give, one feature a slide, grouped Pro and Ultra (build 90; the owner: show every paid feature,
// not only sorting by topic). The same slides as the app's Pro screen (PaidGallery.swift): what each feature does in
// one line, over a sample drawn with the panel's own pieces, in the reader's language and theme. Swipe, the arrows or
// the keyboard's arrow keys; the chips jump to a group.

import type { VNode } from "preact"
import { useRef, useState } from "preact/hooks"

import { t } from "../shared/i18n"
import type { PlanFacts } from "../shared/types"
import { speedLabel } from "../shared/stretch"
import * as Icon from "./icons"
import { SpeakerIcon } from "./listen/useListen"
import { OrganizePreview } from "./Organize"

/** Small line icons for the samples (24-unit grid, current colour). */
const Svg = ({ size = 13, children }: { size?: number; children: VNode | VNode[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>
)
const VideoIcon = () => <Svg><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3z" fill="currentColor" /></Svg>
const DocIcon = () => <Svg><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></Svg>
const SearchIcon = () => <Svg size={14}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>
const BackIcon = () => <Svg size={18}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /></Svg>
const AheadIcon = () => <Svg size={18}><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4h-4" /></Svg>
const PauseIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>

type Slide = "media" | "search" | "organize" | "templates" | "watch" | "answers" | "listen" | "similar" | "watchMore"
const SLIDES: Slide[] = ["media", "search", "organize", "templates", "watch", "answers", "listen", "similar", "watchMore"]
const ULTRA_FROM = SLIDES.indexOf("listen")

const price = (value: number, currency = "USD") => value.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 0 })

export function Gallery({ facts, ultra = false }: { facts: PlanFacts | undefined; ultra?: boolean }): VNode {
  const [index, setIndex] = useState(ultra ? ULTRA_FROM : 0)
  const [forward, setForward] = useState(true)
  const touch = useRef<number | null>(null)
  const slide = SLIDES[index]
  const isUltra = index >= ULTRA_FROM
  const go = (to: number) => {
    if (to < 0 || to >= SLIDES.length || to === index) return
    setForward(to > index)
    setIndex(to)
  }
  const watchPro = facts?.watch.pro ?? 20
  const watchUltra = facts?.watch.ultra ?? 50
  const weekly = facts?.proWeekly ?? 375
  const daily = facts?.freeDaily ?? 5

  const title: Record<Slide, string> = {
    media: t("gMediaTitle"),
    search: t("gSearchTitle"),
    organize: t("upsellOrganizeName"),
    templates: t("gTemplatesTitle"),
    watch: t("gWatchTitle", String(watchPro)),
    answers: t("gAnswersTitle", String(weekly)),
    listen: t("gListenTitle"),
    similar: t("gSimilarTitle"),
    watchMore: t("gWatchTitle", String(watchUltra))
  }
  const line: Record<Slide, string> = {
    media: t("gMediaLine"),
    search: t("gSearchLine"),
    organize: t("upsellOrganizeText"),
    templates: t("gTemplatesLine"),
    watch: t("gWatchLine"),
    answers: t("gAnswersLine", String(daily)),
    listen: t("gListenLine"),
    similar: t("gSimilarLine"),
    watchMore: t("gWatchManyLine", String(watchUltra))
  }

  return (
    <section class="cf-gallery" aria-roledescription="carousel" aria-label={t("galleryTitle")}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(index + 1)
        else if (e.key === "ArrowLeft") go(index - 1)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
      onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const from = touch.current
        touch.current = null
        const to = e.changedTouches[0]?.clientX
        if (from === null || to === undefined) return
        if (to - from < -40) go(index + 1)
        else if (to - from > 40) go(index - 1)
      }}>
      <div class="cf-gallery-head">
        <strong>{t("galleryTitle")}</strong>
        <button type="button" class={`cf-tier-chip pro ${isUltra ? "dim" : ""}`} aria-pressed={!isUltra} onClick={() => go(0)}>{t("planPro")}</button>
        <button type="button" class={`cf-tier-chip ultra ${isUltra ? "" : "dim"}`} aria-pressed={isUltra} onClick={() => go(ULTRA_FROM)}>{t("planUltra")}</button>
      </div>
      <div class="cf-gallery-stage">
        <div key={slide} class={`cf-gallery-slide ${forward ? "fwd" : "back"}`} role="group" aria-roledescription="slide" aria-label={`${index + 1} / ${SLIDES.length}`}>
          <div class="cf-gallery-title">
            <span class={`cf-tier-chip ${isUltra ? "ultra" : "pro"}`}>{isUltra ? t("planUltra") : t("planPro")}</span>
            <strong>{title[slide]}</strong>
          </div>
          <p class="cf-gallery-line">{line[slide]}</p>
          {slide === "organize" ? <OrganizePreview /> : <div class="cf-gallery-sample" aria-hidden="true">{sample(slide, watchUltra, weekly, daily)}</div>}
        </div>
      </div>
      <div class="cf-gallery-nav">
        <button type="button" class="cf-icon-btn" disabled={index === 0} onClick={() => go(index - 1)} aria-label={t("galleryPrevious")}>‹</button>
        <div class="cf-gallery-dots" aria-hidden="true">
          {SLIDES.map((s, i) => <i key={s} class={`${i === index ? "on" : ""} ${i >= ULTRA_FROM ? "ultra" : ""}`} />)}
        </div>
        <button type="button" class="cf-icon-btn" disabled={index === SLIDES.length - 1} onClick={() => go(index + 1)} aria-label={t("galleryNext")}>›</button>
      </div>
    </section>
  )
}

function sample(slide: Slide, watchUltra: number, weekly: number, daily: number): VNode {
  switch (slide) {
    case "media":
      return (
        <>
          <div class="cf-g-chips"><span class="cf-g-chip"><VideoIcon /> {t("gMediaVideo")}</span><span class="cf-g-chip"><DocIcon /> {t("gMediaPdf")}</span></div>
          <p class="cf-g-text">{t("gMediaAnswer")}</p>
        </>
      )
    case "search":
      return (
        <>
          <div class="cf-g-search"><SearchIcon /><span class="q">{t("gSearchQuery")}</span><span class="ai"><Icon.Sparkle size={12} /></span></div>
          <div class="cf-g-result">
            <div><strong>{t("gSearchResult")}</strong><span>{t("gSearchWhen")}</span></div>
            <p>{t("gSearchSnippet")}</p>
          </div>
        </>
      )
    case "templates": {
      const person = t("gTemplatesPerson")
      const day = t("gTemplatesDay")
      const filled = t("gTemplatesBody", "\u0001", "\u0002")
      const pieces = filled.split(/([\u0001\u0002])/)
      return (
        <>
          <strong class="cf-g-name">{t("gTemplatesName")}</strong>
          <p class="cf-g-text">{pieces.map((p, i) => (p === "\u0001" ? <mark key={i}>{person}</mark> : p === "\u0002" ? <mark key={i}>{day}</mark> : p))}</p>
        </>
      )
    }
    case "watch":
      return (
        <div class="cf-g-note">
          <span class="cf-g-icon"><Icon.Sparkle size={16} /></span>
          <div><small>ContextFlow</small><strong>{t("gWatchChanged")}</strong><span>{t("gWatchNow", price(99), price(129))}</span></div>
        </div>
      )
    case "answers":
      return (
        <>
          <div class="cf-g-big"><b>{weekly}</b><span>{t("gAnswersWeek")}</span></div>
          <div class="cf-g-bar pro"><i style={{ width: "100%" }} /><span>{t("planPro")}</span></div>
          <div class="cf-g-bar"><i style={{ width: `${Math.max(3, (daily * 7 * 100) / weekly)}%` }} /><span>{t("gAnswersFree", String(daily))}</span></div>
        </>
      )
    case "listen":
      return (
        <>
          <div class="cf-g-player-title"><SpeakerIcon size={15} /> <strong>{t("gListenSample")}</strong></div>
          <div class="cf-g-track"><i style={{ width: "27%" }} /></div>
          <div class="cf-g-times"><span>1:12</span><span>4:30</span></div>
          <div class="cf-g-controls"><span class="skip"><BackIcon /><small>15</small></span><span class="play"><PauseIcon /></span><span class="skip"><AheadIcon /><small>15</small></span><span class="speed">{speedLabel(1.5)}</span></div>
        </>
      )
    case "similar":
      return (
        <div class="cf-g-rows">
          {([["gSimilar1", 169, "gSimilarInStock"], ["gSimilar2", 249, "gSimilarNewer"], ["gSimilar3", 129, "gSimilarCheaper"]] as const).map(([name, amount, tag]) => (
            <div key={name} class="cf-g-row"><span class="n">{t(name)}</span><span class="tag">{t(tag)}</span><b>{price(amount)}</b></div>
          ))}
        </div>
      )
    case "watchMore":
      return (
        <div class="cf-g-rows">
          <div class="cf-g-row"><span class="n">{t("gWatchItem1")}</span><s>{price(329)}</s><b>{price(279)}</b></div>
          <div class="cf-g-row"><span class="n">{t("gWatchItem2")}</span><b>{price(89, "EUR")}</b></div>
          <p class="cf-g-more">{t("gWatchMore", String(Math.max(0, watchUltra - 2)))}</p>
        </div>
      )
    default:
      return <></>
  }
}
