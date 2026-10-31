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
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { DIR, apply, call, query, readJson, reports, snapshot, spentSince, stopAll, subscribersByKeyword, today } from "./api.mjs"
import { applyProposals, diffPlan, guardProblems, metrics, optimize } from "./lib.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const [command = "help", ...rest] = process.argv.slice(2)
const flag = (name) => rest.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : fallback
}
const PLAN = resolve(opt("plan", join(root, "store/ads/plan.json")))
const usd = (x) => (x == null ? "–" : `$${x.toFixed(2)}`)
const pct = (x) => `${(x * 100).toFixed(1)}%`

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
    await apply(plan, ops, live, (op) => console.log(`→ ${op.desc} … ok`))
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
    console.log(`Paused: ${(await stopAll(live)).join(", ")}`)
    return
  }

  throw new Error(`unknown command "${command}" (see: node tools/ads/asa.mjs help)`)
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
