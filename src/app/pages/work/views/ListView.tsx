// src/app/pages/work/views/ListView.tsx
// 协作列表视图（Solid 版，逻辑从 src/work/list.ts 迁移）：
// 表格展示卡片 + 列头排序（标题/状态/指派/截止/创建）+ 行点击打开详情。

import { For, Show, createSignal, type Component } from "solid-js"
import type { CardDto } from "../../../../types"
import { STATUS_LABEL, dueLabel, typeLabel } from "../work-types"

export interface ListViewProps {
  cards: CardDto[]
  loading: boolean
  onOpenCard: (card: CardDto) => void
}

type SortField = "title" | "status" | "assignee_name" | "due_date" | "created_at"

const COLUMNS: Array<{ field: SortField | null; label: string; sortable: boolean }> = [
  { field: "title", label: "标题", sortable: true },
  { field: null, label: "类型", sortable: false },
  { field: "status", label: "状态", sortable: true },
  { field: "assignee_name", label: "指派", sortable: true },
  { field: "due_date", label: "截止", sortable: true },
  { field: "created_at", label: "创建", sortable: true },
]

function sortValue(card: CardDto, field: SortField): string | number {
  switch (field) {
    case "due_date":
    case "created_at":
      return card[field] ?? Number.MAX_SAFE_INTEGER
    default:
      return (card[field] ?? "") as string | number
  }
}

export const ListView: Component<ListViewProps> = (props) => {
  const [sortField, setSortField] = createSignal<SortField | null>(null)

  const sorted = () => {
    const field = sortField()
    if (!field) return props.cards
    return [...props.cards].sort((a, b) => {
      const va = sortValue(a, field)
      const vb = sortValue(b, field)
      return String(va).localeCompare(String(vb))
    })
  }

  return (
    <div class="flex-1 overflow-auto p-3">
      <Show when={props.cards.length === 0} fallback={<></>}>
        <div class="flex h-full items-center justify-center text-[13px] text-v2-text-text-faint">
          {props.loading ? "加载中…" : "暂无卡片"}
        </div>
      </Show>
      <table class="w-full border-collapse text-left">
        <thead>
          <tr class="border-b border-v2-border-border-weak-base text-[11px] text-v2-text-text-faint">
            <For each={COLUMNS}>
              {(col) => (
                <th
                  class={`px-3 py-2 font-normal ${col.sortable ? "cursor-pointer select-none transition-colors hover:text-v2-text-text-base" : ""} ${sortField() === col.field ? "text-v2-text-text-base" : ""}`}
                  onClick={() => col.sortable && col.field && setSortField(col.field)}
                >
                  {col.label}
                  {sortField() === col.field ? " ↓" : ""}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={sorted()}>
            {(card) => (
              <tr
                class="cursor-pointer border-b border-v2-border-border-weak-base/50 text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-raised"
                onClick={() => props.onOpenCard(card)}
              >
                <td class="max-w-[34%] truncate px-3 py-2.5 font-medium text-v2-text-text-base">{card.title}</td>
                <td class="px-3 py-2.5">{typeLabel(card.type)}</td>
                <td class="px-3 py-2.5">
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="size-1.5 rounded-full border"
                      classList={{
                        "border-v2-text-text-faint bg-transparent": card.status === "todo",
                        "border-v2-text-text-muted bg-v2-text-text-muted": card.status === "in_progress",
                        "border-v2-text-text-base bg-v2-text-text-base": card.status === "done",
                      }}
                    />
                    {STATUS_LABEL[card.status]}
                  </span>
                </td>
                <td class="truncate px-3 py-2.5">{card.assignee_name || "—"}</td>
                <td class="px-3 py-2.5">{dueLabel(card) || "—"}</td>
                <td class="px-3 py-2.5">{new Date(card.created_at * 1000).toLocaleDateString("zh-CN")}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

export default ListView
