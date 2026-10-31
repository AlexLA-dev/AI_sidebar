// Pure logic of the Apple Ads tool (no network): the client secret, payloads for the Apple Ads
// Platform API v1, the diff between store/ads/plan.json and what is live, the budget guard and
// the optimization rules. asa.mjs does the I/O; tests/ads.test.mts covers this file.
import { sign } from "node:crypto"

export const API = "https://api.ads.apple.com/v1"

// ------------------------------------------------------------------ auth

/** ES256 JWT that Apple's OAuth server takes as client_secret (valid up to 180 days). */
export function clientSecret({ clientId, teamId, keyId }, privateKeyPem, now = Math.floor(Date.now() / 1000), days = 180) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const head = part({ alg: "ES256", kid: keyId })
  const body = part({ sub: clientId, aud: "https://appleid.apple.com", iat: now, exp: now + 86400 * days, iss: teamId })
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKeyPem, dsaEncoding: "ieee-p1363" })
  return `${head}.${body}.${signature.toString("base64url")}`
}

// ------------------------------------------------------------------ plan

export const money = (amount, currency = "USD") => ({ amount: Number(amount).toFixed(2), currency })
const amount = (m) => (m?.amount == null ? null : Number(m.amount))
const norm = (s) => String(s ?? "").trim().toLowerCase()
const kwKey = (text, match) => `${norm(text)}|${match ?? "EXACT"}`

/** Apple wants "yyyy-MM-ddTHH:mm:ss.SSS" in UTC. "2026-11-01" → start of that day, end → its last ms. */
export function apiTime(date, end = false) {
  if (!date) return undefined
  if (/T/.test(date)) return date.replace(/Z$/, "")
  return `${date}T${end ? "23:59:59.999" : "00:00:00.000"}`
}

/** Days a campaign can spend: start..end inclusive (UTC dates). */
export function campaignDays(c) {
  if (!c.start || !c.end) return Infinity
  return Math.round((Date.parse(c.end.slice(0, 10)) - Date.parse(c.start.slice(0, 10))) / 86400000) + 1
}

/** Everything that could block a safe apply: overspend, bids above the cap, missing end dates. */
export function guardProblems(plan) {
  const g = plan.guards ?? {}
  const problems = []
  let total = 0
  for (const c of plan.campaigns) {
    if (c.status === "REMOVED") continue
    const days = campaignDays(c)
    if (!Number.isFinite(days)) problems.push(`${c.name}: no start/end date, spend has no ceiling`)
    else total += c.dailyBudget * days
    for (const g2 of c.adGroups ?? []) {
      const bids = [g2.bid, ...(g2.keywords ?? []).map((k) => k.bid)].filter((b) => b != null)
      for (const b of bids) if (g.maxBid != null && b > g.maxBid) problems.push(`${c.name} / ${g2.name}: bid $${b} is above maxBid $${g.maxBid}`)
    }
  }
  if (g.totalBudget != null && total > g.totalBudget + 1e-9) problems.push(`daily budgets × days = $${total.toFixed(2)}, above totalBudget $${g.totalBudget}`)
  return { problems, total }
}

export function campaignPayload(c, plan, adAccountId) {
  return {
    name: c.name,
    adAccountId: Number(adAccountId),
    billingEvent: "TAPS",
    promotedObjectType: "APPSTORE_APP",
    promotedObjectId: String(plan.app.adamId),
    dailyBudget: { value: money(c.dailyBudget, plan.currency) },
    targeting: {
      supplySource: { include: ["APPSTORE"] },
      supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] },
      countryOrRegion: { include: c.countries }
    },
    bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" },
    // A start in the past is rejected; without one the campaign can serve as soon as it's switched on.
    startTime: c.start && Date.parse(`${c.start.slice(0, 10)}T00:00:00Z`) > Date.now() ? apiTime(c.start) : undefined,
    endTime: apiTime(c.end, true),
    // New campaigns always start paused; switching one on is a separate, explicit step (--launch).
    status: "PAUSED"
  }
}

