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
import { conversationAround } from "./conversation"
import { copyToClipboard, sensitiveForm, updateCaret, type Field } from "./field"
import { caretOf, editBlocked, readText, replaceText, workRange } from "./fieldtext"
import { fieldLabel } from "./FillForm"
import * as QIcon from "./icons"
import { follow, placeBeside, placeByCaret, placeSheet } from "./place"
import { codeField } from "./trigger"
import { loadAbout, loadSamples, loadTemplates, loadUse, sendBackground } from "./store"
import { draftSpot, placedDraft, waitsFor } from "./compose"
import { askWriteWith, inTime, STORE_WAIT_MS } from "./writeAsk"

export interface WriteJob {
  action: WriteAction
  tone?: Tone
  // Compose's request, once it's asked (the person's own words, 2.7 (108)); until then the card shows its box.
  request?: string
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

/** What's written in the field, without what's skipped (Gmail's signature, a quoted mail). */
export function draftText(el: Field["el"]): string {
  const ft = readText(el)
  let rest = ft.text
  for (const sk of [...ft.skips].sort((a, b) => b.from - a.from)) rest = rest.slice(0, sk.from) + rest.slice(sk.to)
  return rest
}

/** Nothing written in the field yet: Compose's case (2.7 (108)). */
export const draftEmpty = (el: Field["el"]): boolean => !draftText(el).trim()

// ------------------------------------------------------------ the two, and the tones

/**
 * «Проверить» and «Переписать» (its tones open under it): a small menu by the circle, or a row atop the list. A field
 * with nothing written in it yet (`empty`, 2.7 (108), the owner: «Compose нужно показывать, когда окно для текста
 * пустое, вместо Rewrite») has «Написать» alone: there's nothing to check or rewrite.
 */
export function WriteMenu({ row, fixes = 0, empty = false, onFixes, onPick }: { row: boolean; fixes?: number; empty?: boolean; onFixes?: () => void; onPick: (action: WriteAction, tone?: Tone) => void }): VNode {
  const [tones, setTones] = useState(false)
  if (empty) {
    return (
      <div class={`cf-wr-menu ${row ? "row" : "pop"}`} role="menu" aria-label={t("writeCircle")}>
        <div class="cf-wr-two">
          <button type="button" role="menuitem" class="cf-wr-item" onClick={() => onPick("compose")}>
            <Icon.Pencil /> <span class="cf-wr-word">{t("writeCompose")}</span>
          </button>
        </div>
      </div>
    )
  }
  return (
    <div class={`cf-wr-menu ${row ? "row" : "pop"}`} role="menu" aria-label={t("writeCircle")}>
      <div class="cf-wr-two">
        {/* The underlined mistakes, in a list (2.7 (107)). */}
        {fixes > 0 && onFixes && (
          <button type="button" role="menuitem" class="cf-wr-item" onClick={onFixes}>
            <Icon.List /> <span class="cf-wr-word">{t("writeFixes", fixes)}</span>
          </button>
        )}
        <button type="button" role="menuitem" class="cf-wr-item" onClick={() => onPick("check")}>
          <Icon.Check /> <span class="cf-wr-word">{t("writeCheck")}</span>
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
          <Icon.Pencil /> <span class="cf-wr-word">{t("writeRewrite")}</span> <span class="cf-wr-more" aria-hidden="true"><QIcon.Chevron /></span>
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
export function WriteDot({ at, fixes, empty, onFixes, onPick }: { at: { top: number; left: number }; fixes: number; empty: () => boolean; onFixes: () => void; onPick: (action: WriteAction, tone?: Tone) => void }): VNode {
  const [open, setOpen] = useState(false)
  // Whether the field's draft is empty, read as the menu opens (Gmail's reply box holds only the signature).
  const [blank, setBlank] = useState(false)
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shown = useRef(false)
  const show = () => {
    clearTimeout(leave.current)
    if (!shown.current) {
      shown.current = true
      writeStep("menu", "circle")
    }
    if (!open) setBlank(fixes === 0 && empty())
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
      <button type="button" class="cf-qi-btn cf-wr-dot" aria-label={fixes ? `${t("writeCircle")}. ${t("writeFixes", fixes)}` : t("writeCircle")} title={open ? undefined : t("writeCircle")} aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}>
        <QIcon.Insert />
        {fixes > 0 && <span class="cf-qi-n" aria-hidden="true">{fixes > 9 ? "9+" : fixes}</span>}
      </button>
      {open && <WriteMenu row={false} fixes={fixes} empty={blank} onFixes={() => {
        setOpen(false)
        onFixes()
      }} onPick={(action, tone) => {
        setOpen(false)
        onPick(action, tone)
      }} />}
    </div>
  )
}

// ------------------------------------------------------------ the request

/**
 * The field's text with the page around it and the person's style, as /api/v2/write takes it. In a conversation the
 * request knows where the reply sits (2.7 (107)): the messages go up to the reply box, the answered one last, and the
 * ones written after it go apart (a mail answered in the middle of its thread).
 */
export async function askFor(field: Field, job: WriteJob, text: string, host: string): Promise<WriteAsk> {
  const conversation = conversationAround(field.el)
  const page = conversation
    ? { title: conversation.title || document.title, url: location.href, text: conversation.text.slice(-WRITE_LIMITS.page), conversation: true, ...(conversation.after ? { after: conversation.after } : {}) }
    : { ...pageOnce(), url: location.href, conversation: false }
  const [about, samples, templates, use] = await inTime(Promise.all([loadAbout(), loadSamples(host, text), loadTemplates(), loadUse()]), STORE_WAIT_MS)
  return {
    action: job.action,
    ...(job.tone ? { tone: job.tone } : {}),
    text,
    page: { title: page.title, url: page.url, text: page.conversation ? page.text : page.text.slice(0, WRITE_LIMITS.page), conversation: page.conversation, ...("after" in page && page.after ? { after: page.after } : {}) },
    field: fieldLabel(field),
    style: { ...(about ? { about } : {}), samples, templates: styleTemplates(templates, use, host) }
  }
}

// The page read for a field that's in no conversation: once per address for a few seconds (each paragraph's live
// check asks for it, and reading a long page takes a while on a phone).
let pageRead: { url: string; at: number; page: ReturnType<typeof extractPage> } | null = null
function pageOnce(): ReturnType<typeof extractPage> {
  if (!pageRead || pageRead.url !== location.href || Date.now() - pageRead.at > 20_000) pageRead = { url: location.href, at: Date.now(), page: extractPage() }
  return pageRead.page
}

/** A check or a rewrite asked of the background: it always ends (writeAsk.ts). */
export const askWrite = (ask: WriteAsk): { reply: Promise<WriteReply>; stop: () => void } => askWriteWith(sendBackground, ask)

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
  // Compose (2.7 (108)): the box for what to write, then the draft and where it goes in the field.
  | { step: "ask" }
  | { step: "draft"; at: number; base: string; next: string; left: number | null }
  // A rewrite asked without a tone (the panel's chip): the tones first.
  | { step: "tones" }
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
  // Another tone, from the card itself; Compose's request asked.
  onJob: (job: WriteJob) => void
  // Made: what takes it back (the toast's «Отменить»), and what it was.
  onDone: (undo: Undo | null, action: WriteAction, failed: boolean) => void
}

export function WriteCard(p: CardProps): VNode {
  const ref = useRef<HTMLDivElement>(null)
  const waits = waitsFor(p.job)
  const [state, setState] = useState<State>(waits ? { step: waits } : { step: "reading" })
  // Compose's box: the person's own words and the tone picked (none: their own style).
  const [request, setRequest] = useState(p.job.request ?? "")
  const [tone, setTone] = useState<Tone | undefined>(p.job.action === "compose" ? p.job.tone : undefined)
  const box = useRef<HTMLTextAreaElement>(null)
  const run = useRef(0)
  // The request on its way: Cancel, the ×, Esc and the card going away all stop it.
  const stopAsk = useRef<() => void>(() => undefined)
  useEffect(() => () => stopAsk.current(), [])

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
    const compose = p.job.action === "compose"
    const range = workRange(field, ft)
    const at = compose ? draftSpot(ft, caretOf(field, ft)) : 0
    const text = compose ? (p.job.request ?? "") : ft.text.slice(range.from, range.to)
    if (!compose && !text.trim()) return setState({ step: "empty" })
    if (text.length > (compose ? WRITE_LIMITS.instruction : WRITE_LIMITS.text)) {
      writeStep("too_long", p.job.via)
      return setState({ step: "long" })
    }
    writeStep(p.job.action, p.job.via, p.job.tone)
    stopAsk.current()
    let built: WriteAsk
    try {
      built = await askFor(field, p.job, text, p.host)
    } catch {
      if (id !== run.current) return
      writeStep("updated", p.job.via)
      return setState({ step: "error", code: "UPDATED" })
    }
    if (id !== run.current) return
    const asked = askWrite(built)
    stopAsk.current = asked.stop
    const reply = await asked.reply
    if (id !== run.current) return
    if (!reply.ok) {
      const code = reply.code
      if (code === "STOPPED") return
      if (code === "CONSENT") return setState({ step: "consent" })
      if (code === "LIMIT_REACHED") {
        writeStep("limit", p.job.via)
        return setState({ step: "limit" })
      }
      if (code === "TOO_LONG") return setState({ step: "long" })
      writeStep(code === "SLOW" ? "slow" : "error", p.job.via)
      return setState({ step: "error", code })
    }
    const left = freeLeft(reply, p.free)
    if (compose) {
      writeStep("shown", p.job.via, p.job.tone ?? "compose")
      return setState({ step: "draft", at, base: ft.text, next: reply.text.trim(), left })
    }
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
    const w = waitsFor(p.job)
    if (w) return setState({ step: w })
    void ask()
  }, [p.job.action, p.job.tone, p.job.request])
  // The box takes the caret where a keyboard is at hand; on a phone or a tablet the person taps it (iOS raises the
  // keyboard only in a tap).
  useEffect(() => {
    if (state.step === "ask" && !p.touch) box.current?.focus({ preventScroll: true })
  }, [state.step])

  const compose = () => {
    const words = request.trim()
    if (!words) return box.current?.focus()
    p.onJob({ action: "compose", ...(tone ? { tone } : {}), request: words, via: p.job.via })
  }

  const apply = async () => {
    if (state.step !== "check" && state.step !== "rewrite" && state.step !== "draft") return
    const el = p.field.el
    // Typed on since (or the field went): the changes would land on other words.
    if (!el.isConnected || readText(el).text !== state.base) {
      writeStep("changed", p.job.via)
      return setState({ step: "changed" })
    }
    const edits = state.step === "check"
      ? state.edits.map((e) => ({ from: state.from + e.from, to: state.from + e.to, text: e.text }))
      : state.step === "draft"
        ? [{ from: state.at, to: state.at, text: placedDraft(state.base, state.at, state.next) }]
        : [{ from: state.from, to: state.to, text: state.next }]
    const action = p.job.action
    const made = state.step === "check" ? applyEdits(state.text, state.edits) : state.next
    setState({ step: "applying" })
    const result = await makeEdits(el, edits)
    writeStep(result.failed ? "failed" : "applied", p.job.via, action === "check" ? "check" : action === "compose" ? (p.job.tone ?? "compose") : p.job.tone)
    if (!result.back.length) {
      // The field took none of it: the text is copied, to paste by hand.
      await copyToClipboard(made)
      writeStep("manual", p.job.via)
      return p.onDone(null, action, true)
    }
    p.onDone({ el, after: result.after, back: result.back }, action, result.failed > 0)
  }

  const head = p.job.action === "check"
    ? t("writeCheck")
    : p.job.action === "compose"
      ? (p.job.request !== undefined && p.job.tone ? `${t("writeCompose")}: ${t(TONE_KEY[p.job.tone]).toLowerCase()}` : t("writeCompose"))
      : p.job.tone ? `${t("writeRewrite")}: ${t(TONE_KEY[p.job.tone]).toLowerCase()}` : t("writeRewrite")

  return (
    <div
      ref={ref}
      class={`cf-qi cf-wr ${p.sheet ? "" : "suggest"}`}
      role="dialog"
      aria-label={head}
      // The field keeps the focus, except for Compose's own box.
      onPointerDown={(e) => !(e.target as Element).closest("textarea") && e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") p.onClose()
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyPress={(e) => e.stopPropagation()}
    >
      <div class="cf-qi-fill-head">
        <span><Icon.Sparkle size={14} /> {head}</span>
        <button type="button" class="cf-qi-x" aria-label={t("close")} title={t("close")} onClick={p.onClose}><Icon.Close /></button>
      </div>
      <div class="cf-wr-body">
        {state.step === "reading" && (
          <div class="cf-wr-note"><span class="cf-add-dots"><span /><span /><span /></span> {t(p.job.action === "check" ? "writeChecking" : p.job.action === "compose" ? "writeComposing" : "writeRewriting")}</div>
        )}
        {state.step === "ask" && (
          <>
            <textarea
              ref={box}
              class="cf-wr-ask"
              rows={3}
              dir="auto"
              value={request}
              placeholder={t("writeComposeHint")}
              aria-label={t("writeComposeHint")}
              maxLength={WRITE_LIMITS.instruction}
              onInput={(e) => setRequest(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter writes where there's a keyboard of keys; Shift+Enter, and a phone's return, break the line.
                if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !p.touch) {
                  e.preventDefault()
                  compose()
                }
              }}
            />
            <div class="cf-wr-tones inline" role="group" aria-label={t("writeToneAsk")}>
              {TONES.map((one) => (
                <button type="button" class={`cf-wr-tone ${tone === one ? "on" : ""}`} aria-pressed={tone === one} onClick={() => setTone(tone === one ? undefined : one)}>{t(TONE_KEY[one])}</button>
              ))}
            </div>
          </>
        )}
        {state.step === "tones" && (
          <>
            <div class="cf-wr-note">{t("writeToneAsk")}</div>
            <div class="cf-wr-tones inline" role="group" aria-label={t("writeRewrite")}>
              {TONES.map((one) => (
                <button type="button" class="cf-wr-tone" onClick={() => p.onJob({ action: "rewrite", tone: one, via: p.job.via })}>{t(TONE_KEY[one])}</button>
              ))}
            </div>
          </>
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
        {(state.step === "rewrite" || state.step === "draft") && (
          <>
            <div class="cf-wr-text" dir="auto">{state.next}</div>
            {state.left !== null && <div class="cf-wr-meta">{t("writeLeft", state.left)}</div>}
            <div class="cf-wr-tones inline" role="group" aria-label={t(state.step === "draft" ? "writeToneAsk" : "writeRewrite")}>
              {TONES.filter((one) => one !== p.job.tone).map((one) => (
                <button type="button" class="cf-wr-tone" onClick={() => p.onJob({ ...p.job, tone: one })}>{t(TONE_KEY[one])}</button>
              ))}
              {/* Compose: back to the box, the words kept, to say it differently. */}
              {state.step === "draft" && (
                <button type="button" class="cf-wr-tone" onClick={() => p.onJob({ action: "compose", ...(p.job.tone ? { tone: p.job.tone } : {}), via: p.job.via })}>{t("writeComposeEdit")}</button>
              )}
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
        {state.step === "error" && state.code === "UPDATED" && (
          <div class="cf-wr-note">
            {t("writeUpdated")}{" "}
            <button type="button" class="cf-link" onClick={() => location.reload()}>{t("writeReload")}</button>
          </div>
        )}
        {state.step === "error" && state.code !== "UPDATED" && (
          <div class="cf-wr-note">
            {t(state.code === "NETWORK" ? "errNetwork" : state.code === "BUSY" ? "errBusy" : state.code === "SLOW" ? "writeSlow" : "errUpstream")}{" "}
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
      {(state.step === "check" || state.step === "rewrite" || state.step === "draft") && (
        <div class="cf-qi-fill-row cf-wr-row">
          <button type="button" class="cf-primary" onClick={() => void apply()}>{t(state.step === "check" ? "writeFix" : state.step === "draft" ? "qiInsert" : "writeReplace")}</button>
          <button type="button" class="cf-link" onClick={p.onClose}>{t("close")}</button>
        </div>
      )}
      {state.step === "ask" && (
        <div class="cf-qi-fill-row cf-wr-row">
          <button type="button" class="cf-primary" disabled={!request.trim()} onClick={compose}>{t("writeComposeGo")}</button>
          <button type="button" class="cf-link" onClick={p.onClose}>{t("cancel")}</button>
        </div>
      )}
      {/* While it's asked: Cancel, in the thumb's reach (the × is at the card's top). The request is dropped. */}
      {state.step === "reading" && (
        <div class="cf-qi-fill-row cf-wr-row">
          <button type="button" class="cf-secondary" onClick={() => {
            writeStep("cancel", p.job.via)
            p.onClose()
          }}>{t("cancel")}</button>
        </div>
      )}
    </div>
  )
}
