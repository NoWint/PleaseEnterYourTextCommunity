// src/app/pages/home/home-controller.ts
// 照抄 opencode pages/home/home-controller.ts 改造：
// - server → 账户（本地 server context，list/health/current）
// - projects → workspace（workspace context 的 orderedWorkspaces）
// - recentlyClosed → workspace 退出历史（peyt.closedWorkspaces）
// - homedir = ""（无文件系统概念，保留字段）
// - openProjectNewSession → tabs.newDraft({ directory })，navigate /chat/new

import { createEffect, createMemo } from "solid-js"
import { useLayout, type HomeProjectSelection } from "../../context/layout"
import { ServerConnection, useServer } from "../../context/server"
import { useWorkspace } from "../../context/workspace"
import { useTabs } from "../../context/tabs"
import { toggleHomeProjectSelection } from "../../layout/sidebar/helpers"

export function createHomeController() {
  const layout = useLayout()
  const server = useServer()
  const workspace = useWorkspace()
  const tabs = useTabs()
  const selection = layout.home.selection
  const focusedServer = createMemo(
    () => server.list.find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const projects = createMemo(() => workspace.orderedWorkspaces())
  const recentlyClosed = createMemo(() => workspace.recentlyClosed())
  const homedir = () => ""
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(() => selectedProject() ?? projects()[0])

  createEffect(() => {
    const list = server.list
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    layout.projects.open(directory)
    void tabs.newDraft({ directory })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: () => server.list,
      health: (conn: ServerConnection.Any) => server.health[ServerConnection.key(conn)],
      context: () => ({
        projects: {
          list: () => workspace.orderedWorkspaces(),
          move: (worktree: string, index: number) => workspace.move(worktree, index),
        },
      }),
      focused: focusedServer,
      focusedContext: () => ({
        projects: {
          list: () => workspace.orderedWorkspaces(),
          move: (worktree: string, index: number) => workspace.move(worktree, index),
        },
      }),
      focusedSync: () => ({ data: { path: { home: "" } } }),
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer: (conn: ServerConnection.Any) =>
        ServerConnection.key(conn) === ServerConnection.key(focusedServer()) ? projects() : [],
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (server.health[key]?.healthy === false) return
        if (!projects().some((project) => project.worktree === directory)) return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const directory = directories[0]
        if (!directory) return
        layout.projects.open(directory)
        workspace.reopen(directory)
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()
        if (!conn || !project) return
        openProjectNewSession(conn, project.worktree)
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