export function adGroupTargeting(g, plan) {
  const targeting = {}
  if (g.devices?.length) targeting.deviceClass = { include: g.devices }
  // "New users": people who never downloaded the app. No age/gender targeting on purpose: it
  // drops users with Personalized Ads off and AdServices then reports attribution=false.
  if (g.newUsersOnly) targeting.appDownloader = { exclude: [String(plan.app.adamId)] }
  if (g.daypart?.length) targeting.daypart = { include: g.daypart.map(String) }
  return targeting
}

export function adGroupPayload(g, campaignId, plan) {
  return {
    campaignId: Number(campaignId),
    name: g.name,
    pricingModel: "CPT",
    bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: money(g.bid, plan.currency) },
    automatedKeywordsOptIn: Boolean(g.searchMatch),
    targeting: adGroupTargeting(g, plan),
    status: g.status === "PAUSED" ? "PAUSED" : "ENABLED"
  }
}

const sameList = (a = [], b = []) => [...a].map(String).sort().join() === [...b].map(String).sort().join()

/**
 * What has to change in Apple Ads so that it matches the plan. Live objects are matched by name
 * (campaigns, ad groups) and by text + match type (keywords). Nothing is ever deleted: a keyword
 * that left the plan is paused, and extra negatives are only reported.
 * @returns {{ops: object[], notes: string[]}}
 */
