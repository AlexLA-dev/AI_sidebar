#!/usr/bin/env node
// Builds the web extension.
//
//   node scripts/build-extension.mjs                 → Safari, written into the Xcode project
//   node scripts/build-extension.mjs --target=chrome → Chrome, written to build/chrome
//   --watch  rebuild on change      --out=<dir>  custom output directory
//   CF_API_BASE=https://…  point the build at another backend (default: production)
//
// Output layout (stable file names, so the Xcode project never needs edits):
//   manifest.json  welcome.html  dist/*.js  icons/*.png  _locales/<lang>/messages.json

import { context, build } from "esbuild"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]))
const target = args.target === "chrome" ? "chrome" : "safari"
const out = resolve(root, typeof args.out === "string" ? args.out : target === "safari" ? "ContextFlow/Shared (Extension)/Resources" : "build/chrome")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const apiBase = process.env.CF_API_BASE || "https://aisidebar.netlify.app"

function manifest() {
  const icons = Object.fromEntries([16, 32, 48, 64, 96, 128, 256, 512].map((s) => [String(s), `icons/icon-${s}.png`]))
  const m = {
    manifest_version: 3,
    default_locale: "en",
    name: "__MSG_extName__",
    short_name: "ContextFlow",
    description: "__MSG_extDescription__",
    version: pkg.version,
    icons,
    action: {
      default_title: "__MSG_actionTitle__",
      default_icon: { 16: "icons/icon-16.png", 19: "icons/icon-19.png", 32: "icons/icon-32.png", 38: "icons/icon-38.png", 48: "icons/icon-48.png" }
    },
    background: { service_worker: "dist/background.js" },
    permissions: ["storage", "activeTab", "scripting", ...(target === "safari" ? ["nativeMessaging"] : [])],
    host_permissions: ["http://*/*", "https://*/*"],
    content_scripts: [
      { matches: ["http://*/*", "https://*/*"], js: ["dist/content.js"], run_at: "document_idle", all_frames: false }
    ],
    commands: {
      _execute_action: { suggested_key: { default: "Ctrl+Shift+E", mac: "MacCtrl+Shift+E" }, description: "__MSG_actionTitle__" }
    }
  }
  if (target === "safari") m.browser_specific_settings = { safari: { strict_min_version: "16.4" } }
  return m
}

// _locales/<lang>/messages.json from src/locales/<lang>.json ({0} → $P0$ placeholders).
function locales() {
  const dir = join(root, "src/locales")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const lang = file.replace(/\.json$/, "")
    const source = JSON.parse(readFileSync(join(dir, file), "utf8"))
    const messages = {}
    for (const [key, text] of Object.entries(source)) {
      const placeholders = {}
      const message = String(text).replace(/\{(\d)\}/g, (_, i) => {
        placeholders[`p${i}`] = { content: `$${Number(i) + 1}` }
        return `$P${i}$`
      })
      messages[key] = Object.keys(placeholders).length ? { message, placeholders } : { message }
    }
    mkdirSync(join(out, "_locales", lang), { recursive: true })
    writeFileSync(join(out, "_locales", lang, "messages.json"), JSON.stringify(messages, null, 1) + "\n")
  }
}

function statics() {
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(), null, 2) + "\n")
  cpSync(join(root, "src/pages/welcome.html"), join(out, "welcome.html"))
  cpSync(join(root, "extension/icons"), join(out, "icons"), { recursive: true })
  locales()
}

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.tsx",
    welcome: "src/pages/welcome.ts"
  },
  outdir: join(out, "dist"),
  bundle: true,
  format: "iife",
  target: ["safari16", "chrome110"],
  minify: !args.watch,
  sourcemap: args.watch ? "inline" : false,
  legalComments: "none",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "text" },
  define: {
    __API_BASE__: JSON.stringify(apiBase),
    __VERSION__: JSON.stringify(pkg.version),
    __TARGET__: JSON.stringify(target),
    "process.env.NODE_ENV": JSON.stringify("production")
  },
  logLevel: "info"
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
statics()

if (args.watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log(`watching → ${out}`)
} else {
  const result = await build({ ...options, metafile: true })
  const sizes = Object.entries(result.metafile.outputs).map(([file, info]) => `${file.split("/dist/")[1]} ${(info.bytes / 1024).toFixed(1)} KB`)
  console.log(`ContextFlow ${pkg.version} (${target}) → ${out}\n  ${sizes.join("\n  ")}\n  API: ${apiBase}`)
}
