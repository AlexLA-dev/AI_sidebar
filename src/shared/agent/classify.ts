// A step's class (free / confirm / self / blocked), decided by code from the call, the control and the page: the
// model's own words about a step never change it. The server checks with this before it answers, and the extension
// checks again before it acts (the extension is the one that presses).

import { anyWord, wordKind } from "./match.ts"
import { blockedSite, hostOf, sameSite, type SitePolicy } from "./sites.ts"
import type { MapItem, PageMap, StepVerdict, ToolCall } from "./types.ts"
import { CONSENT_DIALOG, TERMS_BOX } from "./words.ts"

export interface StepContext {
  map: PageMap
  // The site the task began on: going elsewhere needs a «Да».
  startHost: string
  // The person's own words: text the model types that names an address or an e-mail not in them needs a «Да».
  request: string
  // A «Да» was given on this site during the task already (the first step on a site the task came to asks).
  confirmedHere: boolean
  policy: SitePolicy
}

// Mail, chat and social sites: «Send» there is a message in the person's name.
const MESSAGING = /(^|\.)(mail\.google|gmail|outlook|live|yahoo|proton|icloud|mail\.ru|yandex|telegram|t\.me|web\.whatsapp|whatsapp|messenger|facebook|instagram|x|twitter|threads|linkedin|vk|ok|reddit|discord|slack|teams\.microsoft|tiktok|pinterest|quora|medium|substack|tumblr|mastodon|bsky|line|kakao|naver|weibo|wechat|zalo)\.[a-z.]+$/

const READ_ONLY = new Set(["read_page", "scroll", "extract", "ask_user", "done", "back"])
const SELF_KINDS = new Set(["pay", "post", "rate", "account", "auth", "consent"])
// An address or an e-mail address in text the model wants typed.
const ADDRESS = /\bhttps?:\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+/gi

export function itemById(map: PageMap, id: string | undefined): MapItem | null {
  return (id && map.items.find((i) => i.id === id)) || null
}

function verdict(cls: StepVerdict["cls"], reason: string): StepVerdict {
  return { cls, reason }
}

/** The host a link goes to, from the map's href ("/path" on this site, "host/path" elsewhere). */
function linkHost(item: MapItem, pageHost: string): string {
  const href = item.href ?? ""
  if (!href || href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return pageHost
  return href.split("/")[0].toLowerCase()
}

function isConsentDialog(map: PageMap, item: MapItem): boolean {
  return item.where === "dialog" && (map.consent === true || !!anyWord(map.text.slice(0, 1500), CONSENT_DIALOG))
}

/** A «Send» is a message when it's on a mail or social site, or in a form (or a page) that's a message composer. */
function isMessage(map: PageMap, item: MapItem, host: string): boolean {
  if (MESSAGING.test(host)) return true
  if (item.form !== undefined) {
    const form = map.forms.find((f) => f.n === item.form)
    const fields = map.items.filter((i) => i.form === item.form && (i.role === "textbox" || i.role === "textarea" || i.role === "editor"))
    const composer = fields.some((i) => i.role === "editor" || i.role === "textarea")
    const personal = fields.some((i) => i.lock === "personal")
    return !!form && composer && !personal
  }
  return map.items.some((i) => i.role === "editor")
}

/** The class of a click on `item` (a button, a link, a checkbox…) by its words and where it is. */
function clickClass(map: PageMap, item: MapItem, host: string): StepVerdict {
  const hit = wordKind(item.label)
  const form = item.form !== undefined ? map.forms.find((f) => f.n === item.form) : undefined
  const toggle = item.role === "checkbox" || item.role === "radio" || item.role === "switch"
  if (toggle) {
    // «I agree to the terms», «I consent to…»: the person ticks it.
    if (hit?.kind === "consent" || anyWord(item.label, TERMS_BOX)) return verdict("self", "consent")
    return verdict("free", "toggle")
  }
  if (item.role === "file") return verdict("self", "file")
  if (hit) {
    if (hit.kind === "send") return isMessage(map, item, host) ? verdict("self", "send") : verdict("confirm", "submit")
    if (hit.kind === "consent" && isConsentDialog(map, item)) return verdict("self", "cookies_accept")
    if (SELF_KINDS.has(hit.kind)) return verdict("self", hit.kind)
    if (hit.kind === "reject") return isConsentDialog(map, item) ? verdict("free", "cookies_reject") : verdict("confirm", "decline")
    if (hit.kind === "submit") return verdict("confirm", "submit")
    if (hit.kind === "weak") return form?.fillable ? verdict("confirm", "submit") : verdict("free", "weak")
    if (hit.kind === "nav") return form?.secret ? verdict("self", "auth") : verdict("free", "nav")
  }
  // No word we know: by what the control is.
  const submits = item.type === "submit" || item.type === "image" || (item.role === "button" && form !== undefined && item.type !== "button" && item.type !== "reset")
  if (submits && form) {
    if (form.secret) return verdict("self", "auth")
    if (form.otherSite) return verdict("confirm", "other_site")
    if (form.fillable) return verdict("confirm", "submit")
  }
  if (!item.label.trim()) return verdict("confirm", "unknown")
  return verdict("free", "click")
}

/** The class of `call` on the page in `ctx`. The model's call is assumed checked (call.ts) against the map. */
export function classify(call: ToolCall, ctx: StepContext): StepVerdict {
  const host = hostOf(ctx.map.url)
  if (READ_ONLY.has(call.tool)) return verdict("free", "read")
  const blocked = blockedSite(host, ctx.policy)
  if (blocked) return verdict("blocked", `site_${blocked}`)
  const item = itemById(ctx.map, call.id)
  if (!item) return verdict("blocked", "no_item")
  if (item.lock === "secret") return verdict("blocked", "secret")

  let v: StepVerdict
  if (call.tool === "type") {
    if (item.lock === "personal") v = verdict("confirm", "personal")
    else {
      const request = ctx.request.toLowerCase()
      const foreign = (call.text ?? "").match(ADDRESS)?.some((a) => !request.includes(a.toLowerCase().replace(/[.,;]+$/, "")))
      v = foreign ? verdict("confirm", "text_from_page") : verdict("free", "type")
    }
  } else if (call.tool === "select") {
    v = item.lock === "personal" ? verdict("confirm", "personal") : verdict("free", "select")
  } else {
    // click and go: a link elsewhere first, then the words.
    const to = item.role === "link" || call.tool === "go" ? linkHost(item, host) : host
    if (!sameSite(to, host)) return verdict("confirm", "other_site")
    v = clickClass(ctx.map, item, host)
  }
  // The first thing done on a site the task came to (not the one it began on) asks first.
  if (v.cls === "free" && !ctx.confirmedHere && ctx.startHost && !sameSite(host, ctx.startHost) && call.tool !== "scroll") {
    return verdict("confirm", "first_here")
  }
  return v
}
