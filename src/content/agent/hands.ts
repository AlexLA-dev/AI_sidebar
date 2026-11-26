// The agent's hands (2.7.1): one checked call (shared/agent/call.ts) done on the page, then a wait for the page to
// settle. Everything is a plain DOM event: Safari gives extensions no trusted clicks or keys (isTrusted is false),
// so a widget that insists on a real finger gets the person instead ("this step is yours").
// - Fields are typed into without focus (the iPhone keyboard would come up and move the page): the value goes in
//   through the element's own setter and `input`/`change` events, as React, Vue and plain pages all hear it.
//   Editors (contenteditable) need the caret: they get it for the moment of typing, through fieldtext.ts.
// - A field's, a checkbox's and a list's earlier value is kept for «Отменить».
// - Secret fields are refused here too, whatever the server said.

import { sameOption } from "../../shared/agent/call"
import { controlChanged } from "../../shared/agent/expect"
import type { StepResult, ToolCall } from "../../shared/agent/types"
import { readText, replaceText } from "../insert/fieldtext"
import { elementOf, markFilled, nameOf, roleOf } from "./map"
import { catchNewTab } from "./newtab"
import { hostOf, sameSite } from "../../shared/agent/sites"
import { fieldLock } from "../../shared/agent/fields"

const SETTLE_QUIET_MS = 350
const SETTLE_MAX_MS = 4000
const EXTRACT_MAX = 12_000

function tag(el: Element): string {
  return el.tagName.toLowerCase()
}

export interface Watch {
  /** Waits until the page stops changing (or maxMs): whether it changed since the watch began, and whether it went elsewhere. */
  settle(quietMs?: number, maxMs?: number): Promise<{ changed: boolean; navigated: boolean }>
}

/**
 * Starts watching the page for changes. Begun before a step, so what the step changes at once (a list opening in the
 * click itself) counts: a watch begun after it would see a quiet page and say nothing changed.
 */
export function watch(doc: Document = document): Watch {
  const startUrl = doc.location?.href ?? ""
  const view = doc.defaultView ?? window
  let changed = false
  let gone = false
  let last = Date.now()
  // (Not the agent's own marks: the script and the attributes that watch a page's new tab during a tap, 129 — with them
  // every tap read «the page changed».)
  const observer = new view.MutationObserver((records) => {
    if (records.every(ownMark)) return
    changed = true
    last = Date.now()
  })
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  const onGone = () => {
    gone = true
  }
  view.addEventListener("pagehide", onGone)
  return {
    settle(quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS) {
      const t0 = Date.now()
      return new Promise((resolve) => {
        const tick = () => {
          const now = Date.now()
          if (gone || (now - last >= quietMs && now - t0 >= Math.min(quietMs, 150)) || now - t0 >= maxMs) {
            observer.disconnect()
            view.removeEventListener("pagehide", onGone)
            resolve({ changed: changed || gone, navigated: gone || (doc.location?.href ?? "") !== startUrl })
          } else setTimeout(tick, 50)
        }
        setTimeout(tick, 50)
      })
    }
  }
}

// The watch of the step being done (act() begins it before the step, on the document the element is in).
let current: Watch | null = null

function stepSettle(quietMs?: number, maxMs?: number): Promise<{ changed: boolean; navigated: boolean }> {
  const w = current ?? watch(document)
  current = null
  return w.settle(quietMs, maxMs)
}

/** Waits for a quiet page from now on (no step before it). */
export function settle(doc: Document = document, quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS): Promise<{ changed: boolean; navigated: boolean }> {
  return watch(doc).settle(quietMs, maxMs)
}

function inView(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView ?? window
  return r.bottom > 0 && r.top < view.innerHeight && r.right > 0 && r.left < view.innerWidth
}

function reveal(el: Element): void {
  if (!inView(el)) (el as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest" })
}

/** A control that sends its form (a submit button or input, a button with no type inside a form). */
function submitsForm(el: Element): boolean {
  const form = (el as HTMLButtonElement).form ?? el.closest?.("form")
  if (!form) return false
  const t = tag(el)
  const type = (el.getAttribute("type") ?? (t === "button" ? "submit" : "")).toLowerCase()
  return (t === "button" || t === "input") && (type === "submit" || type === "image")
}

/** A change that is only the agent's own: its watching script added or removed, or one of its data-cf- attributes. */
export function ownMark(r: MutationRecord): boolean {
  if (r.type === "attributes") return !!r.attributeName?.startsWith("data-cf-")
  if (r.type !== "childList") return false
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]
  return nodes.length > 0 && nodes.every((n) => (n as Element).hasAttribute?.("data-cf-shim"))
}