export function diffPlan(plan, live) {
  const ops = []
  const statusOps = []
  const notes = []
  const cur = plan.currency ?? "USD"
  for (const c of plan.campaigns) {
    const lc = live.campaigns.find((x) => x.name === c.name && !x.deleted)
    if (!lc) {
      if (c.status === "REMOVED") continue
      ops.push({ kind: "campaign.create", campaign: c.name, payload: campaignPayload(c, plan, live.adAccountId), desc: `create campaign "${c.name}" (${c.countries.join(", ")}, $${c.dailyBudget}/day, ${c.start} → ${c.end}, paused)` })
    } else {
      const patch = {}
      if (amount(lc.dailyBudget?.value) !== c.dailyBudget) patch.dailyBudget = { value: money(c.dailyBudget, cur) }
      if (!sameList(lc.targeting?.countryOrRegion?.include, c.countries)) patch.targeting = { countryOrRegion: { include: c.countries } }
      if ((lc.endTime ?? "").slice(0, 10) !== (c.end ?? "")) patch.endTime = apiTime(c.end, true)
      if (Object.keys(patch).length) ops.push({ kind: "campaign.update", id: lc.id, payload: patch, desc: `update campaign "${c.name}": ${Object.keys(patch).join(", ")}` })
    }
    const wantStatus = c.status === "ENABLED" ? "ENABLED" : "PAUSED"
    const liveStatus = lc?.status ?? "PAUSED"
    if (wantStatus !== liveStatus) {
      // Switching on/off goes last, after the ad groups, keywords and ads it needs exist.
      statusOps.push({ kind: "campaign.status", campaign: c.name, id: lc?.id, payload: { status: wantStatus }, launch: wantStatus === "ENABLED", desc: `${wantStatus === "ENABLED" ? "LAUNCH" : "pause"} campaign "${c.name}"` })
    }

    const liveGroups = lc ? live.adGroups.filter((g) => g.campaignId === lc.id && !g.deleted) : []
    const liveCampaignNeg = lc ? live.negatives.filter((n) => n.campaignId === lc.id && !n.adGroupId && !n.deleted) : []
    const missingNeg = (c.negatives ?? []).filter((n) => !liveCampaignNeg.some((x) => kwKey(x.text, x.matchType) === kwKey(n.text, n.match ?? "BROAD")))
    if (missingNeg.length) ops.push({ kind: "negatives.create", campaign: c.name, items: missingNeg.map((n) => ({ text: n.text, matchType: n.match ?? "BROAD" })), desc: `add ${missingNeg.length} campaign negative(s) to "${c.name}": ${missingNeg.map((n) => n.text).join(", ")}` })

    for (const g of c.adGroups ?? []) {
      const lg = liveGroups.find((x) => x.name === g.name)
      if (!lg) {
        ops.push({ kind: "adgroup.create", campaign: c.name, adGroup: g.name, payload: adGroupPayload(g, lc?.id ?? 0, plan), desc: `create ad group "${c.name} / ${g.name}" (bid $${g.bid}${g.searchMatch ? ", Search Match" : ""}${g.devices ? ", " + g.devices.join("+") : ""})` })
      } else {
        const patch = {}
        if (amount(lg.bidStrategy?.bid) !== g.bid) patch.bidStrategy = { bid: money(g.bid, cur) }
        if (Boolean(lg.automatedKeywordsOptIn) !== Boolean(g.searchMatch)) patch.automatedKeywordsOptIn = Boolean(g.searchMatch)
        const want = adGroupTargeting(g, plan)
        if (!sameList(lg.targeting?.deviceClass?.include, want.deviceClass?.include) || !sameList(lg.targeting?.appDownloader?.exclude, want.appDownloader?.exclude)) patch.targeting = want
        const st = g.status === "PAUSED" ? "PAUSED" : "ENABLED"
        if (lg.status !== st) patch.status = st
        if (Object.keys(patch).length) ops.push({ kind: "adgroup.update", id: lg.id, payload: patch, desc: `update ad group "${c.name} / ${g.name}": ${Object.keys(patch).join(", ")}` })
      }

      const liveKw = lg ? live.keywords.filter((k) => k.adGroupId === lg.id && !k.deleted) : []
      const create = []
      const update = []
      for (const k of g.keywords ?? []) {
        const match = k.match ?? "EXACT"
        const lk = liveKw.find((x) => kwKey(x.text, x.matchType) === kwKey(k.text, match))
        const status = k.status === "PAUSED" ? "PAUSED" : "ENABLED"
        if (!lk) {
          create.push({ text: k.text, matchType: match, status, ...(k.bid != null ? { bid: money(k.bid, cur) } : {}) })
          continue
        }
        const patch = {}
        if (k.bid != null && amount(lk.bid) !== k.bid) patch.bid = money(k.bid, cur)
        if (lk.status !== status) patch.status = status
        if (Object.keys(patch).length) update.push({ id: lk.id, text: k.text, ...patch })
      }
      for (const lk of liveKw) {
        const inPlan = (g.keywords ?? []).some((k) => kwKey(k.text, k.match ?? "EXACT") === kwKey(lk.text, lk.matchType))
        if (!inPlan && lk.status !== "PAUSED") update.push({ id: lk.id, text: lk.text, status: "PAUSED" })
      }
      if (create.length) ops.push({ kind: "keywords.create", campaign: c.name, adGroup: g.name, items: create, desc: `add ${create.length} keyword(s) to "${g.name}": ${create.map((k) => `${k.text}${k.bid ? " $" + k.bid.amount : ""}`).join(", ")}` })
      if (update.length) ops.push({ kind: "keywords.update", items: update, desc: `change ${update.length} keyword(s) in "${g.name}": ${update.map((k) => `${k.text} → ${[k.bid && "$" + k.bid.amount, k.status].filter(Boolean).join(" ")}`).join(", ")}` })

      // Ad-group negatives: the group's own list, plus every exact keyword of the campaign's other
      // groups when the group discovers new terms (Search Match / broad), so they don't compete.
      const groupNeg = [...(g.negatives ?? [])]
      if (g.negateCampaignExact) {
        for (const other of c.adGroups) {
          if (other === g) continue
          for (const k of other.keywords ?? []) if ((k.match ?? "EXACT") === "EXACT") groupNeg.push({ text: k.text, match: "EXACT" })
        }
      }
      const liveGroupNeg = lg ? live.negatives.filter((n) => n.adGroupId === lg.id && !n.deleted) : []
      const seen = new Set()
      const missingGroupNeg = groupNeg.filter((n) => {
        const key = kwKey(n.text, n.match ?? "BROAD")
        if (seen.has(key)) return false
        seen.add(key)
        return !liveGroupNeg.some((x) => kwKey(x.text, x.matchType) === key)
      })
      if (missingGroupNeg.length) ops.push({ kind: "negatives.create", campaign: c.name, adGroup: g.name, items: missingGroupNeg.map((n) => ({ text: n.text, matchType: n.match ?? "BROAD" })), desc: `add ${missingGroupNeg.length} negative(s) to ad group "${g.name}"` })

      // The ad: the default product page or a custom product page (by its App Store Connect name).
      // An ad group without any enabled ad shows the default page (ad groups made in the web UI have
      // no ad object for it), so "default" needs an ad only when a custom one has to be replaced.
      const page = g.productPage ?? "default"
      const liveAds = lg ? live.ads.filter((a) => a.adGroupId === lg.id && !a.deleted) : []
      const enabledAds = liveAds.filter((a) => a.status === "ENABLED")
      const current = enabledAds.find((a) => a.productPage === page) ?? (page === "default" && lg && !enabledAds.length ? "implicit" : null)
      if (!current) ops.push({ kind: "ad.create", campaign: c.name, adGroup: g.name, productPage: page, pauseAdIds: liveAds.filter((a) => a.status === "ENABLED").map((a) => a.id), desc: `ad in "${g.name}": ${page === "default" ? "default product page" : `custom product page "${page}"`}` })
    }
    for (const lg of liveGroups) if (!(c.adGroups ?? []).some((g) => g.name === lg.name) && lg.status !== "PAUSED") notes.push(`ad group "${c.name} / ${lg.name}" is live but not in the plan (left as is)`)
  }
  const extra = live.campaigns.filter((x) => !x.deleted && x.status === "ENABLED" && !plan.campaigns.some((c) => c.name === x.name))
  for (const x of extra) notes.push(`campaign "${x.name}" is running but not in the plan (left as is)`)
  return { ops: [...ops, ...statusOps], notes }
}

