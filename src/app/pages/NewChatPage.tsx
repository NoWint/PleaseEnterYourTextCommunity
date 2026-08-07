// src/app/pages/NewChatPage.tsx
// 新会话占位页（/chat/new）。聊天 UI 在 Phase 2 迁移。

import type { Component } from "solid-js"
import { PanelCard } from "./panel-card"

const NewChatPage: Component = () => {
  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch p-2">
      <PanelCard raised>
        <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          新会话（Phase 2 迁移）
        </div>
      </PanelCard>
    </div>
  )
}

export default NewChatPage
