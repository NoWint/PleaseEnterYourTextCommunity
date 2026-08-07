// src/app/layout/PageShell.tsx
// Page 级布局壳：封装 Rail + 卡片化内容容器。
//
// 严格对齐 opencode 的 page 自治模式：
// - layout-new.tsx 顶层壳只有 Titlebar + main + ToastRegion（不硬编码 Rail）
// - 每个 Page 自己决定布局（home.tsx 单卡片 / session.tsx 多卡片）
// - peytchat 的 4 页都需要 Rail（IM 核心导航约束），故 PageShell 封装 Rail
//
// 对齐点：
// - opencode session.tsx SessionRouteFrame（L329-L335）：
//   `relative size-full overflow-hidden flex flex-col p-2`
// - opencode session.tsx SessionPanelFrame（L337-L351）：
//   `flex-1 min-h-0 flex flex-col bg-v2-background-bg-base rounded-[10px] overflow-hidden`
//   + raised 时 `shadow-[var(--v2-elevation-raised)]`
// - opencode home.tsx（L18-L22）：
//   `m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]`

import type { Component, ParentProps } from "solid-js"
import Rail from "./Rail"

// PageShell：Rail + 外层 p-2 容器（对齐 opencode SessionRouteFrame）
// 每个 Page 在 PageShell 内部自己组合 PanelCard（单卡片或多卡片）
const PageShell: Component<ParentProps> = (props) => {
  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch">
      <Rail />
      {/* 对齐 opencode session.tsx SessionRouteFrame：relative size-full overflow-hidden flex flex-col p-2 */}
      <div class="flex-1 min-h-0 min-w-0 relative overflow-hidden flex flex-col p-2">
        {props.children}
      </div>
    </div>
  )
}

// PanelCard：单卡片容器（对齐 opencode SessionPanelFrame）
// raised=true 时添加阴影（主内容区用），辅助面板可省略
export const PanelCard: Component<ParentProps & { raised?: boolean }> = (props) => {
  return (
    <div
      class="flex-1 min-h-0 min-w-0 flex flex-col bg-v2-background-bg-base rounded-[10px] overflow-hidden"
      classList={{ "shadow-[var(--v2-elevation-raised)]": props.raised }}
    >
      {props.children}
    </div>
  )
}

export default PageShell
