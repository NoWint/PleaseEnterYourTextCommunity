// src/app/components/dialogs/command-palette.ts
// 命令面板条目模型（照抄 opencode components/command-palette.ts 的命令部分，
// 去掉 file/session 条目——IM 版命令面板只展示命令）。

import { createMemo } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { commandPaletteOptions, useCommand, type CommandOption } from "../../context/command"
import { dialogsT } from "./i18n"

export type CommandPaletteEntry = {
  id: string
  type: "command"
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
}

export function uniqueCommandPaletteEntries(items: CommandPaletteEntry[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function createCommandPaletteCommandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}

/** 创建命令面板模型：暴露命令条目 + highlight/select/close。 */
export function createCommandPaletteModel() {
  const command = useCommand()
  const dialog = useDialog()

  const commandEntries = createMemo(() => {
    const category = dialogsT("palette.group.commands")
    return commandPaletteOptions(command.options).map((option) =>
      createCommandPaletteCommandEntry(option, category),
    )
  })

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    dialog.close()
    item.option?.onSelect?.("palette")
  }

  return {
    commandEntries,
    select,
  }
}