/** A press the way a page hears a finger or a mouse: pointer and mouse down and up, then the click itself. */
export function press(el: Element): void {
  // A link of this site that would open a new tab opens here: the agent works in its own tab (a restaurant site's restaurant
  // cards opened tabs it never saw). Another site's link keeps its own way (that's classed apart).
  const a = el.closest?.("a[href][target]") as HTMLAnchorElement | null
  const target = a?.getAttribute("target") ?? ""
  if (a && target && target !== "_self" && sameSite(hostOf(a.href), hostOf(el.ownerDocument.location?.href ?? ""))) {
    a.setAttribute("target", "_self")
    setTimeout(() => a.isConnected && a.setAttribute("target", target), 1500)
  }
  const view = el.ownerDocument.defaultView ?? window
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view }
  const pointer = view.PointerEvent ? (type: string, buttons: number) => new view.PointerEvent(type, { ...at, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true }) : null
  if (pointer) el.dispatchEvent(pointer("pointerover", 0))
  el.dispatchEvent(new view.MouseEvent("mouseover", at))
  if (pointer) el.dispatchEvent(pointer("pointerdown", 1))
  el.dispatchEvent(new view.MouseEvent("mousedown", { ...at, buttons: 1 }))
  if (pointer) el.dispatchEvent(pointer("pointerup", 0))
  el.dispatchEvent(new view.MouseEvent("mouseup", at))
  // click() does what the element itself does on a click (a link goes, a checkbox ticks, a form sends).
  if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click()
  else el.dispatchEvent(new view.MouseEvent("click", at))
}

function lockOf(el: Element): ReturnType<typeof fieldLock> {
  const role = roleOf(el)
  if (!role) return null
  const input = el as HTMLInputElement
  return fieldLock({ tag: tag(el), type: tag(el) === "input" ? input.type : undefined, autocomplete: el.getAttribute("autocomplete") ?? "", name: el.getAttribute("name") ?? "", id: el.id, label: nameOf(el, role) })
}

/** Sets an input's or a textarea's value through its own setter (frameworks track values set any other way). */
function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = el.ownerDocument.defaultView ?? window
  const proto = tag(el) === "textarea" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

async function typeInto(el: Element, text: string, mode: "replace" | "append"): Promise<StepResult> {
  const view = el.ownerDocument.defaultView ?? window
  if (tag(el) === "input" || tag(el) === "textarea") {
    const field = el as HTMLInputElement
    const before = field.value
    const value = mode === "append" && before ? `${before}${/\s$/.test(before) ? "" : " "}${text}` : text
    el.dispatchEvent(new view.FocusEvent("focusin", { bubbles: true, composed: true }))
    el.dispatchEvent(new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Unidentified" }))
    setNative(field, value)
    el.dispatchEvent(new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }))
    el.dispatchEvent(new view.KeyboardEvent("keyup", { bubbles: true, cancelable: true, composed: true, key: "Unidentified" }))
    el.dispatchEvent(new view.Event("change", { bubbles: true }))
    el.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true, composed: true }))
    const settled = await stepSettle(200, 1500)
    const now = field.value
    const note = now === value ? "typed" : now ? `typed; the field shows "${now.slice(0, 80)}"` : "the field didn't take the text"
    return { ok: !!now || !value, note, changed: settled.changed || now !== before, navigated: settled.navigated, undo: { id: "", kind: "value", before } }
  }
  // An editor: typed at its caret as the person would, the editor's own undo works.
  const html = el as HTMLElement
  const ft = readText(html)
  const before = ft.text
  const from = mode === "append" ? ft.text.length : 0
  const piece = mode === "append" && before && !/\s$/.test(before) ? ` ${text}` : text
  let ok = await replaceText(html, from, ft.text.length, piece)
  // An empty editor has no text node to put the caret in: the caret goes into the editor itself, then typing.
  if (!ok && (!before.trim() || mode === "append")) ok = await typeAtEnd(html, piece, mode === "replace")
  html.blur?.()
  const settled = await stepSettle(200, 1500)
  return { ok, note: ok ? "typed" : "the editor didn't take the text", changed: settled.changed, navigated: settled.navigated, undo: { id: "", kind: "value", before } }
}

