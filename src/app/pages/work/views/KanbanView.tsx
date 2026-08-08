// src/app/pages/work/views/KanbanView.tsx
// 协作看板视图（Solid 版，逻辑从 src/work/kanban.ts 迁移）：
// 三列（Todo / Doing / Done）+ 卡片 + 状态切换 + 列底内联创建。
// 交互全部迁移：点击卡片 → onOpenCard 打开详情对话框；状态切换 → onUpdateStatus。

import { For, Show, createSignal, type Component } from "solid-js"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { WorkIcon } from "../work-icons"
import type { CardDto, CardStatus } from "../../../../types"
import { STATUS_LABEL, STATUS_ORDER, dueLabel, isOverdue, typeLabel } from "../work-types"

export interface KanbanViewProps {
  cards: CardDto[]
  loading: boolean
  onCreateCard: (status: CardStatus, title: string) => Promise<void>
  onUpdateStatus: (cardId: number, status: CardStatus) => Promise<void>
  onOpenCard: (card: CardDto) => void
}

function KanbanCard(props: {
  card: CardDto
  currentStatus: CardStatus
  onUpdateStatus: (cardId: number, status: CardStatus) => Promise<void>
  onOpen: (card: CardDto) => void
}) {
  const c = () => props.card
  const overdue = () => isOverdue(c())
  return (
    <div
      class="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-v2-border-border-weak-base bg-v2-background-bg-base p-2.5 transition-colors hover:border-v2-border-border-strong-base hover:bg-v2-background-bg-raised"
      onClick={() => props.onOpen(c())}
    >
      <div class="text-[13px] leading-4 text-v2-text-text-base">{c().title}</div>
      <div class="flex items-center gap-2 text-[11px] text-v2-text-text-faint">
        <span
          class="rounded-sm px-1 py-px"
          classList={{
            "bg-v2-background-bg-raised text-v2-text-text-muted": c().type !== "task",
          }}
        >
          {typeLabel(c().type)}
        </span>
        <Show when={dueLabel(c())}>
          <span class={overdue() ? "font-semibold text-v2-text-text-base" : ""}>
            {overdue() ? "逾期 " : ""}
            {dueLabel(c())}
          </span>
        </Show>
        <Show when={c().assignee_name}>
          <span class="flex size-4 items-center justify-center rounded-full bg-v2-background-bg-raised text-[10px] text-v2-text-text-muted">
            {c().assignee_name!.charAt(0).toUpperCase()}
          </span>
        </Show>
      </div>
      <SegmentedControlV2
        class="mt-0.5"
        value={props.currentStatus}
        onChange={(next) => {
          if (!next || next === props.currentStatus) return
          void props.onUpdateStatus(c().id, next as CardStatus)
        }}
      >
        <For each={STATUS_ORDER}>
          {(s) => (
            <SegmentedControlItemV2 value={s} class="!py-0.5 text-[11px]">
              {STATUS_LABEL[s]}
            </SegmentedControlItemV2>
          )}
        </For>
      </SegmentedControlV2>
    </div>
  )
}

export const KanbanView: Component<KanbanViewProps> = (props) => {
  const [creating, setCreating] = createSignal<CardStatus | null>(null)
  const [title, setTitle] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  const cardsOf = (status: CardStatus) => props.cards.filter((c) => c.status === status)

  const startCreate = (status: CardStatus) => {
    setCreating(status)
    setTitle("")
  }

  const submit = async (status: CardStatus) => {
    const t = title().trim()
    if (!t || submitting()) return
    setSubmitting(true)
    try {
      await props.onCreateCard(status, t)
      setCreating(null)
      setTitle("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-1 flex-col">
      <Show when={props.cards.length === 0} fallback={<></>}>
        <div class="flex flex-1 items-center justify-center text-[13px] text-v2-text-text-faint">
          {props.loading ? "加载中…" : "暂无卡片"}
        </div>
      </Show>
      <div class="flex min-h-0 flex-1 gap-3 p-3">
        <For each={STATUS_ORDER}>
          {(status) => (
            <div class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-v2-border-border-weak-base bg-v2-background-bg-deep">
              <div class="flex items-center gap-2 px-3 py-2.5">
                <span class="text-[13px] font-semibold text-v2-text-text-base">{STATUS_LABEL[status]}</span>
                <span class="rounded-full bg-v2-background-bg-raised px-1.5 text-[11px] text-v2-text-text-faint">
                  {cardsOf(status).length}
                </span>
              </div>
              <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 pb-2.5">
                <For each={cardsOf(status)}>
                  {(card) => (
                    <KanbanCard
                      card={card}
                      currentStatus={status}
                      onUpdateStatus={props.onUpdateStatus}
                      onOpen={props.onOpenCard}
                    />
                  )}
                </For>
                <Show when={creating() === status}>
                  <div class="flex flex-col gap-1.5 rounded-lg border border-v2-border-border-strong-base bg-v2-background-bg-base p-2">
                    <input
                      autofocus
                      value={title()}
                      placeholder="输入卡片标题"
                      class="w-full bg-transparent text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                      onInput={(e) => setTitle(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submit(status)
                        if (e.key === "Escape") setCreating(null)
                      }}
                    />
                    <div class="flex gap-1.5">
                      <ButtonV2 size="small" variant="contrast" disabled={submitting() || !title().trim()} onClick={() => void submit(status)}>
                        创建
                      </ButtonV2>
                      <ButtonV2 size="small" variant="ghost" onClick={() => setCreating(null)}>
                        取消
                      </ButtonV2>
                    </div>
                  </div>
                </Show>
                <button
                  type="button"
                  class="flex w-full items-center gap-1 rounded-lg border border-dashed border-transparent px-2 py-1.5 text-[12px] text-v2-text-text-faint transition-colors hover:border-v2-border-border-strong-base hover:text-v2-text-text-muted"
                  onClick={() => startCreate(status)}
                >
                  <WorkIcon name="plus" size={12} />
                  添加卡片
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export default KanbanView
