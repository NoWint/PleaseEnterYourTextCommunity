// src/app/layout/RightDrawer.tsx
// 右侧抽屉占位：自包含状态（layout context 的 drawer API 已在 Task 1 重构中移除，
// 聊天页迁移（Phase 2）时随真实聊天 UI 一起落地）。
// TODO(Task 2): 接入布局持久化（成员/置顶/设置 tab）

import { createSignal, type Component } from "solid-js"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"

export type DrawerTab = "members" | "pin" | "settings"

const RightDrawer: Component = () => {
  const [tab, setTab] = createSignal<DrawerTab>("members")

  return (
    <div data-component="right-drawer" class="flex-1 flex flex-col contain-strict">
      <TabsV2 value={tab()} onChange={(next) => setTab(next as DrawerTab)}>
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
    </div>
  )
}

export default RightDrawer
