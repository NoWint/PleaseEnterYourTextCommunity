// src/app/pages/WorkPage.tsx
// 协作页：PageShell + 单卡片（对齐 opencode home.tsx 的单卡片模式）。

import type { Component } from "solid-js"
import PageShell, { PanelCard } from "../layout/PageShell"

const WorkPage: Component = () => {
  return (
    <PageShell>
      <PanelCard raised>
        <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          协作（Phase 5 迁移）
        </div>
      </PanelCard>
    </PageShell>
  )
}

export default WorkPage
