// «Проверить» и «Переписать» by a field (2.7, plan section 13). Unlike Apple's Writing Tools, which see only the field,
// these read the page the text is written on too: the conversation around the field (the email being answered, the
// chat), else the page (the post under a comment, the job under an application); and they write in the person's own
// style («О себе», their templates, how they wrote on this site before; store.ts keeps that on this device).
// - On a Mac: a circle above the field once there's text in it; pointing at it opens «Проверить» and «Переписать»
//   (with its tones). On iPhone and iPad: the same two atop quick insert's list, which the field's button opens.
// - The result shows by the field (a sheet on iPhone): a check's changes marked word by word, «Исправить» makes them
//   on those words only (fieldtext.ts); a rewrite, «Заменить». Either can be undone right after.
// - A tap is one answer (the server counts it). Passwords, cards and payment fields are never read.

import type { VNode } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"

import type { ConsentStatus } from "../../shared/consent"
import { t, type MessageKey } from "../../shared/i18n"
import { applyEdits, diffParts, diffWords, freeLeft, styleTemplates, TONES, WRITE_LIMITS, type Edit, type Tone, type WriteAction, type WriteAsk, type WriteReply } from "../../shared/writing"
import { ConsentCard } from "../Consent"
import * as Icon from "../icons"
import { extractPage } from "../page"
import { conversationAround, conversationText } from "./conversation"
import { copyToClipboard, sensitiveForm, updateCaret, type Field } from "./field"
import { editBlocked, readText, replaceText, workRange } from "./fieldtext"
import { fieldLabel } from "./FillForm"
import * as QIcon from "./icons"
import { follow, placeBeside, placeByCaret, placeSheet } from "./place"
import { codeField } from "./trigger"
import { loadAbout, loadSamples, loadTemplates, loadUse, sendBackground } from "./store"

export interface WriteJob {
  action: WriteAction
  tone?: Tone
  // "panel": the panel's chip (2.7, quiet/chips.ts).
  via: "circle" | "list" | "panel"
}

/** What a change did, to take it back: the field's text right after, and the changes that undo it. */
export interface Undo {
  el: Field["el"]
  after: string
  back: Edit[]
}

const TONE_KEY: Record<Tone, MessageKey> = { short: "writeToneShort", warm: "writeToneWarm", formal: "writeToneFormal", confident: "writeToneConfident" }

/** A use of «Проверить» и «Переписать», counted (usage.ts "write"): never the text, the page or the site. */
export function writeStep(a: string, via?: WriteJob["via"] | "underline", what?: string): void {
  void sendBackground({ type: "useEvent", f: "write", a, ...(via ? { via } : {}), ...(what ? { what } : {}) })
}

/**
 * A field these work in: a password, a card, a payment form's field or code never; nor an editor that draws its text
 * itself (Google Docs takes the typing in a hidden box: its text isn't there to read or change).
 */
export function writableField(el: Element): boolean {
  if (sensitiveForm(el) || codeField(el)) return false
  if (/^docs\.google\.com$/i.test(el.ownerDocument.location?.hostname ?? location.hostname)) return false
  if (el.ownerDocument.defaultView?.frameElement?.classList?.contains("docs-texteventtarget-iframe")) return false
  const r = el.getBoundingClientRect()
  return r.width >= 40 && r.height >= 14
}

// ------------------------------------------------------------ the two, and the tones

