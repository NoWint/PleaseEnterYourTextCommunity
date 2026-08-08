// src/app/components/dialogs/dialog-command-palette-v2.tsx
// 命令面板（照抄 opencode dialog-command-palette-v2.tsx 的命令分支）：
// - 去掉 file/session 条目（IM 版只有命令）
// - 去掉 AI 上下文（useGlobal/useServerSDK 等）
// - 文案走 dialogs/i18n（中文）

import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog, DialogBody } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { formatKeybindParts } from "../../context/command"
import { dialogsT } from "./i18n"
import {
  createCommandPaletteModel,
  uniqueCommandPaletteEntries,
  type CommandPaletteEntry,
} from "./command-palette"
import "./dialog-command-palette-v2.css"

function groups(entries: CommandPaletteEntry[]) {
  const map = new Map<string, CommandPaletteEntry[]>()
  for (const entry of entries) map.set(entry.category, [...(map.get(entry.category) ?? []), entry])
  return Array.from(map.entries()).map(([category, entries]) => ({ category, entries }))
}

function matchesEntry(entry: CommandPaletteEntry, query: string) {
  const value = query.toLowerCase()
  return [entry.title, entry.description, entry.category].some((text) => text?.toLowerCase().includes(value))
}

export function DialogImCommandPaletteV2() {
  const palette = createCommandPaletteModel()
  const dialog = useDialog()

  const loadItems = async (text: string) => {
    const query = text.trim()
    const all = palette.commandEntries()
    if (!query) return all.slice(0, 5)
    return all.filter((entry) => matchesEntry(entry, query))
  }

  return (
    <CommandPaletteView
      placeholder={dialogsT("palette.search.placeholder.home")}
      loadItems={loadItems}
      select={palette.select}
      close={() => dialog.close()}
    />
  )
}

function CommandPaletteView(props: {
  placeholder: string
  loadItems: (text: string) => CommandPaletteEntry[] | Promise<CommandPaletteEntry[]>
  select: (item: CommandPaletteEntry | undefined) => void
  close: () => void
}) {
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)

  const [entries] = createResource(query, props.loadItems, { initialValue: [] as CommandPaletteEntry[] })
  // Render stale results while a new query loads to avoid flashing "Loading" per keystroke.
  const visibleEntries = createMemo(() => uniqueCommandPaletteEntries(entries.latest ?? []))
  const groupedEntries = createMemo(() => groups(visibleEntries()))
  const activeEntry = createMemo(() => visibleEntries()[active()])

  createEffect(() => {
    query()
    visibleEntries()
    setActive(0)
  })

  let resultsRef: HTMLDivElement | undefined

  const move = (delta: -1 | 1) => {
    const count = visibleEntries().length
    if (count === 0) return
    setActive((index) => (index + delta + count) % count)
    requestAnimationFrame(() => {
      resultsRef?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" })
    })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      props.select(activeEntry())
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      props.close()
    }
  }

  return (
    <Dialog class="command-palette-v2" size="large">
      <DialogBody class="command-palette-v2-body">
        <div class="command-palette-v2-search">
          <TextInputV2
            value={query()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            placeholder={props.placeholder}
            leadingIcon={<Icon name="magnifying-glass" />}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <ScrollView class="command-palette-v2-scroll" viewportRef={(el) => (resultsRef = el)}>
          <div class="command-palette-v2-results" role="listbox">
            <Show
              when={visibleEntries().length > 0}
              fallback={
                <div class="command-palette-v2-state">
                  {entries.loading ? dialogsT("common.loading") : dialogsT("palette.empty")}
                </div>
              }
            >
              <For each={groupedEntries()}>
                {(group) => (
                  <div class="command-palette-v2-group">
                    <Show when={group.category}>
                      <div class="command-palette-v2-group-title">{group.category}</div>
                    </Show>
                    <For each={group.entries}>
                      {(item) => (
                        <PaletteRow
                          item={item}
                          active={activeEntry()?.id === item.id}
                          onActive={() => setActive(visibleEntries().findIndex((entry) => entry.id === item.id))}
                          onSelect={() => props.select(item)}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </ScrollView>
      </DialogBody>
    </Dialog>
  )
}

function PaletteRow(props: {
  item: CommandPaletteEntry
  active: boolean
  onActive: () => void
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      class="command-palette-v2-row group"
      role="option"
      aria-selected={props.active}
      data-active={props.active ? "" : undefined}
      onMouseMove={(event) => {
        // Ignore hover from a static cursor when keyboard scrolling moves rows underneath it.
        if (event.movementX === 0 && event.movementY === 0) return
        props.onActive()
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
    >
      <Switch
        fallback={
          <div class="command-palette-v2-row-main">
            <div class="command-palette-v2-row-text">
              <span class="command-palette-v2-title">{props.item.title}</span>
              <Show when={props.item.description}>
                <span class="command-palette-v2-description">{props.item.description}</span>
              </Show>
            </div>
          </div>
        }
      >
        <Match when={props.item.type === "command"}>
          <div class="command-palette-v2-row-main">
            <div class="command-palette-v2-row-text">
              <span class="command-palette-v2-title">{props.item.title}</span>
              <Show when={props.item.description}>
                <span class="command-palette-v2-description">{props.item.description}</span>
              </Show>
            </div>
          </div>
          <Show when={props.item.keybind}>
            <KeybindV2 keys={formatKeybindParts(props.item.keybind ?? "")} variant="neutral" />
          </Show>
        </Match>
      </Switch>
    </button>
  )
}
