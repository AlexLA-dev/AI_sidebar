import type { VNode } from "preact"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"

import type { CopiedItem } from "../../shared/copied"
import { siteExcluded, siteKey } from "../../shared/copied"
import { t } from "../../shared/i18n"
import type { InsertSettings, InsertVia } from "../../shared/insert"
import { DEFAULT_INSERT_SETTINGS, type FindResult, type AiFailure } from "../../shared/insert"
import { blanks, searchTemplates, titleStarts, type Template, type TemplateUse } from "../../shared/templates"
import type { Platform } from "../../shared/types"
import type { ConsentStatus } from "../../shared/consent"
import * as Icon from "../icons"
import { HOST_TAG, privateBrowsing } from "../page"
import { copiedText } from "./capture"
import { copyToClipboard, insertText, isControl, restoreCaret, textBeforeCaret, updateCaret, type Field } from "./field"
import { FillForm } from "./FillForm"
import * as QIcon from "./icons"
import { clearCopied, countUse, keepCopied, lastReply, loadCopied, loadInsertSettings, loadTemplates, loadUse, markTipSeen, onCopied, onInsertSettings, onTemplates, report, saveInsertSettings, sendBackground, syncTemplatesNow, tipSeen, type LastReply } from "./store"
import { rememberField, setButtonShown, setPanelInserter } from "./target"
import { TemplateEditor, type EditorStart } from "./TemplateEditor"
import { BUTTON, buttonSpot, noButtonField, pagePointFree } from "./spot"
import { codeField, phraseWorthLooking, signFor, siteMenuOpen, typedPhrase } from "./trigger"
import { follow, placeByCaret, placeSheet } from "./place"
import { caretRect, pageRect, viewport, watchFields } from "./watch"

/** What the panel asks of quick insert, through the bus (the selection's "Template" button, Settings). */
export const QI_EVENTS = { newTemplate: "qi-new-template", editTemplate: "qi-edit-template", insertTemplate: "qi-insert-template" } as const

type Mode =
  | null
  // The list: as a sheet over the page (the button on iPhone and iPad), or by the caret (⌃⇧V).
  | { kind: "list"; at: "sheet" | "caret"; via: InsertVia }
  // "/phrase" typed: the matching templates under the caret.
  | { kind: "suggest"; phrase: string; length: number; items: Template[]; chosen: number }
  // A template with blanks: filled in (by hand, from Copied, or by AI), then inserted.
  | { kind: "fill"; template: Template; via: InsertVia; replace: number }
  | { kind: "editor"; start: EditorStart }

interface Props {
  platform: Platform
  touch: boolean
  bus: EventTarget
  panelOpen: boolean
  consent: ConsentStatus
  // Resolves once the consent is stored (the background checks it before sending anything).
  onConsent: () => Promise<void>
  free: boolean
  onUpgrade: () => void
  onOpenTemplates: () => void
  onAdapt: (text: string) => void
}


// Where the ✦ was when last seen: while it steps aside it isn't on the page to measure.
let lastFab: DOMRect | null = null

