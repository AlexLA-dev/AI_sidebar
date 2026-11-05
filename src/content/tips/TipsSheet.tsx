// The panel's Tips (2.5 (78), the owner's note: mirror the app's Tips in the extension). "…" in the header → Tips:
// the app's blocks, texts and Pro badges (tips/data.ts), each block folding like the app's, which ones are open
// kept on this device. No clips, so the extension stays light: the first line sends to the app's Tips, where they
// play (a link where the panel can open the app).

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import * as Icon from "../icons"
import { useAboveComposer } from "../ux/MessageUx"
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

/** Which blocks are open, kept on this device: the first ("Get started") until one is opened or closed. */
function useOpenBlocks(first: string): [string[], (id: string) => void] {
  const [open, setOpen] = useState<string[]>([first])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const kept = (await chrome.storage.local.get(OPEN))[OPEN]
        if (alive && Array.isArray(kept)) setOpen(kept.filter((id): id is string => typeof id === "string"))
      } catch {
        // No storage: the first block open.
      }
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
  return [open, toggle]
}

function TipCard({ tip, mac }: { tip: TipEntry; mac: boolean }): VNode {
  const { title, text } = forDevice(tip, mac)
  return (
    <div class="cf-tip">
      <div class="cf-tip-title">
        {say(title)}
        {tip.pro && <span class="cf-pro-badge">Pro</span>}
      </div>
      <p class="cf-tip-text">{say(text)}</p>
    </div>
  )
}

/** `mac`: a Mac's words (no touch); `onOpenApp`: the app can be opened from here (Safari), else the line is text. */
export function TipsSheet({ mac, onOpenApp, onClose }: { mac: boolean; onOpenApp?: () => void; onClose: () => void }): VNode | null {
  const data = tipsData()
  const back = useRef<HTMLDivElement>(null)
  useAboveComposer(back)
  const [open, toggle] = useOpenBlocks(data?.groups[0]?.id ?? "")
  if (!data) return null
  const heading = say(data.heading)
  const videos = t("tipsVideos", heading)
  return (
    <div ref={back} class="cf-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cf-sheet cf-tips" role="dialog" aria-label={heading}>
        <div class="cf-sheet-title">
          <TipsIcon /> {heading}
          <button type="button" class="cf-icon cf-sheet-close" onClick={onClose} aria-label={t("close")} title={t("close")}><Icon.Close /></button>
        </div>
        <p class="cf-tips-intro">{say(data.intro)}</p>
        {onOpenApp ? (
          <button type="button" class="cf-link cf-tips-app" onClick={onOpenApp}>{videos}</button>
        ) : (
          <p class="cf-tips-app">{videos}</p>
        )}
        {/* The whole app's, before the blocks, as in the app. */}
        <TipCard tip={data.lead} mac={mac} />
        {data.groups.map((group) => {
          const isOpen = open.includes(group.id)
          return (
            <section key={group.id} class={`cf-tips-block ${isOpen ? "open" : ""}`}>
              <button type="button" class="cf-tips-head" aria-expanded={isOpen} onClick={() => toggle(group.id)}>
                <span>{say(group.title)}</span>
                {!isOpen && <span class="cf-tips-count">{group.tips.length}</span>}
                <Chevron />
              </button>
              {isOpen && (
                <div class="cf-tips-cards">
                  {group.tips.map((tip) => <TipCard key={tip.title.key} tip={tip} mac={mac} />)}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
