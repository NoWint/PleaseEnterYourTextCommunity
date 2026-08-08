// src/app/context/layout.tsx
// 照抄 opencode context/layout.tsx 的结构改造：route/projects/sidebar/home/mobileSidebar。
// projects 列表初始为假数据兜底（src/app/data/fake.ts），workspace context 拉取
// 真实工作区后经 open/rename 同步进来（见 context/workspace.tsx），持久化到 localStorage。

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppWorkspace } from "../types"
import { fakeWorkspaces } from "../data/fake"
import { base64Decode } from "../utils/base64"

export type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 288
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string) {
  if (key === "mint") return "cyan" as const
  if (key === "lime") return "green" as const
  if (
    key === "orange" ||
    key === "yellow" ||
    key === "cyan" ||
    key === "green" ||
    key === "red" ||
    key === "pink" ||
    key === "blue" ||
    key === "purple" ||
    key === "gray"
  )
    return key as "orange" | "cyan" | "green" | "red" | "pink" | "blue" | "purple" | "gray"
  return "gray" as const
}

export type LocalProject = AppWorkspace
export type HomeProjectSelection = { server: string; directory?: string }

export type LayoutRoute =
  | { type: "home" }
  | { type: "workspace"; wsId: string }
  | { type: "draft"; draftID: string }
  | { type: "session"; chatId: string }

export const currentRoute = (pathname: string, search: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }

  if (parts[0] === "home") {
    // wsId 在 URL 中是 base64url 编码（见 AppLayout navigateToProject），此处解码为工作区 key
    const wsId = parts[1] ? base64Decode(parts[1]) : undefined
    if (wsId) return { type: "workspace", wsId }
    return { type: "home" }
  }

  if (parts[0] === "chat") {
    if (parts[1] === "new") {
      const draftID = new URLSearchParams(search).get("draftId")
      if (!draftID) return { type: "home" }
      return { type: "draft", draftID }
    }
    const id = parts[1]
    if (id) return { type: "session", chatId: id }
    return { type: "home" }
  }

  return { type: "home" }
}

const RECENTLY_CLOSED_LIMIT = 5
const wsKey = (directory: string) => directory

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

interface LayoutStore {
  route: () => LayoutRoute
  ready: () => boolean
  home: {
    selection: () => HomeProjectSelection
    setSelection: (selection: HomeProjectSelection) => void
  }
  projects: {
    list: () => LocalProject[]
    recentlyClosed: () => LocalProject[]
    open: (directory: string) => void
    close: (directory: string) => void
    expand: (directory: string) => void
    collapse: (directory: string) => void
    move: (directory: string, toIndex: number) => void
    rename: (directory: string, name: string) => void
  }
  sidebar: {
    opened: () => boolean
    open: () => void
    close: () => void
    toggle: () => void
    width: () => number
    resize: (width: number) => void
    workspaces: (directory: string) => () => boolean
    setWorkspaces: (directory: string, value: boolean) => void
    toggleWorkspaces: (directory: string) => void
  }
  mobileSidebar: {
    opened: () => boolean
    show: () => void
    hide: () => void
    toggle: () => void
  }
}