export function QuickInsert(props: Props): VNode | null {
  const { touch } = props
  const [settings, setSettings] = useState<InsertSettings>(DEFAULT_INSERT_SETTINGS)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [templates, setTemplates] = useState<Template[]>([])
  const templatesRef = useRef(templates)
  templatesRef.current = templates
  const [copied, setCopied] = useState<CopiedItem[]>([])
  const [use, setUse] = useState<TemplateUse>({})
  const useLive = useRef(use)
  useLive.current = use
  const [field, setField] = useState<Field | null>(null)
  const fieldRef = useRef<Field | null>(null)
  const [mode, setModeState] = useState<Mode>(null)
  const modeRef = useRef<Mode>(null)
  const setMode = (m: Mode) => {
    modeRef.current = m
    setModeState(m)
  }
  const [toast, setToast] = useState<string | null>(null)
  const [tip, setTip] = useState(false)
  const tipChecked = useRef(false)
  const [, setTick] = useState(0)
  const host = siteKey(location.hostname)
  const sign = signFor(location.hostname, settings.sign)
  const dismissed = useRef<number | null>(null)
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ------------------------------------------------------------ data
  useEffect(() => {
    void loadInsertSettings().then(setSettings)
    void loadTemplates().then(setTemplates)
    void loadCopied().then(setCopied)
    void loadUse().then(setUse)
    const stops = [
      onInsertSettings(setSettings),
      onTemplates(() => void loadTemplates().then(setTemplates)),
      onCopied(() => void loadCopied().then(setCopied))
    ]
    return () => stops.forEach((s) => s())
  }, [])

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 3200)
  }, [])

  // ------------------------------------------------------------ inserting
  /** Puts `text` at the field's caret; when the field refuses, copies it and asks to paste by hand. */
  const insertNow = useCallback(async (text: string, replace = 0, target?: Field | null): Promise<boolean> => {
    const f = target ?? fieldRef.current
    setMode(null)
    if (!f || !f.el.isConnected) {
      if (await copyToClipboard(text)) showToast(t("qiPasteManually"))
      return false
    }
    const way = await insertText(f, text, replace)
    if (way) {
      if (touch) keepInView(f)
      return true
    }
    if (await copyToClipboard(text)) showToast(t("qiPasteManually"))
    report({ kind: "insert_manual", field: isControl(f.el) ? "control" : "editor" })
    return false
  }, [showToast])

  const insertTemplate = useCallback((tpl: Template, via: InsertVia, replace = 0) => {
    if (blanks(tpl.text).length) {
      setMode({ kind: "fill", template: tpl, via, replace })
      return
    }
    void insertNow(tpl.text, replace).then((ok) => {
      if (ok) report({ kind: "insert_template", via, blanks: 0, filled: "none" })
    })
    void countUse(tpl.id, host).then(() => loadUse().then(setUse))
  }, [host, insertNow])

  // "Insert into the field" under the panel's answers and notes.
  useEffect(() => {
    setPanelInserter((text, what) => {
      void insertNow(text).then((ok) => ok && report({ kind: "insert_answer", what }))
    })
    return () => setPanelInserter(null)
  }, [insertNow])

  // ------------------------------------------------------------ the field and the page
  useEffect(() => {
    const stop = watchFields({
      focus(f) {
        fieldRef.current = f
        setField(f)
        rememberField(f)
        // The panel (and its fields) never count as the page's field.
        if (modeRef.current?.kind === "suggest") setMode(null)
      },
      blur() {
        setField(null)
        if (modeRef.current?.kind === "suggest") setMode(null)
      },
      input(f, composing) {
        fieldRef.current = f
        if (composing) return
        // Korean on iOS replaces the syllable as it grows (delete + insert): look a moment later.
        clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => lookForPhrase(f), 100)
      },
      keydown(e) {
        onKey(e)
      },
      copy(e, doc, phase) {
        onCopy(e, doc, phase)
      }
    })
    return stop
  }, [])

  const lookForPhrase = (f: Field) => {
    const current = updateCaret(f)
    const before = textBeforeCaret(current)
    const typed = codeField(f.el) ? null : typedPhrase(before, signFor(location.hostname, settingsRef.current.sign, location.pathname))
    const m = modeRef.current
    if (!typed || (typed.phrase && !phraseWorthLooking(typed.phrase, before))) {
      dismissed.current = null
      if (m?.kind === "suggest") setMode(null)
      return
    }
    if (m && m.kind !== "suggest") return
    // Esc closed it for this phrase: not again until a new sign is typed.
    const start = textBeforeCaret(current).length - typed.length
    if (dismissed.current === start) return
    const items = typed.phrase ? searchTemplates(templatesRef.current, typed.phrase, { host, use: useLive.current, now: Date.now() }, 5, true) : []
    // The site opened its own menu at the caret (its "/" commands, an autocomplete): ours steps back.
    if (!items.length || siteMenuOpen(f)) {
      if (m?.kind === "suggest") setMode(null)
      return
    }
    // The first one stands chosen only when the phrase starts its title: then Tab takes it; otherwise Tab
    // moves on to the next field as usual.
    setMode({ kind: "suggest", phrase: typed.phrase, length: typed.length, items, chosen: titleStarts(items[0], typed.phrase) ? 0 : -1 })
    // A site's menu may open a moment after the sign: look again then.
    setTimeout(() => {
      if (modeRef.current?.kind === "suggest" && siteMenuOpen(f)) setMode(null)
    }, 200)
  }

  // The list's keys come before the page's editor: arrows, Tab, Enter (only when chosen), Esc.
  const onKey = (e: KeyboardEvent) => {
    const m = modeRef.current
    if (!m || m.kind !== "suggest" || e.isComposing) return
    const stop = () => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      stop()
      const n = m.items.length
      const chosen = e.key === "ArrowDown" ? (m.chosen + 1) % n : (m.chosen - 1 + n) % n
      setMode({ ...m, chosen })
    } else if (e.key === "Tab" && !e.shiftKey && m.chosen >= 0) {
      stop()
      insertTemplate(m.items[m.chosen], "slash", m.length)
    } else if (e.key === "Enter" && m.chosen >= 0) {
      stop()
      insertTemplate(m.items[m.chosen], "slash", m.length)
    } else if (e.key === "Escape") {
      stop()
      const f = fieldRef.current
      if (f) dismissed.current = textBeforeCaret(updateCaret(f)).length - m.length
      setMode(null)
    }
  }

  // ------------------------------------------------------------ Copied
  const copyState = useRef<{ done: boolean } | null>(null)
  const onCopy = (e: ClipboardEvent, doc: Document, phase: "capture" | "bubble") => {
    const s = settingsRef.current
    if (!s.copied || privateBrowsing() || siteExcluded(location.hostname, s.copiedOffSites)) return
    if (phase === "capture") {
      // The page may stop the event before it bubbles up: the selection seen now is kept then.
      const state = { done: false }
      copyState.current = state
      const early = copiedText(e, doc)
      setTimeout(() => {
        if (!state.done && early) void keepCopied(early, location.hostname, "page")
      }, 0)
      return
    }
    const state = copyState.current
    if (state) state.done = true
    // After the page's own handlers: a page that puts its own text on the clipboard is taken at its word.
    const text = copiedText(e, doc)
    if (text) void keepCopied(text, location.hostname, "page")
  }

  // ------------------------------------------------------------ the list
  const openList = useCallback((at: "sheet" | "caret", via: InsertVia) => {
    const f = fieldRef.current
    if (f) fieldRef.current = updateCaret(f)
    if (at === "sheet" && f) {
      // The keyboard goes away and the list takes its room; the caret is kept for the insert.
      const active = f.el.ownerDocument.activeElement as HTMLElement | null
      active?.blur?.()
    }
    setMode({ kind: "list", at, via })
    void syncTemplatesNow()
    void loadCopied().then(setCopied)
  }, [])

  // ⌃⇧V from the background: the list by the caret (or as a sheet when no field has the caret).
  useEffect(() => {
    const listener = (message: { type?: string }) => {
      if (message?.type !== "quickInsert") return false
      const m = modeRef.current
      if (m?.kind === "list") setMode(null)
      else openList(fieldRef.current ? "caret" : "sheet", "shortcut")
      return false
    }
    try {
      chrome.runtime.onMessage.addListener(listener)
    } catch {
      return
    }
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [openList])

  // From the panel: a new template from a selection, one to edit, one to insert (Templates view).
  useEffect(() => {
    const onNew = (e: Event) => setMode({ kind: "editor", start: (e as CustomEvent<EditorStart>).detail })
    const onInsert = (e: Event) => insertTemplate((e as CustomEvent<Template>).detail, "panel")
    props.bus.addEventListener(QI_EVENTS.newTemplate, onNew)
    props.bus.addEventListener(QI_EVENTS.editTemplate, onNew)
    props.bus.addEventListener(QI_EVENTS.insertTemplate, onInsert)
    return () => {
      props.bus.removeEventListener(QI_EVENTS.newTemplate, onNew)
      props.bus.removeEventListener(QI_EVENTS.editTemplate, onNew)
      props.bus.removeEventListener(QI_EVENTS.insertTemplate, onInsert)
    }
  }, [props.bus, insertTemplate])

  const closeTo = (back: boolean) => {
    const f = fieldRef.current
    setMode(null)
    // The field gets its caret back (the list or the form had the focus).
    if (back && f && f.el.isConnected) restoreCaret(f)
  }

  // ------------------------------------------------------------ the button by the field
  const buttonAllowed = touch && settings.button && !siteExcluded(location.hostname, settings.buttonOffSites)
  const showButton = Boolean(buttonAllowed && field && !mode && !props.panelOpen)
  useEffect(() => {
    if (!showButton || tipChecked.current) return
    tipChecked.current = true
    void tipSeen().then((seen) => !seen && setTip(true))
  }, [showButton])
  const dropTip = () => {
    if (!tip) return
    setTip(false)
    void markTipSeen()
  }

  // The tick re-places the button when the page scrolls, the keyboard moves or the field grows.
  useEffect(() => {
    if (!field) return
    const bump = () => setTick((n) => n + 1)
    const vv = window.visualViewport
    vv?.addEventListener("resize", bump)
    vv?.addEventListener("scroll", bump)
    window.addEventListener("scroll", bump, true)
    const grow = new ResizeObserver(bump)
    grow.observe(field.el)
    return () => {
      vv?.removeEventListener("resize", bump)
      vv?.removeEventListener("scroll", bump)
      window.removeEventListener("scroll", bump, true)
      grow.disconnect()
    }
  }, [field])

  // Copied refreshes itself when its oldest piece runs out.
  useEffect(() => {
    if (!copied.length) return
    const next = Math.min(...copied.map((c) => c.at)) + 24 * 3600_000 - Date.now()
    const timer = setTimeout(() => void loadCopied().then(setCopied), Math.max(1000, Math.min(next, 3600_000)))
    return () => clearTimeout(timer)
  }, [copied])

  const vp = viewport(touch)
  let buttonPos: { top: number; left: number } | null = null
  // Outside the field, where nothing of the site's lies underneath (spot.ts); none on searches and codes.
  if (showButton && field && !noButtonField(field.el)) {
    const r = pageRect(field.el)
    const spot = r.width >= 120 ? buttonSpot(r, vp, pagePointFree(document.querySelector(HOST_TAG))) : null
    if (spot) buttonPos = { top: spot.top + vp.dy, left: spot.left + vp.dx }
  }

  // The ✦ steps aside only when the button would sit on it (it used to hide at every field, and blinked).
  const buttonEl = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const el = buttonEl.current
    if (!el || !buttonPos) return setButtonShown(false)
    const fab = (el.getRootNode() as ShadowRoot).querySelector(".cf-fab")
    if (fab) lastFab = fab.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    const f = lastFab
    setButtonShown(Boolean(f && b.left < f.right + 8 && b.right > f.left - 8 && b.top < f.bottom + 8 && b.bottom > f.top - 8))
  }, [buttonPos?.top, buttonPos?.left])
  useEffect(() => () => setButtonShown(false), [])

  // ------------------------------------------------------------ render
  const m = mode
  return (
    <>
      {buttonPos && (
        <button
          ref={buttonEl}
          type="button"
          class="cf-qi-btn"
          style={{ top: `${buttonPos.top}px`, left: `${buttonPos.left}px` }}
          aria-label={t("qiButton")}
          title={t("qiButton")}
          // Like the selection buttons: acts on pointerup (the field keeps the focus until then), and the
          // tap's late click is cancelled so it can't land on the list opening underneath.
          onPointerDown={(e) => e.preventDefault()}
          onTouchEnd={(e) => e.preventDefault()}
          onPointerUp={() => {
            dropTip()
            openList("sheet", "button")
          }}
          onClick={(e) => {
            if (e.detail !== 0) return
            dropTip()
            openList("sheet", "button")
          }}
        >
          <QIcon.Insert />
        </button>
      )}
      {buttonPos && tip && field && <Tip at={buttonPos} fieldTop={pageRect(field.el).top + vp.dy} onClose={dropTip} />}

      {m?.kind === "suggest" && fieldRef.current && (
        <Suggest field={fieldRef.current} touch={touch} items={m.items} chosen={m.chosen} onPick={(tpl) => insertTemplate(tpl, "slash", m.length)} />
      )}

      {m?.kind === "list" && (
        <InsertList
          at={m.at}
          via={m.via}
          platform={props.platform}
          touch={touch}
          field={fieldRef.current}
          templates={templates}
          copied={copied}
          use={use}
          host={host}
          settings={settings}
          consent={props.consent}
          onClose={() => closeTo(m.at === "caret")}
          onCopied={(c) => void insertNow(c.text).then((ok) => ok && report({ kind: "insert_copied", via: m.via }))}
          onTemplate={(tpl) => insertTemplate(tpl, m.via)}
          onReply={(r) => void insertNow(r.text).then((ok) => ok && report({ kind: "insert_answer", what: r.note ? "note" : "answer" }))}
          onPin={(c) => setMode({ kind: "editor", start: { text: c.text, from: "pin" } })}
          onNew={() => setMode({ kind: "editor", start: { text: "", from: "plus" } })}
          onAll={() => {
            setMode(null)
            props.onOpenTemplates()
          }}
          onSettings={(patch) => void saveInsertSettings(patch).then(setSettings)}
          onClear={() => void clearCopied().then(() => setCopied([]))}
        />
      )}

      {m?.kind === "fill" && (
        <FillForm
          template={m.template}
          touch={touch}
          sheet={m.via === "button" || !fieldRef.current}
          field={fieldRef.current}
          copied={copied}
          consent={props.consent}
          onConsent={props.onConsent}
          free={props.free}
          onUpgrade={props.onUpgrade}
          onClose={() => closeTo(m.via !== "button")}
          onAdapt={(text) => {
            setMode(null)
            props.onAdapt(text)
          }}
          onInsert={(text, filled, count) => {
            void insertNow(text, m.replace).then((ok) => ok && report({ kind: "insert_template", via: m.via, blanks: count, filled }))
            void countUse(m.template.id, host).then(() => loadUse().then(setUse))
          }}
        />
      )}

      {m?.kind === "editor" && (
        <TemplateEditor
          start={m.start}
          touch={touch}
          consent={props.consent}
          onConsent={props.onConsent}
          host={host}
          onDone={() => setMode(null)}
        />
      )}

      {toast && (
        <div class="cf-qi-toast" role="status" style={{ top: `${vp.dy + vp.height - 64}px` }}>
          <Icon.Copy /> {toast}
        </div>
      )}
    </>
  )
}

