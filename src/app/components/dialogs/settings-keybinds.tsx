// src/app/components/dialogs/settings-keybinds.tsx
// 设置对话框「快捷键」页（照抄 opencode settings-keybinds.tsx 的 v1 分支）：
// - 命令列表来自 useCommand().options/catalog（IM 命令）
// - 覆盖值持久化在 settings.keybinds（localStorage "peyt.keybinds"）；
//   全量读取/重置走 dialogs/keybind-overrides.ts（settings context 无 current/resetAll）
// - 冲突检测 + 录制 + 搜索（fuzzysort）
// 去掉：v2 分支、fuzzysort 之外的全部 AI 依赖。

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "../../utils/toast"
import fuzzysort from "fuzzysort"
import { DEFAULT_PALETTE_KEYBIND, formatKeybind, parseKeybind, useCommand } from "../../context/command"
import { useSettings } from "../../context/settings"
import { dialogsT } from "./i18n"
import { readKeybindOverrides, resetKeybindOverrides, type KeybindMap } from "./keybind-overrides"
import { SettingsList } from "./settings-list"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
const PALETTE_ID = "command.palette"

type KeybindGroup = "General" | "Session" | "Navigation" | "Workspace"

type KeybindMeta = {
  title: string
  group: KeybindGroup
}

type CommandContext = ReturnType<typeof useCommand>

const GROUPS: KeybindGroup[] = ["General", "Session", "Navigation", "Workspace"]

type GroupKey =
  | "settings.shortcuts.group.general"
  | "settings.shortcuts.group.session"
  | "settings.shortcuts.group.navigation"
  | "settings.shortcuts.group.workspace"

const groupKey: Record<KeybindGroup, GroupKey> = {
  General: "settings.shortcuts.group.general",
  Session: "settings.shortcuts.group.session",
  Navigation: "settings.shortcuts.group.navigation",
  Workspace: "settings.shortcuts.group.workspace",
}

function groupFor(id: string): KeybindGroup {
  if (id === PALETTE_ID) return "General"
  if (id.startsWith("session.") || id.startsWith("tab.") || id.startsWith("message.")) return "Session"
  if (id.startsWith("workspace.") || id === "project.open") return "Workspace"
  if (id.startsWith("home.") || id.startsWith("common.")) return "Navigation"
  if (id.startsWith("theme.")) return "General"
  return "General"
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function recordKeybind(event: KeyboardEvent) {
  if (isModifier(event.key)) return

  const parts: string[] = []

  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (mod) parts.push("mod")

  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")

  const key = normalizeKey(event.key)
  if (!key) return
  parts.push(key)

  return parts.join("+")
}

function signatures(config: string | undefined) {
  if (!config) return []
  const sigs: string[] = []

  for (const kb of parseKeybind(config)) {
    const parts: string[] = []
    if (kb.ctrl) parts.push("ctrl")
    if (kb.alt) parts.push("alt")
    if (kb.shift) parts.push("shift")
    if (kb.meta) parts.push("meta")
    if (kb.key) parts.push(kb.key)
    if (parts.length === 0) continue
    sigs.push(parts.join("+"))
  }

  return sigs
}

function keybinds(value: unknown): KeybindMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as KeybindMap
}

function listFor(command: Pick<CommandContext, "catalog" | "options">, map: KeybindMap, palette: string) {
  const out = new Map<string, KeybindMeta>()
  out.set(PALETTE_ID, { title: palette, group: "General" })

  for (const opt of command.catalog) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const opt of command.options) {
    if (opt.id.startsWith("suggested.")) continue
    if (opt.hidden) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== "string") continue
    if (out.has(id)) continue
    out.set(id, { title: id, group: groupFor(id) })
  }

  return out
}

function groupedFor(list: Map<string, KeybindMeta>) {
  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  for (const [id, item] of list) {
    const ids = out.get(item.group)
    if (!ids) continue
    ids.push(id)
  }

  for (const group of GROUPS) {
    const ids = out.get(group)
    if (!ids) continue
    ids.sort((a, b) => (list.get(a)?.title ?? "").localeCompare(list.get(b)?.title ?? ""))
  }

  return out
}

function filteredFor(
  query: string,
  list: Map<string, KeybindMeta>,
  grouped: Map<KeybindGroup, string[]>,
  keybind: (id: string) => string,
) {
  const value = query.toLowerCase().trim()
  if (!value) return grouped

  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  const items = Array.from(list.entries()).map(([id, meta]) => ({
    id,
    title: meta.title,
    group: meta.group,
    keybind: keybind(id),
  }))

  const results = fuzzysort.go(value, items, {
    keys: ["title", "keybind"],
    threshold: -10000,
  })

  for (const result of results) {
    const ids = out.get(result.obj.group)
    if (!ids) continue
    ids.push(result.obj.id)
  }

  return out
}

