// src/app/pages/chat/row-reconciliation.ts
// 照抄 opencode pages/session/timeline/row-reconciliation.ts 改造：
// IM 行没有 context group（AI part 分组），reuse 退化为按 key 复用相同行实例，
// 保持滚动测量/动画状态稳定。

import { TimelineRow } from "./rows"

export function reuseTimelineRows(previous: TimelineRow[] | undefined, rows: TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const next = rows.map((input) => {
    const existing = byKey.get(TimelineRow.key(input))
    if (!existing) return input
    return TimelineRow.equals(existing, input) ? existing : input
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}
