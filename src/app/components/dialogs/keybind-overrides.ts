// src/app/components/dialogs/keybind-overrides.ts
// 快捷键覆盖（用户自定义）的读取/重置工具。
// settings context（src/app/context/settings.tsx）把 keybinds 持久化到
// localStorage "peyt.keybinds"（get/set 走 context API）；这里只在设置对话框
// 需要"读取全量覆盖 / 一键重置"时直接读写同一存储键，避免扩展 context API。
// TODO(Task 5): 若 settings context 增加 current/resetAll，本文件可删除。

const KEYBINDS_STORAGE = "peyt.keybinds"

export type KeybindMap = Record<string, string | undefined>

export function readKeybindOverrides(): KeybindMap {
  try {
    const raw = localStorage.getItem(KEYBINDS_STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as KeybindMap)
      : {}
  } catch {
    return {}
  }
}

export function resetKeybindOverrides() {
  localStorage.removeItem(KEYBINDS_STORAGE)
}

export function hasKeybindOverrides() {
  return Object.values(readKeybindOverrides()).some((value) => typeof value === "string")
}
