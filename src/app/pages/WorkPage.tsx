// src/app/pages/WorkPage.tsx
// 协作/工作区视图占位页（/work 与 /home/:wsId 复用）。

import { Show, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { useChat } from "../context/chat"
import { useLayout } from "../context/layout"
import { base64Decode } from "../utils/base64"
import { PanelCard } from "./panel-card"

const WorkPage: Component = () => {
  const params = useParams()
  const layout = useLayout()
  const chat = useChat()
  // /home/:wsId 中 wsId 是 base64url 编码的工作区 key（AppLayout navigateToProject 编码）
  const wsId = () => (params.wsId ? base64Decode(params.wsId) : undefined)
  const workspace = () => layout.projects.list().find((p) => p.worktree === wsId())
  const chats = () => (wsId() ? chat.chatList().filter((c) => c.directory === wsId()) : [])

  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch p-2">
      <PanelCard raised>
        <div class="flex-1 flex flex-col items-center justify-center gap-2 text-v2-text-text-faint text-xs">
          <Show when={workspace()} fallback={<span>协作（Phase 5 迁移）</span>}>
            {(ws) => (
              <>
                <span>工作区：{ws().name ?? ws().worktree}</span>
                <span>会话数：{chats().length}</span>
              </>
            )}
          </Show>
        </div>
      </PanelCard>
    </div>
  )
}

export default WorkPage
