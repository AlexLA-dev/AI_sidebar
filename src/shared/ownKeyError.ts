// The person's own key, refused by their provider (build 109). Two refusals have a plain cause the person can fix
// and nothing in our message said so: the provider account has no credit (or billing isn't set up), and the
// account's rate limit. Until 109 OpenAI's 429 came out as the provider's English sentence alone, Anthropic's as
// "ContextFlow is very busy", and an Anthropic account without credit as "The AI service didn't respond".
// What the providers send (their docs, read 2026-11-18):
//   OpenAI     {error: {message, type, code}}: 429 with code "insufficient_quota" (no credit, or a monthly budget
//              used up) or "rate_limit_exceeded" (requests or tokens a minute, counted per model); also
//              "billing_not_active", "billing_hard_limit_reached".
//   Anthropic  {type: "error", error: {type, message}}: 402 "billing_error"; 400 "invalid_request_error" whose
//              message names the credit balance or a spend limit; 429 "rate_limit_error".
// The counters get the provider's type or code only (a short word of theirs), never the message.

export type OwnKeyProvider = "openai" | "anthropic"

/** "credit": the account can't pay for the request. "rate": too many requests or tokens for the account's limit. */
export type OwnKeyProblem = "credit" | "rate"

export interface ProviderError {
  status: number
  type?: string | null
  code?: string | null
  message?: string | null
}

const OPENAI_CREDIT = new Set(["insufficient_quota", "billing_not_active", "billing_hard_limit_reached"])
const ANTHROPIC_CREDIT_TEXT = /credit balance|spend limit|billing/i

export function ownKeyProblem(provider: OwnKeyProvider, error: ProviderError): OwnKeyProblem | null {
  const type = (error.type ?? "").toLowerCase()
  const code = (error.code ?? "").toLowerCase()
  if (provider === "openai") {
    if (OPENAI_CREDIT.has(code) || OPENAI_CREDIT.has(type)) return "credit"
    return error.status === 429 ? "rate" : null
  }
  if (error.status === 402 || type === "billing_error") return "credit"
  if (error.status === 400 && ANTHROPIC_CREDIT_TEXT.test(error.message ?? "")) return "credit"
  return error.status === 429 ? "rate" : null
}

/**
 * What the counters keep of a refusal: the status and the provider's own type or code ("429:insufficient_quota",
 * "402:billing_error", "500"). Their words for kinds of errors, never the sentence: anything that isn't a short
 * lowercase word is left out.
 */
export function providerErrorTag(error: ProviderError): string {
  const word = [error.code, error.type].map((v) => (v ?? "").toLowerCase()).find((v) => /^[a-z][a-z0-9_]{1,39}$/.test(v))
  return word ? `${error.status}:${word}` : String(error.status)
}

/** The same tag as it arrives at the server: checked again there, so nothing else can be stored through it. */
export function cleanErrorTag(value: unknown): string | null {
  return typeof value === "string" && /^[1-5]\d\d(:[a-z][a-z0-9_]{1,39})?$/.test(value) ? value : null
}

/**
 * Whether another model is worth a try after this refusal. A model the key can't use (404): yes, as before. The
 * account's rate limit: with OpenAI yes, its limits are counted per model, and a new account's limit on the newest
 * model can be smaller than one long page while an older model takes it. No credit: no, the account is refused
 * whatever the model, and each try only makes the person wait.
 */
export function tryNextModel(provider: OwnKeyProvider, error: ProviderError): boolean {
  if (error.status === 404) return true
  return provider === "openai" && ownKeyProblem(provider, error) === "rate"
}

/** Where the person mends it: the provider's own page, as a host and path people can read, and its address. */
export function ownKeyPlace(provider: OwnKeyProvider, problem: OwnKeyProblem): { label: string; url: string } {
  if (provider === "openai") {
    return problem === "credit"
      ? { label: "platform.openai.com → Billing", url: "https://platform.openai.com/settings/organization/billing/overview" }
      : { label: "platform.openai.com → Limits", url: "https://platform.openai.com/settings/organization/limits" }
  }
  return problem === "credit"
    ? { label: "platform.claude.com → Billing", url: "https://platform.claude.com/settings/billing" }
    : { label: "platform.claude.com → Limits", url: "https://platform.claude.com/settings/limits" }
}

export function providerName(provider: OwnKeyProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic"
}
