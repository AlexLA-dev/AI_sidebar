// Apple Ads for ContextFlow from the command line (Apple Ads Platform API v1, api.ads.apple.com).
// store/ads/plan.json is the source of truth: campaigns, ad groups, keywords, bids, negatives and
// the ad (default or custom product page). Nothing changes in Apple Ads without --yes, and a
// campaign is switched on only with --launch.
//   node tools/ads/asa.mjs keygen                 key pair for Account Settings → API (once)
//   node tools/ads/asa.mjs accounts               ad accounts this API user can reach
//   node tools/ads/asa.mjs status                 what is live, with spend so far
//   node tools/ads/asa.mjs plan                   what apply would change (dry run)
//   node tools/ads/asa.mjs apply --yes [--launch] make Apple Ads match the plan
//   node tools/ads/asa.mjs report [--from D --to D] [--json out.json]
//   node tools/ads/asa.mjs optimize [--write]     rule-based bid / pause / promote / negative proposals
//   node tools/ads/asa.mjs popularity --country US,DE [--grep summar]
//   node tools/ads/asa.mjs stop --yes             pause every campaign of the app
// Credentials live outside the repo in ~/.appleads (APPLE_ADS_DIR): config.json
// {clientId, teamId, keyId, adAccountId} and private-key.pem. Subscribers per keyword come from
// Supabase (rpc cf_ads_funnel) when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { API, applyProposals, clientSecret, diffPlan, guardProblems, metrics, optimize } from "./lib.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [command = "help", ...rest] = process.argv.slice(2)
const flag = (name) => rest.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : fallback
}
const DIR = process.env.APPLE_ADS_DIR ?? join(homedir(), ".appleads")
const PLAN = resolve(opt("plan", join(root, "store/ads/plan.json")))
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"))
const today = () => new Date().toISOString().slice(0, 10)
const usd = (x) => (x == null ? "–" : `$${x.toFixed(2)}`)
const pct = (x) => `${(x * 100).toFixed(1)}%`

// ------------------------------------------------------------------ auth and transport

