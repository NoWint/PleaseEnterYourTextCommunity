// src/app/pages/work/views/TimelineView.tsx
// 协作时间线视图（Solid 版，逻辑从 src/work/timeline.ts 迁移）：
// 按 created_at DESC 排列，按 今天 / 昨天 / 更早 分组，左侧时间轴 + 右侧卡片摘要。

import { For, Show, createMemo, type Component } from "solid-js"
import type { CardDto } from "../../../../types"
import { STATUS_LABEL, dateKey, dueLabel, typeLabel } from "../work-types"

export interface TimelineViewProps {
  cards: CardDto[]
  loading: boolean
  onOpenCard: (card: CardDto) => void
}

interface TimelineGroup {
  key: "today" | "yesterday" | "earlier"
  label: string
  items: CardDto[]
}

export const TimelineView: Component<TimelineViewProps> = (props) => {
  const groups = createMemo<TimelineGroup[]>(() => {
    const now = new Date()
    const todayKey = dateKey(now)
    const yesterdayKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
    const sorted = [...props.cards].sort((a, b) => b.created_at - a.created_at)
    const buckets: Record<TimelineGroup["key"], CardDto[]> = { today: [], yesterday: [], earlier: [] }
    for (const c of sorted) {
      const key = dateKey(new Date(c.created_at * 1000))
      if (key === todayKey) buckets.today.push(c)
      else if (key === yesterdayKey) buckets.yesterday.push(c)
      else buckets.earlier.push(c)
    }
    const defs: Array<[TimelineGroup["key"], string]> = [
      ["today", "今天"],
      ["yesterday", "昨天"],
      ["earlier", "更早"],
    ]
    return defs
      .map(([key, label]) => ({ key, label, items: buckets[key] }))
      .filter((g) => g.items.length > 0)
  })

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <Show when={props.cards.length === 0}>
        <div class="flex h-full items-center justify-center text-[13px] text-v2-text-text-faint">
          {props.loading ? "加载中…" : "暂无卡片"}
        </div>
      </Show>
      <For each={groups()}>
        {(group) => (
          <div class="mb-4">
            <div class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
              {group.label} · {group.items.length}
            </div>
            <div class="space-y-2">
              <For each={group.items}>
                {(card) => {
                  const d = new Date(card.created_at * 1000)
                  const axisLabel =
                    group.key === "earlier"
                      ? d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
                      : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
                  return (
                    <div class="flex items-stretch gap-3">
                      <div class="flex w-[64px] shrink-0 items-start justify-end pt-2.5 text-[11px] text-v2-text-text-faint">
                        {axisLabel}
                      </div>
                      <div class="relative flex items-center pl-3">
                        <span
                          class="absolute -left-[3px] size-[7px] rounded-full border-2"
                          classList={{
                            "border-v2-text-text-faint bg-v2-background-bg-base": card.status === "todo",
                            "border-v2-text-text-muted bg-v2-background-bg-base": card.status === "in_progress",
                            "border-v2-text-text-base bg-v2-text-text-base": card.status === "done",
                          }}
                        />
                        <span class="absolute bottom-0 -left-px top-0 w-px bg-v2-border-border-weak-base" />
                      </div>
                      <button
                        type="button"
                        class="group min-w-0 flex-1 rounded-lg border border-v2-border-border-weak-base bg-v2-background-bg-base p-2.5 text-left transition-colors hover:border-v2-border-border-strong-base hover:bg-v2-background-bg-raised"
                        onClick={() => props.onOpenCard(card)}
                      >
                        <div class="truncate text-[13px] text-v2-text-text-base">{card.title}</div>
                        <div class="mt-1 flex items-center gap-2 text-[11px] text-v2-text-text-faint">
                          <span>{STATUS_LABEL[card.status]}</span>
                          <span class="flex items-center gap-1">
                            <span class="flex size-4 items-center justify-center rounded-full bg-v2-background-bg-raised text-[10px] text-v2-text-text-muted">
                              {card.assignee_name ? card.assignee_name.charAt(0).toUpperCase() : "?"}
                            </span>
                            {card.assignee_name || "未指派"}
                          </span>
                          <Show when={dueLabel(card)}>
                            <span>截止 {dueLabel(card)}</span>
                          </Show>
                          <span>{typeLabel(card.type)}</span>
                        </div>
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

export default TimelineView
