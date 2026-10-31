// Apple Ads Platform API v1 transport shared by the CLI (asa.mjs) and the panel (panel.mjs):
// OAuth token, calls with 429 back-off, /query paging, bulk endpoints, the live snapshot of the
// app's campaigns, applying diffPlan() ops, and reports. Credentials live in ~/.appleads
// (APPLE_ADS_DIR): config.json {clientId, teamId, keyId, adAccountId} and private-key.pem.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { API, clientSecret, metrics } from "./lib.mjs"

export const DIR = process.env.APPLE_ADS_DIR ?? join(homedir(), ".appleads")
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"))
export const today = () => new Date().toISOString().slice(0, 10)

export function config() {
  const file = join(DIR, "config.json")
  if (!existsSync(file)) throw new Error(`No ${file}. Run keygen, upload the public key in Apple Ads (Account Settings → API) and save clientId, teamId, keyId, adAccountId there.`)
  return readJson(file)
}

let token = null
async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value
  const cache = join(DIR, "token.json")
  if (existsSync(cache)) {
    const t = readJson(cache)
    if (t.expiresAt > Date.now() + 60_000) return (token = t).value
  }
  const cfg = config()
  const secret = clientSecret(cfg, readFileSync(join(DIR, "private-key.pem"), "utf8"))
  const res = await fetch("https://appleid.apple.com/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: secret, scope: "searchadsorg" })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) throw new Error(`OAuth: ${res.status} ${JSON.stringify(body)}`)
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  writeFileSync(cache, JSON.stringify(token), { mode: 0o600 })
  return token.value
}

export async function call(method, path, body, { scoped = true } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }
  if (scoped) headers["X-AP-Context"] = `adAccountId=${config().adAccountId}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch((process.env.APPLE_ADS_API ?? API) + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) })
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** (attempt + 1)
      await new Promise((r) => setTimeout(r, wait * 1000))
      continue
    }
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok || json.error) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 600)}`)
    return json
  }
}

/** All rows of a /query endpoint. */
export async function query(path, filters = [], extra = {}) {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const page = await call("POST", path, { filters, pagination: { offset, pageSize: 1000 }, ...extra })
    const got = Array.isArray(page.result) ? page.result : page.result?.rows ?? []
    rows.push(...got)
    if (got.length < 1000) return rows
  }
}

/** Bulk endpoint; throws listing every failed item. */
async function bulk(path, datas) {
  if (!datas.length) return []
  const res = await call("POST", path, { items: datas.map((data, i) => ({ correlationId: i, data })) })
  const failed = (res.result ?? []).filter((r) => !r.success)
  if (failed.length) throw new Error(`${path}: ${failed.length} item(s) failed: ${JSON.stringify(failed).slice(0, 800)}`)
  return res.result
}

// ------------------------------------------------------------------ live state

export async function snapshot(plan) {
  const cfg = config()
  const adamId = String(plan.app.adamId)
  const campaigns = (await query("/campaigns/query")).filter((c) => String(c.promotedObjectId) === adamId)
  const ids = campaigns.map((c) => c.id)
  const inCampaigns = ids.length ? [{ field: "campaignId", operator: "IN", value: ids }] : null
  const adGroups = inCampaigns ? await query("/adgroups/query", inCampaigns) : []
  const groupIds = adGroups.map((g) => g.id)
  const inGroups = groupIds.length ? [{ field: "adGroupId", operator: "IN", value: groupIds }] : null
  const keywords = inGroups ? await query("/keywords/query", inGroups) : []
  // Campaign-level negatives are the ones without an ad group; Apple wants an adGroupId condition either way.
  // campaignId only takes EQUALS here, so one query per campaign.
  const negatives = []
  for (const id of ids) negatives.push(...(await query("/negative-keywords/query", [{ field: "campaignId", operator: "EQUALS", value: id }, { field: "adGroupId", operator: "IS_NULL" }])))
  if (inGroups) negatives.push(...(await query("/negative-keywords/query", inGroups)))
  const ads = inGroups ? await query("/ads/query", inGroups) : []
  // Which product page each ad shows: creative → productPageId → the page's name in App Store Connect.
  let pages = []
  let creatives = []
  if (ads.length) {
    creatives = await query("/creatives/query")
    pages = await productPages(adamId)
  }
  for (const ad of ads) {
    const cr = creatives.find((c) => c.id === ad.creativeId)
    const pageId = cr?.destination?.parameters?.productPageId
    ad.productPage = cr?.creativeType === "CUSTOM_PRODUCT_PAGE" ? pages.find((p) => p.id === pageId)?.name ?? pageId : "default"
  }
  return { adAccountId: cfg.adAccountId, campaigns, adGroups, keywords, negatives, ads, creatives, pages }
}

const productPages = (adamId) => query("/product-pages/query", [{ field: "adamId", operator: "EQUALS", value: Number(adamId) }])

// ------------------------------------------------------------------ apply

