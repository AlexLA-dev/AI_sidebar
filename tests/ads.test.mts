import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { applyProposals, clientSecret, diffPlan, guardProblems, optimize } from "../tools/ads/lib.mjs"

const plan = JSON.parse(readFileSync(new URL("../store/ads/plan.json", import.meta.url), "utf8"))
type Rows = Record<string, any>[]
const empty = { adAccountId: 42, campaigns: [] as Rows, adGroups: [] as Rows, keywords: [] as Rows, negatives: [] as Rows, ads: [] as Rows, creatives: [] as Rows }

test("the shipped plan stays within $50 and the bid cap", () => {
  const { problems, total } = guardProblems(plan)
  assert.deepEqual(problems, [])
  assert.ok(total <= 50)
})

test("guard blocks overspend, open-ended campaigns and bids above the cap", () => {
  const p = structuredClone(plan)
  p.campaigns[0].dailyBudget = 10
  p.campaigns[1].end = undefined
  p.campaigns[0].adGroups[0].keywords[0].bid = 3
  const { problems } = guardProblems(p)
  assert.ok(problems.some((x) => /above totalBudget/.test(x)))
  assert.ok(problems.some((x) => /no start\/end date/.test(x)))
  assert.ok(problems.some((x) => /above maxBid/.test(x)))
})

test("an empty account gets every campaign paused, iPad-only and new users only", () => {
  const paused = structuredClone(plan)
  for (const c of paused.campaigns) c.status = "PAUSED"
  const { ops } = diffPlan(paused, empty)
  const campaigns = ops.filter((o) => o.kind === "campaign.create")
  assert.equal(campaigns.length, 2)
  assert.ok(campaigns.every((o) => o.payload.status === "PAUSED" && o.payload.targeting.supplyPlacement.include[0] === "APPSTORE_SEARCH_RESULTS"))
  assert.equal(ops.filter((o) => o.launch).length, 0)
  // Even an ENABLED plan creates paused campaigns and switches them on in a separate, flagged step.
  assert.equal(diffPlan({ ...paused, campaigns: paused.campaigns.map((c: Record<string, unknown>) => ({ ...c, status: "ENABLED" })) }, empty).ops.filter((o) => o.launch).length, 2)
  const groups = ops.filter((o) => o.kind === "adgroup.create")
  assert.ok(groups.every((o) => o.payload.targeting.deviceClass.include.join() === "IPAD"))
  assert.ok(groups.every((o) => o.payload.targeting.appDownloader.exclude.join() === "6759115793"))
  assert.ok(groups.every((o) => !o.payload.targeting.minAge && !o.payload.targeting.gender))
  const discovery = groups.find((o) => o.adGroup.startsWith("Discovery") && o.campaign.includes("EN"))
  assert.equal(discovery?.payload.automatedKeywordsOptIn, true)
  // Search Match doesn't bid on what the exact groups already cover.
  const neg = ops.find((o) => o.kind === "negatives.create" && o.adGroup === discovery?.adGroup && o.campaign === discovery?.campaign)
  assert.ok(neg?.items.some((n: { text: string; matchType: string }) => n.text === "safari ai" && n.matchType === "EXACT"))
  assert.ok(neg?.items.some((n: { text: string; matchType: string }) => n.text === "sider" && n.matchType === "EXACT"))
})

test("launching is the last step and is flagged", () => {
  const p = structuredClone(plan)
  p.campaigns[0].status = "ENABLED"
  p.campaigns[1].status = "PAUSED"
  const { ops } = diffPlan(p, empty)
  assert.equal(ops.at(-1)?.kind, "campaign.status")
  assert.equal(ops.at(-1)?.launch, true)
})

