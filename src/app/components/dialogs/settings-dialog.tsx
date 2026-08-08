// src/app/components/dialogs/settings-dialog.tsx
// 照抄 opencode components/settings-dialog.tsx：
// - useSettingsDialog()：动态加载 settings-v2 DialogSettings 并弹出
// - useSettingsCommand()：注册"打开设置"命令（id 用 settings.dialog.open，
//   因为 AppLayout 已注册 settings.open（页面跳转），避免重复 id 被去重吞掉）
// TODO(Task 5): AppLayout 的 settings.open 迁移到对话框后，改回 settings.open 并挂 mod+,。

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
