// src/app/pages/MessagesPage.tsx
// 消息页：PageShell + 三栏卡片化（channel-tree + chat + drawer）。
//
// 严格对齐 opencode session.tsx 的多卡片布局模式：
// - SessionRouteFrame (p-2) → PageShell 提供 Rail + p-2 容器
// - panelRow (gap-2 p-2) → 内部 flex gap-2 容器
// - SessionPanelFrame (rounded-[10px] bg-v2-background-bg-base) → PanelCard
// - ResizeHandle 真实 API：direction/size/min/max/onResize
//
// IM 三栏（spec 约束）：
// - channel-tree (220px，可折叠，可调宽 180-460)
// - chat-main (flex-1，raised 主卡片)
// - right-drawer (200px，可折叠，可调宽 220-520)

import type { Component } from "solid-js"
import { Show } from "solid-js"
import { useLayout } from "../context/layout"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import PageShell, { PanelCard } from "../layout/PageShell"
import RightDrawer from "../layout/RightDrawer"

// opencode 面板过渡动画常量（session.tsx L2260-L2261）
const PANEL_TRANSITION = "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none"

const MessagesPage: Component = () => {
  const layout = useLayout()

  return (
    <PageShell>
      {/* 对齐 opencode session.tsx panelRow：flex-1 min-h-0 flex flex-row gap-2 */}
      <div class="flex flex-1 min-h-0 gap-2">
        {/* 频道树面板（卡片化，可折叠/调宽） */}
        <Show when={!layout.sidebar.collapsed()}>
          <div
            class={`shrink-0 flex flex-col min-h-0 ${PANEL_TRANSITION}`}
            style={{ width: `${layout.sidebar.width()}px` }}
          >
            <PanelCard>
              <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
                频道树
              </div>
            </PanelCard>
          </div>
          <ResizeHandle
            direction="horizontal"
            size={layout.sidebar.width()}
            min={180}
            max={460}
            onResize={(w) => layout.sidebar.resize(w)}
          />
        </Show>

        {/* 聊天主面板（raised 主卡片，对齐 opencode SessionPanelFrame raised） */}
        <PanelCard raised>
          <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
            消息（Phase 2 迁移）
          </div>
        </PanelCard>

        {/* 右侧抽屉面板（卡片化，可折叠/调宽） */}
        <Show when={layout.drawer.open()}>
          <ResizeHandle
            direction="horizontal"
            size={layout.drawer.width()}
            min={220}
            max={520}
            onResize={(w) => layout.drawer.resize(w)}
          />
          <div
            class={`shrink-0 flex flex-col min-h-0 ${PANEL_TRANSITION}`}
            style={{ width: `${layout.drawer.width()}px` }}
          >
            <PanelCard>
              <RightDrawer />
            </PanelCard>
          </div>
        </Show>
      </div>
    </PageShell>
  )
}

export default MessagesPage
