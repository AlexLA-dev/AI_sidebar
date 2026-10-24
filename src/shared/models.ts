// Picks the newest model of a family from a provider's model list, so answers move to a
// new model generation without an app release. Used by the server (Free / Pro) and by
// the extension when the user brings their own key.
//
//   smart: full-size model (GPT "gpt-N[.M]", Claude Sonnet)
//   fast:  small model     (GPT "gpt-N[.M]-mini", Claude Haiku)

export type ModelTier = "fast" | "smart"

// Dated snapshots and special variants (-pro, -nano, -codex, -chat-latest, audio, …) never match.
const GPT: Record<ModelTier, RegExp> = {
  smart: /^gpt-(\d+)(?:\.(\d+))?$/,
  fast: /^gpt-(\d+)(?:\.(\d+))?-mini$/
}

/** GPT-5 and later (and the o-series) reason: no temperature, and reasoning tokens count against max_completion_tokens. */
export function isReasoningGpt(model: string): boolean {
  return /^(gpt-([5-9]|\d{2,})|o\d)/.test(model)
}

/** Newest GPT id of the tier among `ids` (OpenAI GET /v1/models), or null. */
export function newestGptModel(ids: string[], tier: ModelTier): string | null {
  let best: { id: string; version: number } | null = null
  for (const id of ids) {
    const m = GPT[tier].exec(id)
    if (!m) continue
    const version = Number(m[1]) * 1000 + Number(m[2] ?? 0)
    if (!best || version > best.version) best = { id, version }
  }
  return best?.id ?? null
}

const CLAUDE_FAMILY: Record<ModelTier, string> = { smart: "sonnet", fast: "haiku" }

/** Newest Claude Sonnet (smart) or Haiku (fast) among Anthropic's GET /v1/models entries, or null. */
export function newestClaudeModel(models: { id: string; created_at: string }[], tier: ModelTier): string | null {
  const family = models.filter((m) => m.id.startsWith("claude-") && m.id.includes(`-${CLAUDE_FAMILY[tier]}-`))
  family.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  return family[0]?.id ?? null
}

/** OpenAI ("sk-…", "sk-proj-…") and Anthropic ("sk-ant-…") API keys. */
export const OWN_KEY_PATTERN = /^sk-[\w-]{20,}$/

/** Which provider an own API key belongs to: Anthropic keys start with "sk-ant-". */
export function keyProvider(key: string): "anthropic" | "openai" {
  return key.startsWith("sk-ant-") ? "anthropic" : "openai"
}
