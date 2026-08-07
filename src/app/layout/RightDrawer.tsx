// src/app/layout/RightDrawer.tsx
// 右侧抽屉：tabs-v2 空壳（members/pin/settings）
// brief Step 3 将 RightDrawer 内联在 MainRegion.tsx 中，按文件清单拆为独立文件。
// TabsV2 的 value/onChange 来自 @kobalte/core/tabs，tab 为 string，需 cast 到 DrawerTab。

import type { Component } from "solid-js"
import { useLayout, type DrawerTab } from "../context/layout"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"

const RightDrawer: Component = () => {
  const layout = useLayout()

  return (
    <div class="flex-1 flex flex-col">
      <TabsV2
        value={layout.drawer.tab()}
        onChange={(tab) => layout.drawer.setTab(tab as DrawerTab)}
      >
        <TabsV2.List>
          <TabsV2.Trigger value="members">成员</TabsV2.Trigger>
          <TabsV2.Trigger value="pin">置顶</TabsV2.Trigger>
          <TabsV2.Trigger value="settings">设置</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="members" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          成员列表
        </TabsV2.Content>
        <TabsV2.Content value="pin" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          置顶消息
        </TabsV2.Content>
        <TabsV2.Content value="settings" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          会话设置
        </TabsV2.Content>
      </TabsV2>
    </div>
  )
}

export default RightDrawer
