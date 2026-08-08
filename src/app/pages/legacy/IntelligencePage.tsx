// src/app/pages/legacy/IntelligencePage.tsx
// 智能中心页（legacy vanilla：nav 标题+刷新 + 主区四 Tab）
import { renderIntelligenceNav, renderIntelligenceMain } from "@/pages/intelligencePage"
import LegacyPageHost from "./LegacyPageHost"

export default function IntelligencePage() {
  return (
    <LegacyPageHost
      page="intelligence"
      nav={(panel) => renderIntelligenceNav(panel)}
      main={(el) => renderIntelligenceMain(el)}
    />
  )
}
