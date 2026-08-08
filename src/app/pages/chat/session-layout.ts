// src/app/pages/chat/session-layout.ts
// 照抄 opencode pages/session/session-layout.ts 结构改造：
// - SDK/server-sync 会话上下文 → 本地 chat context（useChat）
// - sessionKey 即会话 id（route /chat/:id）
// - workspaceKey 即当前工作区 key（会话所属 directory，可空）

import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useChat } from "../../context/chat"

export const useSessionKey = () => {
  const params = useParams()
  const chat = useChat()
  const sessionKey = createMemo(() => (params.id ? String(params.id) : undefined))
  const workspaceKey = createMemo(() => {
    const id = sessionKey()
    if (!id) return undefined
    return chat.session(id)?.directory
  })
  return { params, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const chat = useChat()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  return {
    params,
    sessionKey,
    workspaceKey,
    session: (id: string) => chat.session(id),
    chatList: chat.chatList,
  }
}
