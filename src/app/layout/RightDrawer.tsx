// src/app/layout/RightDrawer.tsx
// 右侧抽屉：对齐 opencode session-side-panel.tsx 的 V2 面板结构。
//
// 对齐点（opencode SessionSidePanel V2）：
// - contain-strict 性能隔离
// - bg-v2-background-bg-base 内层背景
// - TabsV2 切换视图（opencode 切 review/file-browser/context，peytchat 切 members/pin/settings）

import type { Component } from "solid-js"
import { useLayout, type DrawerTab } from "../context/layout"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"

const RightDrawer: Component = () => {
  const layout = useLayout()

  return (
    <div data-component="right-drawer" class="flex-1 flex flex-col contain-strict">
      <TabsV2
        value={layout.drawer.tab()}
        onChange={(tab) => layout.drawer.setTab(tab as DrawerTab)}
      >
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
