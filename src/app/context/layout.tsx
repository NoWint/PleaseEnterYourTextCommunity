// src/app/context/layout.tsx
// LayoutStore：面板宽度/折叠/右侧抽屉 tab
// 借鉴 opencode context/layout.tsx，简化为 peytchat 四列布局所需
// 持久化 key 复用现有：peyt.navWidth / peyt.drawerWidth / peyt.detailPanelOpen

import { createContext, useContext, createRoot, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type DrawerTab = "members" | "pin" | "settings"
export type AppRoute = "messages" | "groups" | "work" | "settings"

interface LayoutState {
  sidebar: {
    width: number
    collapsed: boolean
  }
  drawer: {
    width: number
    open: boolean
    tab: DrawerTab
  }
}

const DEFAULT_NAV_WIDTH = 240
const DEFAULT_DRAWER_WIDTH = 300

function loadLayoutState(): LayoutState {
  const navWidth = Number(localStorage.getItem("peyt.navWidth")) || DEFAULT_NAV_WIDTH
  const drawerWidth = Number(localStorage.getItem("peyt.drawerWidth")) || DEFAULT_DRAWER_WIDTH
  const drawerOpen = localStorage.getItem("peyt.detailPanelOpen") !== "false"
  return {
    sidebar: { width: navWidth, collapsed: false },
    drawer: { width: drawerWidth, open: drawerOpen, tab: "members" },
  }
}

function createLayoutStore() {
  const [state, setState] = createStore<LayoutState>(loadLayoutState())

  // 持久化辅助
  const persist = {
    navWidth(w: number) {
      localStorage.setItem("peyt.navWidth", String(w))
    },
    drawerWidth(w: number) {
      localStorage.setItem("peyt.drawerWidth", String(w))
    },
    drawerOpen(open: boolean) {
      localStorage.setItem("peyt.detailPanelOpen", String(open))
    },
  }

  return {
    state,
    sidebar: {
      width: () => state.sidebar.width,
      collapsed: () => state.sidebar.collapsed,
      toggle() {
        setState("sidebar", "collapsed", !state.sidebar.collapsed)
      },
      resize(w: number) {
        const clamped = Math.max(180, Math.min(460, w))
        setState("sidebar", "width", clamped)
        persist.navWidth(clamped)
      },
    },
    drawer: {
      width: () => state.drawer.width,
      open: () => state.drawer.open,
      tab: () => state.drawer.tab,
      toggle() {
        setState("drawer", "open", !state.drawer.open)
        persist.drawerOpen(!state.drawer.open)
      },
      setTab(tab: DrawerTab) {
        setState("drawer", "tab", tab)
      },
      resize(w: number) {
        const clamped = Math.max(220, Math.min(520, w))
        setState("drawer", "width", clamped)
        persist.drawerWidth(clamped)
      },
    },
  }
}

type LayoutStore = ReturnType<typeof createLayoutStore>

const LayoutContext = createContext<LayoutStore>()

export function LayoutProvider(props: ParentProps) {
  const store = createRoot(() => createLayoutStore())
  return <LayoutContext.Provider value={store}>{props.children}</LayoutContext.Provider>
}

export function useLayout(): LayoutStore {
  const ctx = useContext(LayoutContext)
  if (!ctx) throw new Error("useLayout must be used within LayoutProvider")
  return ctx
}
