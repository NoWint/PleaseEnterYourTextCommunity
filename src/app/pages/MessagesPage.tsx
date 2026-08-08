// src/app/pages/MessagesPage.tsx
// /chat/:id 路由页：Task 3 复刻的 opencode 会话页（timeline + composer + side panel）。
// 打开会话即加入 tab strip（与 titlebar 行为一致），其余渲染委托 ChatPage。

import { createEffect, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { useChat } from "../context/chat"
import { isTabRecentlyRemoved, tabKey, useTabs } from "../context/tabs"
import { ChatPage } from "./chat/session-page"

const MessagesPage: Component = () => {
  const params = useParams()
  const chat = useChat()
  const tabs = useTabs()

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
    const session = chat.session(id)
    if (session) tabs.rememberSessionInfo(tab, session)
  })

  return <ChatPage />
}

export default MessagesPage
