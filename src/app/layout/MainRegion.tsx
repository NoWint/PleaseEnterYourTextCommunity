// src/app/layout/MainRegion.tsx
// 主内容区：对齐 opencode session.tsx 的 V2 面板卡片化质感。
//
// 对齐点（opencode session.tsx V2 + SessionPanelFrame）：
// - 面板间距 gap-2 p-2（V2 卡片化留白）
// - 每个面板卡片化：rounded-[10px] overflow-hidden bg-v2-background-bg-base
// - 主面板 raised：shadow-[var(--v2-elevation-raised)]
// - ResizeHandle：direction/size/min/max/onResize 真实 API
// - 过渡动画：duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width]
//
// IM 业务结构（spec 约束）：
// - channel-tree (220px) + chat-main (flex) + right-drawer (200px)
// - channel-tree 可折叠（layout.sidebar.collapsed）
// - right-drawer 可折叠（layout.drawer.open）

import type { Component, ParentProps } from "solid-js"
import { Show } from "solid-js"
import { useLayout } from "../context/layout"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import RightDrawer from "./RightDrawer"

// opencode 面板过渡动画常量
const PANEL_TRANSITION = "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none"

const MainRegion: Component<ParentProps> = (props) => {
  const layout = useLayout()

  return (
    <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden gap-2 p-2">
      {/* 频道树面板（卡片化） */}
      <Show when={!layout.sidebar.collapsed()}>
        <aside
          class={`shrink-0 flex flex-col min-h-0 overflow-hidden bg-v2-background-bg-base rounded-[10px]
                  ${PANEL_TRANSITION}`}
          style={{ width: `${layout.sidebar.width()}px` }}
        >
          <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
            频道树
          </div>
        </aside>
        <ResizeHandle
          direction="horizontal"
          size={layout.sidebar.width()}
          min={180}
          max={460}
          onResize={(w) => layout.sidebar.resize(w)}
        />
      </Show>

      {/* 主内容面板（raised 卡片化，对齐 opencode SessionPanelFrame raised） */}
      <main
        class="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col items-stretch
               bg-v2-background-bg-base rounded-[10px]"
        style={{ "box-shadow": "var(--v2-elevation-raised)" }}
      >
        {props.children}
      </main>

      {/* 右侧抽屉面板（卡片化） */}
      <Show when={layout.drawer.open()}>
        <ResizeHandle
          direction="horizontal"
          size={layout.drawer.width()}
          min={220}
          max={520}
          onResize={(w) => layout.drawer.resize(w)}
        />
        <aside
          class={`shrink-0 flex flex-col min-h-0 overflow-hidden bg-v2-background-bg-base rounded-[10px]
                  ${PANEL_TRANSITION}`}
          style={{ width: `${layout.drawer.width()}px` }}
        >
          <RightDrawer />
        </aside>
      </Show>
    </div>
  )
}

export default MainRegion
