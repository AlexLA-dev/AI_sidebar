// The cookie closer (2.7.1): a page's cookie banner answered for the person with the privacy-minded choice — «Reject
// all» or «Only necessary» — so it goes away without a touch. Known consent platforms by their own markup first
// (rules.ts), then a banner the site made itself: a floating element or a dialog about cookies, its reject button
// found by its label in our languages. A banner that offers only «Accept» is left to the person, nothing hidden.
//
// Never: a link that leaves the page, a form's submit, anything near a password or a card. Cheap: one look when the
// page is idle, then one MutationObserver for a short while (no polling), and nothing once a banner is answered.

import { aboutCookies, chooseButton, labelKind } from "../../shared/cookies/labels.ts"
import { ANY_ROOT, RULES, type Rule, type Step } from "./rules.ts"

export type CloseResult =
  | { status: "done"; via: string }
  // wall: «pay or accept» (a subscription is the other door, and rejecting leads there: Le Figaro). Never touched.
  | { status: "left"; why: "only_accept" | "none" | "stuck" | "wall"; via: string }
  | { status: "none" }

export interface Env {
  doc: Document
  // Shown to the person (laid out, not hidden, on the screen).
  visible: (el: Element) => boolean
  // Floats over the page: fixed or sticky (itself or a parent), or a dialog.
  floats: (el: Element) => boolean
  // Resolves when `ready()` holds (looked at after each change under `root`), or false after `ms`.
  until: (root: Node, ms: number, ready: () => boolean) => Promise<boolean>
  // A consent platform's sign on the page (the TCF API's frame): «privacy» and «consent» words count then.
  sign?: boolean
}

// Controls a banner's answer can be. Links only when they stay on the page (no href, "#…", "javascript:").
const CONTROLS = "button, [role=button], input[type=button], input[type=submit], a, [onclick]"
// Generic banners: where they usually are, by their own words and roles.
const GENERIC = [
  "[role=dialog]", "[role=alertdialog]", "[aria-modal=true]", "dialog[open]",
  "[id*=cookie]", "[class*=cookie]", "[id*=Cookie]", "[class*=Cookie]", "[id*=consent]", "[class*=consent]",
  "[id*=Consent]", "[class*=Consent]", "[id*=gdpr]", "[class*=gdpr]", "[id*=GDPR]", "[id*=privacy]", "[class*=privacy]",
  "[aria-label*=cookie]", "[aria-label*=Cookie]", "[aria-label*=consent]", "[aria-label*=Consent]", "[aria-describedby*=cookie]"
].join(", ")
const SECRET = "input[type=password], [autocomplete^=cc-], [autocomplete~=one-time-code], input[name*=card], input[name*=iban]"
// A banner is a short thing; a page's whole text isn't one.
const MAX_TEXT = 6000
const MAX_CANDIDATES = 80

// Waits inside a platform's own flow.
const OPEN_MS = 2500
const STEP_MS = 1200
const GONE_MS = 1800

function textOf(el: Element): string {
  const h = el as HTMLElement
  return ((typeof h.innerText === "string" && h.innerText) || el.textContent || "").replace(/\s+/g, " ").trim()
}

/** A control's label: what it says, else its accessible name, value or title. */
export function labelOf(el: Element): string {
  const text = textOf(el)
  if (text) return text.slice(0, 120)
  const v = el.getAttribute("aria-label") || (el as HTMLInputElement).value || el.getAttribute("title") || ""
  return v.replace(/\s+/g, " ").trim().slice(0, 120)
}