test("a live account that matches the plan needs no changes; drift becomes updates, never deletes", () => {
  const live = structuredClone(empty)
  let id = 1
  for (const c of plan.campaigns) {
    const cid = id++
    live.campaigns.push({ id: cid, name: c.name, status: c.status, dailyBudget: { value: { amount: String(c.dailyBudget) } }, targeting: { countryOrRegion: { include: c.countries } }, endTime: `${c.end}T23:59:59.999` })
    for (const n of c.negatives) live.negatives.push({ id: id++, campaignId: cid, text: n.text, matchType: n.match ?? "BROAD" })
    for (const g of c.adGroups) {
      const gid = id++
      live.adGroups.push({ id: gid, campaignId: cid, name: g.name, status: "ENABLED", bidStrategy: { bid: { amount: String(g.bid) } }, automatedKeywordsOptIn: Boolean(g.searchMatch), targeting: { deviceClass: { include: g.devices }, appDownloader: { exclude: ["6759115793"] } } })
      for (const k of g.keywords) live.keywords.push({ id: id++, adGroupId: gid, text: k.text, matchType: k.match ?? "EXACT", status: "ENABLED", bid: { amount: String(k.bid ?? g.bid) } })
      live.ads.push({ id: id++, adGroupId: gid, status: "ENABLED", productPage: "default" })
      for (const n of g.negatives ?? []) live.negatives.push({ id: id++, adGroupId: gid, text: n.text, matchType: n.match ?? "BROAD" })
      if (g.negateCampaignExact) for (const o of c.adGroups) if (o !== g) for (const k of o.keywords) if ((k.match ?? "EXACT") === "EXACT") live.negatives.push({ id: id++, adGroupId: gid, text: k.text, matchType: "EXACT" })
    }
  }
  assert.deepEqual(diffPlan(plan, live).ops, [])

  // Ad groups made in the web UI have no ad object: that is the default product page, not a change.
  assert.deepEqual(diffPlan(plan, { ...live, ads: [] }).ops, [])
  const custom = structuredClone(live)
  custom.ads[0].productPage = "BetterScreenshots#1"
  assert.deepEqual(diffPlan(plan, custom).ops.map((o) => [o.kind, o.productPage, o.pauseAdIds?.length]), [["ad.create", "default", 1]])

  const drift = structuredClone(live)
  drift.keywords[0].bid = { amount: "1.40" }
  drift.keywords.push({ id: 9999, adGroupId: drift.keywords[0].adGroupId, text: "stray", matchType: "EXACT", status: "ENABLED" })
  const { ops } = diffPlan(plan, drift)
  assert.equal(ops.length, 1)
  assert.equal(ops[0].kind, "keywords.update")
  assert.deepEqual(ops[0].items.map((k: { text: string; bid?: { amount: string }; status?: string }) => [k.text, k.bid?.amount ?? null, k.status ?? null]), [[drift.keywords[0].text, plan.campaigns[0].adGroups[0].keywords[0].bid.toFixed(2), null], ["stray", null, "PAUSED"]])

  // A keyword without its own bid follows its group's bid.
  const follow = structuredClone(plan)
  const fg = follow.campaigns[0].adGroups.find((g: { keywords?: { bid?: number }[] }) => g.keywords?.some((k) => k.bid == null)) ?? follow.campaigns[0].adGroups[0]
  const fk = fg.keywords.find((k: { bid?: number }) => k.bid == null) ?? fg.keywords[0]
  delete fk.bid
  fg.bid = 1.45
  const followUpdates = diffPlan(follow, live).ops.filter((o) => o.kind === "keywords.update").flatMap((o) => o.items)
  assert.ok(followUpdates.some((k: { text: string; bid?: { amount: string } }) => k.text === fk.text && k.bid?.amount === "1.45"))

  // A negative that left the plan is paused, after the groups; one that came back is switched on.
  const neg = structuredClone(live)
  neg.negatives.push({ id: 8888, campaignId: neg.campaigns[0].id, text: "old negative", matchType: "BROAD", status: "ENABLED" })
  neg.negatives[0].status = "PAUSED"
  const negOps = diffPlan(plan, neg).ops
  assert.deepEqual(negOps.map((o) => o.kind), ["negatives.update"])
  assert.deepEqual(negOps[0].items.map((n: { text: string; status: string }) => [n.text, n.status]), [[neg.negatives[0].text, "ENABLED"], ["old negative", "PAUSED"]])
})

const kwRow = (group: string, text: string, t: Record<string, unknown>, id = 1) => ({
  campaignName: "CF · iPad · EN · Search",
  metadata: { id, text, matchType: "EXACT", adGroup: { name: group } },
  totalMetrics: { localSpend: { amount: String(t.spend ?? 0) }, ...t }
})