export const SettingsKeybinds: Component = () => {
  const command = useCommand()
  const settings = useSettings()

  const [store, setStore] = createStore({
    active: null as string | null,
    filter: "",
  })
  // settings context 无 current/resetAll：用版本号驱动本地缓存重读（见 keybind-overrides.ts）。
  const [bump, setBump] = createSignal(0)

  const stop = () => {
    if (!store.active) return
    setStore("active", null)
    command.keybinds(true)
  }

  const start = (id: string) => {
    if (store.active === id) {
      stop()
      return
    }

    if (store.active) stop()

    setStore("active", id)
    command.keybinds(false)
  }

  const map = createMemo<KeybindMap>(() => {
    bump()
    return keybinds(readKeybindOverrides())
  })

  const hasOverrides = createMemo(() => Object.values(map()).some((x) => typeof x === "string"))

  const resetAll = () => {
    stop()
    resetKeybindOverrides()
    setBump((v) => v + 1)
    showToast({
      title: dialogsT("settings.shortcuts.reset.toast.title"),
      description: dialogsT("settings.shortcuts.reset.toast.description"),
    })
  }

  const list = createMemo(() => listFor(command, map(), dialogsT("command.palette")))

  const title = (id: string) => list().get(id)?.title ?? ""

  const grouped = createMemo(() => groupedFor(list()))

  const filtered = createMemo(() => {
    return filteredFor(store.filter, list(), grouped(), (id) => command.keybind(id) || "")
  })

  const hasResults = createMemo(() => {
    for (const group of GROUPS) {
      const ids = filtered().get(group) ?? []
      if (ids.length > 0) return true
    }
    return false
  })

  const used = createMemo(() => {
    const map = new Map<string, { id: string; title: string }[]>()

    const add = (key: string, value: { id: string; title: string }) => {
      const list = map.get(key)
      if (!list) {
        map.set(key, [value])
        return
      }
      list.push(value)
    }

    const palette = settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
    for (const sig of signatures(palette)) {
      add(sig, { id: PALETTE_ID, title: title(PALETTE_ID) })
    }

    const valueFor = (id: string) => {
      const custom = settings.keybinds.get(id)
      if (typeof custom === "string") return custom

      const live = command.options.find((x) => x.id === id)
      if (live?.keybind) return live.keybind

      const meta = command.catalog.find((x) => x.id === id)
      return meta?.keybind
    }

    for (const id of list().keys()) {
      if (id === PALETTE_ID) continue
      for (const sig of signatures(valueFor(id))) {
        add(sig, { id, title: title(id) })
      }
    }

    return map
  })

  const setKeybind = (id: string, keybind: string) => {
    settings.keybinds.set(id, keybind)
    setBump((v) => v + 1)
  }

  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      const id = store.active
      if (!id) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        stop()
        return
      }

      const clear =
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      if (clear) {
        setKeybind(id, "none")
        stop()
        return
      }

      const next = recordKeybind(event)
      if (!next) return

      const conflicts = new Map<string, string>()
      for (const sig of signatures(next)) {
        for (const item of used().get(sig) ?? []) {
          if (item.id === id) continue
          conflicts.set(item.id, item.title)
        }
      }

      if (conflicts.size > 0) {
        showToast({
          title: dialogsT("settings.shortcuts.conflict.title"),
          description: dialogsT("settings.shortcuts.conflict.description", {
            keybind: formatKeybind(next),
            titles: [...conflicts.values()].join(", "),
          }),
        })
        return
      }

      setKeybind(id, next)
      stop()
    }

    makeEventListener(document, "keydown", handle, { capture: true })
  })

  onCleanup(() => {
    if (store.active) command.keybinds(true)
  })

  const emptyResults = (
    <Show when={store.filter && !hasResults()}>
      <div class="flex flex-col items-center justify-center py-12 text-center">
        <span class="text-14-regular text-text-weak">{dialogsT("settings.shortcuts.search.empty")}</span>
        <Show when={store.filter}>
          <span class="text-14-regular text-text-strong mt-1">&quot;{store.filter}&quot;</span>
        </Show>
      </div>
    </Show>
  )

  const groups = (
    <div class="flex flex-col gap-8 max-w-[720px]">
      <For each={GROUPS}>
        {(group) => (
          <Show when={(filtered().get(group) ?? []).length > 0}>
            <div class="flex flex-col gap-1">
              <h3 class="text-14-medium text-text-strong pb-2">{dialogsT(groupKey[group])}</h3>
              <SettingsList>
                <For each={filtered().get(group) ?? []}>
                  {(id) => (
                    <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                      <span class="text-14-regular text-text-strong">{title(id)}</span>
                      <button
                        type="button"
                        data-keybind-id={id}
                        classList={{
                          "h-8 px-3 rounded-md text-12-regular": true,
                          "bg-surface-base text-text-subtle hover:bg-surface-raised-base-hover active:bg-surface-raised-base-active":
                            store.active !== id,
                          "border border-border-weak-base bg-surface-inset-base text-text-weak": store.active === id,
                        }}
                        onClick={() => start(id)}
                      >
                        <Show
                          when={store.active === id}
                          fallback={command.keybind(id) || dialogsT("settings.shortcuts.unassigned")}
                        >
                          {dialogsT("settings.shortcuts.pressKeys")}
                        </Show>
                      </button>
                    </div>
                  )}
                </For>
              </SettingsList>
            </div>
          </Show>
        )}
      </For>
      {emptyResults}
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{dialogsT("settings.shortcuts.title")}</h2>
            <Button size="small" variant="secondary" onClick={resetAll} disabled={!hasOverrides()}>
              {dialogsT("settings.shortcuts.reset.button")}
            </Button>
          </div>

          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={store.filter}
              onChange={(v) => setStore("filter", v)}
              placeholder={dialogsT("settings.shortcuts.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={store.filter}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setStore("filter", "")} />
            </Show>
          </div>
        </div>
      </div>
      {groups}
    </div>
  )
}
