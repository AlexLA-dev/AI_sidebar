// A subscription's first payment never moves, and MRR's movement by day (20261128120000_contextflow_mrr_moves.sql).
// The SQL itself runs on PGlite outside the repo (ContextFlow-work/analytics/pg/test-mrr-moves.mjs); this pins the rule.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const read = (p: string) => readFileSync(join(root, p), "utf8")
const migration = read("supabase/migrations/20261128120000_contextflow_mrr_moves.sql")

test("paid_from: created_at when logging began after it paid; else the first payment note, never an expiry", () => {
  const terms = /create or replace function contextflow\.subscription_terms\(\)[\s\S]*?\n\$\$;/.exec(migration)?.[0] ?? ""
  assert.match(terms, /when coalesce\(f\.type, ''\) not in \('SUBSCRIBED', 'OFFER_REDEEMED'\) and \(f\.offer is null or f\.price > 0\) then s\.created_at/)
  assert.match(terms, /n\.price > 0 and n\.type in \('SUBSCRIBED', 'OFFER_REDEEMED', 'DID_RENEW'\)/)
  // The list prices of every product stay as in 20261108120000 (the latest version).
  for (const product of ["pro.yearly", "ultra.monthly", "ultra.yearly", "byok.yearly"]) assert.match(terms, new RegExp(`com\\.contextflow\\.${product.replace(".", "\\.")}`))
})

test("cf_mrr_moves is read only, for the service role, and the admin report carries it", () => {
  assert.match(migration, /create or replace function public\.cf_mrr_moves\(p_days integer default 30\)\nreturns jsonb language sql stable security definer/)
  assert.match(migration, /grant execute on function public\.cf_mrr_moves\(integer\) to service_role;/)
  assert.doesNotMatch(migration, /\b(insert into|update contextflow|delete from)\b/i)
  const admin = read("netlify/functions/v2-admin-usage.mts")
  assert.match(admin, /mrrMoves\(days\)\.catch\(\(\) => null\)/)
  assert.match(admin, /mrr_moves: moves/)
  const page = read("site/analytics.html")
  assert.match(page, /movesChart\(data\.mrr_moves, fx, data\.days, marks\)/)
  assert.match(page, /renewalCards\(data\.mrr_moves, fx, data\.days\)/)
})
