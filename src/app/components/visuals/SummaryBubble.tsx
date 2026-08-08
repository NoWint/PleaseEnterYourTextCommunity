// src/app/components/visuals/SummaryBubble.tsx
// 主题气泡（Solid 组件版，从 src/components/summaryBubble.ts 迁移渲染层）：
// 状态机 idle / summarizing / done / error / fallback。
// - summarizing：流式文本或「总结中…」+ 旋转 loading 指示器
// - done：解析文本（占位渲染，TODO(Task 4)：接 tagParser 解析）
// - idle/error/fallback：降级显示词频簇短语
// 事件驱动（summary-event 流式）由宿主接线，组件保持纯展示。

import { Show, type Component, type JSX } from "solid-js"
import { WorkIcon } from "../../pages/work/work-icons"
import type { WordFreq } from "../../../utils/wordAnalysis"

export type BubbleStatus = "idle" | "summarizing" | "done" | "error" | "fallback"

export interface TopicClusterLike {
  words: string[]
  score: number
  wordFreqs: WordFreq[]
}

export interface SummaryBubbleProps {
  status: BubbleStatus
  /** summarizing/done 状态的文本（done 为空时退化为簇短语）。 */
  text?: string
  clusters?: TopicClusterLike[]
  onClick?: () => void
  class?: string
}

function LoadingIndicator(): JSX.Element {
  return (
    <svg class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function CheckIndicator(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export const SummaryBubble: Component<SummaryBubbleProps> = (props) => {
  const clusterText = () =>
    props.clusters && props.clusters.length > 0
      ? props.clusters.map((c) => c.words.join(" ")).join(" · ")
      : "暂无主题词"

  const body = (): string => {
    if (props.status === "summarizing") return props.text || "总结中…"
    if (props.status === "done" && props.text) return props.text
    return clusterText()
  }

  return (
    <button
      type="button"
      data-component="summary-bubble"
      class={`group flex min-w-0 items-center gap-1.5 rounded-full border border-v2-border-border-weak-base bg-v2-background-bg-raised px-2.5 py-1 text-xs text-v2-text-text-muted transition-colors hover:border-v2-border-border-strong-base hover:text-v2-text-text-base ${props.class ?? ""}`}
      onClick={props.onClick}
      title="打开主题分析看板"
    >
      <WorkIcon name="hash" size={13} />
      <span class="truncate">{body()}</span>
      <Show when={props.status === "summarizing"}>
        <LoadingIndicator />
      </Show>
      <Show when={props.status === "done"}>
        <CheckIndicator />
      </Show>
    </button>
  )
}

export default SummaryBubble
