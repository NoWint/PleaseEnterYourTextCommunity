// src/app/layout/sidebar/project-avatar-state.ts
// 照抄 opencode pages/layout/project-avatar-state.ts 改造：数据源换成本地 chat context。
// unread：未读数 > 0（或需要注意状态）；loading：会话"工作中"。

import { createMemo, type Accessor } from "solid-js"
import { useChat } from "../../context/chat"

export function useSessionTabAvatarState(
  directory: Accessor<string>,
  sessionId: Accessor<string>,
) {
  const chat = useChat()
  const session = createMemo(() => chat.session(sessionId()))
  const unread = createMemo(() => (session()?.unread ?? 0) > 0)
  const loading = createMemo(() => !!session()?.working)
  return { unread, loading }
}
