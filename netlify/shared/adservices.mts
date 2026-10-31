// Apple Ads attribution (AdServices): the app sends the token from AAAttribution.attributionToken()
// once; Apple tells whether this download came from an Apple Ads tap or view, and which campaign,
// ad group and keyword. No device identifiers, no ATT prompt: Apple does the matching.
// https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken()

export type AdAttribution = {
  attribution: boolean
  orgId?: number
  campaignId?: number
  adGroupId?: number
  keywordId?: number
  adId?: number
  countryOrRegion?: string
  conversionType?: string
  claimType?: string
  supplyPlacement?: string
  clickDate?: string
}

const ENDPOINT = "https://api-adservices.apple.com/api/v1/"

/**
 * The attribution record for a token, or "pending" when Apple doesn't have it yet (404: ask again
 * on a later app launch), or null when the token is invalid or Apple can't be reached.
 */
export async function resolveAdToken(token: string, retryDelayMs = 3000): Promise<AdAttribution | "pending" | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: token,
      signal: AbortSignal.timeout(5000)
    }).catch(() => null)
    if (res?.ok) return (await res.json().catch(() => null)) as AdAttribution | null
    // Apple: right after the download the record may not exist yet; retry shortly, then give up for now.
    if (res?.status === 404 && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs))
      continue
    }
    return res?.status === 404 ? "pending" : null
  }
  return "pending"
}

/** What we keep from a positive attribution: ids to join with subscriptions, nothing about the person. */
export function attributionFields(a: AdAttribution): Record<string, unknown> {
  const keep = ["orgId", "campaignId", "adGroupId", "keywordId", "adId", "countryOrRegion", "conversionType", "claimType", "supplyPlacement", "clickDate"] as const
  const out: Record<string, unknown> = {}
  for (const k of keep) if (a[k] != null) out[k] = typeof a[k] === "string" ? String(a[k]).slice(0, 40) : a[k]
  return out
}