function config() {
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

async function call(method, path, body, { scoped = true } = {}) {
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
async function query(path, filters = [], extra = {}) {
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

async function snapshot(plan) {
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

const dedupe = (rows) => [...new Map(rows.map((r) => [r.id, r])).values()]
const productPages = (adamId) => query("/product-pages/query", [{ field: "adamId", operator: "EQUALS", value: Number(adamId) }])

// ------------------------------------------------------------------ apply

async function apply(plan, ops, live) {
  const campaignId = new Map(live.campaigns.map((c) => [c.name, c.id]))
  const groupId = new Map(live.adGroups.map((g) => [`${g.campaignId}|${g.name}`, g.id]))
  const gid = (op) => groupId.get(`${campaignId.get(op.campaign)}|${op.adGroup}`)
  for (const op of ops) {
    process.stdout.write(`→ ${op.desc} … `)
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
    console.log("ok")
  }
}

// ------------------------------------------------------------------ reports

async function reports(live, from, to) {
  const out = { campaigns: [], keywords: [], searchTerms: [] }
  const ids = live.campaigns.map((c) => c.id)
  if (!ids.length) return out
  const name = (id) => live.campaigns.find((c) => c.id === id)?.name
  const time = (tz = "UTC") => ({ timeRange: { start: from, end: to, timeZone: tz }, options: { includeRows: ["GRAND_TOTAL"] } })
  out.campaigns = (await query("/reports/apps/campaigns/query", [{ field: "id", operator: "IN", value: ids }], time())).map((r) => ({ ...r, campaignName: name(r.metadata?.id ?? r.metadata?.campaignId) }))
  for (const id of ids) {
    const f = [{ field: "campaignId", operator: "EQUALS", value: id }]
    for (const r of await query("/reports/apps/keywords/query", f, time())) out.keywords.push({ ...r, campaignName: name(id) })
    // Search terms report only in the account's time zone.
    for (const r of await query("/reports/apps/searchterms/query", f, time("ORTZ"))) out.searchTerms.push({ ...r, campaignName: name(id) })
  }
  return out
}

/** keywordId → paid subscribers, from AdServices attribution stored by the app (when available). */
async function subscribersByKeyword(from, to) {
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

function table(rows, cols) {
  const cells = rows.map((r) => cols.map(([, f]) => String(f(r))))
  const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (vals) => vals.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join("  ")
  console.log(line(cols.map(([h]) => h)))
  for (const c of cells) console.log(line(c))
}

const metricCols = (subs) => [
  ["impr", (r) => metrics(r).impressions],
  ["taps", (r) => metrics(r).taps],
  ["TTR", (r) => pct(metrics(r).ttr)],
  ["spend", (r) => usd(metrics(r).spend)],
  ["CPT", (r) => usd(metrics(r).cpt)],
  ["inst", (r) => metrics(r).installs],
  ["CPI", (r) => usd(metrics(r).cpi)],
  ...(subs ? [["subs", (r) => subs[r.metadata?.id] ?? 0]] : [])
]

// ------------------------------------------------------------------ commands

function since(plan) {
  return opt("from", plan.guards?.since ?? plan.campaigns.map((c) => c.start).sort()[0] ?? today())
}

async function main() {
  if (command === "help" || command === "--help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0])
    return
  }
  if (command === "keygen") {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const priv = join(DIR, "private-key.pem")
    if (!existsSync(priv)) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      writeFileSync(priv, privateKey.export({ type: "sec1", format: "pem" }), { mode: 0o600 })
      writeFileSync(join(DIR, "public-key.pem"), publicKey.export({ type: "spki", format: "pem" }))
    }
    console.log(`Paste this public key in Apple Ads → Account Settings → API (signed in as the API user):\n\n${readFileSync(join(DIR, "public-key.pem"), "utf8")}`)
    if (!existsSync(join(DIR, "config.json"))) writeFileSync(join(DIR, "config.json"), JSON.stringify({ clientId: "SEARCHADS.…", teamId: "SEARCHADS.…", keyId: "…", adAccountId: 0 }, null, 2) + "\n", { mode: 0o600 })
    console.log(`Then put clientId, teamId and keyId from that page into ${join(DIR, "config.json")} and run: node tools/ads/asa.mjs accounts`)
    return
  }
  if (command === "accounts") {
    const me = await call("GET", "/me", null, { scoped: false })
    const acls = await call("GET", "/acls", null, { scoped: false })
    console.log(`user ${me.result?.userId}, org ${me.result?.orgId}`)
    for (const a of acls.result?.acls ?? []) console.log(`ad account ${a.adAccount?.id}  ${a.adAccount?.name}  roles: ${(a.roles ?? []).join(", ")}`)
    console.log(`Put the ContextFlow ad account id into ${join(DIR, "config.json")} as adAccountId.`)
    return
  }

  const plan = readJson(PLAN)
  const { problems, total } = guardProblems(plan)

  if (command === "plan" || command === "apply") {
    const live = await snapshot(plan)
    const { ops, notes } = diffPlan(plan, live)
    console.log(`Plan ${PLAN}: daily budgets × days = $${total.toFixed(2)} (limit $${plan.guards?.totalBudget ?? "–"})`)
    for (const n of notes) console.log(`note: ${n}`)
    for (const p of problems) console.log(`BLOCKED: ${p}`)
    if (!ops.length) return console.log("Apple Ads already matches the plan.")
    for (const op of ops) console.log(`${op.launch ? "!" : "-"} ${op.desc}`)
    if (command === "plan") return
    if (problems.length) throw new Error("fix the plan first (see BLOCKED)")
    if (!flag("yes")) return console.log("\nDry run. Add --yes to apply.")
    const launches = ops.filter((o) => o.launch)
    if (launches.length && !flag("launch")) throw new Error(`${launches.length} campaign(s) would start spending: add --launch to confirm`)
    if (launches.length) {
      const spent = await spentSince(live, since(plan))
      if (plan.guards?.totalBudget != null && spent >= plan.guards.totalBudget) throw new Error(`already spent ${usd(spent)} of $${plan.guards.totalBudget}`)
    }
    await apply(plan, ops, live)
    return
  }

  if (command === "status") {
    const live = await snapshot(plan)
    const from = since(plan)
    const rep = await reports(live, from, today())
    console.log(`Spend since ${from}: ${usd(rep.campaigns.reduce((s, r) => s + metrics(r).spend, 0))} of $${plan.guards?.totalBudget ?? "–"}\n`)
    for (const c of live.campaigns) {
      const r = rep.campaigns.find((x) => x.campaignName === c.name)
      console.log(`${c.name}  [${c.displayStatus ?? c.status}]  $${c.dailyBudget?.value?.amount}/day  ${(c.targeting?.countryOrRegion?.include ?? []).join(",")}  ${c.startTime?.slice(0, 10)} → ${c.endTime?.slice(0, 10) ?? "∞"}  spend ${usd(metrics(r).spend)}, installs ${metrics(r).installs}`)
      for (const g of live.adGroups.filter((x) => x.campaignId === c.id)) {
        const kws = live.keywords.filter((k) => k.adGroupId === g.id)
        console.log(`  ${g.name}  [${g.displayStatus ?? g.status}]  bid $${g.bidStrategy?.bid?.amount}${g.automatedKeywordsOptIn ? "  Search Match" : ""}  ${(g.targeting?.deviceClass?.include ?? ["all devices"]).join("+")}  ${kws.filter((k) => k.status === "ENABLED").length}/${kws.length} keywords on  ad: ${live.ads.filter((a) => a.adGroupId === g.id && a.status === "ENABLED").map((a) => a.productPage).join(", ") || "default page"}`)
      }
    }
    return
  }

  if (command === "report" || command === "optimize") {
    const live = await snapshot(plan)
    const from = since(plan)
    const to = opt("to", today())
    const rep = await reports(live, from, to)
    const funnel = await subscribersByKeyword(from, to)
    if (command === "report") {
      console.log(`Apple Ads ${from} → ${to}${funnel ? " (subs: AdServices attribution)" : ""}\n`)
      table(rep.campaigns, [["campaign", (r) => r.campaignName], ...metricCols(null)])
      console.log("")
      table([...rep.keywords].sort((a, b) => metrics(b).spend - metrics(a).spend || metrics(b).impressions - metrics(a).impressions), [
        ["keyword", (r) => `${r.metadata?.matchType === "EXACT" ? `[${r.metadata?.text}]` : r.metadata?.text}  (${r.metadata?.adGroup?.name ?? ""})`],
        ["bid", (r) => usd(Number(r.metadata?.bid?.amount))],
        ["sugg", (r) => usd(r.insights?.bidRecommendation?.suggestedBidAmount ?? null)],
        ...metricCols(funnel?.subs)
      ])
      console.log("")
      table([...rep.searchTerms].sort((a, b) => metrics(b).taps - metrics(a).taps).slice(0, Number(opt("terms", 30))), [
        ["search term", (r) => `${r.metadata?.searchTermText ?? "(low volume)"}  ← ${r.metadata?.keyword?.text ?? "Search Match"}`],
        ...metricCols(null)
      ])
      if (opt("json")) writeFileSync(resolve(opt("json")), JSON.stringify({ from, to, plan, ...rep, funnel: funnel?.rows ?? null }, null, 2))
      return
    }
    const proposals = optimize(plan, { keywords: rep.keywords, searchTerms: rep.searchTerms, subs: funnel?.subs ?? {} })
    if (!proposals.length) return console.log("No changes suggested by the rules.")
    for (const p of proposals) console.log(`- ${p.action.padEnd(8)} ${p.text}${p.adGroup ? ` (${p.adGroup})` : ""}${p.to != null ? ` → $${p.to}` : ""}: ${p.why}`)
    if (!flag("write")) return console.log("\nAdd --write to put these into the plan, then run plan / apply.")
    writeFileSync(PLAN, JSON.stringify(applyProposals(plan, proposals), null, 2) + "\n")
    console.log(`Updated ${PLAN}. Review it, then: node tools/ads/asa.mjs apply --yes`)
    return
  }

  if (command === "popularity") {
    const countries = opt("country", "US").split(",")
    const grep = opt("grep", "")
    const end = new Date(Date.now() - 86400000 * ((new Date().getUTCDay() + 1) % 7 || 7))
    const start = new Date(end.getTime() - 6 * 86400000)
    const rows = await query("/insights/apps/search-term-popularity/query", [
      { field: "countryOrRegion", operator: "IN", value: countries },
      ...(opt("genre") ? [{ field: "genre", operator: "EQUALS", value: opt("genre") }] : [])
    ], { timeRange: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), granularity: "WEEKLY_SUN_SAT" }, fields: ["searchTerm", "countryOrRegion", "genre", "rankInGenre", "searchPopularity1to5", "searchPopularity1to100"] })
    const hits = rows.filter((r) => !grep || grep.split("|").some((g) => r.searchTerm?.toLowerCase().includes(g.toLowerCase())))
    table(hits.sort((a, b) => (b.searchPopularity1to100 ?? 0) - (a.searchPopularity1to100 ?? 0)).slice(0, 80), [
      ["term", (r) => r.searchTerm], ["cc", (r) => r.countryOrRegion], ["genre", (r) => r.genre], ["pop5", (r) => r.searchPopularity1to5 ?? "–"], ["pop100", (r) => r.searchPopularity1to100 ?? "–"]
    ])
    return
  }

  if (command === "stop") {
    const live = await snapshot(plan)
    const on = live.campaigns.filter((c) => c.status === "ENABLED")
    if (!on.length) return console.log("Nothing is running.")
    if (!flag("yes")) return console.log(`Would pause: ${on.map((c) => c.name).join(", ")}. Add --yes.`)
    for (const c of on) await call("PUT", `/campaigns/${c.id}`, { status: "PAUSED" })
    console.log(`Paused ${on.length} campaign(s).`)
    return
  }

  throw new Error(`unknown command "${command}" (see: node tools/ads/asa.mjs help)`)
}

async function spentSince(live, from) {
  const rep = await reports(live, from, today())
  return rep.campaigns.reduce((s, r) => s + metrics(r).spend, 0)
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
