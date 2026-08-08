// src/app/pages/chat/chat-smoke.test.tsx
// 结构冒烟测试：确认聊天页模块图可加载（无顶层导入/执行错误），
// 以及行投影/文本渲染等纯逻辑行为正确。
// 浏览器自动化不可用时用于替代 dev 验证的一部分。

import { describe, expect, it } from "vitest"
import { createRoot } from "solid-js"
import { createTimelineProjection, dateLabel } from "./projection"
import { renderMessageText, stateLabel, formatTs } from "./chat-text"
import { TimelineRow } from "./rows"
import { reuseTimelineRows } from "./row-reconciliation"
import type { RenderableMsg } from "../../context/chat"

function msg(overrides: Partial<RenderableMsg> = {}): RenderableMsg {
  return {
    msg_id: 1,
    chat_id: 1,
    from_id: 1,
    from_name: "我",
    from_avatar: null,
    from_color: null,
    text: "hello",
    ts: Math.floor(Date.now() / 1000),
    state: "read",
    view_type: "Text",
    file: null,
    file_mime: null,
    file_name: null,
    file_bytes: null,
    quote_text: null,
    quote_from: null,
    quote_msg_id: null,
    quote_from_id: null,
    reactions: null,
    is_info: false,
    is_out: true,
    ...overrides,
  }
}

describe("chat page module graph", () => {
  it("imports timeline modules", async () => {
    const { MessageTimeline } = await import("./message-timeline")
    const { SessionComposerRegion } = await import("./session-composer-region")
    const { SessionSidePanel } = await import("./session-side-panel")
    expect(typeof MessageTimeline).toBe("function")
    expect(typeof SessionComposerRegion).toBe("function")
    expect(typeof SessionSidePanel).toBe("function")
  })

  it("imports message row modules", async () => {
    const { MessageRow } = await import("./rows/message-row")
    const { MessageAttachment } = await import("./rows/message-attachment")
    const { TimelineRowView } = await import("./rows/row-renderer")
    expect(typeof MessageRow).toBe("function")
    expect(typeof MessageAttachment).toBe("function")
    expect(typeof TimelineRowView).toBe("function")
  })
})

describe("projection", () => {
  it("builds rows with date divider + grouping", () => {
    const now = Math.floor(Date.now() / 1000)
    const messages: RenderableMsg[] = [
      msg({ msg_id: 1, from_id: 2, from_name: "A", is_out: false, ts: now - 60 }),
      msg({ msg_id: 2, from_id: 2, from_name: "A", is_out: false, ts: now - 30 }),
      msg({ msg_id: 3, from_id: 1, is_out: true, ts: now }),
    ]
    const rows = createRoot(() => {
      const projection = createTimelineProjection({
        messages: () => messages,
        unreadCount: () => 0,
      })
      return projection.rows()
    })
    const tags = rows.map((r) => r._tag)
    expect(tags).toEqual(["DateDivider", "Message", "Message", "Message"])
    const messageRows = rows.filter((r) => r._tag === "Message")
    expect(messageRows[0]._tag === "Message" && messageRows[0].groupRole).toBe("first")
    expect(messageRows[1]._tag === "Message" && messageRows[1].groupRole).toBe("last")
    expect(messageRows[2]._tag === "Message" && messageRows[2].groupRole).toBe("solo")
  })

  it("reuses identical row instances", () => {
    const rows: TimelineRow[] = [TimelineRow.DateDivider("今天"), TimelineRow.UnreadDivider()]
    const next = reuseTimelineRows(rows, rows)
    expect(next).toBe(rows)
  })

  it("formats date labels in Chinese", () => {
    const now = Date.now()
    expect(dateLabel(now / 1000)).toBe("今天")
  })
})

describe("chat text rendering", () => {
  it("highlights code blocks", () => {
    const html = renderMessageText("```ts\nconst x: number = 1\n```", {
      selfName: "我",
      roleNames: [],
      markdown: true,
    })
    expect(html).toContain("cm-code")
    expect(html).toContain("hljs")
  })

  it("highlights mentions", () => {
    const html = renderMessageText("hi @小明", { selfName: "我", roleNames: ["小明"], markdown: true })
    expect(html).toContain("cm-mention")
  })

  it("labels message state", () => {
    expect(stateLabel("pending", true)).toBe("发送中")
    expect(stateLabel("read", true, 3)).toBe("3 人已读")
    expect(stateLabel("read", false)).toBe("已读")
    expect(stateLabel("failed")).toBe("失败")
  })

  it("formats timestamps", () => {
    expect(formatTs(new Date(2026, 0, 1, 9, 5).getTime() / 1000)).toBe("09:05")
  })
})
