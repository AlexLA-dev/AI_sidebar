import assert from "node:assert/strict"
import { test } from "node:test"

import { keyProvider, newestClaudeModel, newestGptModel } from "../src/shared/models.ts"

test("newestGptModel picks the newest full-size and mini GPT, ignoring snapshots and variants", () => {
  const ids = ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-pro", "gpt-5.2-2026-01-10", "gpt-5.2-codex", "gpt-5.2-chat-latest", "gpt-5-nano", "o3"]
  assert.equal(newestGptModel(ids, "smart"), "gpt-5.2")
  assert.equal(newestGptModel(ids, "fast"), "gpt-5.2-mini")
  // A new major version wins over a higher minor of the previous one.
  assert.equal(newestGptModel([...ids, "gpt-6", "gpt-6-mini"], "smart"), "gpt-6")
  assert.equal(newestGptModel(["gpt-5.10", "gpt-5.9"], "smart"), "gpt-5.10")
  assert.equal(newestGptModel(["o3", "dall-e-3"], "smart"), null)
})

test("newestClaudeModel picks the most recently released Sonnet or Haiku", () => {
  const models = [
    { id: "claude-opus-5-5", created_at: "2026-09-01T00:00:00Z" },
    { id: "claude-sonnet-5", created_at: "2026-03-01T00:00:00Z" },
    { id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" },
    { id: "claude-haiku-4-5", created_at: "2025-10-01T00:00:00Z" },
    { id: "claude-haiku-5-5", created_at: "2026-09-15T00:00:00Z" }
  ]
  assert.equal(newestClaudeModel(models, "smart"), "claude-sonnet-5-5")
  assert.equal(newestClaudeModel(models, "fast"), "claude-haiku-5-5")
  assert.equal(newestClaudeModel([{ id: "claude-opus-5-5", created_at: "2026-09-01T00:00:00Z" }], "fast"), null)
})

test("keyProvider tells Anthropic keys from OpenAI keys", () => {
  assert.equal(keyProvider("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "anthropic")
  assert.equal(keyProvider("sk-proj-abcdefghijklmnopqrstuvwxyz"), "openai")
  assert.equal(keyProvider("sk-abcdefghijklmnopqrstuvwxyz"), "openai")
})
