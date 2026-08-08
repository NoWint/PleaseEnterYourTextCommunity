// src/app/layout/RightDrawer.tsx
// 右侧抽屉（聊天页信息面板的壳）：成员/置顶/设置三个 tab。
// 激活 tab 与面板宽度持久化到 localStorage（peyt.rightDrawer.active / peyt.rightDrawer.widths）。
// 聊天页（Phase 2）在 tab 内嵌入真实列表；此处保留可用的持久化框架。

import { createEffect, createSignal, type Component } from "solid-js"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"

export type DrawerTab = "members" | "pin" | "settings"

const ACTIVE_KEY = "peyt.rightDrawer.active"
const WIDTHS_KEY = "peyt.rightDrawer.widths"
const WIDTH_MIN = 240
const WIDTH_MAX = 480

function loadActive(): DrawerTab {
  const raw = localStorage.getItem(ACTIVE_KEY)
  return raw === "members" || raw === "pin" || raw === "settings" ? raw : "members"
}

function loadWidths(): Partial<Record<DrawerTab, number>> {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}")
  } catch {
    return {}
  }
}

const RightDrawer: Component = () => {
  const [tab, setTab] = createSignal<DrawerTab>(loadActive())
  const [widths, setWidths] = createSignal<Partial<Record<DrawerTab, number>>>(loadWidths())
  const width = () => Math.max(WIDTH_MIN, Math.min(widths()[tab()] ?? WIDTH_MIN, WIDTH_MAX))

  createEffect(() => {
    try {
      localStorage.setItem(ACTIVE_KEY, tab())
      const next = { ...widths(), [tab()]: width() }
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(next))
    } catch {
      /* 忽略存储异常 */
    }
  })

  return (
    <div
      data-component="right-drawer"
      class="relative flex flex-col contain-strict min-w-0"
      style={{ width: `${width()}px` }}
    >
      <TabsV2 value={tab()} onChange={(next) => setTab(next as DrawerTab)} class="flex h-full flex-col min-h-0">
        <TabsV2.List>
          <TabsV2.Trigger value="members">成员</TabsV2.Trigger>
          <TabsV2.Trigger value="pin">置顶</TabsV2.Trigger>
          <TabsV2.Trigger value="settings">设置</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content
          value="members"
          class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs bg-v2-background-bg-base"
        >
          成员列表
        </TabsV2.Content>
        <TabsV2.Content
          value="pin"
          class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs bg-v2-background-bg-base"
        >
          置顶消息
        </TabsV2.Content>
        <TabsV2.Content
          value="settings"
          class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs bg-v2-background-bg-base"
        >
          会话设置
        </TabsV2.Content>
      </TabsV2>
      <div class="absolute inset-y-0 start-0 z-30 w-0 overflow-visible">
        <ResizeHandle
          direction="horizontal"
          edge="start"
          size={width()}
          min={WIDTH_MIN}
          max={WIDTH_MAX}
          onResize={(w) => setWidths((prev) => ({ ...prev, [tab()]: w }))}
        />
      </div>
    </div>
  )
}

export default RightDrawer
