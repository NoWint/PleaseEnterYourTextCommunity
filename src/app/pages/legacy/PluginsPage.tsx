// src/app/pages/legacy/PluginsPage.tsx
// 插件页（legacy vanilla：nav 市场/已安装切换 + 主区列表，legacy 实现位于 src/plugins/view.ts）
import { renderPluginsNav, renderPluginsMain } from "@/plugins/view"
import LegacyPageHost from "./LegacyPageHost"

export default function PluginsPage() {
  return (
    <LegacyPageHost
      page="plugins"
      nav={(panel) => renderPluginsNav(panel)}
      main={(el) => renderPluginsMain(el)}
    />
  )
}
