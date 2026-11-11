// Netlify Blobs stores by deploy context (netlify/shared/blobstore.mts): production keeps its site-wide stores under
// their usual names; a deploy preview, a branch deploy or a local run writes to that deploy's own.
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.NODE_ENV = "test"
process.env.SUPABASE_URL = "https://db.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
process.env.ANTHROPIC_API_KEY = "test-key"

const { deployContext, storeScope, useStoreOpeners } = await import("../netlify/shared/blobstore.mts")
const { JOB_STORE, jobStore, useJobStore } = await import("../netlify/shared/jobs.mts")
const { loadUnsupportedCountries, searchLocation, useCountryStore } = await import("../netlify/shared/similar.mts")
type Store = import("@netlify/blobs").Store

const g = globalThis as { Netlify?: unknown }

/** Opens fake stores and notes which kind was opened under which name. */
function fakeOpeners() {
  const opened: string[] = []
  const data = new Map<string, unknown>()
  const store = (kind: string, name: string) => {
    opened.push(`${kind}:${name}`)
    const at = (key: string) => `${kind}:${name}:${key}`
    return {
      get: async (key: string) => data.get(at(key)) ?? null,
      setJSON: async (key: string, value: unknown) => { data.set(at(key), value) },
      delete: async (key: string) => { data.delete(at(key)) },
      list: async ({ prefix }: { prefix: string }) => ({ blobs: [...data.keys()].filter((k) => k.startsWith(at(prefix))).map((k) => ({ key: k.slice(at("").length) })) })
    } as unknown as Store
  }
  return { opened, data, openers: { site: (name: string) => store("site", name), deploy: (name: string) => store("deploy", name) } }
}

function inContext(context: string | undefined, run: () => Promise<void>): Promise<void> {
  const before = g.Netlify
  g.Netlify = context === undefined ? undefined : { context: { deploy: { context } } }
  return run().finally(() => { g.Netlify = before })
}

test("which store a deploy context uses: production's own; any other, unknown too, that deploy's", () => {
  assert.equal(storeScope("production"), "site")
  for (const c of ["deploy-preview", "branch-deploy", "dev", "staging", ""]) assert.equal(storeScope(c), "deploy", c)
})

test("the deploy context: the function's own first, then the CONTEXT variable", async () => {
  const env = process.env.CONTEXT
  try {
    delete process.env.CONTEXT
    await inContext(undefined, async () => assert.equal(deployContext(), ""))
    process.env.CONTEXT = "deploy-preview"
    await inContext(undefined, async () => assert.equal(deployContext(), "deploy-preview"))
    await inContext("production", async () => assert.equal(deployContext(), "production"))
  } finally {
    if (env === undefined) delete process.env.CONTEXT
    else process.env.CONTEXT = env
  }
})

test("Find similar's jobs: production keeps its store and name; a preview writes only its deploy's", async () => {
  useJobStore(null)
  const fake = fakeOpeners()
  useStoreOpeners(fake.openers)
  try {
    assert.equal(JOB_STORE, "similar-jobs")
    await inContext("production", async () => {
      await jobStore().set("install/job-prod-1", { state: "running", at: 1 })
    })
    await inContext("deploy-preview", async () => {
      const preview = jobStore()
      await preview.set("install/job-prev-1", { state: "running", at: 2 })
      // A preview sees nothing production kept.
      assert.equal(await preview.get("install/job-prod-1"), null)
      assert.deepEqual(await preview.keys("install/"), ["install/job-prev-1"])
    })
    await inContext("branch-deploy", async () => { jobStore() })
    assert.deepEqual(fake.opened, ["site:similar-jobs", "deploy:similar-jobs", "deploy:similar-jobs"])
    assert.deepEqual([...fake.data.keys()].sort(), ["deploy:similar-jobs:install/job-prev-1", "site:similar-jobs:install/job-prod-1"])
  } finally {
    useStoreOpeners(null)
  }
})

test("the countries the search tool refused: read from production's store in production, a preview's own elsewhere", async () => {
  const fake = fakeOpeners()
  useStoreOpeners(fake.openers)
  try {
    fake.data.set("site:similar-meta:search/unsupported-countries", ["CY"])
    useCountryStore(null)
    await inContext("deploy-preview", () => loadUnsupportedCountries())
    // The preview's store has nothing yet: production's list isn't read.
    assert.equal(searchLocation({ page: { title: "", url: "", text: "" }, facts: {}, condition: "", locale: "en", region: "local", country: "CY" }), "CY")
    useCountryStore(null)
    await inContext("production", () => loadUnsupportedCountries())
    assert.equal(searchLocation({ page: { title: "", url: "", text: "" }, facts: {}, condition: "", locale: "en", region: "local", country: "CY" }), null)
    assert.deepEqual(fake.opened, ["deploy:similar-meta", "site:similar-meta"])
  } finally {
    useCountryStore(null)
    useStoreOpeners(null)
  }
})
