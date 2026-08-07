// src/app/context/workspace.tsx
// WorkspaceStore：workspaces/channels/currentWsId
// Phase 1 空骨架，Phase 3+ 接入 Tauri 事件

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"
import type { WorkspaceDto, ChannelDto } from "../../types"

interface WorkspaceStore {
  workspaces: () => WorkspaceDto[]
  currentWsId: () => number | null
  setCurrentWs: (id: number | null) => void
  channels: () => ChannelDto[]
  refreshWorkspaces: () => Promise<void>
  refreshChannels: () => Promise<void>
}

function createWorkspaceStore(): WorkspaceStore {
  const [workspaces, setWorkspaces] = createSignal<WorkspaceDto[]>([])
  const [currentWsId, setCurrentWsId] = createSignal<number | null>(null)
  const [channels, setChannels] = createSignal<ChannelDto[]>([])

  return {
    workspaces,
    currentWsId,
    setCurrentWs: (id) => setCurrentWsId(id),
    channels,
    async refreshWorkspaces() {
      // Phase 3+ 实现：call<WorkspaceDto[]>('list_workspaces')
    },
    async refreshChannels() {
      // Phase 3+ 实现：call<ChannelDto[]>('list_channels', { wsId })
    },
  }
}

const WorkspaceContext = createContext<WorkspaceStore>()

export function WorkspaceProvider(props: ParentProps) {
  const store = createWorkspaceStore()
  return <WorkspaceContext.Provider value={store}>{props.children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceStore {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
