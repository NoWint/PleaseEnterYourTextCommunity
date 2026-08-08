// src/app/components/dialogs/settings-dialog.tsx
// 照抄 opencode components/settings-dialog.tsx：
// - useSettingsDialog()：动态加载 settings-v2 DialogSettings 并弹出
// - useSettingsCommand()：注册"打开设置对话框"命令（id 用 settings.dialog.open，
//   供命令面板与标题栏齿轮按钮使用）。
// 各入口都指向对话框：AppLayout 的 settings.open（mod+, + 侧栏按钮，hidden）、
// home 页的侧栏设置按钮、标题栏齿轮（settings.dialog.open）——没有 /settings 页面路由。

import { onCleanup } from "solid-js"
import { useCommand } from "../../context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { dialogsT } from "./i18n"

export function useSettingsDialog(defaultValue?: string) {
  const dialog = useDialog()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    const current = ++run
    void import("./settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogSettings defaultValue={defaultValue} />)
    })
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const show = useSettingsDialog()

  command.register("settings-dialog", () => [
    {
      id: "settings.dialog.open",
      title: dialogsT("command.settings.open"),
      category: dialogsT("command.category.settings"),
      onSelect: show,
    },
  ])

  return show
}