/** A control we may press for the person: stays on the page, no form of theirs sent, nothing secret near it. */
export function safeControl(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false
  if (el.tagName === "A") {
    const href = (el.getAttribute("href") ?? "").trim()
    const target = el.getAttribute("target")
    if (href && !/^(#|javascript:)/i.test(href)) return false
    if (target && target !== "_self") return false
  }
  const form = el.closest("form")
  if (form) {
    if (form.querySelector(SECRET)) return false
    // A submit of a form someone fills in (a search, a sign-in) sends it: only a banner's own button form.
    const submits = el.matches("input[type=submit], button:not([type]), button[type=submit]")
    if (submits && form.querySelector("input[type=text], input[type=email], input[type=tel], input[type=search], input:not([type]), textarea")) return false
  }
  return true
}

/** Every control under `scope`, its open shadow roots one level in too (some platforms draw there). */
function controls(scope: ParentNode): Element[] {
  const out = [...scope.querySelectorAll(CONTROLS)]
  for (const el of scope.querySelectorAll("*")) {
    const sr = (el as HTMLElement).shadowRoot
    if (sr) out.push(...sr.querySelectorAll(CONTROLS))
  }
  return out
}

export function firstShown(env: Env, scope: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    let list: Element[]
    try {
      list = [...scope.querySelectorAll(sel)]
    } catch {
      continue
    }
    for (const el of list) if (env.visible(el) && safeControl(el) && labelKind(labelOf(el)) !== "pay") return el as HTMLElement
  }
  return null
}

/** A «pay or accept» wall: a shown control under `scope` subscribes or pays («S'abonner», «Already subscribed?»). */
export function isWall(env: Env, scope: ParentNode): boolean {
  return controls(scope).some((el) => labelKind(labelOf(el)) === "pay" && env.visible(el))
}

/** A shown, safe control under `scope` whose label is of `kind` («reject»: the best one; «save»: one that saves). */
export function byLabel(env: Env, scope: ParentNode, kind: "reject" | "save"): HTMLElement | null {
  const list = controls(scope).filter((el) => env.visible(el) && safeControl(el))
  if (kind === "reject") {
    const choice = chooseButton(list.map(labelOf))
    return "press" in choice ? (list[choice.press] as HTMLElement) : null
  }
  return (list.find((el) => SAVE.test(labelOf(el)) && labelKind(labelOf(el)) !== "accept") as HTMLElement | undefined) ?? null
}

// «Save», «Confirm my choices», in our languages: pressed only inside a platform's settings, its switches off first.
const SAVE = /^(save|confirm|сохран|підтверд|зберег|speichern|auswahl (bestätigen|speichern)|bestätigen|enregistrer|confirmer|valider|guardar|confirmar|salva|conferma|salvar|kaydet|onayla|حفظ|تأكيد|保存|確認|确认|저장|확인|lưu|xác nhận|opslaan|zapisz|potwierdź|spara|gem|uložit)/i

export function press(el: HTMLElement): void {
  el.click()
}

/** Turns the optional switches off under `scope` (the necessary ones are disabled and stay on). */
function switchesOff(scope: ParentNode, selector: string | undefined): void {
  if (!selector) return
  let list: Element[]
  try {
    list = [...scope.querySelectorAll(selector)]
  } catch {
    return
  }
  for (const el of list) {
    const box = el as HTMLInputElement
    if (box.checked && !box.disabled && box.getAttribute("aria-disabled") !== "true") box.click()
  }
}

function scopeOf(env: Env, rule: Rule, root: Element): ParentNode {
  if (rule.shadow) {
    const host = env.doc.querySelector(rule.shadow) as HTMLElement | null
    if (host?.shadowRoot) return host.shadowRoot
  }
  return rule.wide ? env.doc : root
}

/** Where a platform's buttons are looked for by their label: its shown windows (and their open shadow roots). */
function windowsOf(env: Env, rule: Rule): ParentNode[] {
  if (rule.shadow) {
    const host = env.doc.querySelector(rule.shadow) as HTMLElement | null
    return host?.shadowRoot ? [host.shadowRoot] : []
  }
  let list: Element[] = []
  try {
    list = [...env.doc.querySelectorAll(rule.root)].filter((el) => env.visible(el))
  } catch {
    return []
  }
  // The outermost only: a window inside another is looked at with it.
  return list.filter((el) => !list.some((o) => o !== el && o.contains(el)))
}

/** A platform's own button (by its selectors) under `scope`, or inside its window's open shadow roots. */
function ownButton(env: Env, rule: Rule, scope: ParentNode, selectors: readonly string[]): HTMLElement | null {
  const hit = firstShown(env, scope, selectors)
  if (hit || rule.shadow) return hit
  for (const w of windowsOf(env, rule)) {
    for (const el of (w as Element).querySelectorAll?.("*") ?? []) {
      const sr = (el as HTMLElement).shadowRoot
      const inner = sr ? firstShown(env, sr, selectors) : null
      if (inner) return inner
    }
  }
  return null
}

function byLabelIn(env: Env, scopes: ParentNode[], kind: "reject" | "save"): HTMLElement | null {
  for (const scope of scopes) {
    const hit = byLabel(env, scope, kind)
    if (hit) return hit
  }
  return null
}

/** The platform's window, shown (a rule's root that is there and shown; a shadow host counts by its shadow's look). */
function shownRoot(env: Env, rule: Rule): Element | null {
  let list: Element[]
  try {
    list = [...env.doc.querySelectorAll(rule.root)]
  } catch {
    return null
  }
  for (const el of list) {
    if (rule.shadow && (el as HTMLElement).shadowRoot) {
      const inner = [...(el as HTMLElement).shadowRoot!.querySelectorAll("*")].find((c) => c.matches(CONTROLS) && env.visible(c))
      if (inner) return el
      continue
    }
    if (env.visible(el)) return el
  }
  return null
}

async function gone(env: Env, rule: Rule | null, el: Element): Promise<boolean> {
  const away = () => (rule ? !shownRoot(env, rule) : !el.isConnected || !env.visible(el))
  if (away()) return true
  return env.until(env.doc.documentElement, GONE_MS, away)
}

/** Runs a platform's own way: its reject button, a reject label in its window, or its settings saved as necessary. */
async function byRule(env: Env, rule: Rule, root: Element): Promise<CloseResult> {
  const scope = () => scopeOf(env, rule, root)
  if (windowsOf(env, rule).some((w) => isWall(env, w))) return { status: "left", why: "wall", via: rule.id }
  const own = ownButton(env, rule, scope(), rule.reject) ?? byLabelIn(env, windowsOf(env, rule), "reject")
  if (own) {
    press(own)
    return (await gone(env, rule, root)) ? { status: "done", via: rule.id } : { status: "left", why: "stuck", via: rule.id }
  }
  const s = rule.settings
  const open = s ? ownButton(env, rule, scope(), s.open) : null
  if (!s || !open) {
    const labels = windowsOf(env, rule).flatMap((w) => controls(w)).filter((el) => env.visible(el)).map(labelOf)
    if (!labels.length) return { status: "none" }
    const choice = chooseButton(labels)
    return { status: "left", why: "leave" in choice ? choice.leave : "none", via: rule.id }
  }
  press(open)
  const find = (step: Step): HTMLElement | null =>
    step === "reject" || step === "save" ? byLabelIn(env, windowsOf(env, rule), step) : ownButton(env, rule, scope(), step)
  // The settings come: wait for one of the steps' buttons.
  const ready = await env.until(env.doc.documentElement, OPEN_MS, () => s.then.some((step) => !!find(step)))
  if (!ready) return { status: "left", why: "stuck", via: rule.id }
  for (const w of windowsOf(env, rule)) switchesOff(w, s.off)
  switchesOff(scope(), s.off)
  for (const step of s.then) {
    const el = find(step)
    if (!el) continue
    press(el)
    if (await gone(env, rule, root)) return { status: "done", via: rule.id }
    await env.until(env.doc.documentElement, STEP_MS, () => false)
  }
  return (await gone(env, rule, root)) ? { status: "done", via: rule.id } : { status: "left", why: "stuck", via: rule.id }
}

/** A banner the site made: shown, floating, about cookies, nothing secret in it. The smallest ones first. */
export function genericBanners(env: Env): Element[] {
  const doc = env.doc
  const body = doc.body
  if (!body) return []
  const seen = new Set<Element>()
  const add = (el: Element) => seen.size < MAX_CANDIDATES && seen.add(el)
  try {
    for (const el of doc.querySelectorAll(GENERIC)) add(el)
  } catch {
    // a selector the engine doesn't take: the page's top levels below still are looked at
  }
  // The page's top levels: banners are mostly a direct child of <body> (or one level in).
  for (const el of body.children) {
    add(el)
    for (const inner of el.children) add(inner)
  }
  const out: Element[] = []
  for (const el of seen) {
    if (el === body || el.matches(CONTROLS) || el.closest("contextflow-root")) continue
    // The cheap looks first (the page's own app root is never read whole): shown, floating, not too long.
    if (!env.visible(el) || !env.floats(el)) continue
    const raw = el.textContent ?? ""
    if (raw.length < 20 || raw.length > MAX_TEXT * 2) continue
    const text = textOf(el)
    if (text.length < 20 || text.length > MAX_TEXT) continue
    if (!aboutCookies(text, env.sign === true)) continue
    if (el.querySelector(SECRET)) continue
    out.push(el)
  }
  // The innermost first: its buttons are the banner's own.
  return out.sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))
}

