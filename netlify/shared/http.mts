import { createHash } from "node:crypto"

import { config } from "./config.mts"

// The extension calls the API from its background page and, as a fallback,
// from content scripts running on arbitrary origins.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }
  })
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders })
}

// Per-day salted hash: lets us rate-limit an address without storing it.
export function ipSubject(ip: string | undefined): string {
  const day = new Date().toISOString().slice(0, 10)
  const digest = createHash("sha256").update(`${ip ?? "unknown"}|${day}|${config.ipPepper}`).digest("hex")
  return `ip:${digest.slice(0, 32)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value)
}

export async function readJson(req: Request, maxBytes = 200_000): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "")
  if (!text || text.length > maxBytes) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}