/** Runs diffPlan() ops in order; log(op, error?) is called after each one. */
export async function apply(plan, ops, live, log = () => {}) {
  const campaignId = new Map(live.campaigns.map((c) => [c.name, c.id]))
  const groupId = new Map(live.adGroups.map((g) => [`${g.campaignId}|${g.name}`, g.id]))
  const gid = (op) => groupId.get(`${campaignId.get(op.campaign)}|${op.adGroup}`)
  for (const op of ops) {
    switch (op.kind) {
      case "campaign.create": {
        const res = await call("POST", "/campaigns", op.payload)
        campaignId.set(op.campaign, res.result.id)
        break
      }
      case "campaign.update":
        await call("PUT", `/campaigns/${op.id}`, op.payload)
        break
      case "campaign.status":
        await call("PUT", `/campaigns/${op.id ?? campaignId.get(op.campaign)}`, op.payload)
        break
      case "adgroup.create": {
        const res = await call("POST", "/adgroups", { ...op.payload, campaignId: campaignId.get(op.campaign) })
        groupId.set(`${campaignId.get(op.campaign)}|${op.adGroup}`, res.result.id)
        break
      }
      case "adgroup.update":
        await call("PUT", `/adgroups/${op.id}`, op.payload)
        break
      case "keywords.create":
        await bulk("/keywords/bulk-create", op.items.map((k) => ({ ...k, adGroupId: gid(op) })))
        break
      case "keywords.update":
        await bulk("/keywords/bulk-update", op.items.map(({ text, ...k }) => k))
        break
      case "negatives.create":
        await bulk("/negative-keywords/bulk-create", op.items.map((n) => (op.adGroup ? { ...n, adGroupId: gid(op) } : { ...n, campaignId: campaignId.get(op.campaign) })))
        break
      case "ad.create": {
        const adamId = String(plan.app.adamId)
        let productPageId
        if (op.productPage !== "default") {
          const page = (await productPages(adamId)).find((p) => p.name === op.productPage || p.id === op.productPage)
          if (!page) throw new Error(`no custom product page "${op.productPage}" (is it approved and visible?)`)
          productPageId = page.id
        }
        const type = productPageId ? "CUSTOM_PRODUCT_PAGE" : "DEFAULT_PRODUCT_PAGE"
        const existing = live.creatives.find((c) => c.creativeType === type && !c.deleted && String(c.destination?.parameters?.adamId) === adamId && (c.destination?.parameters?.productPageId ?? undefined) === productPageId)
        const creative = existing ?? (await call("POST", "/creatives", {
          name: `ContextFlow · ${productPageId ? op.productPage : "default page"}`,
          creativeType: type,
          creativeSpec: {},
          destination: { destinationType: "APP_STORE_PRODUCT_PAGE", parameters: { adamId, ...(productPageId ? { productPageId } : {}) } }
        })).result
        if (!existing) live.creatives.push(creative)
        await call("POST", "/ads", { adGroupId: gid(op), creativeId: creative.id, name: `${op.adGroup} · ${op.productPage}`, status: "ENABLED" })
        for (const id of op.pauseAdIds) await call("PUT", `/ads/${id}`, { status: "PAUSED" })
        break
      }
      default:
        throw new Error(`unknown op ${op.kind}`)
    }
    log(op)
  }
}

/** Pauses every running campaign of the app; returns their names. */
export async function stopAll(live) {
  const on = live.campaigns.filter((c) => c.status === "ENABLED")
  for (const c of on) await call("PUT", `/campaigns/${c.id}`, { status: "PAUSED" })
  return on.map((c) => c.name)
}

// ------------------------------------------------------------------ reports

export async function reports(live, from, to) {
  const out = { campaigns: [], adGroups: [], keywords: [], searchTerms: [] }
  const ids = live.campaigns.map((c) => c.id)
  if (!ids.length) return out
  const name = (id) => live.campaigns.find((c) => c.id === id)?.name
  const time = (tz = "UTC") => ({ timeRange: { start: from, end: to, timeZone: tz }, options: { includeRows: ["GRAND_TOTAL"] } })
  out.campaigns = (await query("/reports/apps/campaigns/query", [{ field: "id", operator: "IN", value: ids }], time())).map((r) => ({ ...r, campaignName: name(r.metadata?.id ?? r.metadata?.campaignId) }))
  // Per-campaign reports, all campaigns at once (a handful of requests; call() backs off on 429).
  await Promise.all(ids.map(async (id) => {
    const f = [{ field: "campaignId", operator: "EQUALS", value: id }]
    const tag = (rows) => rows.map((r) => ({ ...r, campaignName: name(id) }))
    const [groups, keywords, terms] = await Promise.all([
      query("/reports/apps/adgroups/query", f, time()),
      query("/reports/apps/keywords/query", f, time()),
      // Search terms report only in the account's time zone.
      query("/reports/apps/searchterms/query", f, time("ORTZ"))
    ])
    out.adGroups.push(...tag(groups))
    out.keywords.push(...tag(keywords))
    out.searchTerms.push(...tag(terms))
  }))
  return out
}

export async function spentSince(live, from) {
  const rep = await reports(live, from, today())
  return rep.campaigns.reduce((s, r) => s + metrics(r).spend, 0)
}

/** keywordId → paid subscribers, from AdServices attribution stored by the app (when available). */
export async function subscribersByKeyword(from, to) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  const res = await fetch(`${url}/rest/v1/rpc/cf_ads_funnel`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_from: from, p_to: to })
  })
  if (!res.ok) return null
  const rows = await res.json()
  return { rows, subs: Object.fromEntries(rows.filter((r) => r.keyword_id).map((r) => [r.keyword_id, Number(r.subscribed ?? 0)])) }
}