/**
 * A consent window drawn in a frame of the page's own (srcdoc or about:blank: no content script runs there): its body,
 * when the frame floats over the page and talks about cookies. Other sites' frames can't be read and are left out.
 */
export function frameBanners(env: Env): Element[] {
  const out: Element[] = []
  for (const frame of env.doc.querySelectorAll("iframe")) {
    if (!env.visible(frame) || !env.floats(frame)) continue
    let body: HTMLElement | null = null
    try {
      body = (frame as HTMLIFrameElement).contentDocument?.body ?? null
    } catch {
      continue
    }
    if (!body) continue
    const raw = body.textContent ?? ""
    if (raw.length < 20 || raw.length > MAX_TEXT * 2 || !aboutCookies(textOf(body), env.sign === true)) continue
    if (body.querySelector(SECRET)) continue
    out.push(body)
  }
  return out
}

// Banners already answered on this page: never pressed again, nor anything inside or around them.
const done = new Set<Element>()
// Banners left to the person: looked at again as they change (a reject may come later), counted once.
const leftAlone = new Set<Element>()
const handled = (el: Element): boolean => {
  for (const d of done) if (d === el || d.contains(el) || el.contains(d)) return true
  return false
}

/** Forgets the page's answered banners (the tests' pages one after another). */
export function forgetBanners(): void {
  done.clear()
  leftAlone.clear()
}

