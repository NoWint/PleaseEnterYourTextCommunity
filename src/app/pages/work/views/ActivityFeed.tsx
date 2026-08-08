// src/app/pages/work/views/ActivityFeed.tsx
// 协作活动流（Solid 版，逻辑从 src/work/activity.ts 迁移）：
// 展示当前工作区活动（list_activities 结果），点击卡片类活动 → onOpenCardTarget。

import { For, Show, type Component } from "solid-js"
import { WorkIcon } from "../work-icons"
import type { ActivityDto, CardDto } from "../../../../types"
import { activityMeta, activityTargetLabel, formatRelativeTs } from "../work-types"

export interface ActivityFeedProps {
  activities: ActivityDto[]
  cards: CardDto[]
  channelNames: Record<number, string>
  loading: boolean
  onOpenCard: (cardId: number) => void
}

export const ActivityFeed: Component<ActivityFeedProps> = (props) => {
  const channelOf = (chatId: number | null) => (chatId != null ? props.channelNames[chatId] ?? "协作" : "协作")

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-v2-border-border-weak-base bg-v2-background-bg-deep">
      <div class="border-b border-v2-border-border-weak-base px-3 py-2.5 text-[13px] font-semibold text-v2-text-text-base">
        活动
      </div>
      <Show when={props.activities.length === 0}>
        <div class="flex flex-1 items-center justify-center p-6 text-[12px] text-v2-text-text-faint">
          {props.loading ? "加载中…" : "暂无活动记录"}
        </div>
      </Show>
      <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        <For each={props.activities}>
          {(activity) => {
            const meta = activityMeta(activity.action)
            const isCard = activity.target_type === "card"
            return (
              <button
                type="button"
                class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-v2-background-bg-raised"
                classList={{ "cursor-pointer": isCard, "cursor-default": !isCard }}
                onClick={() => isCard && props.onOpenCard(activity.target_id)}
              >
                <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-raised text-v2-text-text-muted">
                  <WorkIcon name={meta.icon} size={12} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="text-[12px] leading-4 text-v2-text-text-muted">
                    <span class="font-medium text-v2-text-text-base">{activity.actor_name}</span>
                    {meta.label}
                    {isCard ? (
                      <span class="text-v2-text-text-muted">「{activityTargetLabel(activity, props.cards)}」</span>
                    ) : null}
                  </span>
                  <span class="mt-0.5 flex items-center gap-2 text-[10px] text-v2-text-text-faint">
                    {activity.channel_chat_id != null ? (
                      <span class="flex items-center gap-0.5">
                        <WorkIcon name="hash" size={10} />
                        {channelOf(activity.channel_chat_id)}
                      </span>
                    ) : null}
                    <span>{formatRelativeTs(activity.created_at)}</span>
                  </span>
                </span>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

export default ActivityFeed
