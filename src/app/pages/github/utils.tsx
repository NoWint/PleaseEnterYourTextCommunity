// src/app/pages/github/utils.tsx
// GitHub 页共享工具:超时保护 / 格式化 / 图标映射 / 小型展示组件。
// 自 legacy src/pages/githubPage.ts 迁移(v2 图标集替换 TDesign 图标)。

import { Show } from "solid-js"
import type { IconProps } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), ms)
    }),
  ])
}

export function decodeBase64(b64: string): string {
  try {
    const binary = atob(b64.replace(/\s/g, ""))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder("utf-8").decode(bytes)
  } catch {
    return b64
  }
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return `${n} B`
}

export function fmtDate(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  return t.toLocaleDateString()
}

export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  if (diff < 60000) return "刚刚"
  if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前"
  if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前"
  return Math.floor(diff / 86400000) + "天前"
}

// 语言色点:GitHub 原生色板映射,未知语言回退灰(仓库树 + 详情卡共用)
const LANG_COLORS: Record<string, string> = {
  Rust: "#dea584",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Go: "#00ADD8",
  Java: "#b07219",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  CSS: "#663399",
  HTML: "#e34c26",
  Shell: "#89e051",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Vue: "#41b883",
  Ruby: "#701516",
  Dart: "#00B4AB",
  PHP: "#4F5D95",
  Lua: "#000080",
  Zig: "#ec915c",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  R: "#198CE7",
  Scala: "#c22d40",
}

export function langColor(lang: string | null | undefined): string {
  return (lang && LANG_COLORS[lang]) || "#6e7681"
}

export function LangDot(props: { lang: string | null | undefined; class?: string }) {
  return (
    <span
      class={`inline-block size-2 shrink-0 rounded-full ${props.class ?? ""}`}
      style={{ background: langColor(props.lang) }}
    />
  )
}

const STATE_COLORS: Record<string, string> = {
  open: "#3fb950",
  closed: "#a371f7",
  merged: "#a371f7",
}

export function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "#a371f7"
}

/** 状态 pill(open / closed / merged),GitHub 配色 */
export function StatePill(props: { state: string }) {
  const color = stateColor(props.state)
  return (
    <span
      class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}
    >
      {props.state === "merged" || props.state === "已合并" ? "已合并" : props.state === "open" ? "开启" : "已关闭"}
    </span>
  )
}

export function fileIcon(name: string): IconProps["name"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (["ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "c", "cpp", "h", "rb", "php", "sh", "css", "html", "vue", "swift", "kt"].includes(ext)) return "filetree"
  if (["json", "yaml", "yml", "toml"].includes(ext)) return "filetree"
  if (["md", "txt", "log"].includes(ext)) return "review"
  if (["zip", "tar", "gz", "7z"].includes(ext)) return "archive"
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "monitor"
  return "review"
}

export function eventIcon(typ: string): IconProps["name"] {
  const map: Record<string, IconProps["name"]> = {
    WatchEvent: "workspace",
    ForkEvent: "branch",
    PushEvent: "expand",
    CreateEvent: "plus",
    DeleteEvent: "xmark-small",
    IssuesEvent: "menu",
    IssueCommentEvent: "review",
    PullRequestEvent: "branch",
    PullRequestReviewEvent: "check",
    ReleaseEvent: "archive",
    CommitCommentEvent: "review",
  }
  return map[typ] ?? "menu"
}

/** Issue/PR 状态图标(描边圆圈 / 实心圆点),GitHub 语义色 */
export function StatusIcon(props: { state: string; merged?: boolean }) {
  const open = props.state === "open"
  const color = open ? "#3fb950" : "#a371f7"
  if (open) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="shrink-0">
        <circle cx="8" cy="8" r="6.2" stroke={color} stroke-width="1.6" fill="none" />
        <circle cx="8" cy="8" r="2.2" fill={color} />
      </svg>
    )
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="shrink-0">
      <circle cx="8" cy="8" r="7" fill={color} />
      <path d="M5.5 8l1.8 1.8L10.8 6.4" stroke="rgba(0,0,0,0.35)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" />
    </svg>
  )
}

/** 加载/错误/空态三选一容器:data 未就绪时按需显示 */
export function DataState(props: {
  loading: boolean
  error: Error | unknown | undefined
  empty: boolean
  onRetry?: () => void
}) {
  return (
    <>
      <Show when={props.loading && !props.error}>
        <div class="flex flex-1 items-center justify-center py-8">
          <LoaderV2 width={22} height={22} class="text-v2-text-text-faint" />
        </div>
      </Show>
      <Show when={props.error}>
        <div class="flex flex-col items-center gap-2 py-8 text-[12px] text-v2-text-text-faint">
          <span class="px-4 text-center">{props.error instanceof Error ? props.error.message : String(props.error)}</span>
          <Show when={props.onRetry}>
            <button type="button" class="rounded-md border border-v2-border-border-weak-base px-3 py-1 text-[11px] hover:bg-v2-background-bg-raised" onClick={() => props.onRetry?.()}>
              重试
            </button>
          </Show>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.empty}>
        <div class="py-10 text-center text-[12px] text-v2-text-text-faint">暂无数据</div>
      </Show>
    </>
  )
}
