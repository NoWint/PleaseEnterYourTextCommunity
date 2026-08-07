// src/app/layout/titlebar/titlebar.tsx
// 照抄 opencode components/titlebar.tsx V2 分支改造：
// - 删除：update 提示（AI 更新）、WindowsAppMenu、legacy 分支
// - 保留：tab strip、home 切换、新建会话、历史前进/后退、macOS 红绿灯留白
// - route 形状改为 IM：home / workspace / draft / session

import { createEffect, createMemo, createSignal, on, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLayout } from "../../context/layout"
import { usePlatform } from "../../platform"
import { useCommand } from "../../context/command"
import { useLanguage } from "../../context/language"
import { useSettings } from "../../context/settings"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "./titlebar-tab-strip"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "./titlebar-session-events"
import { isTabRecentlyRemoved, tabKey, useTabs, type Tab } from "../../context/tabs"
import { useChat } from "../../context/chat"
import type { LayoutRoute } from "../../context/layout"
import { newTabTooltipKeybind } from "./command-tooltip-keybind"
import "./titlebar.css"

const v2TitlebarHeight = 36
const macTrafficLightsBaseWidth = 84

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => useV2Titlebar() && mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const macTrafficLights = createMemo(() => mac() && !platform.windowFullscreen?.())
  const zoom = () => platform.webviewZoom?.() ?? 1
  const minHeight = () => {
    const height = v2TitlebarHeight
    if (mac()) return `${height / zoom()}px`
    return undefined
  }

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const tabs = useTabs()
  const chat = useChat()
  const tabsStore = () => tabs.store
  const tabsStoreActions = tabs

  const matchRoute = (route: LayoutRoute): Tab | undefined => {
    if (route.type === "home" || route.type === "workspace") return
    if (route.type === "draft") {
      return tabsStore().find((item) => item.type === "draft" && item.draftID === route.draftID)
    }
    if (route.type === "session") {
      return tabsStore().find((item) => item.type === "session" && item.chatId === route.chatId)
    }
  }

  const currentTab = () => matchRoute(layout.route())

  createEffect(() => {
    const route = layout.route()
    if (route.type !== "session") return
    const tab = matchRoute(route)
    if (tab) {
      tabs.remember(tab)
      return
    }
    // 关闭标签页的竞态保护：removeTab 改 store 时本 effect 同步重跑，
    // 若 route 仍指向刚关闭的 session 会把 tab 又加回来（navigate 是异步的）。
    if (isTabRecentlyRemoved(tabKey({ type: "session", chatId: route.chatId }))) {
      return
    }
    const s = chat.session(route.chatId)
    if (!s) return
    const next = tabsStoreActions.addSessionTab({ chatId: route.chatId })
    tabs.remember(next)
  })

  makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
    const detail = readSessionTabsRemovedDetail(event)
    if (!detail) return
    tabsStoreActions.removeSessions(detail.sessionIDs)
  })

  const openNewTab = () => {
    const route = layout.route()
    const activeSession = route.type === "session" ? chat.session(route.chatId) : undefined
    if (route.type === "session" && activeSession) {
      void tabs.newDraft({ directory: activeSession.directory })
      return
    }

    const activeTab = currentTab()
    if (activeTab?.type === "draft") {
      void tabs.newDraft({ directory: activeTab.directory })
      return
    }

    const current = layout.projects.list()[0]
    if (current) {
      void tabs.newDraft({ directory: current.worktree })
      return
    }

    void tabs.newDraft({})
  }

  const toggleHome = () => tabs.toggleHome({ home: layout.route().type === "home", current: currentTab() })

  command.register("titlebar-home", () => [
    {
      id: "home.toggle",
      title: language.t("home.title"),
      category: language.t("command.category.view"),
      keybind: "mod+b",
      hidden: true,
      onSelect: toggleHome,
    },
  ])

  command.register("tabs", () => {
    const current = currentTab()

    return [
      {
        id: "tab.new",
        category: "tab",
        title: language.t("command.session.new"),
        keybind: "mod+t,mod+n",
        hidden: true,
        onSelect: openNewTab,
      },
      current && {
        id: "tab.close",
        category: "tab",
        title: language.t("command.tab.close"),
        keybind: "mod+w",
        hidden: true,
        onSelect: () => {
          tabsStoreActions.closeTab(tabsStore().findIndex((tab) => current === tab))
        },
      },
      {
        id: "tab.reopenClosed",
        category: language.t("command.category.file"),
        title: language.t("command.tab.reopenClosed"),
        keybind: "mod+shift+t",
        onSelect: () => tabsStoreActions.reopenClosedTab(),
      },
    ].filter((v) => v !== undefined)
  })

  const [tabsAreOverflowing, setTabsAreOverflowing] = createSignal(false)

  return (
    <header
      data-slot={useV2Titlebar() ? "titlebar-v2" : undefined}
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": useV2Titlebar(),
        "h-10 bg-background-base overflow-hidden": !useV2Titlebar(),
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": macTrafficLights() ? `${macTrafficLightsBaseWidth / zoom()}px` : 0,
      }}
      data-tauri-drag-region
    >
      <div
        class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3"
        classList={{
          "pt-2": !bottom(),
          "pb-2": bottom(),
          "md:pl-2": macTrafficLights(),
          "md:pl-4": !macTrafficLights(),
        }}
      >
        <ChannelIndicator />

        <TooltipV2
          placement="bottom"
          value={
            <>
              {language.t("home.title")}
              <KeybindV2 keys={command.keybindParts("home.toggle")} variant="neutral" />
            </>
          }
          class="shrink-0"
        >
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            icon={<IconV2 name="grid-plus" />}
            state={layout.route().type === "home" ? "pressed" : undefined}
            onClick={toggleHome}
            aria-label={language.t("home.title")}
            aria-pressed={layout.route().type === "home"}
          />
        </TooltipV2>

        <TitlebarTabStrip
          tabs={tabsStore()}
          currentTab={currentTab}
          forceTruncate={tabsAreOverflowing()}
          onOverflowChange={setTabsAreOverflowing}
          onNavigate={(tab, el) => {
            tabs.select(tab)
            el?.scrollIntoView({ behavior: "instant" })
          }}
          onClose={(tab) => {
            const index = tabsStore().findIndex((item) => tabKey(item) === tabKey(tab))
            if (index !== -1) tabsStoreActions.closeTab(index)
          }}
          onReorder={(keys) => tabsStoreActions.reorder(keys)}
        />
        <TooltipV2
          placement="bottom"
          value={
            <>
              {language.t("command.session.new")}
              <KeybindV2 keys={newTabTooltipKeybind(command)} variant="neutral" />
            </>
          }
        >
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            icon={<IconV2 name="plus" />}
            onClick={openNewTab}
            aria-label={language.t("command.session.new")}
          />
        </TooltipV2>
        <div class="flex-1" />
        <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
      </div>
    </header>
  )
}

function ChannelIndicator() {
  const channel = import.meta.env.VITE_OPENCODE_CHANNEL
  return (
    <>
      {["beta", "dev"].includes(channel) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {channel.toUpperCase()}
        </div>
      )}
    </>
  )
}
