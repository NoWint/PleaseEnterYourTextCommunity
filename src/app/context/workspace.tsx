// src/app/context/workspace.tsx
// WorkspaceStore：workspaces 数据（Task 3 接 list_workspaces invoke）。
// - refreshWorkspaces：list_workspaces → AppWorkspace[]，并同步进 layout.projects
//   （sidebar/home 的项目列表来自 layout context；open/rename 是其公开 API）
// - 拉取失败时保留 Task 1 假数据（fakeWorkspaces）

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession, AppWorkspace } from "../types"
import { fakeWorkspaces } from "../data/fake"
import { call } from "../../api"
import type { WorkspaceDto } from "@/types"
import { useLayout } from "./layout"

interface WorkspaceStore {
  workspaces: () => AppWorkspace[]
  loading: () => boolean
  currentWsId: () => string | null
  setCurrentWs: (id: string | null) => void
  chats: (directory: string) => AppSession[]
  allChats: () => AppSession[]
  refreshWorkspaces: () => Promise<void>
}

const WORKSPACE_COLORS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

function createWorkspaceStore(): WorkspaceStore {
  const layout = useLayout()
  const [state, setState] = createStore({
    workspaces: fakeWorkspaces,
    currentWsId: fakeWorkspaces[0]?.id ?? null,
    loading: false,
  })

  async function refreshWorkspaces(): Promise<void> {
    setState("loading", true)
    try {
      const list = await call<WorkspaceDto[]>("list_workspaces")
      const workspaces: AppWorkspace[] = list.map((ws, index) => ({
        id: String(ws.id),
        name: ws.name || `工作区 ${ws.id}`,
        worktree: `ws-${ws.id}`,
        expanded: false,
        icon: { color: WORKSPACE_COLORS[index % WORKSPACE_COLORS.length] },
        vcs: "git",
        sandboxes: [],
      }))
      // 同步进 layout.projects（open 去重追加 + rename 更新名称）
      for (const ws of workspaces) {
        layout.projects.open(ws.worktree)
        layout.projects.rename(ws.worktree, ws.name ?? "")
      }
      setState("workspaces", workspaces)
      if (!state.currentWsId && workspaces[0]?.id) setState("currentWsId", workspaces[0].id)
    } catch {
      // invoke 不可用（浏览器 dev）→ 保留假数据
    } finally {
      setState("loading", false)
    }
  }

  // 初始化拉取
  void refreshWorkspaces()

  return {
    workspaces: createMemo(() => state.workspaces),
    loading: () => state.loading,
    currentWsId: () => state.currentWsId,
    setCurrentWs: (id) => setState("currentWsId", id),
    chats: (directory: string) => [],
    allChats: () => [],
    refreshWorkspaces,
  }
}

export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext<WorkspaceStore, Record<string, any>>({
  name: "Workspace",
  gate: false,
  init: () => createWorkspaceStore(),
})
