// src/app/pages/SettingsPage.tsx
// 设置页：PageShell + 单卡片（对齐 opencode home.tsx 的单卡片模式）。
//
// 对齐 opencode home.tsx L18-L22：
// - m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow
// - 通过 PageShell 提供 Rail + p-2，PanelCard raised 提供卡片化

import type { Component } from "solid-js"
import PageShell, { PanelCard } from "../layout/PageShell"

const SettingsPage: Component = () => {
  return (
    <PageShell>
      {/* 对齐 opencode home.tsx 单卡片：flex-1 + raised */}
      <PanelCard raised>
        <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          设置（Phase 2 迁移）
        </div>
      </PanelCard>
    </PageShell>
  )
}

export default SettingsPage