/** One look at the page: a platform's banner, else a banner the site made. */
export async function closeOnce(env: Env): Promise<CloseResult> {
  const doc = env.doc
  let anyRoot: Element | null = null
  try {
    anyRoot = doc.querySelector(ANY_ROOT)
  } catch {
    anyRoot = null
  }
  if (anyRoot) {
    for (const rule of RULES) {
      const root = shownRoot(env, rule)
      if (!root || done.has(root)) continue
      // Sourcepoint answers in its own frame (frame.ts): nothing to press on the page.
      if (!rule.reject.length && !rule.settings) return { status: "none" }
      const result = await byRule(env, rule, root)
      if (result.status === "done" || (result.status === "left" && result.why === "stuck")) done.add(root)
      // Left to the person (only «Accept» so far) or still being drawn: looked at again on the page's next change,
      // counted once.
      if (result.status === "left" && result.why !== "stuck") {
        if (leftAlone.has(root)) return { status: "none" }
        leftAlone.add(root)
      }
      return result
    }
  }
  let left: CloseResult | null = null
  const banners = [...genericBanners(env), ...frameBanners(env)]
  for (const banner of banners) {
    if (handled(banner)) continue
    const list = controls(banner).filter((el) => env.visible(el))
    const safe = list.filter(safeControl)
    // A wall is told by any of its parts: the box with the answers or the banner around it.
    const wall = list.some((el) => labelKind(labelOf(el)) === "pay") || banners.some((o) => o !== banner && o.contains(banner) && isWall(env, o))
    const choice = wall ? ({ leave: "wall" } as const) : chooseButton(safe.map(labelOf))
    if ("press" in choice) {
      done.add(banner)
      press(safe[choice.press] as HTMLElement)
      return (await gone(env, null, banner)) ? { status: "done", via: env.sign ? "tcf" : "generic" } : { status: "left", why: "stuck", via: "generic" }
    }
    // Only «Accept» (and maybe settings, or a reject that leaves the page), or a wall: the person's choice. Counted
    // once. A part of the page with no answer we know («none») isn't counted: it's often a box inside the banner.
    if (!left && choice.leave !== "none" && ![...leftAlone].some((l) => l === banner || l.contains(banner) || banner.contains(l))) {
      leftAlone.add(banner)
      left = { status: "left", why: choice.leave, via: "generic" }
    }
  }
  return left ?? { status: "none" }
}

// ---------------------------------------------------------------------------------------------- the real page

/** The real page's look at an element. */
export function shownOnPage(el: Element): boolean {
  if (!el.isConnected) return false
  const h = el as HTMLElement & { checkVisibility?: (o?: Record<string, boolean>) => boolean }
  const r = h.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const view = el.ownerDocument.defaultView ?? window
  // Above or beside the screen is away; below it counts (a dialog's buttons further down its own scroll).
  if (r.bottom <= 0 || r.right <= 0 || r.left >= view.innerWidth) return false
  if (typeof h.checkVisibility === "function") return h.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })
  const s = view.getComputedStyle(el)
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
}

export function floatsOnPage(el: Element): boolean {
  const view = el.ownerDocument.defaultView ?? window
  let e: Element | null = el
  for (let depth = 0; e && e !== el.ownerDocument.body && depth < 14; depth++) {
    if (e.matches("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]")) return true
    const p = view.getComputedStyle(e).position
    if (p === "fixed" || p === "sticky") return true
    e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)
  }
  return false
}

/** Waits for `ready()` after changes under `root`, `ms` at most: one observer, no polling. */
export function untilOnPage(root: Node, ms: number, ready: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false
    let pending = 0
    const end = (ok: boolean) => {
      if (finished) return
      finished = true
      observer.disconnect()
      clearTimeout(timer)
      clearTimeout(pending)
      resolve(ok)
    }
    const observer = new MutationObserver(() => {
      // A burst of changes is looked at once.
      if (pending) return
      pending = setTimeout(() => {
        pending = 0
        if (ready()) end(true)
      }, 60) as unknown as number
    })
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"] })
    const timer = setTimeout(() => end(ready()), ms)
  })
}

export function pageEnv(doc: Document = document, sign = false): Env {
  return { doc, visible: shownOnPage, floats: floatsOnPage, until: untilOnPage, sign }
}

/** The TCF API's sign on the page (its locator frame): consent platforms that we have no rule for. */
export function tcfSign(doc: Document = document): boolean {
  return !!doc.querySelector("iframe[name=__tcfapiLocator], iframe[name=__cmpLocator]")
}
