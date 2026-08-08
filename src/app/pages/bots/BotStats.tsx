// src/app/pages/bots/BotStats.tsx
// 统计 Tab：get_bot_stats 卡片组（总活动/回复/规则回复/定时/工具调用/错误/限流/最近活动）。
// 数据由 BotDetail 打开时并行拉取（b5 §3.5）。

import { For, Show, type Component } from "solid-js"
import type { BotStatsDto } from "./types"

interface BotStatsProps {
  stats: () => BotStatsDto | null
  loading: () => boolean
}

export function BotStats(props: BotStatsProps) {
  const items = () => {
    const s = props.stats()
    if (!s) return []
    return [
      { label: "总活动", value: String(s.total_activities) },
      { label: "自动回复", value: String(s.reply_sent) },
      { label: "规则回复", value: String(s.rule_reply) },
      { label: "定时消息", value: String(s.schedule_sent) },
      { label: "工具调用", value: String(s.tool_called) },
      { label: "LLM 错误", value: String(s.llm_error) },
      { label: "被限流", value: String(s.rate_limited) },
      {
        label: "最近活动",
        value: s.last_activity_at ? new Date(s.last_activity_at * 1000).toLocaleString() : "—",
      },
    ]
  }

  return (
    <div class="mx-auto w-full max-w-[760px] p-4">
      <Show
        when={!props.loading()}
        fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">加载中…</div>}
      >
        <Show
          when={props.stats()}
          fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">统计加载失败</div>}
        >
          <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <For each={items()}>
              {(it) => (
                <div class="flex flex-col gap-1 rounded-[8px] border border-v2-border-border-weak-base bg-v2-background-bg-raised px-3.5 py-3">
                  <div class="text-[20px] font-bold tracking-[-0.02em] text-v2-text-text-base">{it.value}</div>
                  <div class="text-[11px] text-v2-text-text-muted">{it.label}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