/**
 * iPhone and iPad: the focus came back to the field in code, and iOS doesn't scroll it above the keyboard
 * as it does after a tap. Once the keyboard is up, the page scrolls so the caret's line shows.
 */
function keepInView(field: Field): void {
  const bring = () => {
    if (!field.el.isConnected) return
    const vp = viewport(true)
    const r = pageRect(field.el)
    const caret = caretRect(updateCaret(field))
    const bottom = Math.min(r.bottom, caret.bottom + 24)
    if (bottom > vp.height - 8) window.scrollBy({ top: bottom - vp.height + 24, behavior: "smooth" })
    else if (r.top < 8) window.scrollBy({ top: r.top - 24, behavior: "smooth" })
  }
  // After the keyboard's animation (and once more for a slow one).
  setTimeout(bring, 450)
  setTimeout(bring, 900)
}

// ------------------------------------------------------------ the first-touch tip

function Tip({ at, fieldTop, onClose }: { at: { top: number; left: number }; fieldTop: number; onClose: () => void }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: at.top - 70, left: at.left - 200 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const vp = viewport(true)
    // Above the field (not over what's typed in it); under the button when there's no room above.
    const above = Math.min(fieldTop, at.top) - el.offsetHeight - 8
    setPos({
      top: above >= vp.dy + 8 ? above : at.top + BUTTON + 8,
      left: Math.max(vp.dx + 8, Math.min(at.left + BUTTON - el.offsetWidth, vp.dx + vp.width - el.offsetWidth - 8))
    })
  }, [at.top, at.left, fieldTop])
  return (
    <div ref={ref} class="cf-qi-tip" role="status" style={{ top: `${pos.top}px`, left: `${pos.left}px` }} onClick={onClose}>
      {t("qiTip")}
    </div>
  )
}

