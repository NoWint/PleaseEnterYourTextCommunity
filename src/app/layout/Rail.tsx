// src/app/layout/Rail.tsx
// 64px 侧边导航栏：对齐 opencode pages/layout/sidebar-shell.tsx 的 SidebarContent 结构。
//
// 对齐点（opencode sidebar-shell.tsx）：
// - <div data-component="sidebar-rail"> + w-16 shrink-0 + flex flex-col items-center overflow-hidden
// - 顶部滚动区：flex-1 min-h-0 w-full + overflow-y-auto no-scrollbar + gap-3 px-3 py-3
// - 底部固定区：shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2
// - 底部放 settings/help IconButton（对齐 opencode）
//
// IM 适配（vs opencode）：
// - opencode Rail 内是 projects 列表（SortableProvider + 拖拽），peytchat 是 4 页导航图标
// - 背景用 bg-v2-background-bg-deep（与 titlebar 一致，V2 深背景）
// - 图标用 v2 IconButtonV2（opencode legacy 用 v1 IconButton，V2 已废弃全局 Rail）

import type { Component } from "solid-js"
import { For } from "solid-js"
import { useNavigate, useLocation } from "@solidjs/router"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"

interface RailItem {
  page: "messages" | "groups" | "work" | "settings"
  icon: string
  label: string
}

// 对齐 opencode V2 titlebar 的 grid-plus/home 图标语义；
// v2 icon 集合无 message-circle/users/layout-grid，用最接近的现有图标。
const RAIL_ITEMS: RailItem[] = [
  { page: "messages", icon: "outline-dots", label: "消息" },
  { page: "groups", icon: "workspace", label: "群组" },
  { page: "work", icon: "grid-plus", label: "协作" },
]

const Rail: Component = () => {
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = (page: string) => {
    const current = location.pathname.replace(/^\//, "") || "messages"
    return current === page
  }

  return (
    <nav
      data-component="sidebar-rail"
      class="w-16 shrink-0 bg-v2-background-bg-deep flex flex-col items-center overflow-hidden select-none"
    >
      {/* 顶部导航图标区（对齐 opencode flex-1 min-h-0 w-full + gap-3 px-3 py-3） */}
      <div class="flex-1 min-h-0 w-full">
        <div class="h-full w-full flex flex-col items-center gap-3 px-3 py-3 overflow-y-auto no-scrollbar">
          <For each={RAIL_ITEMS}>
            {(item) => (
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                class="!w-9 shrink-0"
                icon={<Icon name={item.icon} />}
                state={isActive(item.page) ? "pressed" : undefined}
                aria-label={item.label}
                aria-pressed={isActive(item.page)}
                onClick={() => navigate(`/${item.page}`)}
              />
            )}
          </For>
        </div>
      </div>

      {/* 底部固定区（对齐 opencode shrink-0 w-full pt-3 pb-6 gap-2） */}
      <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="large"
          class="!w-9 shrink-0"
          icon={<Icon name="settings-gear" />}
          state={isActive("settings") ? "pressed" : undefined}
          aria-label="设置"
          aria-pressed={isActive("settings")}
          onClick={() => navigate("/settings")}
        />
        {/* 用户头像占位（Phase 2+ 接入 profile） */}
        <div
          class="w-8 h-8 rounded-full bg-v2-background-bg-layer-01 flex items-center justify-center
                 text-v2-text-text-muted text-xs font-[440]"
          aria-label="用户菜单"
        >
          U
        </div>
      </div>
    </nav>
  )
}

export default Rail
