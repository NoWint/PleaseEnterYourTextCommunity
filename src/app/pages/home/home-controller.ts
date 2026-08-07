// src/app/pages/home/home-controller.ts
// 照抄 opencode pages/home/home-controller.ts 改造：单 server（本地）+ 假数据工作区。

import { createMemo } from "solid-js"
import { useLayout, type HomeProjectSelection } from "../../context/layout"
import { LOCAL_SERVER, ServerConnection } from "../../context/server"
import { useTabs } from "../../context/tabs"
import { toggleHomeProjectSelection } from "../../layout/sidebar/helpers"

export function createHomeController() {
  const layout = useLayout()
  const tabs = useTabs()
  const selection = layout.home.selection
  const focusedServer = createMemo<ServerConnection.Any>(() => LOCAL_SERVER)
  const projects = () => layout.projects.list()
  const recentlyClosed = layout.projects.recentlyClosed
  const homedir = () => ""
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(() => selectedProject() ?? projects()[0])

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function openProjectNewSession(directory: string) {
    void tabs.newDraft({ directory })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: () => [LOCAL_SERVER],
      health: () => ({ healthy: true }),
      context: () => undefined,
      focused: focusedServer,
      focusedContext: () => undefined,
      focusedSync: () => undefined,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer: () => projects(),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (!projects().some((project) => project.worktree === directory)) return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const directory = directories[0]
        if (!directory) return
        layout.projects.open(directory)
        layout.projects.expand(directory)
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: () => {
        const project = newSessionProject()
        if (!project) return
        openProjectNewSession(project.worktree)
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