// ------------------------------------------------------------ "/phrase" suggestions

function Suggest({ field, touch, items, chosen, onPick }: { field: Field; touch: boolean; items: Template[]; chosen: number; onPick: (t: Template) => void }): VNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) placeByCaret(ref.current, field, touch, 320)
  })
  return (
    <div ref={ref} class="cf-qi suggest" role="listbox" aria-label={t("qiTemplates")} onPointerDown={(e) => e.preventDefault()}>
      <div class="cf-qi-body" style={{ paddingTop: "4px" }}>
        {items.map((tpl, i) => (
          <button type="button" role="option" aria-selected={i === chosen} class={`cf-qi-row ${i === chosen || (chosen < 0 && i === 0) ? "on" : ""}`} onClick={() => onPick(tpl)}>
            <TemplateRow tpl={tpl} />
          </button>
        ))}
      </div>
      <div class="cf-qi-keys">
        <span><kbd>Tab</kbd> {t("qiKeyInsert")}</span>
        <span><kbd>↑↓</kbd> {t("qiKeyChoose")}</span>
        <span><kbd>Esc</kbd> {t("qiKeyClose")}</span>
      </div>
    </div>
  )
}

function TemplateRow({ tpl }: { tpl: Template }): VNode {
  const count = blanks(tpl.text).length
  return (
    <>
      <span class="cf-qi-main">
        <span class="cf-qi-title">{tpl.title}</span>
        <span class="cf-qi-text">{tpl.text.replace(/\s+/g, " ")}</span>
      </span>
      {count > 0 && <span class="cf-qi-mark"><Icon.Sparkle size={11} /> {t("qiBlanksMark")}</span>}
    </>
  )
}

