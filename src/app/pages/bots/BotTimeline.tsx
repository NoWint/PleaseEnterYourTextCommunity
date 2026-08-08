// src/app/pages/bots/BotTimeline.tsx
// 时间线 Tab：list_bot_activities（limit 100，后端倒序 → 前端正序展示）+
// bot-activity 实时追加（仅当前 bot，onCleanup 退订）。

import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { onBotActivity } from "./activity"
import { kindLabel, kindVariant, type BotActivityDto, type BotDto } from "./types"

function badgeClass(kind: string): string {
  const v = kindVariant(kind)
  if (v === "danger") return "text-v2-danger-danger-base"
  if (v === "success") return "text-v2-state-fg-success"
  if (v === "muted") return "text-v2-text-text-faint"
  return ""
}

interface BotTimelineProps {
  bot: BotDto
}

export function BotTimeline(props: BotTimelineProps) {
  const [activities, setActivities] = createSignal<BotActivityDto[]>([])
  const [loading, setLoading] = createSignal(true)
  let listRef: HTMLDivElement | undefined

  const scrollToBottom = () => {
    if (listRef) listRef.scrollTop = listRef.scrollHeight
  }

  onMount(() => {
    void (async () => {
      try {
        const list = await call<BotActivityDto[]>("list_bot_activities", { botId: props.bot.id, limit: 100 })
        setActivities([...list].reverse())
      } catch (e) {
        showToast({ title: "加载活动失败", description: e instanceof Error ? e.message : String(e) })
      } finally {
        setLoading(false)
        scrollToBottom()
      }
    })()

    const off = onBotActivity((a) => {
      if (a.bot_id !== props.bot.id) return
      setActivities((prev) => [...prev, a])
      scrollToBottom()
    })
    onCleanup(off)
  })

  return (
    <div ref={listRef} class="mx-auto h-full w-full max-w-[760px] overflow-y-auto p-4">
      <Show
        when={!loading}
        fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">加载中…</div>}
      >
        <Show
          when={activities().length > 0}
          fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">暂无活动记录</div>}
        >
          <div class="flex flex-col gap-2">
            <For each={activities()}>
              {(a) => (
                <div class="flex items-start gap-3 rounded-[8px] border border-v2-border-border-weak-base bg-v2-background-bg-raised px-3 py-2.5">
                  <span class="shrink-0 pt-0.5 text-[11px] whitespace-nowrap text-v2-text-text-muted">
                    {new Date(a.created_at * 1000).toLocaleString()}
                  </span>
                  <BadgeV2 class={badgeClass(a.kind)}>{kindLabel(a.kind)}</BadgeV2>
                  <span class="min-w-0 flex-1 text-[13px] break-words text-v2-text-text-base">
                    {a.summary || "—"}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
