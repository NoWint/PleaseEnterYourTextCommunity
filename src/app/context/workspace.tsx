// src/app/context/workspace.tsx
// WorkspaceStore：workspaces + chats（Task 1 假数据）。
// TODO(Task 3): 接入 Tauri 事件（list_workspaces / list_chats）。

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession, AppWorkspace } from "../types"
import { fakeWorkspaces, makeFakeChats } from "../data/fake"

interface WorkspaceStore {
  workspaces: () => AppWorkspace[]
  currentWsId: () => string | null
  setCurrentWs: (id: string | null) => void
  chats: (directory: string) => AppSession[]
  allChats: () => AppSession[]
  refreshWorkspaces: () => Promise<void>
  refreshChats: () => Promise<void>
}

function createWorkspaceStore(): WorkspaceStore {
  const [state, setState] = createStore({
    workspaces: fakeWorkspaces,
    currentWsId: fakeWorkspaces[0]?.id ?? null,
    chats: makeFakeChats(),
  })

  return {
    workspaces: createMemo(() => state.workspaces),
    currentWsId: () => state.currentWsId,
    setCurrentWs: (id) => setState("currentWsId", id),
    chats: (directory: string) =>
      state.chats.filter((chat) => chat.directory === directory && !chat.archived),
    allChats: createMemo(() => state.chats.filter((chat) => !chat.archived)),
    async refreshWorkspaces() {
      // TODO(Task 3): call<WorkspaceDto[]>('list_workspaces')
    },
    async refreshChats() {
      // TODO(Task 3): call<ChannelDto[]>('list_chats', { wsId })
    },
  }
}

export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext<WorkspaceStore, Record<string, any>>({
  name: "Workspace",
  gate: false,
  init: () => createWorkspaceStore(),
})