function createLayoutStore(): LayoutStore {
  const location = useLocation()
  const [store, setStore] = createStore({
    sidebar: {
      opened: localStorage.getItem("peyt.sidebarOpened") === "true",
      width: Number(localStorage.getItem("peyt.sidebarWidth")) || DEFAULT_SIDEBAR_WIDTH,
      workspaces: loadJson<Record<string, boolean>>("peyt.wsExpanded", {}),
    },
    mobileSidebar: {
      opened: false,
    },
    home: {
      selection: loadJson<HomeProjectSelection>("peyt.homeSelection", { server: "local" }),
    },
    projects: {
      list: fakeWorkspaces,
      recentlyClosed: loadJson<string[]>("peyt.wsRecentlyClosed", []),
    },
  })

  const route = createMemo(() => currentRoute(location.pathname, location.search))

  const persistSidebar = () => {
    localStorage.setItem("peyt.sidebarOpened", String(store.sidebar.opened))
    localStorage.setItem("peyt.sidebarWidth", String(store.sidebar.width))
  }

  const knownWorkspaces = () => new Set(store.projects.list.map((p) => wsKey(p.worktree)))

  return {
    route,
    ready: () => true,
    home: {
      selection: createMemo(() => store.home.selection),
      setSelection(selection: HomeProjectSelection) {
        setStore("home", "selection", selection)
        localStorage.setItem("peyt.homeSelection", JSON.stringify(selection))
      },
    },
    projects: {
      list: createMemo(() => store.projects.list),
      recentlyClosed: createMemo(() =>
        store.projects.recentlyClosed
          .filter((worktree) => knownWorkspaces().has(worktree))
          .map((worktree) => ({
            worktree,
            expanded: false,
            icon: { color: "gray" as const },
          })),
      ),
      open(directory: string) {
        if (store.projects.list.find((x) => wsKey(x.worktree) === wsKey(directory))) return
        setStore("projects", "list", (items) => [
          ...items,
          { worktree: directory, expanded: false, icon: { color: "gray" as const } },
        ])
      },
      close(directory: string) {
        setStore("projects", "list", (items) => items.filter((p) => wsKey(p.worktree) !== wsKey(directory)))
        setStore("projects", "recentlyClosed", (items) =>
          [directory, ...items.filter((d) => wsKey(d) !== wsKey(directory))].slice(0, RECENTLY_CLOSED_LIMIT),
        )
        localStorage.setItem("peyt.wsRecentlyClosed", JSON.stringify(store.projects.recentlyClosed))
      },
      expand(directory: string) {
        setStore("projects", "list", (p) =>
          p.map((item) => (wsKey(item.worktree) === wsKey(directory) ? { ...item, expanded: true } : item)),
        )
      },
      collapse(directory: string) {
        setStore("projects", "list", (p) =>
          p.map((item) => (wsKey(item.worktree) === wsKey(directory) ? { ...item, expanded: false } : item)),
        )
      },
      move(directory: string, toIndex: number) {
        setStore("projects", "list", (items) => {
          const index = items.findIndex((p) => wsKey(p.worktree) === wsKey(directory))
          if (index === -1) return items
          const next = items.slice()
          const [moved] = next.splice(index, 1)
          next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved)
          return next
        })
      },
      rename(directory: string, name: string) {
        setStore("projects", "list", (p) =>
          p.map((item) => (wsKey(item.worktree) === wsKey(directory) ? { ...item, name } : item)),
        )
      },
    },
    sidebar: {
      opened: () => store.sidebar.opened,
      open() {
        setStore("sidebar", "opened", true)
        persistSidebar()
      },
      close() {
        setStore("sidebar", "opened", false)
        persistSidebar()
      },
      toggle() {
        setStore("sidebar", "opened", (x) => !x)
        // 必须在 setStore 之后 persist：updater 内读取的 store.sidebar.opened 还是旧值
        persistSidebar()
      },
      width: () => store.sidebar.width,
      resize(width: number) {
        setStore("sidebar", "width", Math.max(244, Math.min(1000, width)))
        persistSidebar()
      },
      workspaces(directory: string) {
        return () => store.sidebar.workspaces[wsKey(directory)] ?? false
      },
      setWorkspaces(directory: string, value: boolean) {
        setStore("sidebar", "workspaces", wsKey(directory), value)
        localStorage.setItem("peyt.wsExpanded", JSON.stringify(store.sidebar.workspaces))
      },
      toggleWorkspaces(directory: string) {
        const current = store.sidebar.workspaces[wsKey(directory)] ?? false
        setStore("sidebar", "workspaces", wsKey(directory), !current)
        localStorage.setItem("peyt.wsExpanded", JSON.stringify(store.sidebar.workspaces))
      },
    },
    mobileSidebar: {
      opened: () => store.mobileSidebar.opened,
      show() {
        setStore("mobileSidebar", "opened", true)
      },
      hide() {
        setStore("mobileSidebar", "opened", false)
      },
      toggle() {
        setStore("mobileSidebar", "opened", (x) => !x)
      },
    },
  }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext<LayoutStore, Record<string, any>>({
  name: "Layout",
  gate: false,
  init: () => createLayoutStore(),
})
