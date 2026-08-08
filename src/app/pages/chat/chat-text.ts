// src/app/pages/chat/chat-text.ts
// IM 消息文本渲染纯函数（从 legacy src/chat/message.ts 迁移）：
// hljs 代码高亮、@mention 高亮、链接识别、纯 emoji 放大、时间/状态/字节格式化。
// 返回 HTML 字符串，由消息行组件以 innerHTML 挂载。

import hljs from "highlight.js/lib/core"
import rust from "highlight.js/lib/languages/rust"
import javascript from "highlight.js/lib/languages/javascript"
import typescript from "highlight.js/lib/languages/typescript"
import python from "highlight.js/lib/languages/python"
import go from "highlight.js/lib/languages/go"
import bash from "highlight.js/lib/languages/bash"
import sql from "highlight.js/lib/languages/sql"
import json from "highlight.js/lib/languages/json"
import { resolveMessageText, tryParseEnvelope, envelopeMarkdown } from "@/utils/envelope"
import type { MsgState } from "@/types"

hljs.registerLanguage("rust", rust)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("js", javascript)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("ts", typescript)
hljs.registerLanguage("python", python)
hljs.registerLanguage("py", python)
hljs.registerLanguage("go", go)
hljs.registerLanguage("bash", bash)
hljs.registerLanguage("sh", bash)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("json", json)

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// 消息状态文本：单聊/群聊已读人数。
export function stateLabel(s: MsgState | undefined, isGroup?: boolean, readCount?: number): string {
  switch (s) {
    case "pending":
      return "发送中"
    case "delivered":
      return "已送达"
    case "read":
      return isGroup ? `${readCount ?? 0} 人已读` : "已读"
    case "failed":
      return "失败"
    default:
      return "发送中"
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return ""
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

export function colorHex(c: number | null | undefined): string {
  if (c == null) return "var(--v2-border-border-weaker-base, #2a2a2a)"
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0")
}

export function formatTs(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

export function formatVoiceTime(sec: number): string {
  const total = Math.floor(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

// 纯 emoji 放大（仿 Delta）：≤8 个 emoji 按数量分级。
const EMOJI_MAX_COUNT = 8

function countEmojisIfOnlyEmoji(str: string): number | null {
  const trimmed = str.trim()
  if (trimmed.length === 0) return null
  if (/[A-Za-z0-9一-鿿]/.test(trimmed)) return null
  const emojiRegex = /\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*(?:\p{Emoji_Modifier})?/gu
  let count = 0
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = emojiRegex.exec(trimmed)) !== null) {
    if (trimmed.slice(lastIndex, match.index).trim().length > 0) return null
    lastIndex = match.index + match[0].length
    count++
  }
  if (trimmed.slice(lastIndex).trim().length > 0) return null
  return count > 0 ? count : null
}

function emojiSizeClass(count: number): string | null {
  if (count > 8) return null
  if (count > 6) return "small"
  if (count > 4) return "medium"
  if (count > 2) return "large"
  return "jumbo"
}

// 链接识别：http(s) | www | 邮箱 | 裸域名。
const LINK_RE =
  /(https?:\/\/[^\s<"']+)|(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<"']*)?)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|((?:^|(?<=[\s(]))[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/[^\s<"']*)?)/gi

export function autolink(text: string): string {
  if (!text.includes("http") && !text.includes("@") && !text.includes("www") && !text.includes(".")) return escapeHtml(text)
  LINK_RE.lastIndex = 0
  let last = 0
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push(escapeHtml(text.slice(last, m.index)))
    const raw = m[0].replace(/[.,;:!?，。；、!?]+$/, "")
    const [http, , mail] = [m[1], m[2], m[3]]
    let href: string
    if (http) href = raw
    else if (mail) href = "mailto:" + raw
    else href = "http://" + raw
    out.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="cm-link">${escapeHtml(raw)}</a>`)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(escapeHtml(text.slice(last)))
  return out.join("")
}

// 高亮 @提及（自己/角色名）。
export function highlightMentions(html: string, selfName: string, roleNames: string[]): string {
  const targets = [selfName, ...roleNames].filter(Boolean).map(escapeRegex)
  if (targets.length === 0) return html
  const re = new RegExp(`@(${targets.join("|")})`, "g")
  return html.replace(re, '<span class="cm-mention">@$1</span>')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 正文文本 → HTML：代码块 hljs 高亮 + @mention + 链接 + 纯 emoji 放大。
export function renderMessageText(
  text: string,
  input: { selfName: string; roleNames: string[]; markdown: boolean },
): string {
  const plain = resolveMessageText(text)
  if (!plain.includes("```")) {
    const emojiCount = countEmojisIfOnlyEmoji(plain)
    if (emojiCount != null && emojiCount <= EMOJI_MAX_COUNT) {
      const cls = emojiSizeClass(emojiCount)
      if (cls) return `<span class="cm-emoji ${cls}">${escapeHtml(plain.trim())}</span>`
    }
  }
  const parts: string[] = []
  const regex = /```(\w*)\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  const inline = (s: string) =>
    highlightMentions(autolink(s), input.selfName, input.roleNames).replace(/\r?\n/g, "<br>")
  while ((match = regex.exec(plain)) !== null) {
    if (match.index > last) parts.push(inline(plain.slice(last, match.index)))
    const lang = match[1]
    const code = match[2]
    let highlighted: string
    try {
      highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : escapeHtml(code)
    } catch {
      highlighted = escapeHtml(code)
    }
    parts.push(`<div class="cm-code"><pre><code>${highlighted}</code></pre></div>`)
    last = match.index + match[0].length
  }
  if (last < plain.length) parts.push(inline(plain.slice(last)))
  return parts.join("")
}

// 引用块文本：跟随被引用消息的 markdown 标记。
export function quoteHtml(quoteText: string | null): { html: string; isMd: boolean } {
  const env = quoteText ? tryParseEnvelope(quoteText) : null
  const isMd = env ? envelopeMarkdown(env) : false
  const text = quoteText ? resolveMessageText(quoteText).slice(0, 80) : ""
  return { html: isMd ? renderMarkdownSimple(text) : escapeHtml(text), isMd }
}

// 简化 md 渲染（引用块用）：段落/行内 code/粗体/列表。
function renderMarkdownSimple(text: string): string {
  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
  const out: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^[-*]\s+/.test(trimmed)) {
      out.push(`<li>${inline(trimmed.replace(/^[-*]\s+/, ""))}</li>`)
      continue
    }
    out.push(`<p>${inline(trimmed)}</p>`)
  }
  return out.join("")
}

export function extractWebUrls(text: string): string[] {
  if (!text || (!text.includes("http") && !text.includes("www") && !text.includes("."))) return []
  LINK_RE.lastIndex = 0
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:!?，。；、!?]+$/, "")
    let url: string | null = null
    if (m[1]) url = raw
    else if (m[2]) url = "http://" + raw
    else if (m[4]) url = "http://" + raw
    if (url && !seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function msgMarkdown(text: string): boolean {
  const env = tryParseEnvelope(text)
  if (env) return envelopeMarkdown(env)
  return false
}

export function msgThemeStyle(text: string): { id: string; style: Record<string, string> } | null {
  const env = tryParseEnvelope(text)
  if (!env || env.type !== "text") return null
  const theme = env.payload?.theme as Record<string, unknown> | undefined
  if (!theme || typeof theme !== "object" || theme.id === undefined || theme.id === "default") return null
  const style: Record<string, string> = {}
  if (typeof theme.font_family === "string") style["--mt-font"] = theme.font_family
  if (typeof theme.text_color === "string") style["--mt-color"] = theme.text_color
  if (typeof theme.bubble_bg === "string") style["--mt-bg"] = theme.bubble_bg
  if (typeof theme.radius === "number") style["--mt-radius"] = `${theme.radius}px`
  if (typeof theme.bold === "boolean") style["--mt-weight"] = theme.bold ? "700" : "400"
  if (typeof theme.italic === "boolean") style["--mt-style"] = theme.italic ? "italic" : "normal"
  return { id: String(theme.id), style }
}
