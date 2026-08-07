// src/app/layout/MainRegion.tsx
// 主内容区：路由 outlet + Suspense + sidebar/drawer + ResizeHandle
// 借鉴 opencode pages/layout-new.tsx 的 <main> 结构
//
// RightDrawer 拆为独立文件（见 RightDrawer.tsx）。

import type { Component, ParentProps } from "solid-js"
import { Suspense, Show } from "solid-js"
import { useLayout } from "../context/layout"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import RightDrawer from "./RightDrawer"

const MainRegion: Component<ParentProps> = (props) => {
  const layout = useLayout()

  return (
    <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden">
      {/* 频道树空壳（Phase 2+ 填充） */}
      <Show when={!layout.sidebar.collapsed()}>
        <aside
          class="shrink-0 flex flex-col min-h-0 bg-v2-background-bg-base overflow-hidden"
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

      {/* 主内容 */}
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-stretch contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>

      {/* 右侧抽屉 */}
      <Show when={layout.drawer.open()}>
        <ResizeHandle
          direction="horizontal"
          size={layout.drawer.width()}
          min={220}
          max={520}
          onResize={(w) => layout.drawer.resize(w)}
        />
        <aside
          class="shrink-0 flex flex-col min-h-0 bg-v2-background-bg-base overflow-hidden"
          style={{ width: `${layout.drawer.width()}px` }}
        >
          <RightDrawer />
        </aside>
      </Show>
    </div>
  )
}

export default MainRegion
