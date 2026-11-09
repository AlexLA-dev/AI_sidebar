#!/usr/bin/env node
// Builds the web extension.
//
//   node scripts/build-extension.mjs                 → Safari, written into the Xcode project
//   node scripts/build-extension.mjs --target=chrome → Chrome, written to build/chrome
//   --watch  rebuild on change      --out=<dir>  custom output directory
//   CF_API_BASE=https://…  point the build at another backend (default: production)
//   CF_WATCH_EVERY_S=60    page watch checks a page every minute (test builds; default 15 minutes)
//   CF_OPEN_SHADOW=1       the panel's shadow root left open for Playwright checks (test builds only)
//
// Output layout (stable file names, so the Xcode project never needs edits):
//   manifest.json  welcome.html  popup.html  dist/*.js  dist/clip.html  icons/*.png  _locales/<lang>/messages.json

import { context, build } from "esbuild"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { tipClips, tipsData, tipsMessages } from "./tips-source.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]))
const target = args.target === "chrome" ? "chrome" : "safari"
const out = resolve(root, typeof args.out === "string" ? args.out : target === "safari" ? "ContextFlow/Shared (Extension)/Resources" : "build/chrome")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const apiBase = process.env.CF_API_BASE || "https://aisidebar.netlify.app"
// Test builds only: the panel's shadow root left open, so Playwright checks can read inside it. Production keeps
// it closed (no page script can read the panel: Copied, the chats, the answers), and the two never meet.
const openShadow = process.env.CF_OPEN_SHADOW === "1"
if (openShadow && apiBase === "https://aisidebar.netlify.app") throw new Error("CF_OPEN_SHADOW=1 is for test builds (set CF_API_BASE to a local stand)")
// The panel's Tips sheet: the app's Tips (ContentView.swift), its texts in every language from the app's catalog.
const tips = tipsData(root)

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
    // alarms: page watch's checks while Safari runs (2.5).
    permissions: ["storage", "activeTab", "scripting", "alarms", ...(target === "safari" ? ["nativeMessaging"] : [])],
    host_permissions: ["http://*/*", "https://*/*"],
    content_scripts: [
      { matches: ["http://*/*", "https://*/*"], js: ["dist/content.js"], run_at: "document_idle", all_frames: false }
    ],
    // The Tips clips' page (2.6 (91)): the panel shows the app's clips in a frame of it, so pages must be able to.
    // Under dist/ (a folder the Xcode project copies whole; files at the root are listed one by one there).
    web_accessible_resources: [{ resources: ["dist/clip.html"], matches: ["http://*/*", "https://*/*"] }],
    commands: {
      _execute_action: { suggested_key: { default: "Ctrl+Shift+E", mac: "MacCtrl+Shift+E" }, description: "__MSG_actionTitle__" },
      // Quick insert at the caret: ⌃⇧V in Safari on Mac and iPad (Ctrl+Space is the system's on iPad).
      // Chrome keeps Ctrl+Shift+V for pasting plain text: there the user picks a key in chrome://extensions.
      quick_insert: { ...(target === "safari" ? { suggested_key: { default: "Ctrl+Shift+V", mac: "MacCtrl+Shift+V" } } : {}), description: "__MSG_qiCommand__" }
    }
  }
  if (target === "safari") m.browser_specific_settings = { safari: { strict_min_version: "16.4" } }
  return m
}

// Chinese by region (2.6): Traditional for Taiwan, Hong Kong and Macao, Simplified for China and Singapore. The
// browser picks a _locales folder by the device's language and region, so the regions without a folder of their own
// get a copy of their script's: zh_TW (Traditional) is also zh_HK and zh_MO, zh_CN (Simplified) is also zh_SG.
// Chrome skips folders it doesn't know (it maps those regions itself).
const LOCALE_COPIES = { zh_HK: "zh_TW", zh_MO: "zh_TW", zh_SG: "zh_CN" }

// _locales/<lang>/messages.json from src/locales/<lang>.json, plus the Tips texts (tip_…) from the app's catalog.
// {0}, {1} stay as they are: t() fills them in itself (Safari's own substitution loses the value next to some
// characters, e.g. “{0}”).
function locales() {
  const dir = join(root, "src/locales")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const lang = file.replace(/\.json$/, "")
    const source = { ...JSON.parse(readFileSync(join(dir, file), "utf8")), ...tipsMessages(root, tips, lang) }
    const messages = {}
    for (const [key, text] of Object.entries(source)) {
      // "$" starts a placeholder in messages.json; written as "$$" it is a dollar sign.
      messages[key] = { message: String(text).replace(/\$/g, "$$$$") }
    }
    for (const folder of [lang, ...Object.keys(LOCALE_COPIES).filter((copy) => LOCALE_COPIES[copy] === lang)]) {
      mkdirSync(join(out, "_locales", folder), { recursive: true })
      writeFileSync(join(out, "_locales", folder, "messages.json"), JSON.stringify(messages, null, 1) + "\n")
    }
  }
}

// The Tips clips (2.6 (91), the owner: «подтянуть их из приложения в расширение на том же девайсе»): none in the
// extension. The app shares its own (TipClips/<en|ru>) through the App Group and the panel plays them from there
// (TipClipShare.swift, src/background/tipClips.ts, src/pages/clip.ts). The build only checks that the app has every
// clip a Tips card names, in both languages, so no card waits on a clip that doesn't exist.
function clips() {
  const app = join(root, "ContextFlow/Shared (App)/TipClips")
  for (const lang of ["en", "ru"]) {
    for (const name of tipClips(tips)) {
      if (!existsSync(join(app, lang, `${name}.mp4`))) throw new Error(`tips: no ${lang} clip ${name}.mp4 in the app's TipClips`)
    }
  }
}

function statics() {
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(), null, 2) + "\n")
  cpSync(join(root, "src/pages/welcome.html"), join(out, "welcome.html"))
  cpSync(join(root, "src/pages/popup.html"), join(out, "popup.html"))
  cpSync(join(root, "extension/icons"), join(out, "icons"), { recursive: true })
  mkdirSync(join(out, "dist"), { recursive: true })
  cpSync(join(root, "src/pages/clip.html"), join(out, "dist/clip.html"))
  locales()
  clips()
}

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.tsx",
    popup: "src/popup/index.tsx",
    welcome: "src/pages/welcome.ts",
    clip: "src/pages/clip.ts"
  },
  outdir: join(out, "dist"),
  bundle: true,
  format: "iife",
  target: ["safari16", "chrome110"],
  // CF_MINIFY=0: readable bundles for profiling test builds (function names in stacks); release builds are minified.
  minify: !args.watch && process.env.CF_MINIFY !== "0",
  sourcemap: args.watch ? "inline" : false,
  legalComments: "none",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "text" },
  define: {
    __API_BASE__: JSON.stringify(apiBase),
    __VERSION__: JSON.stringify(pkg.version),
    __TARGET__: JSON.stringify(target),
    __SHADOW_MODE__: JSON.stringify(openShadow ? "open" : "closed"),
    __TIPS__: JSON.stringify(tips),
    // Page watch: how often a page is checked, in seconds (15 minutes; test builds: CF_WATCH_EVERY_S=60).
    __WATCH_EVERY_S__: String(Number(process.env.CF_WATCH_EVERY_S) || 900),
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
