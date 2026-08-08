// src/app/pages/legacy/DebugPage.tsx
// 调试页（legacy vanilla：nav 路由/自检/工作区 + 主区消息流）
import { renderDebugNav, renderDebugMain } from "@/pages/debugPage"
import LegacyPageHost from "./LegacyPageHost"

export default function DebugPage() {
  return (
    <LegacyPageHost
      page="debug"
      nav={(panel) => renderDebugNav(panel)}
      main={(el) => renderDebugMain(el)}
    />
  )
}