/** Types into an editor with the caret at its end (all of it selected first when `replace`). */
async function typeAtEnd(el: HTMLElement, text: string, replace: boolean): Promise<boolean> {
  const doc = el.ownerDocument
  const view = doc.defaultView ?? window
  el.focus({ preventScroll: true })
  const range = doc.createRange()
  range.selectNodeContents(el)
  if (!replace) range.collapse(false)
  const sel = view.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  try {
    doc.execCommand("insertText", false, text)
  } catch {
    return false
  }
  await settle(doc, 100, 800)
  return (el.textContent ?? "").includes(text.trim())
}

async function choose(el: Element, asked: string): Promise<StepResult> {
  const view = el.ownerDocument.defaultView ?? window
  // The map's own mark on an option isn't part of its text.
  const option = asked.replace(/\s*\[unavailable\]\s*$/, "")
  if (tag(el) === "select") {
    const select = el as HTMLSelectElement
    const before = select.value
    const match = Array.from(select.options).find((o) => sameOption(o.textContent ?? "", option) || sameOption(o.value, option))
    if (!match) return { ok: false, note: `no option "${option}"` }
    // An option the page doesn't let be chosen (a full time in a dropdown) isn't set behind its back.
    if (match.disabled || match.hasAttribute("disabled")) return { ok: false, note: `"${option}" can't be chosen on the page (unavailable): choose another the rules allow, or ask with the page's real options` }
    select.value = match.value
    match.selected = true
    select.dispatchEvent(new view.Event("input", { bubbles: true }))
    select.dispatchEvent(new view.Event("change", { bubbles: true }))
    const settled = await stepSettle()
    return { ok: select.value === match.value, note: `chose "${(match.textContent ?? "").trim().slice(0, 60)}"`, changed: true, navigated: settled.navigated, undo: { id: "", kind: "select", before } }
  }
  // A list of the page's own (ARIA): its option is pressed.
  const options = Array.from(el.querySelectorAll("[role=option], [role=radio], [role=menuitemradio], input[type=radio]"))
  const match = options.find((o) => sameOption(nameOf(o, roleOf(o) ?? "option"), option))
  if (!match) return { ok: false, note: `no option "${option}" shown: open the list first (click it), then click the option` }
  reveal(match)
  press(match)
  const settled = await stepSettle()
  return { ok: true, note: "chose it", changed: settled.changed, navigated: settled.navigated }
}

function scrollPage(doc: Document, to: "up" | "down"): void {
  const view = doc.defaultView ?? window
  const by = Math.round(view.innerHeight * 0.8) * (to === "up" ? -1 : 1)
  const root = doc.scrollingElement ?? doc.documentElement
  if (root.scrollHeight > root.clientHeight + 10) {
    view.scrollBy({ top: by, behavior: "instant" as ScrollBehavior })
    return
  }
  // The page scrolls inside a box of its own (app-like sites): the biggest one under the middle of the screen.
  for (let e = doc.elementFromPoint(view.innerWidth / 2, view.innerHeight / 2); e; e = e.parentElement) {
    const style = view.getComputedStyle(e)
    if (/(auto|scroll)/.test(style.overflowY) && e.scrollHeight > e.clientHeight + 10) {
      e.scrollBy({ top: by })
      return
    }
  }
}

/** The page's text for an answer: tables as rows of cells, the main part when the page marks one. */
export function pageData(doc: Document = document): string {
  const main = doc.querySelector("main, [role=main], article") ?? doc.body
  const html = main as HTMLElement
  const text = typeof html.innerText === "string" && html.innerText ? html.innerText : main.textContent ?? ""
  return text.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[  ]{2,}/g, " ").trim().slice(0, EXTRACT_MAX)
}

// The control a step is about, for the panel's ring on the page (the person sees what the agent does). Shown a moment
// before the step, so the eye gets there first.
type TargetListener = (el: Element | null) => void
const targetListeners = new Set<TargetListener>()
const SHOW_FIRST_MS = 350

export function onTarget(f: TargetListener): () => void {
  targetListeners.add(f)
  return () => targetListeners.delete(f)
}

export function announceTarget(el: Element | null): void {
  for (const f of targetListeners) f(el)
}

// What a page says after a step: its alerts, statuses and live regions, and the usual error boxes.
const MESSAGES = "[role=alert], [role=status], [aria-live=assertive], [aria-live=polite], .error, .errors, .invalid-feedback, .field-error, .form-error, [aria-invalid=true] ~ *"

