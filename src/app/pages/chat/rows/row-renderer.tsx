// src/app/pages/chat/rows/row-renderer.tsx
// TimelineRow → JSX 渲染（对应 opencode message-timeline 的 renderTimelineRow）。
// 行类型：Message（IM 气泡）/ SystemInfo（居中信息行）/ DateDivider / UnreadDivider。

import { type Component } from "solid-js"
import { useChat } from "../../../context/chat"
import type { TimelineRow } from "../rows"
import type { MsgDto } from "@/types"
import { MessageRow } from "./message-row"

export function renderTimelineRow(
  row: TimelineRow,
  handlers: {
    onReply: (msgId: number) => void
    onJumpToMessage: (msgId: number) => void
    onSizeChange?: () => void
  },
) {
  switch (row._tag) {
    case "Message":
      return (
        <MessageRow
          message={row.message}
          groupRole={row.groupRole}
          onReply={handlers.onReply}
          onJumpToMessage={handlers.onJumpToMessage}
          onSizeChange={handlers.onSizeChange}
        />
      )
    case "SystemInfo":
      return (
        <div class="cm-system" data-msg={String(row.message.msg_id)}>
          <span>{row.message.text || ""}</span>
        </div>
      )
    case "DateDivider":
      return <div class="cm-divider">{row.label}</div>
    case "UnreadDivider":
      return <div class="cm-divider cm-unread">新消息</div>
  }
}

// 行内容纯渲染组件（虚拟行挂载用）。
export const TimelineRowView: Component<{
  row: TimelineRow
  onSizeChange?: () => void
  onReply: (msgId: number) => void
  onJumpToMessage: (msgId: number) => void
}> = (props) => {
  const chat = useChat()
  return renderTimelineRow(props.row, {
    onReply: props.onReply,
    onJumpToMessage: props.onJumpToMessage,
    onSizeChange: props.onSizeChange,
  })
}

// 给 SystemInfo 行一个惰性访问 chat 的占位（保持导入稳定）
export { useChat }