// ------------------------------------------------------------------ reports

const m = (row) => row?.totalMetrics ?? {}
export function metrics(row) {
  const t = m(row)
  const installs = Number(t.totalInstalls ?? t.tapInstalls ?? 0)
  const spend = amount(t.localSpend) ?? 0
  return {
    impressions: Number(t.impressions ?? 0),
    taps: Number(t.taps ?? 0),
    installs,
    newDownloads: Number(t.totalNewDownloads ?? t.tapNewDownloads ?? 0),
    spend,
    ttr: t.taps && t.impressions ? t.taps / t.impressions : 0,
    cpt: t.taps ? spend / t.taps : 0,
    cpi: installs ? spend / installs : null
  }
}

// ------------------------------------------------------------------ optimization rules

export const DEFAULT_RULES = {
  // A keyword is cut when it clearly doesn't produce installs.
  pauseTapsWithoutInstall: 12,
  pauseSpendWithoutInstall: 4,
  // …or when people see the ad and skip it (irrelevant intent).
  lowTtrImpressions: 300,
  lowTtr: 0.025,
  // Installs at or below target CPI get more reach; much dearer ones get a lower bid.
  targetCpi: 1.5,
  raiseStep: 0.15,
  lowerStep: 0.2,
  minBid: 0.2,
  // Search terms found by Search Match / broad: promote on the first install, block when they burn money.
  negativeSpendWithoutInstall: 1.5
}

const round2 = (x) => Math.round(x * 100 + 1e-6) / 100

/**
 * Proposes plan edits from keyword and search-term rows. Each proposal says why and what it
 * changes in plan.json; applyProposals() writes them in. `subs` maps keyword id → paid subscribers
 * (from AdServices attribution), when known: a keyword that brought a subscriber is never paused.
 */
