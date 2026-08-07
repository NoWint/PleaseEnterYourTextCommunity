// src/app/layout/titlebar/command-tooltip-keybind.ts
// 照抄 opencode components/command-tooltip-keybind.ts。

type CommandKeybind = {
  keybindParts: (id: string) => string[]
}

export function newTabTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("tab.new")
}
