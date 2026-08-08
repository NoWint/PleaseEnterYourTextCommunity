// src/app/pages/work/views/CalendarView.tsx
// 协作日历视图（Solid 版，逻辑从 src/work/calendar.ts 迁移）：
// 月份网格（周一起始）+ 上月/下月/今天导航 + 未排期列表。
// 点击带日期的卡片 → onOpenCard。

import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { WorkIcon } from "../work-icons"
import type { CardDto, CardStatus } from "../../../../types"
import { STATUS_LABEL, dateKey } from "../work-types"

export interface CalendarViewProps {
  cards: CardDto[]
  loading: boolean
  onOpenCard: (card: CardDto) => void
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const

interface DayCell {
  date: Date
  inMonth: boolean
  isToday: boolean
  key: string
}

export const CalendarView: Component<CalendarViewProps> = (props) => {
  const now = new Date()
  const [year, setYear] = createSignal(now.getFullYear())
  const [month, setMonth] = createSignal(now.getMonth())

  const scheduled = createMemo(() => props.cards.filter((c) => c.due_date != null))
  const unscheduled = createMemo(() => props.cards.filter((c) => c.due_date == null))

  const byDay = createMemo(() => {
    const map = new Map<string, CardDto[]>()
    for (const c of scheduled()) {
      const key = dateKey(new Date(c.due_date! * 1000))
      const arr = map.get(key) ?? []
      arr.push(c)
      map.set(key, arr)
    }
    return map
  })

  const cells = createMemo<DayCell[]>(() => {
    const first = new Date(year(), month(), 1)
    const offset = (first.getDay() + 6) % 7
    const daysInMonth = new Date(year(), month() + 1, 0).getDate()
    const total = Math.ceil((offset + daysInMonth) / 7) * 7
    const todayKey = dateKey(new Date())
    return Array.from({ length: total }, (_, i) => {
      const d = new Date(year(), month(), 1 - offset + i)
      return {
        date: d,
        inMonth: d.getMonth() === month(),
        isToday: dateKey(d) === todayKey,
        key: dateKey(d),
      }
    })
  })

  const shiftMonth = (delta: number) => {
    const m = month() + delta
    if (m < 0) {
      setMonth(11)
      setYear((y) => y - 1)
    } else if (m > 11) {
      setMonth(0)
      setYear((y) => y + 1)
    } else {
      setMonth(m)
    }
  }

  const goToday = () => {
    const t = new Date()
    setYear(t.getFullYear())
    setMonth(t.getMonth())
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col p-3">
      <div class="mb-3 flex items-center gap-2">
        <ButtonV2 size="small" variant="outline" class="!px-1.5" onClick={() => shiftMonth(-1)} aria-label="上一月">
          <WorkIcon name="chevron-left" size={14} />
        </ButtonV2>
        <span class="min-w-[96px] text-center text-[13px] font-semibold text-v2-text-text-base">
          {year()}年{month() + 1}月
        </span>
        <ButtonV2 size="small" variant="outline" class="!px-1.5" onClick={() => shiftMonth(1)} aria-label="下一月">
          <WorkIcon name="chevron-right" size={14} />
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost" onClick={goToday}>
          今天
        </ButtonV2>
        <span class="ml-auto text-[12px] text-v2-text-text-faint">
          {props.cards.length} 个卡片 · {scheduled().length} 已排期
        </span>
      </div>

      <Show when={props.cards.length === 0} fallback={<></>}>
        <div class="flex h-full items-center justify-center text-[13px] text-v2-text-text-faint">
          {props.loading ? "加载中…" : "暂无卡片"}
        </div>
      </Show>

      <div class="grid flex-1 grid-cols-7 gap-px overflow-hidden rounded-lg border border-v2-border-border-weak-base bg-v2-border-border-weak-base">
        <For each={WEEKDAY_LABELS}>
          {(w) => (
            <div class="bg-v2-background-bg-deep px-2 py-1.5 text-center text-[11px] text-v2-text-text-faint">
              {w}
            </div>
          )}
        </For>
        <For each={cells()}>
          {(cell) => (
            <div
              class="min-h-[84px] bg-v2-background-bg-base p-1.5"
              classList={{
                "opacity-40": !cell.inMonth,
                "bg-v2-background-bg-raised": cell.isToday,
              }}
            >
              <div class="mb-1 flex justify-end">
                <span
                  class="flex size-5 items-center justify-center rounded-full text-[11px]"
                  classList={{
                    "bg-v2-text-text-base font-semibold text-v2-background-bg-base": cell.isToday,
                    "text-v2-text-text-faint": !cell.inMonth,
                    "text-v2-text-text-muted": cell.inMonth && !cell.isToday,
                  }}
                >
                  {cell.date.getDate()}
                </span>
              </div>
              <div class="space-y-1">
                <For each={(byDay().get(cell.key) ?? []).slice(0, 3)}>
                  {(card) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-raised hover:text-v2-text-text-base"
                      onClick={() => props.onOpenCard(card)}
                      title={card.title}
                    >
                      <span
                        class="size-1.5 shrink-0 rounded-full border"
                        classList={{
                          "border-v2-text-text-faint": card.status === "todo",
                          "bg-v2-text-text-muted": card.status === "in_progress",
                          "bg-v2-text-text-base": card.status === "done",
                        }}
                      />
                      <span class="truncate">{card.title}</span>
                    </button>
                  )}
                </For>
                <Show when={(byDay().get(cell.key) ?? []).length > 3}>
                  <div class="px-1 text-[10px] text-v2-text-text-faint">+{(byDay().get(cell.key) ?? []).length - 3}</div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={unscheduled().length > 0}>
        <div class="mt-3">
          <div class="mb-1.5 text-[11px] font-semibold text-v2-text-text-faint">未排期 · {unscheduled().length}</div>
          <div class="flex flex-wrap gap-1.5">
            <For each={unscheduled()}>
              {(card) => (
                <button
                  type="button"
                  class="flex items-center gap-1.5 rounded-full border border-v2-border-border-weak-base px-2.5 py-1 text-[12px] text-v2-text-text-muted transition-colors hover:border-v2-border-border-strong-base hover:text-v2-text-text-base"
                  onClick={() => props.onOpenCard(card)}
                >
                  <span
                    class="size-1.5 rounded-full border"
                    classList={{
                      "border-v2-text-text-faint": card.status === "todo",
                      "bg-v2-text-text-muted": card.status === "in_progress",
                      "bg-v2-text-text-base": card.status === "done",
                    }}
                  />
                  {card.title}
                  <span class="text-[10px] text-v2-text-text-faint">{STATUS_LABEL[card.status]}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default CalendarView
