// src/app/pages/GroupsPage.tsx
// 群组页：PageShell + 两栏卡片化（群组列表 + 群组详情）。
//
// 对齐 opencode session.tsx 的多卡片布局模式：
// - PageShell 提供 Rail + p-2 容器
// - 内部 flex gap-2 容器（对齐 panelRow）
// - 群组列表（固定宽度卡片）+ 群组详情（raised 主卡片）

import type { Component } from "solid-js"
import PageShell, { PanelCard } from "../layout/PageShell"

const GroupsPage: Component = () => {
  return (
    <PageShell>
      {/* 对齐 opencode session.tsx panelRow：flex-1 min-h-0 flex flex-row gap-2 */}
      <div class="flex flex-1 min-h-0 gap-2">
        {/* 群组列表面板（固定宽度卡片） */}
        <div class="shrink-0 flex flex-col min-h-0 w-[260px]">
          <PanelCard>
            <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
              群组列表
            </div>
          </PanelCard>
        </div>

        {/* 群组详情面板（raised 主卡片） */}
        <PanelCard raised>
          <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
            群组（Phase 4 迁移）
          </div>
        </PanelCard>
      </div>
    </PageShell>
  )
}

export default GroupsPage
