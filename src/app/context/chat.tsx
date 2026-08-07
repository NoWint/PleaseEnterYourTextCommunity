// src/app/context/chat.tsx
// ChatStore：聊天会话数据源（Task 1 假数据）+ 会话级操作。
// TODO(Task 3): 接入 deltachat/tauri 事件。

import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession } from "../types"
import { makeFakeChats } from "../data/fake"

interface ChatStore {
  currentChatId: () => string | null
  setCurrentChat: (id: string | null) => void
  session: (id: string) => AppSession | undefined
  chatList: () => AppSession[]
  unreadFor: (id: string) => number
  rename: (id: string, title: string) => void
  archive: (id: string) => void
  markRead: (id: string) => void
  touch: (id: string) => void
}

function createChatStore(): ChatStore {
  const [state, setState] = createStore({
    currentChatId: null as string | null,
    sessions: makeFakeChats(),
  })

  const byId = createMemo(() => {
    const map = new Map<string, AppSession>()
    for (const session of state.sessions) map.set(session.id, session)
    return map
  })

  return {
    currentChatId: () => state.currentChatId,
    setCurrentChat: (id) => setState("currentChatId", id),
    session: (id: string) => byId().get(id),
    chatList: createMemo(() =>
      state.sessions
        .filter((chat) => !chat.archived)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
    ),
    unreadFor: (id: string) => byId().get(id)?.unread ?? 0,
    rename(id: string, title: string) {
      setState("sessions", (s) =>
        s.map((item) => (item.id === id ? { ...item, title } : item)),
      )
    },
    archive(id: string) {
      setState("sessions", (s) =>
        s.map((item) => (item.id === id ? { ...item, archived: true } : item)),
      )
    },
    markRead(id: string) {
      setState("sessions", (s) =>
        s.map((item) => (item.id === id ? { ...item, unread: 0 } : item)),
      )
    },
    touch(id: string) {
      setState("sessions", (s) =>
        s.map((item) =>
          item.id === id ? { ...item, time: { ...item.time, updated: Date.now() } } : item,
        ),
      )
    },
  }
}

export const { use: useChat, provider: ChatProvider } = createSimpleContext<ChatStore, Record<string, any>>({
  name: "Chat",
  gate: false,
  init: () => createChatStore(),
})
