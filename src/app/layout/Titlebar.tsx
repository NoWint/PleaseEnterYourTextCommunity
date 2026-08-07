// src/app/layout/Titlebar.tsx
// 标题栏：对齐 opencode components/titlebar.tsx 的 V2 结构。
//
// 对齐点（opencode titlebar.tsx V2 分支）：
// - <header data-slot="titlebar-v2"> + shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible
// - data-tauri-drag-region 启用拖拽
// - macOS 给红绿灯让位：padding-left 84px（macTrafficLightsBaseWidth）
// - 内部容器：h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3 md:pl-4 pt-2
// - 左侧品牌 + 中间 flex-1 占位 + 右侧操作 IconButton
//
// IM 简化（裁剪 AI 专有）：
// - 不做 TitlebarTabStrip（IM 无多 session tab，保留中间 flex-1 扩展点供后续页面 Portal 注入搜索）
// - 不做 ChannelIndicator / WindowsAppMenu / TitlebarV2Right（AI 更新提示）
// - 右侧：通知 IconButtonV2（设置按钮在 rail 底部，对齐 opencode 模式）

import type { Component } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"

// macOS 红绿灯基础宽度（对齐 opencode macTrafficLightsBaseWidth）
const MAC_TRAFFIC_LIGHTS_WIDTH = 84

const Titlebar: Component = () => {
  // macOS 检测（Tauri 运行时；浏览器 dev 为 false）
  const isMac = () => {
    if (typeof window === "undefined") return false
    // @ts-expect-error - Tauri 运行时注入的全局，类型未声明
    return window.__TAURI_INTERNALS__ !== undefined && navigator.platform.toLowerCase().includes("mac")
  }

  return (
    <header
      data-slot="titlebar-v2"
      class="shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible select-none"
      style={{
        "padding-left": isMac() ? `${MAC_TRAFFIC_LIGHTS_WIDTH}px` : "0px",
      }}
      data-tauri-drag-region
    >
      {/* 内部容器：对齐 opencode V2 titlebar 内部 div 结构 */}
      <div
        class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3 md:pl-4 pt-2
               [app-region:no-drag]"
      >
        {/* 左侧：品牌字（对齐 opencode WordmarkV2，简化为文字） */}
        <span class="text-v2-text-text-base text-[13px] font-[440] shrink-0" data-slot="titlebar-brand">
          PEYT Chat
        </span>

        {/* 中间：flex-1 占位（后续页面可 Portal 注入搜索/会话名） */}
        <div class="flex-1 min-w-0" data-slot="titlebar-center" />

        {/* 右侧：通知 IconButtonV2（设置按钮在 rail 底部，避免重复） */}
        <div class="flex flex-row items-center gap-1 shrink-0">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            icon={<Icon name="notification" />}
            aria-label="通知"
          />
        </div>
      </div>
    </header>
  )
}

export default Titlebar
