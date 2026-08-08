// src/app/pages/work/work-smoke.test.tsx
// 结构冒烟测试（Task 4）：4 个视图组件 + 可视化组件 + 词频派生逻辑
// 可在 jsdom 中挂载并渲染（浏览器自动化不可用时的结构验证替代）。

import { describe, expect, it } from "vitest"
import { render } from "@solidjs/testing-library"
import { KanbanView } from "./views/KanbanView"
import { ListView } from "./views/ListView"
import { CalendarView } from "./views/CalendarView"
import { TimelineView } from "./views/TimelineView"
import { ActivityFeed } from "./views/ActivityFeed"
import { CloudSphere } from "../../components/visuals/CloudSphere"
import { WordCloud } from "../../components/visuals/WordCloud"
import { SummaryBubble } from "../../components/visuals/SummaryBubble"
import { deriveWorkWords, dateKey, formatRelativeTs, isOverdue } from "./work-types"
import type { CardDto } from "../../../types"

const now = Math.floor(Date.now() / 1000)

function card(overrides: Partial<CardDto> = {}): CardDto {
  return {
    id: 1,
    workspace_id: 1,
    channel_chat_id: 100,
    msg_id: null,
    type: "task",
    title: "测试卡片",
    description: null,
    status: "todo",
    assignee_contact_id: null,
    assignee_name: "小明",
    due_date: now + 86400,
    created_at: now,
    ...overrides,
  }
}

const CARDS: CardDto[] = [
  card({ id: 1, title: "待办卡片", status: "todo" }),
  card({ id: 2, title: "进行中卡片", status: "in_progress", due_date: now - 3600 }),
  card({ id: 3, title: "已完成卡片", status: "done", due_date: null }),
]

describe("work views render", () => {
  it("KanbanView 渲染三列与卡片", () => {
    const { container } = render(() => (
      <KanbanView
        cards={CARDS}
        loading={false}
        onCreateCard={() => Promise.resolve()}
        onUpdateStatus={() => Promise.resolve()}
        onOpenCard={() => {}}
      />
    ))
    expect(container.textContent).toContain("Todo")
    expect(container.textContent).toContain("Doing")
    expect(container.textContent).toContain("Done")
    expect(container.textContent).toContain("待办卡片")
    expect(container.textContent).toContain("添加卡片")
  })

  it("ListView 渲染表格与排序表头", () => {
    const { container } = render(() => <ListView cards={CARDS} loading={false} onOpenCard={() => {}} />)
    expect(container.textContent).toContain("标题")
    expect(container.textContent).toContain("状态")
    expect(container.textContent).toContain("待办卡片")
  })

  it("CalendarView 渲染月份网格与未排期", () => {
    const { container } = render(() => <CalendarView cards={CARDS} loading={false} onOpenCard={() => {}} />)
    expect(container.textContent).toContain("年")
    expect(container.textContent).toContain("月")
    expect(container.textContent).toContain("未排期")
    expect(container.textContent).toContain("今天")
  })

  it("TimelineView 渲染时间分组", () => {
    const { container } = render(() => <TimelineView cards={CARDS} loading={false} onOpenCard={() => {}} />)
    expect(container.textContent).toContain("今天")
    expect(container.textContent).toContain("未指派")
  })

  it("ActivityFeed 渲染活动条目", () => {
    const { container } = render(() => (
      <ActivityFeed
        activities={[
          {
            id: 1,
            workspace_id: 1,
            channel_chat_id: 100,
            actor_id: 1,
            actor_name: "小明",
            action: "card_created",
            target_type: "card",
            target_id: 1,
            payload: JSON.stringify({ title: "待办卡片" }),
            created_at: now,
          },
        ]}
        cards={CARDS}
        channelNames={{ 100: "需求评审" }}
        loading={false}
        onOpenCard={() => {}}
      />
    ))
    expect(container.textContent).toContain("小明")
    expect(container.textContent).toContain("创建了卡片")
    expect(container.textContent).toContain("刚刚")
  })
})

describe("visuals render", () => {
  it("CloudSphere 挂载 canvas", () => {
    const { container } = render(() => (
      <CloudSphere
        words={[
          { word: "看板", count: 3, weight: 1 },
          { word: "卡片", count: 2, weight: 0.8 },
          { word: "协作", count: 1, weight: 0.6 },
        ]}
      />
    ))
    expect(container.querySelector("canvas")).not.toBeNull()
  })

  it("WordCloud 挂载 canvas", () => {
    const { container } = render(() => (
      <WordCloud
        words={[
          { word: "看板", count: 3, weight: 1 },
          { word: "卡片", count: 2, weight: 0.8 },
        ]}
      />
    ))
    expect(container.querySelector("canvas")).not.toBeNull()
  })

  it("SummaryBubble 渲染状态文本", () => {
    const { container } = render(() => <SummaryBubble status="done" text="共 3 个卡片" clusters={[]} />)
    expect(container.textContent).toContain("共 3 个卡片")
  })
})

describe("work-types helpers", () => {
  it("deriveWorkWords 提取中文词频", () => {
    const words = deriveWorkWords(
      [card({ title: "首页改版需求收集" }), card({ title: "首页改版排期" })],
      ["需求评审"],
      ["首页改版讨论"],
    )
    expect(words.length).toBeGreaterThan(0)
    expect(words[0].word).toBe("首页改版")
  })

  it("dateKey / formatRelativeTs / isOverdue", () => {
    expect(dateKey(new Date(2026, 7, 8))).toBe("2026-08-08")
    expect(formatRelativeTs(now - 30)).toBe("刚刚")
    expect(formatRelativeTs(now - 600)).toBe("10 分钟前")
    expect(isOverdue(card({ status: "todo", due_date: now - 3600 }))).toBe(true)
    expect(isOverdue(card({ status: "done", due_date: now - 3600 }))).toBe(false)
  })
})
