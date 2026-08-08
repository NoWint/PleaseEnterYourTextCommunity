// src/app/pages/legacy/InboxPage.tsx
// 通知页（legacy vanilla 全屏主区，renderInboxMain）
import { renderInboxMain } from "@/pages/inboxPage"
import LegacyPageHost from "./LegacyPageHost"

export default function InboxPage() {
  return <LegacyPageHost page="inbox" main={(el) => renderInboxMain(el)} />
}
