// src/app/pages/panel-card.tsx
// 单卡片容器（原 PageShell.tsx 的 PanelCard，PageShell 已随 Rail 删除）。
// 对齐 opencode SessionPanelFrame：rounded-[10px] bg-v2-background-bg-base

import type { Component, ParentProps } from "solid-js"

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

export default PanelCard
