// src/app/layout/Titlebar.tsx
// 标题栏：data-tauri-drag-region + 窗口标题
// 借鉴 opencode components/titlebar.tsx 的 V2 模式

import type { Component } from "solid-js"

const Titlebar: Component = () => {
  return (
    <header
      data-tauri-drag-region
      class="shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible select-none"
      style={{
        // macOS 给红绿灯让位
        "padding-left": "env(titlebar-area-x, 0px)",
      }}
    >
      <div class="h-full flex-1 overflow-hidden flex flex-row items-center gap-2 px-3">
        <span class="text-v2-text-text-base text-[13px] font-semibold">PEYT Chat</span>
      </div>
    </header>
  )
}

export default Titlebar
