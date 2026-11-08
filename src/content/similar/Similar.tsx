// "Find similar" (2.6, Ultra) in the panel: the card to start it (a condition chip, or the person's own words),
// the answer as a list of checked alternatives (streamed in as each one passes the server's checks), and the card
// for someone without Ultra. Every link in the list was opened on our server just now; what the page states (price,
// stock, date) shows as it was read, and a condition the page doesn't show says "Not confirmed".

import type { VNode } from "preact"
import { useState } from "preact/hooks"

import { t, uiLang } from "../../shared/i18n"
import { SIMILAR_CHIPS, type SimilarAnswer, type SimilarChip, type SimilarItem, type SimilarPricing, type SimilarStep } from "../../shared/similar"
import { moneyIn } from "../../shared/watch/compare"
import { parseNumber } from "../../shared/watch/extract"
import * as Icon from "../icons"

/** A price worth watching: a real one (a free app's 0 has nowhere to go). */
export function watchable(price: string): boolean {
  const n = parseNumber(price)
  return n !== null && n > 0
}

const CHIP_LABEL: Record<SimilarChip, Parameters<typeof t>[0]> = {
  cheaper: "similarCheaper",
  in_stock: "similarInStock",
  newer: "similarNewer",
  free: "similarFree",
  language: "similarMyLanguage",
  shorter: "similarShorter"
}

/** The condition in the person's language, as the server reads it ("cheaper", "in Russian", …). */
export function chipCondition(chip: SimilarChip): string {
  return chip === "language" ? t("similarInLanguage", t("languageName")) : t(CHIP_LABEL[chip])
}

/** Two pages, one behind the other: "more like this". */
export function SimilarIcon({ size = 16 }: { size?: number }): VNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

/** A check mark at a given size ("checked on the page"). */
function Tick({ size = 13 }: { size?: number }): VNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** The start: an optional condition chip (one at a time) and the person's own words; Find. */
export function SimilarPicker({ title, onFind, onClose }: { title: string; onFind: (condition: string, label: string) => void; onClose: () => void }): VNode {
  const [chip, setChip] = useState<SimilarChip | null>(null)
  const [words, setWords] = useState("")
  const find = () => {
    const condition = [chip ? chipCondition(chip) : "", words.trim()].filter(Boolean).join(", ").slice(0, 300)
    // The question's bubble: the person's own words (or the chip's), in whatever language they wrote them; the Find
    // similar icon beside it says what it is (2.6 build 90: "Find similar:" in an English panel before Russian words).
    onFind(condition, condition || t("similarAsked"))
  }
  return (
    <div class="cf-card cf-similar-pick" role="dialog" aria-label={t("similarTitle")}>
      <div class="cf-similar-head">
        <SimilarIcon size={17} />
        <strong>{t("similarTitle")}</strong>
      </div>
      <p class="cf-similar-of" dir="auto">{title}</p>
      <div class="cf-similar-chips" role="group" aria-label={t("similarConditions")}>
        {SIMILAR_CHIPS.map((c) => (
          <button key={c} type="button" class={`cf-chip small${chip === c ? " on" : ""}`} aria-pressed={chip === c} onClick={() => setChip(chip === c ? null : c)}>
            {t(CHIP_LABEL[c])}
          </button>
        ))}
      </div>
      <input
        class="cf-similar-words"
        type="text"
        dir="auto"
        maxLength={200}
        value={words}
        placeholder={t("similarCustom")}
        onInput={(e) => setWords(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault()
            find()
          }
        }}
      />
      <p class="cf-similar-hint">{t("similarHint")}</p>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={find}><SimilarIcon size={14} /> {t("similarFind")}</button>
        <button type="button" class="cf-secondary" onClick={onClose}>{t("cancel")}</button>
      </div>
    </div>
  )
}

function shortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(uiLang(), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
  } catch {
    return iso
  }
}

/** A price as the page's markup states it ("169.99 USD") in the person's way of writing money. */
export function shownPrice(price: string): string {
  const m = /^(\d+(?:\.\d+)?)\s([A-Z]{3})$/.exec(price.trim())
  if (!m) return price
  try {
    return moneyIn(uiLang(), Number(m[1]), m[2])
  } catch {
    return price
  }
}

/**
 * An item's link opens its page in a new tab the browser's own way (build 91, the owner: the titles opened nothing on
 * iPhone; a tab the extension opens may stay behind the one shown there). Only a page that stops links itself (its
 * own click handling) gets it opened by the background instead.
 */
function opening(url: string, onOpen: (url: string) => void): (e: MouseEvent) => void {
  return (e) => {
    setTimeout(() => {
      if (e.defaultPrevented) onOpen(url)
    }, 0)
  }
}

/**
 * What an app costs, as its App Store page or pricing page says (build 91): "Free · Subscription from $11.99/month",
 * "One-time purchase $9.99", "Free, no in-app purchases".
 */
export function payText(p: SimilarPricing): string {
  if (p.model === "free") return t("similarPayFree")
  const money = p.from ? shownPrice(p.from) : ""
  const per = p.period ? t(p.period === "week" ? "similarPerWeek" : p.period === "year" ? "similarPerYear" : "similarPerMonth", money) : money
  const what = p.model === "subscription" ? t("similarPaySub", per) : p.model === "one_time" ? t("similarPayOnce", money) : t("similarPayIap", per)
  return p.freeStart ? `${t("similarPayFreeStart")} · ${what}` : what
}

