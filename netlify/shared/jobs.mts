// A search shouldn't stop when the person leaves Safari, and they should hear when it's done: a Find similar asked with its question's id runs to its end on our server even when the
// request goes away (iOS suspends Safari's extension when the person leaves Safari), and its answer waits here for
// the extension, or the app woken by iOS, to pick it up (/api/v2/similar-result). Kept per install and question, a
// day at most; the extension takes it away once it wrote the answer into the chat.

import { scopedStore } from "./blobstore.mts"

import type { SimilarItem } from "../../src/shared/similar.ts"

export interface StoredResult {
  intro: string
  items: SimilarItem[]
  note: string
  condition: string
}

export interface StoredJob {
  state: "running" | "done" | "failed"
  // Started and ended (ms).
  at: number
  end?: number
  result?: StoredResult
  // Failed: why (UPSTREAM: the search itself failed).
  code?: string
}

/** Where the jobs are kept: Netlify Blobs (production's own store; a preview's, that deploy's), a map in tests. */
export interface JobStore {
  get(key: string): Promise<StoredJob | null>
  set(key: string, job: StoredJob): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

// A question's id (src/shared/conversation.ts newEntryId: 12 letters and digits; older ids may be longer).
export const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/
export const JOB_KEEP_MS = 24 * 3_600_000
// A job still "running" this long after it started lost its function (a timeout): it counts as failed.
export const JOB_STALE_MS = 3 * 60_000

let testStore: JobStore | null = null

/** Tests: a store of their own (null: back to Netlify Blobs). */
export function useJobStore(store: JobStore | null): void {
  testStore = store
}

/** The Blobs store's name: production's stays the same across deploys, so jobs running during a deploy are kept. */
export const JOB_STORE = "similar-jobs"

export function jobStore(): JobStore {
  if (testStore) return testStore
  // Off production, that deploy's store: a preview's test searches never write what production reads.
  const store = scopedStore(JOB_STORE)
  return {
    get: async (key) => ((await store.get(key, { type: "json" })) as StoredJob | null) ?? null,
    set: async (key, job) => {
      await store.setJSON(key, job)
    },
    delete: (key) => store.delete(key),
    keys: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key)
  }
}

export const jobKey = (installId: string, job: string): string => `${installId}/${job}`

/** The job as the asker sees it: a "running" one past JOB_STALE_MS ended without a word (failed). */
export function jobState(job: StoredJob | null, now = Date.now()): StoredJob | null {
  if (!job) return null
  if (job.state === "running" && now - job.at > JOB_STALE_MS) return { ...job, state: "failed", code: "STREAM" }
  return job
}

/**
 * Waits for a job to end: its state now, then again every `everyMs` until it isn't running or `waitMs` passed (null:
 * no such job — never asked with this id, or taken already).
 */
export async function waitForJob(store: JobStore, key: string, waitMs: number, signal?: AbortSignal, everyMs = 1_500): Promise<StoredJob | null> {
  const until = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const job = jobState(await store.get(key).catch(() => null))
    if (!job || job.state !== "running" || Date.now() + everyMs > until || signal?.aborted) return job
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/** The install's jobs older than JOB_KEEP_MS go (the person never came back for the answer). */
export async function sweepJobs(store: JobStore, installId: string, now = Date.now()): Promise<number> {
  const keys = (await store.keys(`${installId}/`).catch(() => [] as string[])).slice(0, 40)
  let gone = 0
  for (const key of keys) {
    const job = await store.get(key).catch(() => null)
    if (job && now - (job.end ?? job.at) <= JOB_KEEP_MS) continue
    await store.delete(key).catch(() => undefined)
    gone++
  }
  return gone
}
