// src/app/layout/titlebar/titlebar-tab-strip.tsx
// 照抄 opencode components/titlebar-tab-strip.tsx 改造：
// - 去掉 @dnd-kit/solid 拖拽（不引入新依赖），保留滚动/溢出渐变/快捷键/可见性
// - 会话数据源：本地 chat context + tabs.info（无 server/sync）
// TODO(Task 2): 恢复 tab 拖拽排序（@dnd-kit/solid 或 @thisbeyond/solid-dnd）

import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { tabHref, tabKey, type SessionTab, type Tab } from "../../context/tabs"
import { useCommand } from "../../context/command"
import { useLanguage } from "../../context/language"
import { useTabs } from "../../context/tabs"
import { useChat } from "../../context/chat"
import { DraftTabItem, TabNavItem } from "./titlebar-tab-nav"
import { adjacentTabKey } from "./titlebar-tab-order"
import type { AppSession } from "../../types"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  session: () => AppSession | undefined
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  let ref!: HTMLDivElement

  return (
    <div
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        session={props.session}
        fallbackTitle={props.fallbackTitle}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        forceTruncate={props.forceTruncate}
        dragging={false}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const chat = useChat()
  const language = useLanguage()
  const session = createMemo(() => chat.session(props.tab.chatId))
  const persisted = createMemo(() => tabs.info[props.id])
  const visible = createMemo(() => !!session() || !!persisted()?.title)

  const rename = async (title: string) => {
    const value = session()
    if (!value) return
    chat.rename(value.id, title)
    tabs.rememberSessionInfo(props.tab, { title, directory: value.directory })
  }

  createEffect(() => props.onVisibleChange(visible()))

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        forceTruncate={props.forceTruncate}
        session={session}
        fallbackTitle={persisted()?.title ?? (session() ? undefined : language.t("session.tab.unknown"))}
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  let ref!: HTMLDivElement

  return (
    <div
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        dragging={false}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const language = useLanguage()
  const command = useCommand()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const visibleTabs = createMemo(() => props.tabs.filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))
  const visibleTabIds = () => visibleTabs().map(tabKey)

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1) {
    const current = props.currentTab()
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset)
    const next = props.tabs.find((tab) => tabKey(tab) === key)
    if (next) props.onNavigate(next)
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(scrollRef.scrollWidth > scrollRef.clientWidth)
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    refreshOverflow()
  })

  return (
    <div data-slot="titlebar-tabs" class="relative min-w-0">
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
        ref={scrollRef}
      >
        <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
          <For each={props.tabs}>
            {(tab) => {
              const id = tabKey(tab)
              let ref!: HTMLDivElement
              const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
              useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))

              if (tab.type === "session") {
                return (
                  <SessionTabEntry
                    tab={tab}
                    id={id}
                    index={visibleIndex}
                    active={() => props.currentTab() === tab}
                    forceTruncate={props.forceTruncate}
                    onVisibleChange={(visible) => setVisibility(id, visible)}
                    onNavigate={(element) => {
                      ref = element
                      props.onNavigate(tab, element)
                    }}
                    onClose={() => props.onClose(tab)}
                  />
                )
              }

              return (
                <DraftTabSlot
                  tab={tab}
                  id={id}
                  index={visibleIndex}
                  active={() => props.currentTab() === tab}
                  title={language.t("command.session.new")}
                  onNavigate={(element) => {
                    ref = element
                    props.onNavigate(tab, element)
                  }}
                  onClose={() => props.onClose(tab)}
                />
              )
            }}
          </For>
        </div>
      </div>
      <div
        data-slot="titlebar-tabs-fade-left"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
      />
      <div
        data-slot="titlebar-tabs-fade-right"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
      />
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number < 1 || number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}

// mergeVisibleTabOrder 目前由拖拽排序使用；拖拽恢复后接入（TODO Task 2）。