// ------------------------------------------------------------ the list

interface ListProps {
  at: "sheet" | "caret"
  // Opened from the button by the field: the list offers to hide that button on this site.
  via: InsertVia
  platform: Platform
  touch: boolean
  field: Field | null
  templates: Template[]
  copied: CopiedItem[]
  use: TemplateUse
  host: string
  settings: InsertSettings
  consent: ConsentStatus
  onClose: () => void
  onCopied: (c: CopiedItem) => void
  onTemplate: (t: Template) => void
  onReply: (r: LastReply) => void
  onPin: (c: CopiedItem) => void
  onNew: () => void
  onAll: () => void
  onSettings: (patch: Partial<InsertSettings>) => void
  onClear: () => void
}

type Row = { kind: "copied"; item: CopiedItem } | { kind: "template"; item: Template } | { kind: "reply"; item: LastReply }

function ago(at: number): string {
  const min = Math.max(1, Math.round((Date.now() - at) / 60_000))
  return min < 60 ? t("minutes", min) : t("hours", Math.round(min / 60))
}

function InsertList(p: ListProps): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [reply, setReply] = useState<LastReply | null>(null)
  const [chosen, setChosen] = useState(0)
  const [aiIds, setAiIds] = useState<string[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => void lastReply().then(setReply), [])

  const q = query.trim().toLowerCase()
  const found = useMemo(() => searchTemplates(p.templates, query, { host: p.host, use: p.use, now: Date.now() }, q ? 20 : 3), [p.templates, query, p.host, p.use])
  const templates = aiIds ? aiIds.map((id) => p.templates.find((x) => x.id === id)).filter((x): x is Template => Boolean(x)) : found
  const copied = (p.settings.copied ? p.copied : []).filter((c) => !q || c.text.toLowerCase().includes(q))
  const showReply = reply && (!q || reply.text.toLowerCase().includes(q))
  const rows: Row[] = [
    ...copied.map((item) => ({ kind: "copied" as const, item })),
    ...templates.map((item) => ({ kind: "template" as const, item })),
    ...(showReply ? [{ kind: "reply" as const, item: reply! }] : [])
  ]
  useEffect(() => setChosen(0), [query, aiIds])
  useEffect(() => setAiIds(null), [query])

  // Placed: a sheet over the bottom of what's visible, or under the caret; again when the keyboard moves.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return follow(el, () => {
      if (p.at === "sheet") placeSheet(el, p.touch)
      else {
        el.style.maxHeight = `${Math.min(460, viewport(p.touch).height - 16)}px`
        placeByCaret(el, p.field, p.touch, 360)
      }
    })
  })
  // By the caret (⌃⇧V) the search field takes the keys at once; on iPhone the keyboard stays away until tapped.
  useEffect(() => {
    if (p.at === "caret") setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 0)
  }, [p.at])
  // A tap outside closes it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const path = e.composedPath()
      if (ref.current && !path.includes(ref.current)) p.onClose()
    }
    const timer = setTimeout(() => document.addEventListener("pointerdown", away, true), 50)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", away, true)
    }
  }, [p.onClose])

  const pick = (row: Row) => {
    if (row.kind === "copied") p.onCopied(row.item)
    else if (row.kind === "template") p.onTemplate(row.item)
    else p.onReply(row.item)
  }

  const askAi = async () => {
    setAiBusy(true)
    const reply = await sendBackground<FindResult | AiFailure>({
      type: "qiFind",
      query,
      templates: p.templates.map((x) => ({ id: x.id, title: x.title, keywords: x.keywords }))
    })
    setAiBusy(false)
    setAiIds(reply && reply.ok ? reply.ids : [])
  }

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const n = rows.length || 1
      setChosen((c) => (e.key === "ArrowDown" ? (c + 1) % n : (c - 1 + n) % n))
    } else if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && !e.isComposing) {
      e.preventDefault()
      if (rows[chosen]) pick(rows[chosen])
    } else if (e.key === "Escape") {
      e.preventDefault()
      p.onClose()
    }
  }

  const where = t(p.platform === "ios" ? "qiOnIphone" : p.platform === "ipados" ? "qiOnIpad" : p.platform === "macos" ? "qiOnMac" : "qiOnDevice")
  const off = siteExcluded(p.host, p.settings.copiedOffSites)
  let index = -1
  const rowClass = () => {
    index++
    return `cf-qi-row ${index === chosen && (p.at === "caret" || q) ? "on" : ""}`
  }

  return (
    <div ref={ref} class={`cf-qi ${p.at === "caret" ? "suggest" : ""}`} role="dialog" aria-label={t("qiTitle")} onPointerDown={(e) => !(e.target as Element).closest("input") && e.preventDefault()}>
      <div class="cf-qi-head">
        <input
          ref={searchRef}
          class="cf-qi-search"
          type="search"
          value={query}
          placeholder={t("qiSearch")}
          aria-label={t("qiSearch")}
          enterKeyHint="go"
          autoComplete="off"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyPress={(e) => e.stopPropagation()}
        />
        <button type="button" aria-label={t("qiNewTemplate")} title={t("qiNewTemplate")} onClick={p.onNew}><Icon.Plus /></button>
      </div>
      <div class="cf-qi-body">
        <div class="cf-qi-sec">
          <span>{t("qiCopied")}</span>
          {p.settings.copied && copied.length > 0 && !q && <button type="button" onClick={p.onClear}>{t("qiClear")}</button>}
        </div>
        {!p.settings.copied ? (
          <div class="cf-qi-empty">{t("qiCopiedOff")}</div>
        ) : copied.length === 0 ? (
          <div class="cf-qi-empty">{q ? t("qiNothing") : t("qiCopiedEmpty")}</div>
        ) : copied.map((c) => (
          <div class={rowClass()} role="button" tabIndex={-1} onClick={() => p.onCopied(c)}>
            <span class="cf-qi-main">
              <span class="cf-qi-text">{c.text.replace(/\s+/g, " ")}</span>
              <span class="cf-qi-meta">{c.host || "ContextFlow"} · {ago(c.at)}</span>
            </span>
            <button type="button" class="cf-qi-act" aria-label={t("qiToTemplate")} title={t("qiToTemplate")} onClick={(e) => { e.stopPropagation(); p.onPin(c) }}><QIcon.Pin /></button>
          </div>
        ))}

        <div class="cf-qi-sec">
          <span>{t("qiTemplates")}</span>
          {p.templates.length > 0 && <button type="button" onClick={p.onAll}>{t("qiAllTemplates")}</button>}
        </div>
        {templates.map((tpl) => (
          <button type="button" class={rowClass()} onClick={() => p.onTemplate(tpl)}><TemplateRow tpl={tpl} /></button>
        ))}
        {templates.length === 0 && (
          <div class="cf-qi-empty">
            {p.templates.length === 0 ? t("qiTemplatesEmpty") : aiIds ? t("qiNothing") : q ? t("qiNothing") : ""}
            {q && !aiIds && p.templates.length > 0 && (
              <div style={{ marginTop: "6px" }}>
                <button type="button" class="cf-secondary" disabled={aiBusy} onClick={() => void askAi()}><Icon.Sparkle size={13} /> {aiBusy ? t("qiFinding") : t("qiFindAi")}</button>
              </div>
            )}
          </div>
        )}

        {showReply && (
          <>
            <div class="cf-qi-sec"><span>{t("qiFromCf")}</span></div>
            <button type="button" class={rowClass()} onClick={() => p.onReply(reply!)}>
              <span class="cf-qi-main">
                <span class="cf-qi-text">{reply!.text.replace(/\s+/g, " ")}</span>
                <span class="cf-qi-meta">{t(reply!.note ? "qiLastNote" : "qiLastAnswer")} · {ago(reply!.at)}</span>
              </span>
            </button>
          </>
        )}
      </div>
      <div class="cf-qi-foot">
        <label class="cf-qi-keep">
          <button type="button" class="cf-qi-switch" role="switch" aria-checked={p.settings.copied} onClick={() => p.onSettings({ copied: !p.settings.copied })} />
          <span>{t("qiKeepCopied")}</span>
        </label>
        <div>
          {t("qiPrivacy", where)}{" "}
          {p.settings.copied && p.host && (
            <button type="button" onClick={() => p.onSettings({ copiedOffSites: off ? p.settings.copiedOffSites.filter((s) => s !== p.host) : [...p.settings.copiedOffSites, p.host] })}>
              {off ? t("qiKeepOnSite", p.host) : t("qiDontKeepOnSite", p.host)}
            </button>
          )}
          {/* Where the button gets in the way, it's taken away right here (not only in Settings). */}
          {p.via === "button" && p.host && (
            <>
              {" · "}
              <button type="button" onClick={() => {
                p.onSettings({ buttonOffSites: [...p.settings.buttonOffSites.filter((x) => x !== p.host), p.host].slice(-200) })
                p.onClose()
              }}>
                {t("qiHideButtonOnSite", p.host)}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
