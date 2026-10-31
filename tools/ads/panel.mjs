// Apple Ads panel for ContextFlow: a local web page over the same plan and API as asa.mjs.
// Shows campaigns, ad groups, keywords and search terms with their numbers; edits (bids, pauses,
// new keywords, negatives, budgets) go into a draft of store/ads/plan.json, are previewed as the
// list of Apple Ads changes, pass the same budget / max-bid guard, and are applied on confirm.
//   node tools/ads/panel.mjs [--port 8790]   → http://localhost:8790 (this Mac only)
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { apply, readJson, reports, snapshot, spentSince, stopAll, subscribersByKeyword, today } from "./api.mjs"
import { applyProposals, diffPlan, guardProblems, optimize } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const PLAN = resolve(here, "../../store/ads/plan.json")
const portArg = process.argv.indexOf("--port")
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT ?? 8790)

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" })
  res.end(type === "application/json" ? JSON.stringify(body) : body)
}
const readBody = async (req) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}
const since = (plan) => plan.guards?.since ?? plan.campaigns.map((c) => c.start).sort()[0] ?? today()
/** Report rows without Apple's bulky metadata the page doesn't need. */
const slim = (rows) => rows.map(({ granularMetrics, ...r }) => r)

async function state(from, to) {
  const plan = readJson(PLAN)
  const live = await snapshot(plan)
  const rep = await reports(live, from ?? since(plan), to ?? today())
  const funnel = await subscribersByKeyword(from ?? since(plan), to ?? today())
  const spent = from || to ? await spentSince(live, since(plan)) : rep.campaigns.reduce((s, r) => s + Number(r.totalMetrics?.localSpend?.amount ?? 0), 0)
  return {
    plan,
    live: {
      campaigns: live.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, displayStatus: c.displayStatus, startTime: c.startTime, endTime: c.endTime })),
      adGroups: live.adGroups.map((g) => ({ id: g.id, campaignId: g.campaignId, name: g.name, status: g.status, displayStatus: g.displayStatus })),
      keywords: live.keywords.map((k) => ({ id: k.id, adGroupId: k.adGroupId, text: k.text, matchType: k.matchType, status: k.status, displayStatus: k.displayStatus }))
    },
    report: { campaigns: slim(rep.campaigns), adGroups: slim(rep.adGroups), keywords: slim(rep.keywords), searchTerms: slim(rep.searchTerms) },
    subs: funnel?.subs ?? null,
    spent,
    pending: diffPlan(plan, live).ops.map((o) => o.desc),
    proposals: optimize(plan, { keywords: rep.keywords, searchTerms: rep.searchTerms, subs: funnel?.subs ?? {} }),
    period: { from: from ?? since(plan), to: to ?? today() }
  }
}

async function preview(draft) {
  const live = await snapshot(draft)
  const { ops, notes } = diffPlan(draft, live)
  const { problems, total } = guardProblems(draft)
  return { live, ops, notes, problems, total }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, readFileSync(join(here, "panel.html"), "utf8"), "text/html")
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await state(url.searchParams.get("from"), url.searchParams.get("to")))
    if (req.method === "POST" && url.pathname === "/api/preview") {
      const { ops, notes, problems, total } = await preview((await readBody(req)).plan)
      return send(res, 200, { ops: ops.map((o) => ({ desc: o.desc, launch: Boolean(o.launch) })), notes, problems, total })
    }
    if (req.method === "POST" && url.pathname === "/api/proposals") {
      const { plan: draft, proposals } = await readBody(req)
      return send(res, 200, { plan: applyProposals(draft, proposals) })
    }
    if (req.method === "POST" && url.pathname === "/api/apply") {
      const { plan: draft, launch } = await readBody(req)
      const { live, ops, problems } = await preview(draft)
      if (problems.length) return send(res, 400, { error: problems.join("; ") })
      if (ops.some((o) => o.launch) && !launch) return send(res, 400, { error: "Изменения включают кампанию: подтвердите запуск" })
      if (ops.some((o) => o.launch) && draft.guards?.totalBudget != null && (await spentSince(live, since(draft))) >= draft.guards.totalBudget) {
        return send(res, 400, { error: `Бюджет $${draft.guards.totalBudget} уже потрачен` })
      }
      // The plan is the intent: saved first, so a change that fails half-way shows up in the next preview.
      writeFileSync(PLAN, JSON.stringify(draft, null, 2) + "\n")
      const done = []
      try {
        await apply(draft, ops, live, (op) => done.push(op.desc))
      } catch (e) {
        return send(res, 500, { done, error: e.message })
      }
      return send(res, 200, { done })
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const plan = readJson(PLAN)
      const paused = await stopAll(await snapshot(plan))
      for (const c of plan.campaigns) if (paused.includes(c.name)) c.status = "PAUSED"
      writeFileSync(PLAN, JSON.stringify(plan, null, 2) + "\n")
      return send(res, 200, { paused })
    }
    send(res, 404, { error: "not found" })
  } catch (e) {
    send(res, 500, { error: e.message })
  }
})

// Localhost only: the panel can spend money and has no login of its own.
server.listen(PORT, "127.0.0.1", () => console.log(`Apple Ads panel: http://localhost:${PORT}`))
