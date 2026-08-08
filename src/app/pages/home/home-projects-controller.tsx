// src/app/pages/home/home-projects-controller.tsx
// 照抄 opencode pages/home/home-projects-controller.tsx 改造：
// - server → 账户（本地 server context：collapsed/canDefault/defaultKey/setDefault/focus）
// - project → workspace（workspace context：排序/退出历史/未读聚合）
// - 目录选择器 → 新建工作区对话框（DialogEditWorkspaceV2 创建模式）
// - 设置/帮助 → 设置对话框 / 帮助对话框（HelpDialogContent）

import { createEffect } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useChat } from "../../context/chat"
import { useLanguage } from "../../context/language"
import { useLayout, type LocalProject } from "../../context/layout"
import { LOCAL_SERVER, ServerConnection, useServer } from "../../context/server"
import { bindChatListSource, useWorkspace } from "../../context/workspace"
import { useSettingsDialog } from "../../components/dialogs/settings-dialog"
import { DialogEditWorkspaceV2 } from "../../components/dialogs/dialog-edit-workspace-v2"
import { DialogAccount } from "../../components/dialogs/dialog-account"
import { HelpDialogContent } from "../../components/dialogs/help-button"
import { showToast } from "../../utils/toast"
import type { HomeController } from "./home-controller"

export function createHomeProjectsController(home: HomeController) {
  const language = useLanguage()
  const chat = useChat()
  const layout = useLayout()
  const dialog = useDialog()
  const server = useServer()
  const workspace = useWorkspace()
  const openSettings = useSettingsDialog()

  // 桥接 chat 会话列表 → workspace context（unseenCount/markSeen 的未读聚合数据源）
  createEffect(() => bindChatListSource(chat.chatList))

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
      collapsed: (conn: ServerConnection.Any) => server.collapsed[ServerConnection.key(conn)] ?? false,
      toggleCollapsed: (conn: ServerConnection.Any) => {
        const key = ServerConnection.key(conn)
        server.setCollapsed(key, !(server.collapsed[key] ?? false))
      },
      canDefault: server.canDefault,
      defaultKey: () => server.defaultKey,
      setDefault: (conn: ServerConnection.Any | undefined) =>
        server.setDefault(conn ? ServerConnection.key(conn) : undefined),
      remove: (conn: ServerConnection.Any) => {
        // TODO(Task 3): 后端无删除账号命令，暂以 toast 提示（菜单对本地回落账号已禁用）。
        showToast({ title: language.t("dialog.server.menu.delete"), description: "暂不支持删除账号" })
      },
      edit: (conn: ServerConnection.Any) => {
        if (ServerConnection.key(conn) === ServerConnection.key(LOCAL_SERVER)) return
        void dialog.show(() => <DialogAccount />)
      },
      focus: home.selection.focusServer,
    },
    project: {
      list: home.project.list,
      recentlyClosed: home.project.recentlyClosed,
      homedir: home.project.homedir,
      select: home.project.select,
      add: home.project.add,
      openNewSession: (conn: ServerConnection.Any, directory: string) =>
        home.project.openProjectNewSession(conn, directory),
      edit: (conn: ServerConnection.Any, project: LocalProject) => {
        void dialog.show(() => <DialogEditWorkspaceV2 project={project} />)
      },
      unseenCount: (conn: ServerConnection.Any, project: LocalProject) => workspace.unseenCount(project.worktree),
      clearNotifications: (conn: ServerConnection.Any, project: LocalProject) => {
        // 本地乐观清零（chat store）+ 后端批量已读（workspace.markSeen）
        for (const directory of directories(project)) {
          for (const session of chat.chatList()) {
            if (session.directory === directory && session.unread > 0) chat.markRead(session.id)
          }
        }
        void workspace.markSeen(project.worktree)
      },
      choose: (conn: ServerConnection.Any) => {
        if (home.server.health(conn)?.healthy === false) return
        void dialog.show(() => <DialogEditWorkspaceV2 mode="create" project={{ worktree: "", expanded: false }} />)
      },
      close: (conn: ServerConnection.Any, directory: string) => {
        const selection = home.selection.value()
        workspace.close(directory)
        // 侧栏同步（layout.projects 是 sidebar 的数据源；workspace 刷新时会经 open() 恢复）
        layout.projects.close(directory)
        if (selection.server === ServerConnection.key(conn) && selection.directory === directory) {
          home.selection.set({ server: selection.server })
        }
      },
      move: (conn: ServerConnection.Any, worktree: string, index: number) => {
        workspace.move(worktree, index)
      },
      // "显示"（文件管理器）菜单项已移除，canReveal 保留形状恒为 false
      canReveal: () => false,
      reveal: () => {},
    },
    utility: {
      settings: openSettings,
      help: () => {
        void dialog.show(() => <HelpDialogContent />)
      },
    },
  }
}

export type HomeProjectsController = ReturnType<typeof createHomeProjectsController>