function messages(doc: Document): string[] {
  return Array.from(doc.querySelectorAll(MESSAGES))
    .map((m) => ((m as HTMLElement).innerText ?? m.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
}

/** Does one checked call on the page, and says what the page said after it (new messages, errors). */
export async function act(call: ToolCall, doc: Document = document): Promise<StepResult> {
  const before = new Set(messages(doc))
  const target = call.id ? elementOf(call.id) : null
  if (target && call.tool !== "extract" && call.tool !== "read_page" && targetListeners.size) {
    reveal(target)
    announceTarget(target)
    await new Promise((r) => setTimeout(r, SHOW_FIRST_MS))
  }
  current = watch(target?.ownerDocument ?? doc)
  const result = await actOnly(call, doc)
  current = null
  if (!result.navigated && call.tool !== "extract" && call.tool !== "read_page") {
    const said = messages(doc).filter((m) => !before.has(m)).slice(0, 3)
    if (said.length) result.note = `${result.note ?? ""}; the page says: ${said.map((s) => `"${s}"`).join(", ")}`.replace(/^; /, "")
  }
  return result
}

/** The live control isn't the one the step was classed on: refused, the model reads again (shared/agent/expect.ts). */
export function changedSince(el: Element, call: ToolCall): string | null {
  const role = roleOf(el)
  return controlChanged(call, { role, label: role ? nameOf(el, role) : "", lock: lockOf(el) })
}

async function actOnly(call: ToolCall, doc: Document): Promise<StepResult> {
  const view = doc.defaultView ?? window
  const needs = call.tool === "click" || call.tool === "type" || call.tool === "fill" || call.tool === "select" || call.tool === "go"
  const el = call.id ? elementOf(call.id) : null
  if (needs && !el) return { ok: false, note: `element ${call.id} is gone from the page (read it again)` }
  if (el && (call.tool === "type" || call.tool === "fill" || call.tool === "click" || call.tool === "select") && lockOf(el) === "secret") {
    return { ok: false, note: "a secret field: the agent never touches it" }
  }
  const changed = el ? changedSince(el, call) : null
  if (changed) return { ok: false, note: changed }
  switch (call.tool) {
    case "click":
    case "go": {
      reveal(el!)
      const toggle = tag(el!) === "input" && /^(checkbox|radio)$/i.test((el as HTMLInputElement).type)
      const before = toggle ? (el as HTMLInputElement).checked : null
      // A page that opens its place in a new tab by script (window.open): Safari blocks it for a tap that isn't a person's
      // (128, the iPad: the stand's card got the test line «the new tab was blocked»). During this tap only, the page's
      // window.open keeps the address instead; the runner sends the task there through the same checks as any «go».
      const win = toggle ? null : catchNewTab(el!.ownerDocument)
      let settled: { changed: boolean; navigated: boolean }
      let tab: { url: string; reached: boolean } | null = null
      // (Put back however the tap ends: a settle that throws, a task stopped mid-tap. The script's own timer covers a
      // content script torn down before this runs.)
      try {
        press(el!)
        settled = await stepSettle()
      } finally {
        tab = win?.done() ?? null
      }
      // A form's submit that seems to change nothing may still be loading its next page (129, the iPad: the stays list's
      // Search went on after the quiet wait and read «nothing changed», the line without its ✓): a little longer for it.
      if (!settled.changed && !settled.navigated && submitsForm(el!)) {
        const more = await watch(el!.ownerDocument).settle(SETTLE_QUIET_MS, 2500)
        if (more.navigated || more.changed) settled = more
      }
      const result: StepResult = { ok: true, note: settled.navigated ? "the page went on" : settled.changed ? "the page changed" : "nothing changed on the page", changed: settled.changed, navigated: settled.navigated }
      if (tab?.url && !settled.navigated) {
        result.opened = tab.url
        result.note = "the page tried to open another page in a new tab"
      } else if (tab && !tab.reached && !settled.changed && !settled.navigated && roleOf(el!) === "link" && !(el as HTMLAnchorElement).href) result.tabBlocked = true
      if (toggle && before !== null) {
        const now = (el as HTMLInputElement).checked
        if (now === before) result.note = "the box didn't change (the site may want a real tap)"
        else {
          // A box's own state isn't a change the page shows (no attribute moves): said, or the model thinks it failed.
          if (!settled.changed && !settled.navigated) result.note = now ? "the box is now ticked" : "the box is now cleared"
          result.undo = { id: call.id!, kind: "checked", before }
        }
      }
      return result
    }
    case "type": {
      reveal(el!)
      // A site's own slider (a price from–to): stepped with its keys to the number asked (a restaurant site, 121 sweep: «до 50 €»
      // couldn't be set). A native range input takes its value as typed.
      if (roleOf(el!) === "slider" && tag(el!) !== "input") return slideTo(el as HTMLElement, call.text ?? "")
      const r = await typeInto(el!, call.text ?? "", call.mode ?? "replace")
      if (r.undo) r.undo.id = call.id!
      return r
    }
    case "fill": {
      // A value from «Мои данные», after the person's «Заполнить»: typed, or chosen in a list; marked so the map hides it.
      reveal(el!)
      const list = tag(el!) === "select" || roleOf(el!) === "listbox" || roleOf(el!) === "radio"
      const r = list ? await choose(el!, call.text ?? "") : await typeInto(el!, call.text ?? "", "replace")
      markFilled(el!)
      if (r.undo) r.undo.id = call.id!
      return { ...r, note: r.ok ? "filled" : r.note }
    }
    case "select": {
      reveal(el!)
      const r = await choose(el!, call.option ?? "")
      if (r.undo) r.undo.id = call.id!
      return r
    }
    case "scroll": {
      if (el) (el as HTMLElement).scrollIntoView?.({ block: "center" })
      else scrollPage(doc, call.to ?? "down")
      const settled = await stepSettle(250, 1500)
      return { ok: true, note: "scrolled", changed: settled.changed }
    }
    case "back": {
      view.history.back()
      const settled = await stepSettle(400, 3000)
      return { ok: true, note: "went back", navigated: settled.navigated, changed: settled.changed }
    }
    case "extract": {
      if (el) {
        const value = tag(el) === "input" || tag(el) === "textarea" || tag(el) === "select" ? (el as HTMLInputElement).value : ""
        const text = (value || ((el as HTMLElement).innerText ?? el.textContent ?? "")).slice(0, EXTRACT_MAX)
        return { ok: true, note: "read it", data: lockOf(el) ? "(a personal or secret field: not read)" : text }
      }
      return { ok: true, note: "read the page", data: pageData(doc) }
    }
    default:
      return { ok: true }
  }
}

/** Puts back what a step changed («Отменить»): a field's text, a checkbox, a list's choice. */
export async function undo(u: NonNullable<StepResult["undo"]>): Promise<boolean> {
  const el = elementOf(u.id)
  if (!el) return false
  const view = el.ownerDocument.defaultView ?? window
  if (u.kind === "checked") {
    if ((el as HTMLInputElement).checked !== u.before) press(el)
    return (el as HTMLInputElement).checked === u.before
  }
  if (u.kind === "select") {
    ;(el as HTMLSelectElement).value = String(u.before)
    el.dispatchEvent(new view.Event("change", { bubbles: true }))
    return true
  }
  const r = await typeInto(el, String(u.before), "replace")
  return r.ok
}

/** Steps a custom slider (role=slider) with its arrow keys until its value reaches the number in `text`. */
async function slideTo(el: HTMLElement, text: string): Promise<StepResult> {
  const want = Number((/-?\d+(?:[.,]\d+)?/.exec(text.replace(/\s/g, ""))?.[0] ?? "").replace(",", "."))
  const now = () => Number(el.getAttribute("aria-valuenow") ?? NaN)
  if (!Number.isFinite(want) || !Number.isFinite(now())) return { ok: false, note: "this slider doesn't say its value: press the steps beside it, or ask the person" }
  const before = now()
  el.focus?.()
  for (let i = 0; i < 400 && now() !== want; i++) {
    const v = now()
    const key = want > v ? "ArrowRight" : "ArrowLeft"
    for (const type of ["keydown", "keyup"] as const) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 8))
    // Overshot (steps bigger than one): stop at the first value past the number asked.
    if ((key === "ArrowRight" && now() >= want) || (key === "ArrowLeft" && now() <= want) || now() === v) break
  }
  const after = now()
  const settled = await stepSettle(300, 2000)
  return after === before ? { ok: false, note: "the slider didn't move with its keys: press the steps beside it, or ask the person" } : { ok: true, note: `the slider is at ${after}`, changed: settled.changed }
}