function Item({ item, n, onOpen, onWatch }: { item: SimilarItem; n: number; onOpen: (url: string) => void; onWatch?: (item: SimilarItem) => void }): VNode {
  const facts = [
    // An app's pricing says more than its store price ($0.00 for one with a subscription inside).
    item.price && !item.pricing ? shownPrice(item.price) : "",
    item.stock === "in" ? t("similarStockIn") : item.stock === "out" ? t("similarStockOut") : "",
    item.date ? shortDate(item.date) : ""
  ].filter(Boolean)
  return (
    <li class="cf-similar-item">
      <span class="cf-similar-n">{n}</span>
      <div class="cf-similar-body">
        <a class="cf-similar-name" href={item.url} target="_blank" rel="noopener noreferrer" dir="auto" onClick={opening(item.url, onOpen)}>
          {item.name}
        </a>
        <span class="cf-similar-host">
          <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={opening(item.url, onOpen)}>{item.host}</a>
          {item.source === "list" ? ` · ${t("similarFromList")}` : ""}
        </span>
        {item.why && <p class="cf-similar-why" dir="auto">{item.why}</p>}
        {item.met === "yes" && item.fit && <p class="cf-similar-fit ok" dir="auto"><Tick size={13} /> {item.fit}</p>}
        {item.met === "unknown" && (
          <p class="cf-similar-fit unknown" dir="auto"><span class="cf-similar-nc">{t("similarNotConfirmed")}</span>{item.fit ? ` ${item.fit}` : ""}</p>
        )}
        {item.met === "n/a" && item.fit && <p class="cf-similar-fit" dir="auto">{item.fit}</p>}
        {(facts.length > 0 || item.pricing || !item.checked || (onWatch && item.watch)) && (
          <div class="cf-similar-facts">
            {item.pricing && (
              <a class="cf-similar-pay" href={item.pricing.url} target="_blank" rel="noopener noreferrer" dir="auto" onClick={opening(item.pricing.url, onOpen)}>{payText(item.pricing)}</a>
            )}
            {facts.map((f) => <span key={f}>{f}</span>)}
            {!item.checked && <span class="cf-similar-unopened">{t("similarNotOpened")}</span>}
            {onWatch && item.watch && item.source === "item" && watchable(item.watch.value) && (
              <button type="button" class="cf-similar-watch" onClick={() => onWatch(item)}><Icon.Eye size={13} /> {t("similarWatchPrice")}</button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

const STEP_TEXT: Record<SimilarStep, Parameters<typeof t>[0]> = {
  plan: "similarStepPlan",
  search: "similarStepSearch",
  check: "similarStepCheck",
  write: "similarStepWrite"
}

/**
 * The answer: the list (items as they come, while `step` is set), the note, and when the pages were checked.
 * `onWatch` absent: no page watch here (not Safari).
 */
export function SimilarList({ answer, items, step, pages, onOpen, onWatch }: {
  answer?: SimilarAnswer
  items: SimilarItem[]
  step?: SimilarStep | null
  pages?: number
  onOpen: (url: string) => void
  onWatch?: (item: SimilarItem) => void
}): VNode {
  const streaming = Boolean(step)
  return (
    <div class="cf-similar" aria-busy={streaming}>
      {answer?.intro && <p class="cf-similar-intro" dir="auto">{answer.intro}</p>}
      {items.length > 0 && (
        <ol class="cf-similar-list">
          {items.map((it, i) => <Item key={it.url + it.name} item={it} n={i + 1} onOpen={onOpen} onWatch={onWatch} />)}
        </ol>
      )}
      {streaming && (
        <div class="cf-thinking cf-similar-step"><span /><span /><span /> {step === "check" && pages ? t("similarStepCheckN", pages) : t(STEP_TEXT[step!])}</div>
      )}
      {!streaming && answer && !items.length && <p class="cf-similar-none">{t("similarNone")}</p>}
      {!streaming && answer?.note && <p class="cf-similar-note" dir="auto">{answer.note}</p>}
      {!streaming && answer && items.length > 0 && (
        <p class="cf-similar-checked"><Tick size={12} /> {t("similarChecked", new Intl.DateTimeFormat(uiLang(), { hour: "numeric", minute: "2-digit" }).format(new Date(answer.at)))}</p>
      )}
    </div>
  )
}

/** For someone without Ultra: what it does, and the way to it. */
export function SimilarUpsell({ onUpgrade, onClose }: { onUpgrade: () => void; onClose: () => void }): VNode {
  return (
    <div class="cf-card cf-upsell cf-similar-upsell" role="dialog" aria-label={t("similarTitle")}>
      <div class="cf-upsell-head">
        <span class="cf-upsell-icon"><SimilarIcon size={18} /></span>
        <strong>{t("similarTitle")}</strong>
        <span class="cf-pro-badge cf-ultra-badge">Ultra</span>
      </div>
      <p>{t("similarUpsellText")}</p>
      <ul class="cf-upsell-list">
        <li><span>{t("similarUpsellChecked")}</span></li>
        <li><span>{t("similarUpsellConditions")}</span></li>
        <li><span>{t("similarUpsellWatch")}</span></li>
      </ul>
      <div class="cf-card-actions">
        <button type="button" class="cf-primary" onClick={onUpgrade}><Icon.Sparkle size={14} /> {t("similarGetUltra")}</button>
        <button type="button" class="cf-secondary" onClick={onClose}>{t("offerLater")}</button>
      </div>
    </div>
  )
}
