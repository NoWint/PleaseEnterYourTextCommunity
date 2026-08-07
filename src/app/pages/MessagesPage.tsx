// src/app/pages/MessagesPage.tsx
// 聊天页占位：显示会话标题（来自 chat context 假数据），聊天 UI 在 Phase 2 迁移。

import { createEffect, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { useChat } from "../context/chat"
import { isTabRecentlyRemoved, tabKey, useTabs } from "../context/tabs"
import { PanelCard } from "./panel-card"

const MessagesPage: Component = () => {
  const params = useParams()
  const chat = useChat()
  const tabs = useTabs()
  const session = () => chat.session(params.id)

  // 打开会话即加入 tab strip（与 titlebar 行为一致）
  createEffect(() => {
    const id = params.id
    if (!id) return
    const existing = tabs.store.find((t) => t.type === "session" && t.chatId === id)
    if (existing) {
      tabs.remember(existing)
      return
    }
    // 与 titlebar auto-add 相同的竞态保护：关闭标签页时本 effect 会同步重跑，
    // 若不加保护会把刚关闭的 tab 又加回来。
    if (isTabRecentlyRemoved(tabKey({ type: "session", chatId: id }))) return
    const tab = tabs.addSessionTab({ chatId: id })
    tabs.remember(tab)
  })

  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch p-2">
      <PanelCard raised>
        <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          {session() ? `聊天：${session()?.title}` : "消息（Phase 2 迁移）"}
        </div>
      </PanelCard>
    </div>
  )
}

export default MessagesPage
