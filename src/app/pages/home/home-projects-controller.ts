// src/app/pages/home/home-projects-controller.ts
// 照抄 opencode pages/home/home-projects-controller.tsx 改造：
// - 多 server 管理删除（单本地 server）
// - 目录选择/编辑/显示对话框 → TODO 占位（Task 3 接 Tauri 对话框）

import { useNavigate } from "@solidjs/router"
import { useLanguage } from "../../context/language"
import { useChat } from "../../context/chat"
import { useLayout, type LocalProject } from "../../context/layout"
import type { ServerConnection } from "../../context/server"
import type { HomeController } from "./home-controller"

export function createHomeProjectsController(home: HomeController) {
  const navigate = useNavigate()
  const language = useLanguage()
  const chat = useChat()
  const layout = useLayout()

  function directories(project: LocalProject) {
    return [project.worktree, ...(project.sandboxes ?? [])]
  }

  return {
    copy: {
      language,
    },
    selection: {
      value: home.selection.value,
    },
    server: {
      list: home.server.list,
      health: home.server.health,
      projects: home.project.forServer,
      collapsed: () => false,
      toggleCollapsed: () => {},
      canDefault: () => false,
      defaultKey: () => null,
      setDefault: () => {},
      remove: () => {},
      edit: () => {},
      focus: home.selection.focusServer,
    },
    project: {
      list: home.project.list,
      recentlyClosed: home.project.recentlyClosed,
      homedir: home.project.homedir,
      select: home.project.select,
      add: home.project.add,
      openNewSession: (_conn: ServerConnection.Any, directory: string) =>
        home.project.openProjectNewSession(directory),
      // TODO(Task 3): 工作区编辑对话框（@opencode-ai/ui v2 dialog）
      edit: () => {},
      unseenCount: (project: LocalProject) =>
        directories(project).reduce(
          (total, directory) =>
            total +
            chat
              .chatList()
              .filter((item) => item.directory === directory)
              .reduce((sum, item) => sum + item.unread, 0),
          0,
        ),
      clearNotifications: (_conn: ServerConnection.Any, project: LocalProject) => {
        directories(project).forEach((directory) =>
          chat
            .chatList()
            .filter((item) => item.directory === directory && item.unread > 0)
            .forEach((item) => chat.markRead(item.id)),
        )
      },
      // TODO(Task 3): 工作区目录选择（Tauri 目录选择器）
      choose: () => {},
      close: (_conn: ServerConnection.Any, directory: string) => {
        const selection = home.selection.value()
        layout.projects.close(directory)
        if (selection.directory === directory) home.selection.set({ server: selection.server })
      },
      canReveal: () => false,
      reveal: () => {},
    },
    utility: {
      settings: () => navigate("/settings"),
      help: () => {
        // TODO(Task 3): 帮助链接（打开文档）
      },
    },
  }
}

export type HomeProjectsController = ReturnType<typeof createHomeProjectsController>

// 供 HomeProjectsView 类型引用（保留 opencode 形状）
export type HomeProjectsServer = {
  key: ServerConnection.Key
  displayName?: string
}
