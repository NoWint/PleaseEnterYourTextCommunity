// src/app/pages/legacy/BotsPage.tsx
// 机器人页（legacy vanilla 全屏主区，renderBots）
import { renderBots } from "@/pages/botsPage"
import LegacyPageHost from "./LegacyPageHost"

export default function BotsPage() {
  return <LegacyPageHost page="bots" main={(el) => renderBots(el)} />
}