export function optimize(plan, { keywords = [], searchTerms = [], subs = {} }, rules = {}) {
  const r = { ...DEFAULT_RULES, ...(plan.guards?.rules ?? {}), ...rules }
  const maxBid = plan.guards?.maxBid ?? Infinity
  const out = []
  const findKw = (campaignName, groupName, text, match) => {
    const c = plan.campaigns.find((x) => x.name === campaignName)
    const g = c?.adGroups?.find((x) => x.name === groupName)
    const k = g?.keywords?.find((x) => kwKey(x.text, x.match ?? "EXACT") === kwKey(text, match))
    return { c, g, k }
  }
  for (const row of keywords) {
    const meta = row.metadata ?? {}
    const { c, g, k } = findKw(row.campaignName, meta.adGroup?.name, meta.text, meta.matchType)
    if (!k || k.status === "PAUSED" || k.locked) continue
    const x = metrics(row)
    const bid = k.bid ?? g.bid
    const paid = subs[meta.id] ?? 0
    const at = { campaign: c.name, adGroup: g.name, text: k.text, match: k.match ?? "EXACT" }
    if (paid === 0 && x.installs === 0 && (x.taps >= r.pauseTapsWithoutInstall || x.spend >= r.pauseSpendWithoutInstall)) {
      out.push({ ...at, action: "pause", why: `${x.taps} taps, $${x.spend.toFixed(2)} spent, 0 installs` })
    } else if (paid === 0 && x.impressions >= r.lowTtrImpressions && x.ttr < r.lowTtr) {
      out.push({ ...at, action: "pause", why: `TTR ${(x.ttr * 100).toFixed(1)}% on ${x.impressions} impressions: people skip this ad` })
    } else if (x.cpi != null && (x.cpi <= r.targetCpi || paid > 0) && bid < maxBid) {
      const next = round2(Math.min(maxBid, bid * (1 + r.raiseStep)))
      if (next > bid) out.push({ ...at, action: "bid", from: bid, to: next, why: paid > 0 ? `${paid} subscriber(s), CPI $${x.cpi.toFixed(2)}` : `CPI $${x.cpi.toFixed(2)} ≤ target $${r.targetCpi}` })
    } else if (x.cpi != null && x.cpi > 2 * r.targetCpi && paid === 0) {
      const next = round2(Math.max(r.minBid, bid * (1 - r.lowerStep)))
      if (next < bid) out.push({ ...at, action: "bid", from: bid, to: next, why: `CPI $${x.cpi.toFixed(2)} > 2 × target` })
    }
  }
  for (const row of searchTerms) {
    const meta = row.metadata ?? {}
    const term = meta.searchTermText
    if (!term) continue
    const c = plan.campaigns.find((x) => x.name === row.campaignName)
    if (!c) continue
    const x = metrics(row)
    const exists = c.adGroups.some((g) => (g.keywords ?? []).some((k) => norm(k.text) === norm(term)))
    const negated = (c.negatives ?? []).some((n) => norm(n.text) === norm(term))
    const fromDiscovery = meta.searchTermSource === "AUTO" || meta.keyword?.matchType === "BROAD"
    if (!fromDiscovery || exists || negated) continue
    const target = c.adGroups.find((g) => g.promoteTo) ?? c.adGroups.find((g) => !g.searchMatch)
    if (x.installs > 0 && target) {
      const to = round2(Math.min(maxBid, Math.max(target.bid, x.cpt * 1.1)))
      out.push({ campaign: c.name, adGroup: target.name, text: term, match: "EXACT", action: "promote", to, why: `search term brought ${x.installs} install(s) at CPT $${x.cpt.toFixed(2)}` })
    } else if (x.installs === 0 && x.spend >= r.negativeSpendWithoutInstall) {
      out.push({ campaign: c.name, text: term, match: "EXACT", action: "negative", why: `search term spent $${x.spend.toFixed(2)} with 0 installs` })
    }
  }
  return out
}

/** Writes proposals into a copy of the plan. */
export function applyProposals(plan, proposals) {
  const next = structuredClone(plan)
  for (const p of proposals) {
    const c = next.campaigns.find((x) => x.name === p.campaign)
    if (!c) continue
    if (p.action === "negative") {
      c.negatives = c.negatives ?? []
      if (!c.negatives.some((n) => norm(n.text) === norm(p.text))) c.negatives.push({ text: p.text, match: "EXACT" })
      continue
    }
    const g = c.adGroups.find((x) => x.name === p.adGroup)
    if (!g) continue
    g.keywords = g.keywords ?? []
    const k = g.keywords.find((x) => kwKey(x.text, x.match ?? "EXACT") === kwKey(p.text, p.match))
    if (p.action === "pause" && k) k.status = "PAUSED"
    if (p.action === "bid" && k) k.bid = p.to
    if (p.action === "promote" && !k) g.keywords.push({ text: p.text, match: "EXACT", bid: p.to })
  }
  return next
}
