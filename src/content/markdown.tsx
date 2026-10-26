import type { ComponentChildren, VNode } from "preact"

import { stripCitations } from "../shared/conversation"

export { stripCitations }

// Small Markdown renderer for model answers. Produces Preact nodes only (no
// innerHTML), and links are limited to http(s) so a crafted answer can't run
// script in the host page.

type Inline = ComponentChildren

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/

function safeHref(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

export function inline(text: string, keyBase = "i"): Inline[] {
  const out: Inline[] = []
  let rest = text
  let k = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const token = m[0]
    const key = `${keyBase}${k++}`
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>)
    else if (m[3]) out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>)
    else if (m[4]) {
      const label = token.slice(1, token.indexOf("]("))
      const href = safeHref(m[5] ?? "")
      // "[2](url)" is a numbered source citation (Google answers).
      const cite = /^\d{1,2}$/.test(label)
      if (href && cite) out.push(<a key={key} class="md-cite" href={href} target="_blank" rel="noopener noreferrer">{label}</a>)
      else out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : label)
    } else if (m[6]) {
      const href = safeHref(token)
      out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{token}</a> : token)
    }
    rest = rest.slice(m.index + token.length)
  }
  return out
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

export function Markdown({ text, onCopyCode }: { text: string; onCopyCode?: (code: string) => void }): VNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const blocks: VNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*```/.test(line)) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      i++
      const source = code.join("\n")
      blocks.push(
        <div class="md-code" key={key++}>
          <pre><code>{source}</code></pre>
          {onCopyCode && <button type="button" class="md-code-copy" onClick={() => onCopyCode(source)}>⧉</button>}
        </div>
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6)
      const Tag = `h${level}` as "h3"
      blocks.push(<Tag key={key++}>{inline(heading[2])}</Tag>)
      i++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(<hr key={key++} />)
      i++
      continue
    }

    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push(
        <div class="md-table" key={key++}>
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""))
      blocks.push(<blockquote key={key++}>{inline(quote.join(" "))}</blockquote>)
      continue
    }

    const listItem = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/
    if (listItem.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items: { text: string; nested: boolean }[] = []
      while (i < lines.length) {
        const m = listItem.exec(lines[i])
        if (m) {
          items.push({ text: m[3], nested: m[1].length >= 2 })
          i++
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`
          i++
        } else break
      }
      const List = ordered ? "ol" : "ul"
      blocks.push(
        <List key={key++}>
          {items.map((it, j) => <li key={j} class={it.nested ? "nested" : undefined}>{inline(it.text)}</li>)}
        </List>
      )
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>|([-*+•]|\d+[.)])\s)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1]))
    ) para.push(lines[i++])
    blocks.push(<p key={key++}>{para.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l, `p${j}`)] : inline(l, `p${j}`)))}</p>)
  }

  return <div class="md">{blocks}</div>
}

/** Plain text for copy/share: strip Markdown syntax but keep structure. */
export function toPlainText(text: string): string {
  return stripCitations(text)
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim()
}
