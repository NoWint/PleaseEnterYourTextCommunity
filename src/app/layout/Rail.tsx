// src/app/layout/Rail.tsx
// 64px 侧边导航栏：4 图标 + 激活态指示 + 头像
// 借鉴 opencode pages/layout/sidebar-shell.tsx 的 rail 结构（w-16）
//
// 注意：@opencode-ai/ui/v2/icon 不导出 IconName 类型，icon name 类型为
// `keyof typeof icons | (string & {})`，这里用 string 简化。
// brief 中的 message-circle/users/layout-grid 图标在 v2 icon 集合中不存在，
// 已替换为语义最接近的现有图标：outline-dots / workspace / grid-plus。
// settings-gear 保留。

import type { Component } from "solid-js"
import { useNavigate, useLocation } from "@solidjs/router"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"

interface RailItem {
  page: "messages" | "groups" | "work" | "settings"
  icon: string
  label: string
}

const RAIL_ITEMS: RailItem[] = [
  { page: "messages", icon: "outline-dots", label: "消息" },
  { page: "groups", icon: "workspace", label: "群组" },
  { page: "work", icon: "grid-plus", label: "协作" },
  { page: "settings", icon: "settings-gear", label: "设置" },
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
      class="w-16 shrink-0 bg-v2-background-bg-deep flex flex-col items-center overflow-hidden"
    >
      {/* 顶部导航图标 */}
      <div class="flex-1 min-h-0 w-full flex flex-col items-center gap-2 px-2 py-3 overflow-y-auto no-scrollbar">
        {RAIL_ITEMS.map((item) => (
          <IconButtonV2
            variant="ghost-muted"
            size="large"
            icon={<Icon name={item.icon} />}
            state={isActive(item.page) ? "pressed" : undefined}
            aria-pressed={isActive(item.page)}
            aria-label={item.label}
            onClick={() => navigate(`/${item.page}`)}
          />
        ))}
      </div>
      {/* 底部头像 */}
      <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
        <div
          class="w-8 h-8 rounded-full bg-v2-background-bg-layer-01 flex items-center justify-center text-v2-text-text-muted text-xs font-semibold"
          aria-label="用户菜单"
        >
          U
        </div>
      </div>
    </nav>
  )
}

export default Rail
