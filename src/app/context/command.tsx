// src/app/context/command.tsx
// 照抄 opencode context/command.tsx 的简化版：register/keybind/keybindParts/trigger +
// 全局 keydown 分发。省略 palette（命令面板 UI）与 catalog 持久化。
// TODO(Task 2): 若实现命令面板，补齐 palette/show。

import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

type KeyLabel =
  | "common.key.ctrl"
  | "common.key.alt"
  | "common.key.shift"
  | "common.key.meta"
  | "common.key.space"
  | "common.key.backspace"
  | "common.key.enter"
  | "common.key.tab"
  | "common.key.delete"
  | "common.key.home"
  | "common.key.end"
  | "common.key.pageUp"
  | "common.key.pageDown"
  | "common.key.insert"
  | "common.key.esc"

const keyText: Record<KeyLabel, string> = {
  "common.key.ctrl": "Ctrl",
  "common.key.alt": "Alt",
  "common.key.shift": "Shift",
  "common.key.meta": "Cmd",
  "common.key.space": "Space",
  "common.key.backspace": "Backspace",
  "common.key.enter": "Enter",
  "common.key.tab": "Tab",
  "common.key.delete": "Delete",
  "common.key.home": "Home",
  "common.key.end": "End",
  "common.key.pageUp": "PageUp",
  "common.key.pageDown": "PageDown",
  "common.key.insert": "Insert",
  "common.key.esc": "Esc",
}

export type KeybindConfig = string

export interface Keybind {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export interface CommandOption {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: KeybindConfig
  slash?: string
  suggested?: boolean
  disabled?: boolean
  hidden?: boolean
  when?: (event: KeyboardEvent) => boolean
  onSelect?: (source?: "palette" | "keybind" | "slash") => void
  onHighlight?: () => (() => void) | void
}

type CommandSource = "palette" | "keybind" | "slash"

export type CommandRegistration = {
  key?: string
  options: Accessor<CommandOption[]>
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function signature(key: string, ctrl: boolean, meta: boolean, shift: boolean, alt: boolean) {
  const mask = (ctrl ? 1 : 0) | (meta ? 2 : 0) | (shift ? 4 : 0) | (alt ? 8 : 0)
  return `${key}:${mask}`
}

function signatureFromEvent(event: KeyboardEvent) {
  return signature(normalizeKey(event.key), event.ctrlKey, event.metaKey, event.shiftKey, event.altKey)
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []
  return config.split(",").map((combo) => {
    const parts = combo.trim().toLowerCase().split("+")
    const keybind: Keybind = { key: "", ctrl: false, meta: false, shift: false, alt: false }
    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          keybind.ctrl = true
          break
        case "meta":
        case "cmd":
        case "command":
          keybind.meta = true
          break
        case "mod":
          if (IS_MAC) keybind.meta = true
          else keybind.ctrl = true
          break
        case "alt":
        case "option":
          keybind.alt = true
          break
        case "shift":
          keybind.shift = true
          break
        default:
          keybind.key = part
          break
      }
    }
    return keybind
  })
}

function displayKeybindParts(kb: Keybind): string[] {
  const parts: string[] = []
  if (kb.ctrl) parts.push(IS_MAC ? "⌃" : "Ctrl")
  if (kb.alt) parts.push(IS_MAC ? "⌥" : "Alt")
  if (kb.shift) parts.push(IS_MAC ? "⇧" : "Shift")
  if (kb.meta) parts.push(IS_MAC ? "⌘" : "Cmd")
  if (!kb.key) return parts

  const keys: Record<string, string> = {
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    comma: ",",
    plus: "+",
  }
  const named: Record<string, string> = {
    backspace: keyText["common.key.backspace"],
    delete: keyText["common.key.delete"],
    end: keyText["common.key.end"],
    enter: keyText["common.key.enter"],
    esc: keyText["common.key.esc"],
    escape: keyText["common.key.esc"],
    home: keyText["common.key.home"],
    insert: keyText["common.key.insert"],
    pagedown: keyText["common.key.pageDown"],
    pageup: keyText["common.key.pageUp"],
    space: keyText["common.key.space"],
    tab: keyText["common.key.tab"],
  }
  const key = kb.key.toLowerCase()
  const displayKey =
    keys[key] ??
    named[key] ??
    (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
  parts.push(displayKey)
  return parts
}

export function formatKeybindParts(config: string): string[] {
  if (!config || config === "none") return []
  const keybind = parseKeybind(config)[0]
  return keybind ? displayKeybindParts(keybind) : []
}

export function formatKeybind(config: string): string {
  const parts = formatKeybindParts(config)
  if (parts.length === 0) return ""
  return IS_MAC ? parts.join("") : parts.join("+")
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest("[contenteditable='true']")) return true
  if (target.closest("input, textarea, select")) return true
  return false
}

