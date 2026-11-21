// Sites the agent reads but never acts on, by their address (the panel still answers questions there):
// - Amazon (the owner's rule for Find similar, and Amazon's suit against agent shopping), switchable by config;
// - banks, payment services, brokers and crypto exchanges;
// - government portals; adult sites and gambling.
// Heuristic by design: a list of well-known names and words in the address. The server and the extension both check.

export type BlockedKind = "amazon" | "money" | "gov" | "adult" | "gambling"

/** The host without "www." and a trailing dot, lower case. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
  } catch {
    return ""
  }
}

// Second-level labels under a country's TLD that aren't a site of their own (example.co.uk, example.com.tr).
const SECOND = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go", "gob", "gouv", "nic", "mil", "ltd", "plc", "me", "biz", "info", "in", "kiev", "spb", "msk"])

/** The site a host belongs to: shop.example.co.uk → example.co.uk. */
export function siteOfHost(host: string): string {
  const parts = host.split(".").filter(Boolean)
  if (parts.length <= 2) return parts.join(".")
  const tld = parts[parts.length - 1]
  const second = parts[parts.length - 2]
  const keep = tld.length === 2 && SECOND.has(second) ? 3 : 2
  return parts.slice(-keep).join(".")
}

export function sameSite(a: string, b: string): boolean {
  return !!a && !!b && siteOfHost(a) === siteOfHost(b)
}

const AMAZON = /(^|\.)amazon\.[a-z.]+$|(^|\.)amzn\.[a-z]+$|(^|\.)audible\.[a-z.]+$/
const MONEY_NAMES = [
  "paypal", "stripe", "wise", "revolut", "monzo", "n26", "chase", "wellsfargo", "bankofamerica", "citi", "citibank",
  "capitalone", "hsbc", "barclays", "lloydsbank", "natwest", "santander", "bbva", "caixabank", "ing", "commerzbank",
  "deutsche-bank", "sparkasse", "postbank", "bnpparibas", "societegenerale", "creditagricole", "unicredit", "intesasanpaolo",
  "itau", "bradesco", "nubank", "garanti", "garantibbva", "isbank", "akbank", "yapikredi", "ziraatbank", "sberbank",
  "tbank", "tinkoff", "vtb", "alfabank", "raiffeisen", "gazprombank", "monobank", "privatbank", "privat24", "oschadbank",
  "alrajhibank", "emiratesnbd", "mufg", "smbc", "mizuhobank", "jp-bank", "kbstar", "shinhan", "wooribank", "hanabank",
  "toss", "icbc", "ccb", "boc", "abchina", "alipay", "cathaybk", "esunbank", "vietcombank", "techcombank", "bidv",
  "vpbank", "momo", "binance", "coinbase", "kraken", "bybit", "okx", "bitstamp", "kucoin", "gemini", "crypto",
  "robinhood", "etrade", "schwab", "fidelity", "vanguard", "interactivebrokers", "degiro", "trading212", "etoro",
  "tradingview-broker", "plus500", "xtb", "freedom24", "finam", "bcs", "tradestation", "webull", "klarna", "afterpay"
]
const MONEY_WORDS = /(^|[.-])(bank|banking|banca|banco|banque|bankasi|ebank|netbank|onlinebanking|ibank|wallet|broker|brokerage|exchange)([.-]|$)/
const GOV = /(^|\.)(gov|gouv|gob|gv|go|mil)\.[a-z]{2}$|\.gov$|\.mil$|\.gov\.[a-z.]+$|\.bund\.de$|(^|\.)gosuslugi\.ru$|(^|\.)diia\.gov\.ua$|(^|\.)turkiye\.gov\.tr$|(^|\.)europa\.eu$|(^|\.)service-public\.fr$|(^|\.)impots\.gouv\.fr$|(^|\.)elster\.de$|(^|\.)nalog\.(ru|gov\.ru)$|(^|\.)mos\.ru$/
const ADULT = /(^|[.-])(porn|porno|xxx|sex|xvideos|xhamster|pornhub|onlyfans|redtube|youporn|chaturbate|brazzers)([.-]|$)/
const GAMBLING = /(^|[.-])(casino|bet|bets|betting|poker|slots|bet365|1xbet|pinup|parimatch|fonbet|williamhill|betway|stake|draftkings|fanduel|lottery|loto)([.-]|$)/

export interface SitePolicy {
  // Amazon is blocked unless the owner switches it off (AGENT_BLOCK_AMAZON=off).
  amazon: boolean
  // More hosts to block or to allow (config), matched as the host or a parent of it.
  block?: string[]
  allow?: string[]
}

function listed(host: string, list: string[] | undefined): boolean {
  return !!list?.some((d) => d && (host === d || host.endsWith(`.${d}`)))
}

/** Why the agent doesn't act on this host, or null when it may. */
export function blockedSite(host: string, policy: SitePolicy): BlockedKind | "listed" | null {
  if (!host) return null
  if (listed(host, policy.allow)) return null
  if (listed(host, policy.block)) return "listed"
  if (policy.amazon && AMAZON.test(host)) return "amazon"
  const site = siteOfHost(host).split(".")[0]
  if (MONEY_NAMES.includes(site) || MONEY_WORDS.test(host)) return "money"
  if (GOV.test(host)) return "gov"
  if (ADULT.test(host)) return "adult"
  if (GAMBLING.test(host)) return "gambling"
  return null
}
