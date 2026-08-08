// src/app/pages/chat/projection.ts
// 照抄 opencode pages/session/timeline/projection.ts 改造：
// - 输入为 IM 消息列表（MsgDto[]）而非 SessionMessageInfo/parts
// - constructRows：日期分隔线 + 新消息分隔线 + 消息分组角色（solo/first/middle/last）
// - 复用 row-reconciliation 保持行实例稳定

import { createMemo, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { TimelineRow, type GroupRole, type TimelineRow as Row } from "./rows"
import type { RenderableMsg } from "../../context/chat"

export { reuseTimelineRows } from "./row-reconciliation"

export function dateLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "今天"
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return "昨天"
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const isPending = (m: RenderableMsg) => m.state === "pending" || m.state === "failed"

function computeGroupRole(messages: RenderableMsg[], index: number, dividerIndex: number): GroupRole {
  const m = messages[index]
  const prev = messages[index - 1]
  const next = messages[index + 1]
  const date = dateLabel(m.ts)
  // 未读分隔线插在 dividerIndex 消息之前：它打断上下分组
  const prevIsSame =
    !!prev &&
    prev.from_id === m.from_id &&
    !isPending(m) &&
    !isPending(prev) &&
    dateLabel(prev.ts) === date &&
    index !== dividerIndex
  const nextIsSame =
    !!next &&
    next.from_id === m.from_id &&
    !isPending(m) &&
    !isPending(next) &&
    dateLabel(next.ts) === date &&
    index + 1 !== dividerIndex
  return !prevIsSame && !nextIsSame ? "solo" : !prevIsSame && nextIsSame ? "first" : prevIsSame && !nextIsSame ? "last" : "middle"
}

// 组装行序列：日期分隔线 + 新消息分隔线 + 消息（SystemInfo 独立成行）。
function constructRows(messages: RenderableMsg[], unreadCount: number): Row[] {
  const rows: Row[] = []
  const dividerIndex = unreadCount > 0 && messages.length >= unreadCount ? messages.length - unreadCount : -1
  let prevDate = ""
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const date = dateLabel(m.ts)
    if (date !== prevDate) {
      rows.push(TimelineRow.DateDivider(date))
      prevDate = date
    }
    if (i === dividerIndex) rows.push(TimelineRow.UnreadDivider())
    if (m.is_info) {
      rows.push(TimelineRow.SystemInfo(m))
      continue
    }
    rows.push(TimelineRow.Message(m, computeGroupRole(messages, i, dividerIndex)))
  }
  return rows
}

export function createTimelineProjection(input: {
  messages: Accessor<RenderableMsg[]>
  unreadCount: Accessor<number>
}) {
  const projection = createMemo(() => constructRows(input.messages(), input.unreadCount()))
  const rows = createMemo((previous: Row[] | undefined) => reuseTimelineRows(previous, projection()))
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (row._tag !== "Message") return
      const key = String(row.message.msg_id)
      if (!result.has(key)) result.set(key, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (row._tag === "Message") result.set(String(row.message.msg_id), index)
    })
    return result
  })

  return {
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