interface CommandStore {
  register(cb: () => CommandOption[]): void
  register(key: string, cb: () => CommandOption[]): void
  trigger(id: string, source?: CommandSource): void
  keybind(id: string): string
  keybindParts(id: string): string[]
  show(): void
  keybinds(enabled: boolean): void
  suspended(): boolean
}

function createCommandStore(): CommandStore {
  const [store, setStore] = createStore({
    registrations: [] as CommandRegistration[],
    suspendCount: 0,
  })

  const options = createMemo(() => {
    const seen = new Set<string>()
    const all: CommandOption[] = []
    for (const reg of store.registrations) {
      for (const opt of reg.options()) {
        if (seen.has(opt.id)) continue
        seen.add(opt.id)
        all.push(opt)
      }
    }
    return all
  })

  const keymap = createMemo(() => {
    const map = new Map<string, CommandOption[]>()
    for (const option of options()) {
      if (option.disabled || !option.keybind) continue
      for (const kb of parseKeybind(option.keybind)) {
        if (!kb.key) continue
        const sig = signature(kb.key, kb.ctrl, kb.meta, kb.shift, kb.alt)
        const existing = map.get(sig)
        if (existing) existing.push(option)
        else map.set(sig, [option])
      }
    }
    return map
  })

  const optionMap = createMemo(() => {
    const map = new Map<string, CommandOption>()
    for (const option of options()) map.set(option.id, option)
    return map
  })

  const suspended = () => store.suspendCount > 0

  const handleKeyDown = (event: KeyboardEvent) => {
    if (suspended()) return
    const sig = signatureFromEvent(event)
    const option =
      keymap().get(sig)?.find((item) => item.when?.(event)) ??
      keymap().get(sig)?.find((item) => !item.when)
    if (!option) return
    event.preventDefault()
    event.stopPropagation()
    option.onSelect?.("keybind")
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown, { capture: true })
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true })
    })
  })

  function register(cb: () => CommandOption[]): void
  function register(key: string, cb: () => CommandOption[]): void
  function register(key: string | (() => CommandOption[]), cb?: () => CommandOption[]) {
    const id = typeof key === "string" ? key : undefined
    const next = typeof key === "function" ? key : cb
    if (!next) return
    const options = createMemo(next)
    const entry: CommandRegistration = { key: id, options }
    setStore("registrations", (arr) => [entry, ...arr])
    onCleanup(() => {
      setStore("registrations", (arr) => arr.filter((x) => x !== entry))
    })
  }

  const run = (id: string, source?: CommandSource) => {
    optionMap().get(id)?.onSelect?.(source)
  }

  return {
    register,
    trigger: run,
    keybind(id: string) {
      const config = options().find((x) => x.id === id)?.keybind
      return config ? formatKeybind(config) : ""
    },
    keybindParts(id: string) {
      const config = options().find((x) => x.id === id)?.keybind
      return config ? formatKeybindParts(config) : []
    },
    // TODO(Task 2): 命令面板 UI（当前为 no-op 占位）
    show() {},
    keybinds(enabled: boolean) {
      setStore("suspendCount", (count) => Math.max(0, count + (enabled ? -1 : 1)))
    },
    suspended,
  }
}

export const { use: useCommand, provider: CommandProvider } = createSimpleContext<CommandStore, Record<string, any>>({
  name: "Command",
  gate: false,
  init: () => createCommandStore(),
})