test("rules pause dead keywords, raise cheap ones, promote and block search terms", () => {
  const keywords = [
    kwRow("Safari AI · exact", "safari ai", { impressions: 200, taps: 14, spend: 9, totalInstalls: 0 }),
    kwRow("Summarize · exact", "ai summarizer", { impressions: 100, taps: 4, spend: 3, totalInstalls: 3 }),
    kwRow("Summarize · exact", "tldr", { impressions: 400, taps: 5, spend: 2, totalInstalls: 0 })
  ]
  const searchTerms = [
    { campaignName: "CF · iPad · EN · Search", metadata: { searchTermText: "safari gpt sidebar", searchTermSource: "AUTO" }, totalMetrics: { taps: 2, impressions: 20, localSpend: { amount: "0.80" }, totalInstalls: 1 } },
    { campaignName: "CF · iPad · EN · Search", metadata: { searchTermText: "pdf reader", searchTermSource: "AUTO" }, totalMetrics: { taps: 4, impressions: 30, localSpend: { amount: "2.00" }, totalInstalls: 0 } }
  ]
  const proposals = optimize(plan, { keywords, searchTerms })
  const by = (t: string) => proposals.find((p: { text: string }) => p.text === t)
  assert.equal(by("safari ai")?.action, "pause")
  assert.equal(by("ai summarizer")?.action, "bid")
  const summarizer = plan.campaigns[0].adGroups[1].keywords.find((k: { text: string }) => k.text === "ai summarizer")
  assert.equal(by("ai summarizer")?.to, Math.min(plan.guards.maxBid, Math.round(summarizer.bid * 115 + 1e-6) / 100))
  assert.equal(by("tldr")?.action, "pause")
  assert.equal(by("safari gpt sidebar")?.action, "promote")
  assert.equal(by("safari gpt sidebar")?.adGroup, "Safari AI · exact")
  assert.equal(by("pdf reader")?.action, "negative")

  const next = applyProposals(plan, proposals)
  const g = next.campaigns[0].adGroups[0]
  assert.equal(g.keywords.find((k: { text: string }) => k.text === "safari ai").status, "PAUSED")
  assert.ok(g.keywords.some((k: { text: string }) => k.text === "safari gpt sidebar"))
  assert.ok(next.campaigns[0].negatives.some((n: { text: string }) => n.text === "pdf reader"))
  assert.ok(guardProblems(next).problems.length === 0)
})

test("a keyword that brought a subscriber is never paused", () => {
  const keywords = [kwRow("Safari AI · exact", "safari ai", { impressions: 200, taps: 14, spend: 9, totalInstalls: 0 }, 77)]
  const proposals = optimize(plan, { keywords, subs: { 77: 1 } })
  assert.notEqual(proposals[0]?.action, "pause")
})

test("client secret is an ES256 JWT Apple can verify with the uploaded public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwt = clientSecret({ clientId: "SEARCHADS.c", teamId: "SEARCHADS.t", keyId: "k1" }, privateKey.export({ type: "sec1", format: "pem" }) as string, 1_800_000_000)
  const [h, b, s] = jwt.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "k1" })
  const body = JSON.parse(Buffer.from(b, "base64url").toString())
  assert.equal(body.aud, "https://appleid.apple.com")
  assert.equal(body.sub, "SEARCHADS.c")
  assert.equal(body.iss, "SEARCHADS.t")
  assert.equal(body.exp - body.iat, 86400 * 180)
  assert.ok(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")))
})

test("pacing raises every bid of a campaign that underspent yesterday, within the cap", () => {
  const p = structuredClone(plan)
  p.campaigns[0].status = "ENABLED"
  p.campaigns[1].status = "ENABLED"
  const proposals = optimize(p, { lastDaySpend: { [p.campaigns[0].name]: 0.4, [p.campaigns[1].name]: p.campaigns[1].dailyBudget } })
  assert.ok(proposals.every((x) => x.action === "groupbid" && x.campaign === p.campaigns[0].name))
  assert.equal(proposals.length, p.campaigns[0].adGroups.length)
  const next = applyProposals(p, proposals)
  const g = next.campaigns[0].adGroups[0]
  assert.equal(g.bid, Math.round(p.campaigns[0].adGroups[0].bid * 115) / 100)
  const before = p.campaigns[0].adGroups[0].keywords.find((k: { bid?: number }) => k.bid != null)
  const after = g.keywords.find((k: { text: string }) => k.text === before.text)
  assert.ok(after.bid > before.bid && after.bid <= p.guards.maxBid)
  assert.deepEqual(guardProblems(next).problems, [])
})

test("an exact end time is compared to the minute", () => {
  const p = structuredClone(plan)
  p.campaigns = [p.campaigns[0]]
  const c = p.campaigns[0]
  c.end = "2026-11-06T22:00:00.000"
  const live = { ...empty, campaigns: [{ id: 1, name: c.name, status: c.status, dailyBudget: { value: { amount: String(c.dailyBudget) } }, targeting: { countryOrRegion: { include: c.countries } }, endTime: "2026-11-06T22:00:00.000" }] }
  assert.equal(diffPlan(p, live).ops.filter((o) => o.kind === "campaign.update").length, 0)
  live.campaigns[0].endTime = "2026-11-09T22:00:00.000"
  assert.deepEqual(diffPlan(p, live).ops.find((o) => o.kind === "campaign.update")?.payload, { endTime: "2026-11-06T22:00:00.000" })
})
