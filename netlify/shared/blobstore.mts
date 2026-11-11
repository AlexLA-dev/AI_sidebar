// Netlify Blobs stores kept apart by deploy: production reads and writes its site-wide store (the same name as
// always, so what it kept before a deploy is still there after it); a deploy preview, a branch deploy or a local run
// gets a store of that deploy only, so test traffic never writes what production reads.

import { getDeployStore, getStore, type Store } from "@netlify/blobs"

/** The deploy context the function runs in ("production", "deploy-preview", "branch-deploy", "dev"…; "" unknown). */
export function deployContext(): string {
  return (globalThis as { Netlify?: { context?: { deploy?: { context?: string } } | null } }).Netlify?.context?.deploy?.context ??
    process.env.CONTEXT ?? ""
}

/** Which store a deploy context uses: the site's own in production; anywhere else (unknown too), that deploy's. */
export function storeScope(context: string): "site" | "deploy" {
  return context === "production" ? "site" : "deploy"
}

interface Openers {
  site: (name: string) => Store
  deploy: (name: string) => Store
}

const NETLIFY: Openers = {
  site: (name) => getStore({ name, consistency: "strong" }),
  deploy: (name) => getDeployStore({ name, consistency: "strong" })
}
let openers: Openers = NETLIFY

/** Tests: how stores are opened (null: Netlify Blobs). */
export function useStoreOpeners(test: Openers | null): void {
  openers = test ?? NETLIFY
}

/** The store `name` for the deploy this runs in (throws where Netlify Blobs isn't set up, as getStore does). */
export function scopedStore(name: string, context = deployContext()): Store {
  return storeScope(context) === "site" ? openers.site(name) : openers.deploy(name)
}
