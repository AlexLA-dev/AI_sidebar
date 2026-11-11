// The panel's Tips (2.5 (78), the owner's note: mirror the app's Tips in the extension). "…" in the header → Tips:
// the app's blocks, texts and Pro badges (tips/data.ts), each block folding like the app's, which ones are open
// kept on this device. 2.5 (81): an open block's title stays at the top while its cards scroll (tips.css), and the
// cards play the app's clips, each loaded only once its card is on screen. 2.6 (91): from the app itself (App Group),
// none in the extension (ClipFrame).

import type { VNode } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import { useAboveComposer } from "../ux/MessageUx"
import { ClipFrame } from "./ClipFrame"
import { forDevice, say, tipsData, type TipEntry } from "./data"

const OPEN = "cf:tipsOpen"

// A light bulb, the app's Tips tab icon.
export const TipsIcon = ({ size = 16 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18h6M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
  </svg>
)

const Chevron = (): VNode => (
  <svg class="cf-tips-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

/** The menu's word for it, the app's tab name in this language (null in a build without Tips). */
export function tipsLabel(): string | null {
  const data = tipsData()
  return data ? say(data.heading) : null
}

function stillOnly(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/** How a clip starts: prepared when the sheet opens ("auto" the first, "metadata" the next two), or not at all (null). */
type Load = "auto" | "metadata" | null

/**
 * A card's clip: the app's, from the App Group, played in the extension's clip page (2.6 (91), ClipFrame; before, the
 * extension's own copies). The loading rule (2.5 (81), the owner): nothing before Tips opens; on opening, only the
 * first three clips of the open block are prepared (the first plays, the next two wait on a still frame); any other
 * clip loads once its card is on screen in an open block, or on a tap; closing Tips lets go of every clip (their
 * frames go). Muted and looping like the app's, paused off screen; with Reduce Motion, one still frame.
 */
function TipClip({ name, lang, load }: { name: string; lang: string; load: Load }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const still = stillOnly()
  const [shown, setShown] = useState(load !== null)
  const [onScreen, setOnScreen] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const box = ref.current
    if (!box || typeof IntersectionObserver === "undefined") return
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setShown(true)
      setOnScreen(Boolean(entry?.isIntersecting) && !still)
    }, { root: box.closest(".cf-sheet"), threshold: 0.2 })
    seen.observe(box)
    return () => seen.disconnect()
  }, [])
  // Prepared ones wait on the still frame until they're seen; the first and the ones loaded on screen play at once.
  const waits = still || load === "metadata"
  return (
    <div ref={ref} class="cf-tip-clip" aria-hidden="true" onClick={() => setShown(true)}>
      {shown && <ClipFrame name={name} lang={lang} still={waits && !onScreen} active={onScreen} motion={!still} />}
    </div>
  )
}

/**
 * Which blocks are open, kept on this device: the first ("Get started") until one is opened or closed. `ready` once
 * that's read: no card (and no clip) shows before, so a block left folded never starts loading.
 */
function useOpenBlocks(first: string): [string[], (id: string) => void, boolean] {
  const [open, setOpen] = useState<string[]>([first])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const kept = (await chrome.storage.local.get(OPEN))[OPEN]
        if (alive && Array.isArray(kept)) setOpen(kept.filter((id): id is string => typeof id === "string"))
      } catch {
        // No storage: the first block open.
      }
      if (alive) setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [])
  const toggle = (id: string) => {
    const next = open.includes(id) ? open.filter((x) => x !== id) : [...open, id]
    setOpen(next)
    try {
      void chrome.storage.local.set({ [OPEN]: next })
    } catch {
      // Kept while the sheet is open.
    }
  }
  return [open, toggle, ready]
}

function TipCard({ tip, mac, lang, load = null }: { tip: TipEntry; mac: boolean; lang: string; load?: Load }): VNode {
  const { title, text, clip } = forDevice(tip, mac)
  return (
    <div class="cf-tip">
      {clip && <TipClip name={clip} lang={lang} load={load} />}
      <div class="cf-tip-title">
        {say(title)}
        {tip.pro && <span class="cf-pro-badge">Pro</span>}
        {tip.ultra && <span class="cf-ultra-badge">Ultra</span>}
      </div>
      <p class="cf-tip-text">{say(text)}</p>
    </div>
  )
}

/** `mac`: a Mac's words and clips (no touch). */
export function TipsSheet({ mac, onClose }: { mac: boolean; onClose: () => void }): VNode | null {
  const data = tipsData()
  const back = useRef<HTMLDivElement>(null)
  useAboveComposer(back)
  const [open, toggle, ready] = useOpenBlocks(data?.groups[0]?.id ?? "")
  // Prepared as Tips opens: the first three clips of the block(s) open then, in order (the first plays).
  const prepared = useMemo(() => {
    const load = new Map<string, Load>()
    if (!data || !ready) return load
    const clips = data.groups.filter((g) => open.includes(g.id)).flatMap((g) => g.tips).filter((tip) => forDevice(tip, mac).clip)
    clips.slice(0, 3).forEach((tip, i) => load.set(tip.title.key, i === 0 ? "auto" : "metadata"))
    return load
  }, [ready])
  if (!data) return null
  const heading = say(data.heading)
  const lang = say(data.clipLang)
  return (
    <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cf-sheet cf-tips" role="dialog" aria-label={heading}>
        <div class="cf-sheet-title">
          <TipsIcon /> {heading}
          <button type="button" class="cf-icon cf-sheet-close" onClick={onClose} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
        </div>
        <p class="cf-tips-intro">{say(data.intro)}</p>
        {/* The whole app's, before the blocks, as in the app. */}
        <TipCard tip={data.lead} mac={mac} lang={lang} />
        {data.groups.map((group) => {
          const isOpen = open.includes(group.id)
          return (
            <section key={group.id} class={`cf-tips-block ${isOpen ? "open" : ""}`}>
              <button type="button" class="cf-tips-head" aria-expanded={isOpen} onClick={() => toggle(group.id)}>
                <span>{say(group.title)}</span>
                {!isOpen && <span class="cf-tips-count">{group.tips.length}</span>}
                <Chevron />
              </button>
              {isOpen && ready && (
                <div class="cf-tips-cards">
                  {group.tips.map((tip) => <TipCard key={tip.title.key} tip={tip} mac={mac} lang={lang} load={prepared.get(tip.title.key) ?? null} />)}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
