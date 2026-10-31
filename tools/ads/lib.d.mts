// Types for lib.mjs (plain JS so the CLI runs with bare node); used by tests/ads.test.mts.

export type Money = { amount: string; currency: string }
export type PlanKeyword = { text: string; match?: "EXACT" | "BROAD"; bid?: number; status?: "ENABLED" | "PAUSED"; locked?: boolean }
export type PlanNegative = { text: string; match?: "EXACT" | "BROAD" }
export type PlanAdGroup = {
  name: string
  bid: number
  status?: "ENABLED" | "PAUSED"
  devices?: ("IPAD" | "IPHONE")[]
  newUsersOnly?: boolean
  searchMatch?: boolean
  negateCampaignExact?: boolean
  promoteTo?: boolean
  productPage?: string
  daypart?: number[]
  keywords?: PlanKeyword[]
  negatives?: PlanNegative[]
}
export type PlanCampaign = {
  name: string
  status?: "ENABLED" | "PAUSED" | "REMOVED"
  countries: string[]
  dailyBudget: number
  start?: string
  end?: string
  negatives?: PlanNegative[]
  adGroups: PlanAdGroup[]
}
export type Plan = {
  app: { adamId: string; name?: string }
  currency?: string
  guards?: { totalBudget?: number; maxBid?: number; since?: string; rules?: Partial<Rules> }
  campaigns: PlanCampaign[]
}
/** Live Apple Ads objects as the Platform API returns them (only the fields the diff reads). */
export type Live = {
  adAccountId: number | string
  campaigns: Record<string, any>[]
  adGroups: Record<string, any>[]
  keywords: Record<string, any>[]
  negatives: Record<string, any>[]
  ads: Record<string, any>[]
  creatives?: Record<string, any>[]
}
/** One change for Apple Ads; besides kind and desc it carries what that kind needs (campaign,
 *  adGroup, id, payload, items, productPage, pauseAdIds, launch). */
export type Op = { kind: string; desc: string; launch?: boolean; [field: string]: any }
export type Rules = {
  pauseTapsWithoutInstall: number
  pauseSpendWithoutInstall: number
  lowTtrImpressions: number
  lowTtr: number
  targetCpi: number
  raiseStep: number
  lowerStep: number
  minBid: number
  negativeSpendWithoutInstall: number
}
export type Proposal = {
  campaign: string
  adGroup?: string
  text: string
  match: "EXACT" | "BROAD"
  action: "pause" | "bid" | "promote" | "negative"
  from?: number
  to?: number
  why: string
}
export type Metrics = { impressions: number; taps: number; installs: number; newDownloads: number; spend: number; ttr: number; cpt: number; cpi: number | null }

export const API: string
export function clientSecret(cfg: { clientId: string; teamId: string; keyId: string }, privateKeyPem: string, now?: number, days?: number): string
export function money(amount: number | string, currency?: string): Money
export function apiTime(date?: string, end?: boolean): string | undefined
export function campaignDays(c: PlanCampaign): number
export function guardProblems(plan: Plan): { problems: string[]; total: number }
export function campaignPayload(c: PlanCampaign, plan: Plan, adAccountId: number | string): Record<string, any>
export function adGroupTargeting(g: PlanAdGroup, plan: Plan): Record<string, any>
export function adGroupPayload(g: PlanAdGroup, campaignId: number, plan: Plan): Record<string, any>
export function diffPlan(plan: Plan, live: Live): { ops: Op[]; notes: string[] }
export function metrics(row: Record<string, any> | undefined): Metrics
export const DEFAULT_RULES: Rules
export function optimize(plan: Plan, data: { keywords?: Record<string, any>[]; searchTerms?: Record<string, any>[]; subs?: Record<string, number> }, rules?: Partial<Rules>): Proposal[]
export function applyProposals<P extends Plan>(plan: P, proposals: Proposal[]): P