/** «Проверить» and «Переписать» (its tones open under it): a small menu by the circle, or a row atop the list. */
export function WriteMenu({ row, onPick }: { row: boolean; onPick: (action: WriteAction, tone?: Tone) => void }): VNode {
  const [tones, setTones] = useState(false)
  return (
    <div class={`cf-wr-menu ${row ? "row" : "pop"}`} role="menu" aria-label={t("writeCircle")}>
      <div class="cf-wr-two">
        <button type="button" role="menuitem" class="cf-wr-item" onClick={() => onPick("check")}>
          <Icon.Check /> {t("writeCheck")}
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={tones}
          class={`cf-wr-item ${tones ? "on" : ""}`}
          // A Mac: pointing at it opens the tones; a tap (and a click) too.
          onPointerEnter={(e) => e.pointerType === "mouse" && setTones(true)}
          onClick={() => setTones(!tones)}
        >
          <Icon.Pencil /> {t("writeRewrite")} <span class="cf-wr-more" aria-hidden="true">›</span>
        </button>
      </div>
      {tones && (
        <div class="cf-wr-tones" role="group" aria-label={t("writeRewrite")}>
          {TONES.map((tone) => (
            <button type="button" role="menuitem" class="cf-wr-tone" onClick={() => onPick("rewrite", tone)}>{t(TONE_KEY[tone])}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The circle above the field on a Mac (spot.ts places it as the iPhone's button). Pointing at it, or clicking it, opens
 * the menu; it closes a moment after the pointer leaves both. The field keeps the focus throughout.
 */
export function WriteDot({ at, onPick }: { at: { top: number; left: number }; onPick: (action: WriteAction, tone?: Tone) => void }): VNode {
  const [open, setOpen] = useState(false)
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shown = useRef(false)
  const show = () => {
    clearTimeout(leave.current)
    if (!shown.current) {
      shown.current = true
      writeStep("menu", "circle")
    }
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(leave.current)
    leave.current = setTimeout(() => setOpen(false), 350)
  }
  useEffect(() => () => clearTimeout(leave.current), [])
  return (
    <div
      class="cf-wr-dot-wrap"
      style={{ top: `${at.top}px`, left: `${at.left}px` }}
      onPointerEnter={show}
      onPointerLeave={hide}
      // The field keeps the focus (and its caret) while the circle and the menu are used.
      onPointerDown={(e) => e.preventDefault()}
    >
      <button type="button" class="cf-qi-btn cf-wr-dot" aria-label={t("writeCircle")} title={open ? undefined : t("writeCircle")} aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}>
        <QIcon.Insert />
      </button>
      {open && <WriteMenu row={false} onPick={(action, tone) => {
        setOpen(false)
        onPick(action, tone)
      }} />}
    </div>
  )
}

// ------------------------------------------------------------ the request

/** The field's text with the page around it and the person's style, as /api/v2/write takes it. */
export async function askFor(field: Field, job: WriteJob, text: string, host: string): Promise<WriteAsk> {
  const conversation = conversationAround(field.el)
  const page = conversation
    ? { title: conversation.title || document.title, url: location.href, text: conversationText(conversation), conversation: true }
    : { ...extractPage(), url: location.href, conversation: false }
  const [about, samples, templates, use] = await Promise.all([loadAbout(), loadSamples(host, text), loadTemplates(), loadUse()])
  return {
    action: job.action,
    ...(job.tone ? { tone: job.tone } : {}),
    text,
    page: { title: page.title, url: page.url, text: page.text.slice(0, WRITE_LIMITS.page), conversation: page.conversation },
    field: fieldLabel(field),
    style: { ...(about ? { about } : {}), samples, templates: styleTemplates(templates, use, host) }
  }
}

/**
 * Makes `edits` (on the field's text as it is now, in order, not overlapping), the last one first so the earlier ones'
 * places hold. Returns the changes that take them back (on the text as it ends up) and how many didn't go in.
 */
export async function makeEdits(el: Field["el"], edits: Edit[]): Promise<{ back: Edit[]; failed: number; after: string }> {
  const done: Array<{ edit: Edit; was: string; end: number }> = []
  let failed = 0
  for (const e of [...edits].reverse()) {
    const before = readText(el).text
    if (!(await replaceText(el, e.from, e.to, e.text))) {
      failed++
      continue
    }
    const after = readText(el).text
    done.unshift({ edit: e, was: before.slice(e.from, e.to), end: after.length - (before.length - e.to) })
  }
  // Each change's place once all are made: the changes before it moved it by what they added or took away.
  const back: Edit[] = []
  let shift = 0
  for (const d of done) {
    back.push({ from: d.edit.from + shift, to: d.end + shift, text: d.was })
    shift += d.end - d.edit.to
  }
  return { back, failed, after: readText(el).text }
}

/** Takes a change back, if the field is still as the change left it. */
export async function undoEdits(u: Undo): Promise<boolean> {
  if (!u.el.isConnected || readText(u.el).text !== u.after) return false
  const result = await makeEdits(u.el, u.back)
  return result.failed === 0
}

// ------------------------------------------------------------ the result

type State =
  | { step: "reading" }
  | { step: "check"; text: string; from: number; to: number; base: string; edits: Edit[]; left: number | null }
  | { step: "rewrite"; text: string; from: number; to: number; base: string; next: string; left: number | null }
  | { step: "clean"; left: number | null }
  | { step: "consent" }
  | { step: "limit" }
  | { step: "long" }
  | { step: "empty" }
  | { step: "changed" }
  | { step: "error"; code: string }
  | { step: "applying" }

export interface CardProps {
  job: WriteJob
  field: Field
  host: string
  touch: boolean
  sheet: boolean
  consent: ConsentStatus
  onConsent: () => Promise<void>
  free: boolean
  onUpgrade: () => void
  onClose: () => void
  // Another tone, from the card itself.
  onJob: (job: WriteJob) => void
  // Made: what takes it back (the toast's «Отменить»), and what it was.
  onDone: (undo: Undo | null, action: WriteAction, failed: boolean) => void
}

export function WriteCard(p: CardProps): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>({ step: "reading" })
  const run = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    return follow(el, () => placeBeside(el, p.field, p.touch, 400, 520) || (p.sheet ? placeSheet(el, p.touch, 560) : placeByCaret(el, p.field, p.touch, 400)))
  })

  const ask = async () => {
    const id = ++run.current
    setState({ step: "reading" })
    const field = updateCaret(p.field)
    const ft = readText(field.el)
    const range = workRange(field, ft)
    const text = ft.text.slice(range.from, range.to)
    if (!text.trim()) return setState({ step: "empty" })
    if (text.length > WRITE_LIMITS.text) {
      writeStep("too_long", p.job.via)
      return setState({ step: "long" })
    }
    writeStep(p.job.action, p.job.via, p.job.tone)
    const reply = await sendBackground<WriteReply>({ type: "qiWrite", ask: await askFor(field, p.job, text, p.host) })
    if (id !== run.current) return
    if (!reply || !reply.ok) {
      const code = reply?.code ?? "NETWORK"
      if (code === "CONSENT") return setState({ step: "consent" })
      if (code === "LIMIT_REACHED") {
        writeStep("limit", p.job.via)
        return setState({ step: "limit" })
      }
      if (code === "TOO_LONG") return setState({ step: "long" })
      writeStep("error", p.job.via)
      return setState({ step: "error", code })
    }
    const left = freeLeft(reply, p.free)
    if (p.job.action === "check") {
      // Changes that cross a paragraph or touch what the editor won't let change are left out.
      const edits = diffWords(text, reply.text).filter((e) => !editBlocked(ft, range.from + e.from, range.from + e.to))
      if (!edits.length) {
        writeStep("clean", p.job.via)
        return setState({ step: "clean", left })
      }
      writeStep("shown", p.job.via, "check")
      return setState({ step: "check", text, from: range.from, to: range.to, base: ft.text, edits, left })
    }
    writeStep("shown", p.job.via, p.job.tone)
    setState({ step: "rewrite", text, from: range.from, to: range.to, base: ft.text, next: reply.text.trim(), left })
  }
  useEffect(() => {
    void ask()
  }, [p.job.action, p.job.tone])

  const apply = async () => {
    if (state.step !== "check" && state.step !== "rewrite") return
    const el = p.field.el
    // Typed on since (or the field went): the changes would land on other words.
    if (!el.isConnected || readText(el).text !== state.base) {
      writeStep("changed", p.job.via)
      return setState({ step: "changed" })
    }
    const edits = state.step === "check"
      ? state.edits.map((e) => ({ from: state.from + e.from, to: state.from + e.to, text: e.text }))
      : [{ from: state.from, to: state.to, text: state.next }]
    const action = p.job.action
    setState({ step: "applying" })
    const result = await makeEdits(el, edits)
    writeStep(result.failed ? "failed" : "applied", p.job.via, action === "rewrite" ? p.job.tone : "check")
    if (!result.back.length) {
      // The field took none of it: the text is copied, to paste by hand.
      await copyToClipboard(state.step === "check" ? applyEdits(state.text, state.edits) : state.next)
      writeStep("manual", p.job.via)
      return p.onDone(null, action, true)
    }
    p.onDone({ el, after: result.after, back: result.back }, action, result.failed > 0)
  }

  const head = p.job.action === "check" ? t("writeCheck") : `${t("writeRewrite")}: ${t(TONE_KEY[p.job.tone ?? "short"]).toLowerCase()}`

  return (
    <div
      ref={ref}
      class={`cf-qi cf-wr ${p.sheet ? "" : "suggest"}`}
      role="dialog"
      aria-label={head}
      onPointerDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") p.onClose()
      }}
    >
      <div class="cf-qi-fill-head">
        <span><Icon.Sparkle size={14} /> {head}</span>
        <button type="button" class="cf-qi-x" aria-label={t("close")} title={t("close")} onClick={p.onClose}><Icon.Close /></button>
      </div>
      <div class="cf-wr-body">
        {state.step === "reading" && (
          <div class="cf-wr-note"><span class="cf-add-dots"><span /><span /><span /></span> {t(p.job.action === "check" ? "writeChecking" : "writeRewriting")}</div>
        )}
        {state.step === "check" && (
          <>
            <div class="cf-wr-text" dir="auto">
              {diffParts(state.text, state.edits).map((part) =>
                "same" in part ? <span>{part.same}</span> : <>{part.was && <del>{part.was}</del>}{part.now && <ins>{part.now}</ins>}</>
              )}
            </div>
            <div class="cf-wr-meta">{t("writeFixes", state.edits.length)}{state.left !== null ? ` · ${t("writeLeft", state.left)}` : ""}</div>
          </>
        )}
        {state.step === "rewrite" && (
          <>
            <div class="cf-wr-text" dir="auto">{state.next}</div>
            {state.left !== null && <div class="cf-wr-meta">{t("writeLeft", state.left)}</div>}
            <div class="cf-wr-tones inline" role="group" aria-label={t("writeRewrite")}>
              {TONES.filter((tone) => tone !== p.job.tone).map((tone) => (
                <button type="button" class="cf-wr-tone" onClick={() => p.onJob({ action: "rewrite", tone, via: p.job.via })}>{t(TONE_KEY[tone])}</button>
              ))}
            </div>
          </>
        )}
        {state.step === "clean" && <div class="cf-wr-note">✓ {t("writeClean")}{state.left !== null ? ` ${t("writeLeft", state.left)}` : ""}</div>}
        {state.step === "empty" && <div class="cf-wr-note">{t("writeEmpty")}</div>}
        {state.step === "long" && <div class="cf-wr-note">{t("writeTooLong")}</div>}
        {state.step === "changed" && (
          <div class="cf-wr-note">{t("writeChanged")} <button type="button" class="cf-link" onClick={() => void ask()}>{t("retry")}</button></div>
        )}
        {state.step === "applying" && <div class="cf-wr-note"><span class="cf-add-dots"><span /><span /><span /></span></div>}
        {state.step === "error" && (
          <div class="cf-wr-note">
            {t(state.code === "NETWORK" ? "errNetwork" : state.code === "BUSY" ? "errBusy" : "errUpstream")}{" "}
            <button type="button" class="cf-link" onClick={() => void ask()}>{t("retry")}</button>
          </div>
        )}
        {state.step === "limit" && (
          <div class="cf-card">
            <p>{t(p.free ? "limitFreeTitle" : "limitProTitle")}</p>
            {p.free && (
              <div class="cf-card-actions">
                <button type="button" class="cf-primary" onClick={() => {
                  writeStep("plans", p.job.via)
                  p.onUpgrade()
                }}><Icon.Sparkle size={14} /> {t("tryPro")}</button>
              </div>
            )}
          </div>
        )}
        {state.step === "consent" && (
          <ConsentCard again={p.consent === "old"} onAccept={() => {
            writeStep("consent", p.job.via)
            void p.onConsent().then(ask)
          }} onDecline={p.onClose} />
        )}
      </div>
      {(state.step === "check" || state.step === "rewrite") && (
        <div class="cf-qi-fill-row cf-wr-row">
          <button type="button" class="cf-primary" onClick={() => void apply()}>{t(state.step === "check" ? "writeFix" : "writeReplace")}</button>
          <button type="button" class="cf-link" onClick={p.onClose}>{t("close")}</button>
        </div>
      )}
    </div>
  )
}
