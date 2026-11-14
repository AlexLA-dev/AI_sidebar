// «Снимок страницы в заметке» (2.7): the switch over the note field, the thumbnail on a note, and the picture full screen
// with a crop frame. The crop is kept on the note (the picture itself stays as it was), so it reaches the other devices
// with the chat and can be undone with «Весь снимок».

import type { VNode } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

import { t } from "../../shared/i18n"
import { cleanCrop, cropView, dragCrop, type Shot, type ShotKind, type ShotPref } from "../../shared/shots"
import * as Icon from "../icons"
import { openShot } from "../shot"

const CameraIcon = ({ size = 15 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
)

/** Over the note field: «Снимок страницы» on or off, and what it takes (the whole page is Pro's and Ultra's). */
export function ShotSwitch({ pref, pro, busy, onChange, onPlans }: {
  pref: ShotPref
  pro: boolean
  // Taking one now: "screen 3 of 8".
  busy: string | null
  onChange: (pref: ShotPref) => void
  onPlans: () => void
}): VNode {
  const [ask, setAsk] = useState(false)
  if (busy) return <div class="cf-shot-row busy" role="status"><span class="cf-add-dots"><span /><span /><span /></span> {busy}</div>
  return (
    <div class="cf-shot-row">
      <label class="cf-whole cf-shot-on">
        <input type="checkbox" role="switch" checked={pref.on} onChange={(e) => onChange({ ...pref, on: e.currentTarget.checked })} />
        <span class="cf-switch" aria-hidden="true" />
        <CameraIcon size={14} /> <span>{t("shotSwitch")}</span>
      </label>
      {pref.on && (
        <div class="cf-seg cf-shot-kind" role="radiogroup" aria-label={t("shotSwitch")}>
          {(["visible", "full"] as const).map((k: ShotKind) => (
            <button
              type="button"
              role="radio"
              aria-checked={pref.kind === k}
              class={pref.kind === k ? "on" : ""}
              onClick={() => {
                if (k === "full" && !pro) return setAsk(true)
                setAsk(false)
                onChange({ ...pref, kind: k })
              }}
            >
              {t(k === "visible" ? "shotVisible" : "shotFull")}
              {k === "full" && !pro && <span class="cf-shot-pro">Pro</span>}
            </button>
          ))}
        </div>
      )}
      {ask && (
        <div class="cf-shot-ask" role="status">
          {t("shotProOnly")} <button type="button" class="cf-link" onClick={() => {
            setAsk(false)
            onPlans()
          }}>{t("tryPro")}</button>
        </div>
      )}
    </div>
  )
}

/** The note's thumbnail (its crop when it has one); a tap opens the picture. */
export function ShotThumb({ shot, onOpen }: { shot: Shot; onOpen: () => void }): VNode {
  const view = cropView(shot.crop)
  // The thumbnail is the picture's top (shots.ts thumbnail): a crop lower down is shown on opening, not here.
  const scale = Math.min(240, shot.w) / shot.w
  const covers = Math.min(1, 320 / (shot.h * scale))
  const inThumb = view && shot.crop && shot.crop[1] + shot.crop[3] <= covers + 0.001
  return (
    <button type="button" class={`cf-shot-thumb ${shot.kind}`} aria-label={t("shotOpen")} title={t("shotOpen")} onClick={onOpen}>
      {inThumb ? (
        <span class="cf-shot-crop" style={{ aspectRatio: `${(shot.w * shot.crop![2]) / (shot.h * shot.crop![3])}` }}>
          <img src={shot.th} alt={t("shotNote")} style={{ width: view!.width, left: view!.left, top: view!.top }} />
        </span>
      ) : (
        <img src={shot.th} alt={t("shotNote")} />
      )}
      {shot.kind === "full" && <span class="cf-shot-badge">{t("shotFull")}</span>}
    </button>
  )
}

type Edge = "move" | "nw" | "ne" | "sw" | "se"

/** The picture full screen: scrolls when it's tall; «Обрезать» puts a frame on it, «Готово» keeps the frame on the note. */
export function ShotViewer({ shot, onClose, onCrop }: { shot: Shot; onClose: () => void; onCrop: (crop: Shot["crop"]) => void }): VNode {
  const [data, setData] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  // A whole page's frame starts on its first screen (the picture is many screens tall).
  const first: [number, number, number, number] = shot.kind === "full" ? [0.05, 0.02, 0.9, Math.min(0.9, Math.max(0.1, (shot.w * 0.6) / shot.h))] : [0.05, 0.05, 0.9, 0.9]
  const [frame, setFrame] = useState<[number, number, number, number]>(shot.crop ?? first)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ edge: Edge; x: number; y: number; start: [number, number, number, number] } | null>(null)

  useEffect(() => {
    let live = true
    void openShot(shot).then((d) => {
      if (!live) return
      if (d) setData(d)
      else setMissing(true)
    })
    return () => {
      live = false
    }
  }, [shot.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const start = (edge: Edge) => (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { edge, x: e.clientX, y: e.clientY, start: frame }
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    const r = box.current?.getBoundingClientRect()
    if (!d || !r) return
    setFrame(dragCrop(d.start, d.edge, (e.clientX - d.x) / r.width, (e.clientY - d.y) / r.height))
  }
  const end = () => {
    drag.current = null
  }

  const view = !editing ? cropView(shot.crop) : null
  return (
    <div class="cf-shot-viewer" role="dialog" aria-label={t("shotNote")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div class="cf-shot-bar">
        <button type="button" class="cf-shot-x" aria-label={t("close")} title={t("close")} onClick={onClose}><Icon.Close /></button>
        <span class="cf-shot-title">{t(shot.kind === "full" ? "shotFull" : "shotVisible")}</span>
        {data && !editing && <button type="button" class="cf-shot-act" onClick={() => {
          setFrame(shot.crop ?? first)
          setEditing(true)
        }}>{t("shotCrop")}</button>}
        {editing && (
          <>
            {shot.crop && <button type="button" class="cf-shot-act quiet" onClick={() => {
              setEditing(false)
              onCrop(undefined)
            }}>{t("shotCropReset")}</button>}
            <button type="button" class="cf-shot-act primary" onClick={() => {
              setEditing(false)
              onCrop(cleanCrop(frame))
            }}>{t("shotCropDone")}</button>
          </>
        )}
      </div>
      <div class="cf-shot-stage">
        {!data && !missing && <div class="cf-shot-note"><span class="cf-add-dots"><span /><span /><span /></span> {t("shotLoading")}</div>}
        {missing && (
          <div class="cf-shot-note">
            <img class="cf-shot-small" src={shot.th} alt="" />
            <p>{t("shotMissing")}</p>
          </div>
        )}
        {data && (
          <div
            ref={box}
            class={`cf-shot-pic ${editing ? "editing" : ""}`}
            // Cropping: the whole picture on screen, so every corner of the frame can be reached.
            style={editing ? { width: `min(100%, calc((100vh - 110px) * ${shot.w / shot.h}))` } : view ? { aspectRatio: `${(shot.w * shot.crop![2]) / (shot.h * shot.crop![3])}`, overflow: "hidden" } : undefined}
          >
            <img src={data} alt={t("shotNote")} draggable={false} style={view ? { position: "absolute", width: view.width, left: view.left, top: view.top } : undefined} />
            {editing && (
              <div class="cf-shot-frame" style={{ left: `${frame[0] * 100}%`, top: `${frame[1] * 100}%`, width: `${frame[2] * 100}%`, height: `${frame[3] * 100}%` }} onPointerDown={start("move")}>
                {(["nw", "ne", "sw", "se"] as const).map((c) => <span class={`cf-shot-handle ${c}`} onPointerDown={start(c)} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export { CameraIcon }
