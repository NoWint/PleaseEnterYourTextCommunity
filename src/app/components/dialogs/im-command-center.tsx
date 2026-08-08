// src/app/components/dialogs/im-command-center.tsx
// IM 命令中枢：注册命令面板（mod+k）与 5 个 IM 命令
// （切换会话、新建会话、标记已读、切换工作区、切换主题）。
// 挂载在 Titlebar（根布局常驻），渲染 null。
// 数据源均为现有 context 只读调用（tabs/chat/layout/theme），
// 不修改其他任务拥有的 context 文件。

import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useCommand } from "../../context/command"
import { useLayout } from "../../context/layout"
import { useTabs, tabKey } from "../../context/tabs"
import { useChat } from "../../context/chat"
import { base64Encode } from "../../utils/base64"
import { showToast } from "../../utils/toast"
import { dialogsT } from "./i18n"

export function ImCommandCenter() {
  const command = useCommand()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const chat = useChat()
  const theme = useTheme()
  const navigate = useNavigate()

  command.register("im-palette", () => [
    {
      id: "command.palette",
      title: dialogsT("command.palette"),
      hidden: true,
      onSelect: async () => {
        const { DialogImCommandPaletteV2 } = await import("./dialog-command-palette-v2")
        void dialog.show(() => <DialogImCommandPaletteV2 />)
      },
    },
  ])

  const switchSession = () => {
    const open = tabs.store
    if (open.length === 0) {
      void tabs.newDraft({})
      return
    }
    const route = layout.route()
    const currentKey =
      route.type === "session"
        ? tabKey({ type: "session", chatId: route.chatId })
        : route.type === "draft"
          ? tabKey({ type: "draft", draftID: route.draftID })
          : undefined
    const index = currentKey ? open.findIndex((tab) => tabKey(tab) === currentKey) : -1
    const next = open[(index + 1) % open.length]
    tabs.select(next)
  }

  const markRead = () => {
    const route = layout.route()
    if (route.type === "session") {
      chat.markRead(route.chatId)
    } else {
      chat.chatList().forEach((session) => {
        if (session.unread > 0) chat.markRead(session.id)
      })
    }
    showToast({ title: dialogsT("command.session.markRead") })
  }

  const switchWorkspace = () => {
    const list = layout.projects.list()
    if (list.length === 0) return
    const route = layout.route()
    const current = route.type === "workspace" ? route.wsId : undefined
    const index = list.findIndex((project) => project.worktree === current)
    const next = list[(index + 1) % list.length]
    navigate(`/home/${base64Encode(next.worktree)}`)
  }

  const switchTheme = () => {
    const ids = theme.ids()
    if (ids.length === 0) return
    const current = theme.themeId()
    const index = ids.indexOf(current)
    const next = ids[(index + 1) % ids.length] ?? ids[0]
    theme.setTheme(next)
    showToast({ title: dialogsT("command.theme.switch"), description: theme.name(next) })
  }

  command.register("im", () => [
    {
      id: "session.new",
      title: dialogsT("command.session.new"),
      category: dialogsT("command.category.session"),
      onSelect: () => void tabs.newDraft({}),
    },
    {
      id: "session.switch",
      title: dialogsT("command.session.switch"),
      category: dialogsT("command.category.session"),
      onSelect: switchSession,
    },
    {
      id: "session.markRead",
      title: dialogsT("command.session.markRead"),
      category: dialogsT("command.category.session"),
      onSelect: markRead,
    },
    {
      id: "workspace.switch",
      title: dialogsT("command.workspace.switch"),
      category: dialogsT("command.category.workspace"),
      onSelect: switchWorkspace,
    },
    {
      id: "theme.switch",
      title: dialogsT("command.theme.switch"),
      category: dialogsT("command.category.theme"),
      onSelect: switchTheme,
    },
  ])

  return null
}
