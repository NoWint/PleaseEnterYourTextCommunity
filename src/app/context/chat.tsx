// src/app/context/chat.tsx
// ChatStore：currentChatId/chatMeta/unread
// Phase 1 空骨架，Phase 3+ 接入 deltachat 事件

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

interface ChatMeta {
  id: number
  name: string
  isGroup: boolean
  memberCount: number
}

interface ChatStore {
  currentChatId: () => number | null
  setCurrentChat: (id: number | null) => void
  chatMeta: () => ChatMeta | null
  unread: () => number
}

function createChatStore(): ChatStore {
  const [currentChatId, setCurrentChatId] = createSignal<number | null>(null)
  const [chatMeta, setChatMeta] = createSignal<ChatMeta | null>(null)
  const [unread, setUnread] = createSignal(0)

  return {
    currentChatId,
    setCurrentChat: (id) => {
      setCurrentChatId(id)
      if (id === null) setChatMeta(null)
    },
    chatMeta,
    unread,
  }
}

const ChatContext = createContext<ChatStore>()

export function ChatProvider(props: ParentProps) {
  const store = createChatStore()
  return <ChatContext.Provider value={store}>{props.children}</ChatContext.Provider>
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error("useChat must be used within ChatProvider")
  return ctx
}
