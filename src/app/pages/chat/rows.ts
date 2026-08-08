// src/app/pages/chat/rows.ts
// IM 版 timeline 行模型（照抄 opencode session/timeline/rows.ts + timeline-row.ts 改造）：
// - AI 行（AssistantPart/Thinking/Retry/DiffSummary/Error/CommentStrip）删除
// - 行 = 消息行（Message，含分组角色）/ 系统信息行（SystemInfo）/ 日期分隔线（DateDivider）
//   / 新消息分隔线（UnreadDivider）
// - 不用 Effect Data.TaggedClass（全局约束），用 plain tagged union + 工厂函数

import type { RenderableMsg } from "../../context/chat"

export type GroupRole = "solo" | "first" | "middle" | "last"

export type TimelineRow =
  | { _tag: "Message"; key: string; message: RenderableMsg; groupRole: GroupRole }
  | { _tag: "SystemInfo"; key: string; message: RenderableMsg }
  | { _tag: "DateDivider"; key: string; label: string }
  | { _tag: "UnreadDivider"; key: string }

export namespace TimelineRow {
  export const Message = (message: RenderableMsg, groupRole: GroupRole): TimelineRow => ({
    _tag: "Message",
    key: `message:${message.msg_id}`,
    message,
    groupRole,
  })
  export const SystemInfo = (message: RenderableMsg): TimelineRow => ({
    _tag: "SystemInfo",
    key: `system:${message.msg_id}`,
    message,
  })
  export const DateDivider = (label: string): TimelineRow => ({
    _tag: "DateDivider",
    key: `date:${label}`,
    label,
  })
  export const UnreadDivider = (): TimelineRow => ({
    _tag: "UnreadDivider",
    key: "unread",
  })

  export const key = (row: TimelineRow) => row.key

  export function equals(a: TimelineRow, b: TimelineRow) {
    if (a === b) return true
    if (a._tag !== b._tag) return false
    switch (a._tag) {
      case "Message":
        return b._tag === "Message" && a.message === b.message && a.groupRole === b.groupRole
      case "SystemInfo":
        return b._tag === "SystemInfo" && a.message === b.message
      case "DateDivider":
        return b._tag === "DateDivider" && a.label === b.label
      case "UnreadDivider":
        return true
    }
  }
}
