# 前端重构 Phase 1：Solid app 壳 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Solid app 壳（Titlebar + 64px Rail + MainRegion 路由 outlet + RightDrawer 空壳 + ToastRegion），配置 @solidjs/router 4 路由，创建 PlatformProvider + 空 context store，验证 4 页路由可切换、rail 激活态正确、标题栏拖拽正常。

**Architecture:** 在 Phase 0 的 `src/app/` 基础上扩展。新建 `platform/`（Tauri 适配层）、`context/`（layout/settings/workspace/chat store）、`layout/`（Titlebar/Rail/MainRegion/RightDrawer/ToastRegion）、`pages/`（4 个占位页面）。App.tsx 重构为完整 Provider 树 + 布局骨架。通过 `app.html` 独立入口验证，不修改 `index.html`（旧 shell 保持可用）。

**Tech Stack:** SolidJS 1.9.14、@solidjs/router 0.15.3、@opencode-ai/ui 本地包（v2 组件 + resize-handle + scroll-view）、Tauri 2.0 IPC

**前置条件：** Phase 0 已完成（commit 84e9c35），`@opencode-ai/ui` 本地包可用，ThemeProvider + DialogProvider 已挂载，ButtonV2 渲染验证通过。

## Global Constraints

- core/ 子模块禁止修改
- 仅黑白配色：oc-2 + amoled 两个主题
- 旧 shell（src/index.html + src/main.ts 的 renderShell）不动，通过 app.html 独立入口验证
- rail 导航只有 4 页：messages/groups/work/settings（debug/github/intelligence/plugins/bots/inbox 不保留路由）
- rail 宽度 64px（对齐 opencode sidebar-rail 的 w-16）
- 四列布局保留 CSS 变量 --nav-w / --drawer-w（复用现有 columnResizer.ts 的持久化 key）
- 标题栏用 data-tauri-drag-region 实现拖拽
- solid-js 保持 1.9.14

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `src/app/platform/tauri.ts` | Platform 接口 + 封装 src/api.ts 的 call/onEvent |
| `src/app/platform/index.tsx` | PlatformProvider（Solid context） |
| `src/app/context/layout.tsx` | LayoutStore（面板宽度/折叠/右侧抽屉 tab），借鉴 opencode context/layout.tsx |
| `src/app/context/settings.tsx` | SettingsStore（主题/字号/feature flags），迁移 src/theme.ts 逻辑 |
| `src/app/context/workspace.tsx` | WorkspaceStore（workspaces/channels/currentWsId），空骨架 |
| `src/app/context/chat.tsx` | ChatStore（currentChatId/chatMeta/unread），空骨架 |
| `src/app/layout/Titlebar.tsx` | 标题栏（data-tauri-drag-region + 窗口标题 + 窗口控件） |
| `src/app/layout/Rail.tsx` | 64px 侧边导航栏（4 图标 + 激活态指示 + 头像） |
| `src/app/layout/MainRegion.tsx` | 主内容区（路由 outlet + Suspense） |
| `src/app/layout/RightDrawer.tsx` | 右侧抽屉空壳（可折叠，含 tabs-v2 空壳） |
| `src/app/layout/ToastRegion.tsx` | Toast 区域（复用 @opencode-ai/ui/v2/toast-v2） |
| `src/app/layout/AppLayout.tsx` | 布局骨架组合（Titlebar + Rail + MainRegion + RightDrawer + ToastRegion） |
| `src/app/pages/MessagesPage.tsx` | 占位页面（显示标题 "消息"） |
| `src/app/pages/GroupsPage.tsx` | 占位页面（显示标题 "群组"） |
| `src/app/pages/WorkPage.tsx` | 占位页面（显示标题 "协作"） |
| `src/app/pages/SettingsPage.tsx` | 占位页面（显示标题 "设置"） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/app/App.tsx` | 重构为完整 Provider 树 + AppLayout + Router |
| `src/app/entry.tsx` | 不变（render(() => <App />, root)） |
| `src/app/index.css` | 添加布局相关样式（shell flex、rail、titlebar） |
| `src/app.html` | 不变（Phase 0 已创建） |
| `package.json` | 添加 @solidjs/router 依赖 |

---

### Task 1: PlatformProvider + 空 context store

**Files:**
- Create: `src/app/platform/tauri.ts`
- Create: `src/app/platform/index.tsx`
- Create: `src/app/context/layout.tsx`
- Create: `src/app/context/settings.tsx`
- Create: `src/app/context/workspace.tsx`
- Create: `src/app/context/chat.tsx`

**Interfaces:**
- Consumes: Phase 0 的 `src/api.ts`（call/onEvent/transformBlobURL）、`@opencode-ai/ui/theme/context`（ThemeProvider）
- Produces:
  - `PlatformProvider` + `usePlatform()`：平台抽象层
  - `LayoutProvider` + `useLayout()`：`{ sidebar: { width, collapsed, toggle, resize }, drawer: { width, open, toggle, tab, setTab }, route: () => "messages"|"groups"|"work"|"settings" }`
  - `SettingsProvider` + `useSettings()`：`{ theme, setTheme, fontScale, setFontScale, featureFlags: { useSolidApp } }`
  - `WorkspaceProvider` + `useWorkspace()`：`{ workspaces: () => WorkspaceDto[], currentWsId: () => number|null, setCurrentWs: (id) => void, channels: () => ChannelDto[] }`（空骨架，返回空数组/null）
  - `ChatProvider` + `useChat()`：`{ currentChatId: () => number|null, setCurrentChat: (id) => void, chatMeta: () => ChatMeta|null, unread: () => number }`（空骨架）

- [ ] **Step 1: 安装 @solidjs/router**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npm install @solidjs/router@0.15.3
```

验证：`node_modules/@solidjs/router/package.json` 存在，版本 0.15.3。

- [ ] **Step 2: 创建 src/app/platform/tauri.ts**

```ts
// src/app/platform/tauri.ts
// Platform 接口：封装 Tauri invoke 为统一抽象层
// 借鉴 opencode createPlatform，裁剪 AI 专有能力

import { call, onEvent, transformBlobURL } from "../../api"

export interface Platform {
  // 通用能力
  openExternal(url: string): Promise<void>
  setTitlebar(mode: "light" | "dark"): Promise<void>
  setZoomFactor(factor: number): Promise<void>
  // 存储层
  storage: {
    get(key: string): Promise<string | null>
    set(key: string, val: string): Promise<void>
    delete(key: string): Promise<void>
  }
  // 草稿存储（每会话输入草稿）
  draftStore: {
    get(chatId: number): Promise<string | null>
    set(chatId: number, val: string): Promise<void>
    delete(chatId: number): Promise<void>
  }
  // IM 事件流
  onEvent(typ: string, cb: (payload: { typ: string; [k: string]: unknown }) => void): Promise<() => void>
  // blob URL 转换
  transformBlobURL(path: string): Promise<string>
}

// 创建 Tauri 平台实例
export function createTauriPlatform(): Platform {
  return {
    async openExternal(url: string) {
      const { open } = await import("@tauri-apps/plugin-shell")
      await open(url)
    },
    async setTitlebar(mode) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().setTheme(mode)
    },
    async setZoomFactor(factor) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      await getCurrentWebview().setZoom(factor)
    },
    storage: {
      async get(key) {
        return localStorage.getItem(key)
      },
      async set(key, val) {
        localStorage.setItem(key, val)
      },
      async delete(key) {
        localStorage.removeItem(key)
      },
    },
    draftStore: {
      async get(chatId) {
        return localStorage.getItem(`peyt.draft.${chatId}`)
      },
      async set(chatId, val) {
        localStorage.setItem(`peyt.draft.${chatId}`, val)
      },
      async delete(chatId) {
        localStorage.removeItem(`peyt.draft.${chatId}`)
      },
    },
    async onEvent(typ, cb) {
      return onEvent(typ, cb)
    },
    async transformBlobURL(path) {
      return transformBlobURL(path)
    },
  }
}
```

- [ ] **Step 3: 创建 src/app/platform/index.tsx**

```tsx
// src/app/platform/index.tsx
// PlatformProvider：注入 Platform 实例到 Solid context

import { createContext, useContext, type ParentProps } from "solid-js"
import { createTauriPlatform, type Platform } from "./tauri"

const PlatformContext = createContext<Platform>()

export function PlatformProvider(props: ParentProps) {
  const platform = createTauriPlatform()
  return (
    <PlatformContext.Provider value={platform}>
      {props.children}
    </PlatformContext.Provider>
  )
}

export function usePlatform(): Platform {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error("usePlatform must be used within PlatformProvider")
  return ctx
}
```

- [ ] **Step 4: 创建 src/app/context/layout.tsx**

```tsx
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
```

- [ ] **Step 5: 创建 src/app/context/settings.tsx**

```tsx
// src/app/context/settings.tsx
// SettingsStore：主题/字号/feature flags
// 迁移 src/theme.ts 的主题切换逻辑

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

interface SettingsStore {
  theme: () => string
  setTheme: (theme: string) => void
  fontScale: () => number
  setFontScale: (scale: number) => void
  featureFlags: {
    useSolidApp: () => boolean
  }
}

function createSettingsStore(): SettingsStore {
  // 主题：沿用 opencode 的 localStorage key（ThemeProvider 内部用 'opencode-theme-id'）
  const [theme, setThemeState] = createSignal(
    localStorage.getItem("opencode-theme-id") || "oc-2"
  )

  // 字号：沿用现有 peyt.fontScale
  const [fontScale, setFontScaleState] = createSignal(
    Number(localStorage.getItem("peyt.fontScale")) || 1
  )

  // feature flags
  const useSolidApp = () => localStorage.getItem("peyt.useSolidApp") !== "false"

  return {
    theme,
    setTheme(t: string) {
      localStorage.setItem("opencode-theme-id", t)
      document.documentElement.setAttribute("data-theme", t)
      setThemeState(t)
    },
    fontScale,
    setFontScale(s: number) {
      localStorage.setItem("peyt.fontScale", String(s))
      setFontScaleState(s)
    },
    featureFlags: { useSolidApp },
  }
}

const SettingsContext = createContext<SettingsStore>()

export function SettingsProvider(props: ParentProps) {
  const store = createSettingsStore()
  return <SettingsContext.Provider value={store}>{props.children}</SettingsContext.Provider>
}

export function useSettings(): SettingsStore {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider")
  return ctx
}
```

- [ ] **Step 6: 创建 src/app/context/workspace.tsx**

```tsx
// src/app/context/workspace.tsx
// WorkspaceStore：workspaces/channels/currentWsId
// Phase 1 空骨架，Phase 3+ 接入 Tauri 事件

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"
import type { WorkspaceDto, ChannelDto } from "../../types"

interface WorkspaceStore {
  workspaces: () => WorkspaceDto[]
  currentWsId: () => number | null
  setCurrentWs: (id: number | null) => void
  channels: () => ChannelDto[]
  refreshWorkspaces: () => Promise<void>
  refreshChannels: () => Promise<void>
}

function createWorkspaceStore(): WorkspaceStore {
  const [workspaces, setWorkspaces] = createSignal<WorkspaceDto[]>([])
  const [currentWsId, setCurrentWsId] = createSignal<number | null>(null)
  const [channels, setChannels] = createSignal<ChannelDto[]>([])

  return {
    workspaces,
    currentWsId,
    setCurrentWs: (id) => setCurrentWsId(id),
    channels,
    async refreshWorkspaces() {
      // Phase 3+ 实现：call<WorkspaceDto[]>('list_workspaces')
    },
    async refreshChannels() {
      // Phase 3+ 实现：call<ChannelDto[]>('list_channels', { wsId })
    },
  }
}

const WorkspaceContext = createContext<WorkspaceStore>()

export function WorkspaceProvider(props: ParentProps) {
  const store = createWorkspaceStore()
  return <WorkspaceContext.Provider value={store}>{props.children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceStore {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
```

- [ ] **Step 7: 创建 src/app/context/chat.tsx**

```tsx
// src/app/context/chat.tsx
// ChatStore：currentChatId/chatMeta/unread
// Phase 1 空骨架，Phase 3+ 接入 deltachat 事件

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

interface ChatMeta {
  id: number
  name: string
  isGroup: boolean
  memberCount: number
}

interface ChatStore {
  currentChatId: () => number | null
  setCurrentChat: (id: number | null) => void
  chatMeta: () => ChatMeta | null
  unread: () => number
}

function createChatStore(): ChatStore {
  const [currentChatId, setCurrentChatId] = createSignal<number | null>(null)
  const [chatMeta, setChatMeta] = createSignal<ChatMeta | null>(null)
  const [unread, setUnread] = createSignal(0)

  return {
    currentChatId,
    setCurrentChat: (id) => {
      setCurrentChatId(id)
      if (id === null) setChatMeta(null)
    },
    chatMeta,
    unread,
  }
}

const ChatContext = createContext<ChatStore>()

export function ChatProvider(props: ParentProps) {
  const store = createChatStore()
  return <ChatContext.Provider value={store}>{props.children}</ChatContext.Provider>
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error("useChat must be used within ChatProvider")
  return ctx
}
```

- [ ] **Step 8: 验证 tsc**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npx tsc --noEmit
```

验证：0 errors。如果报 `@tauri-apps/plugin-shell` 或 `@tauri-apps/api/window` 找不到，检查 `src-tauri/Cargo.toml` 和 `package.json` 是否有对应依赖。如果缺失，用动态 import + try/catch 容错（Phase 1 不需要实际调用这些 API）。

- [ ] **Step 9: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
git add src/app/platform/ src/app/context/ package.json package-lock.json
git commit -m "feat(app): add PlatformProvider and empty context stores

- platform/tauri.ts: Platform interface wrapping Tauri invoke (openExternal, storage, draftStore, onEvent)
- platform/index.tsx: PlatformProvider Solid context
- context/layout.tsx: LayoutStore (sidebar width/collapsed, drawer width/open/tab) with persistence
- context/settings.tsx: SettingsStore (theme, fontScale, featureFlags.useSolidApp)
- context/workspace.tsx: WorkspaceStore empty skeleton (Phase 3+ will wire Tauri events)
- context/chat.tsx: ChatStore empty skeleton (Phase 3+ will wire deltachat events)
- Add @solidjs/router 0.15.3 dependency"
```

---

### Task 2: 路由 + 占位页面

**Files:**
- Create: `src/app/pages/MessagesPage.tsx`
- Create: `src/app/pages/GroupsPage.tsx`
- Create: `src/app/pages/WorkPage.tsx`
- Create: `src/app/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `@solidjs/router`（Route 组件）
- Produces: 4 个占位页面组件，供 Task 3 的 AppLayout 路由匹配

- [ ] **Step 1: 创建 4 个占位页面**

创建 `src/app/pages/MessagesPage.tsx`：

```tsx
import type { Component } from "solid-js"

const MessagesPage: Component = () => {
  return (
    <div class="flex-1 flex items-center justify-center text-v2-text-text-base">
      <div class="text-center">
        <h2 class="text-xl font-semibold mb-2">消息</h2>
        <p class="text-v2-text-text-muted text-sm">Phase 2 将迁移消息列表与聊天视图</p>
      </div>
    </div>
  )
}

export default MessagesPage
```

创建 `src/app/pages/GroupsPage.tsx`：

```tsx
import type { Component } from "solid-js"

const GroupsPage: Component = () => {
  return (
    <div class="flex-1 flex items-center justify-center text-v2-text-text-base">
      <div class="text-center">
        <h2 class="text-xl font-semibold mb-2">群组</h2>
        <p class="text-v2-text-text-muted text-sm">Phase 4 将迁移群组列表与管理</p>
      </div>
    </div>
  )
}

export default GroupsPage
```

创建 `src/app/pages/WorkPage.tsx`：

```tsx
import type { Component } from "solid-js"

const WorkPage: Component = () => {
  return (
    <div class="flex-1 flex items-center justify-center text-v2-text-text-base">
      <div class="text-center">
        <h2 class="text-xl font-semibold mb-2">协作</h2>
        <p class="text-v2-text-text-muted text-sm">Phase 5 将迁移工作区视图</p>
      </div>
    </div>
  )
}

export default WorkPage
```

创建 `src/app/pages/SettingsPage.tsx`：

```tsx
import type { Component } from "solid-js"

const SettingsPage: Component = () => {
  return (
    <div class="flex-1 flex items-center justify-center text-v2-text-text-base">
      <div class="text-center">
        <h2 class="text-xl font-semibold mb-2">设置</h2>
        <p class="text-v2-text-text-muted text-sm">Phase 2 将迁移设置页</p>
      </div>
    </div>
  )
}

export default SettingsPage
```

- [ ] **Step 2: 验证 tsc**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npx tsc --noEmit
```

验证：0 errors。

- [ ] **Step 3: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
git add src/app/pages/
git commit -m "feat(app): add 4 placeholder pages (messages/groups/work/settings)"
```

---

### Task 3: 布局骨架组件

**Files:**
- Create: `src/app/layout/Titlebar.tsx`
- Create: `src/app/layout/Rail.tsx`
- Create: `src/app/layout/MainRegion.tsx`
- Create: `src/app/layout/RightDrawer.tsx`
- Create: `src/app/layout/ToastRegion.tsx`
- Create: `src/app/layout/AppLayout.tsx`
- Modify: `src/app/index.css`

**Interfaces:**
- Consumes: Task 1 的 `useLayout()`（面板宽度/折叠）、`useSettings()`（feature flags）、`@opencode-ai/ui/v2/icon-button-v2`、`@opencode-ai/ui/v2/icon`、`@opencode-ai/ui/v2/tabs-v2`、`@opencode-ai/ui/resize-handle`、`@opencode-ai/ui/v2/toast-v2`
- Produces: `AppLayout` 组件（Titlebar + Rail + MainRegion + RightDrawer + ToastRegion）

- [ ] **Step 1: 创建 src/app/layout/Titlebar.tsx**

```tsx
// src/app/layout/Titlebar.tsx
// 标题栏：data-tauri-drag-region + 窗口标题
// 借鉴 opencode components/titlebar.tsx 的 V2 模式

import type { Component } from "solid-js"

const Titlebar: Component = () => {
  return (
    <header
      data-tauri-drag-region
      class="shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible select-none"
      style={{
        // macOS 给红绿灯让位
        "padding-left": "env(titlebar-area-x, 0px)",
      }}
    >
      <div class="h-full flex-1 overflow-hidden flex flex-row items-center gap-2 px-3">
        <span class="text-v2-text-text-base text-[13px] font-semibold">PEYT Chat</span>
      </div>
    </header>
  )
}

export default Titlebar
```

- [ ] **Step 2: 创建 src/app/layout/Rail.tsx**

```tsx
// src/app/layout/Rail.tsx
// 64px 侧边导航栏：4 图标 + 激活态指示 + 头像
// 借鉴 opencode pages/layout/sidebar-shell.tsx 的 rail 结构（w-16）

import type { Component } from "solid-js"
import { useNavigate, useLocation } from "@solidjs/router"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon, type IconName } from "@opencode-ai/ui/v2/icon"

interface RailItem {
  page: "messages" | "groups" | "work" | "settings"
  icon: IconName
  label: string
}

const RAIL_ITEMS: RailItem[] = [
  { page: "messages", icon: "message-circle", label: "消息" },
  { page: "groups", icon: "users", label: "群组" },
  { page: "work", icon: "layout-grid", label: "协作" },
  { page: "settings", icon: "settings-gear", label: "设置" },
]

const Rail: Component = () => {
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = (page: string) => {
    const current = location.pathname.replace(/^\//, "") || "messages"
    return current === page
  }

  return (
    <nav
      data-component="sidebar-rail"
      class="w-16 shrink-0 bg-v2-background-bg-deep flex flex-col items-center overflow-hidden"
    >
      {/* 顶部导航图标 */}
      <div class="flex-1 min-h-0 w-full flex flex-col items-center gap-2 px-2 py-3 overflow-y-auto no-scrollbar">
        {RAIL_ITEMS.map((item) => (
          <IconButtonV2
            variant="ghost-muted"
            size="large"
            icon={<Icon name={item.icon} />}
            state={isActive(item.page) ? "pressed" : undefined}
            aria-pressed={isActive(item.page)}
            aria-label={item.label}
            onClick={() => navigate(`/${item.page}`)}
          />
        ))}
      </div>
      {/* 底部头像 */}
      <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
        <div
          class="w-8 h-8 rounded-full bg-v2-background-bg-layer-01 flex items-center justify-center text-v2-text-text-muted text-xs font-semibold"
          aria-label="用户菜单"
        >
          U
        </div>
      </div>
    </nav>
  )
}

export default Rail
```

- [ ] **Step 3: 创建 src/app/layout/MainRegion.tsx`

```tsx
// src/app/layout/MainRegion.tsx
// 主内容区：路由 outlet + Suspense + sidebar/drawer + ResizeHandle
// 借鉴 opencode pages/layout-new.tsx 的 <main> 结构

import type { Component, ParentProps } from "solid-js"
import { Suspense, Show } from "solid-js"
import { useLayout } from "../context/layout"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"

// 右侧抽屉内部：tabs-v2 空壳
const RightDrawer: Component = () => {
  const layout = useLayout()

  return (
    <div class="flex-1 flex flex-col">
      <TabsV2
        value={layout.drawer.tab()}
        onChange={(tab) => layout.drawer.setTab(tab as "members" | "pin" | "settings")}
      >
        <TabsV2.List>
          <TabsV2.Trigger value="members">成员</TabsV2.Trigger>
          <TabsV2.Trigger value="pin">置顶</TabsV2.Trigger>
          <TabsV2.Trigger value="settings">设置</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="members" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          成员列表
        </TabsV2.Content>
        <TabsV2.Content value="pin" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          置顶消息
        </TabsV2.Content>
        <TabsV2.Content value="settings" class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
          会话设置
        </TabsV2.Content>
      </TabsV2>
    </div>
  )
}

// 主内容区
const MainRegion: Component<ParentProps> = (props) => {
  const layout = useLayout()

  return (
    <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden">
      {/* 频道树空壳（Phase 2+ 填充） */}
      <Show when={!layout.sidebar.collapsed()}>
        <aside
          class="shrink-0 flex flex-col min-h-0 bg-v2-background-bg-base overflow-hidden"
          style={{ width: `${layout.sidebar.width()}px` }}
        >
          <div class="flex-1 flex items-center justify-center text-v2-text-text-faint text-xs">
            频道树
          </div>
        </aside>
        <ResizeHandle
          direction="horizontal"
          size={layout.sidebar.width()}
          min={180}
          max={460}
          onResize={(w) => layout.sidebar.resize(w)}
        />
      </Show>

      {/* 主内容 */}
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-stretch contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>

      {/* 右侧抽屉 */}
      <Show when={layout.drawer.open()}>
        <ResizeHandle
          direction="horizontal"
          size={layout.drawer.width()}
          min={220}
          max={520}
          onResize={(w) => layout.drawer.resize(w)}
        />
        <aside
          class="shrink-0 flex flex-col min-h-0 bg-v2-background-bg-base overflow-hidden"
          style={{ width: `${layout.drawer.width()}px` }}
        >
          <RightDrawer />
        </aside>
      </Show>
    </div>
  )
}

export default MainRegion
```

- [ ] **Step 4: 创建 src/app/layout/ToastRegion.tsx**

```tsx
// src/app/layout/ToastRegion.tsx
// Toast 区域：复用 @opencode-ai/ui/v2/toast-v2

import type { Component } from "solid-js"
import { Toaster as ToastV2Toaster } from "@opencode-ai/ui/v2/toast-v2"

const ToastRegion: Component = () => {
  return <ToastV2Toaster />
}

export default ToastRegion
```

- [ ] **Step 5: 创建 src/app/layout/AppLayout.tsx**

```tsx
// src/app/layout/AppLayout.tsx
// 布局骨架组合：Titlebar + Rail + MainRegion + ToastRegion

import type { Component, ParentProps } from "solid-js"
import Titlebar from "./Titlebar"
import Rail from "./Rail"
import MainRegion from "./MainRegion"
import ToastRegion from "./ToastRegion"

const AppLayout: Component<ParentProps> = (props) => {
  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none
             [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
    >
      <Titlebar />
      <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden">
        <Rail />
        <MainRegion>{props.children}</MainRegion>
      </div>
      <ToastRegion />
    </div>
  )
}

export default AppLayout
```

- [ ] **Step 6: 添加布局样式到 src/app/index.css**

在 `src/app/index.css` 末尾追加：

```css
/* 布局骨架样式 */
[data-component="sidebar-rail"] {
  width: 64px;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Tauri 拖拽区域：标题栏内的交互元素取消拖拽 */
[data-tauri-drag-region] button,
[data-tauri-drag-region] a,
[data-tauri-drag-region] input {
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 7: 验证 tsc**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npx tsc --noEmit
```

验证：0 errors。如果报 `@opencode-ai/ui/v2/icon` 的 `IconName` 类型找不到，检查 `packages/ui/src/v2/components/icon.tsx` 的导出。如果 `IconName` 不存在，改为 `string` 类型。

如果报 `@opencode-ai/ui/v2/tabs-v2` 找不到，检查 `packages/ui/src/v2/components/tabs-v2.tsx` 是否存在。如果不存在，用 `@opencode-ai/ui/v2/tab` 或其他可用 tab 组件替代。

如果报 `@opencode-ai/ui/v2/toast-v2` 找不到，检查 `packages/ui/src/v2/components/toast-v2.tsx` 是否存在。如果不存在，用 `solid-sonner` 的 `Toaster` 直接替代。

- [ ] **Step 8: 修复组件导入问题（如果有）**

根据 Step 7 的 tsc 报错，修复导入路径或类型。常见问题：
- `IconName` 不导出 → 改 `icon: string`
- `TabsV2` 不存在 → 检查实际组件名（可能是 `Tab` 或 `Tabs`）
- `Toaster` 导出名不对 → 检查 `packages/ui/src/v2/components/toast-v2.tsx` 的实际导出

修复后重新运行 `npx tsc --noEmit` 确认 0 errors。

- [ ] **Step 9: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
git add src/app/layout/ src/app/index.css
git commit -m "feat(app): add layout skeleton (Titlebar + Rail + MainRegion + RightDrawer + ToastRegion)

- Titlebar.tsx: data-tauri-drag-region header with window title
- Rail.tsx: 64px sidebar with 4 nav icons (messages/groups/work/settings) + avatar
- MainRegion.tsx: route outlet + Suspense + sidebar/drawer with ResizeHandle
- RightDrawer: empty tabs-v2 shell (members/pin/settings)
- ToastRegion.tsx: v2 toaster
- AppLayout.tsx: composition of all layout components
- index.css: add sidebar-rail width + no-scrollbar + drag-region styles"
```

---

### Task 4: 组装 App.tsx + 路由 + 验证

**Files:**
- Modify: `src/app/App.tsx`

**Interfaces:**
- Consumes: Task 1 的 4 个 context Provider + PlatformProvider、Task 2 的 4 个页面、Task 3 的 AppLayout
- Produces: 完整的 Solid app 壳，4 页路由可切换

- [ ] **Step 1: 重写 src/app/App.tsx**

```tsx
// src/app/App.tsx
// 完整 Provider 树 + Router + AppLayout

import type { Component } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { PlatformProvider } from "./platform"
import { LayoutProvider } from "./context/layout"
import { SettingsProvider } from "./context/settings"
import { WorkspaceProvider } from "./context/workspace"
import { ChatProvider } from "./context/chat"
import AppLayout from "./layout/AppLayout"
import MessagesPage from "./pages/MessagesPage"
import GroupsPage from "./pages/GroupsPage"
import WorkPage from "./pages/WorkPage"
import SettingsPage from "./pages/SettingsPage"

const App: Component = () => {
  return (
    <ThemeProvider defaultTheme="oc-2">
      <Font />
      <DialogProvider>
        <PlatformProvider>
          <SettingsProvider>
            <LayoutProvider>
              <WorkspaceProvider>
                <ChatProvider>
                  <Router root={(props) => <AppLayout>{props.children}</AppLayout>}>
                    <Route path="/" component={() => <Navigate href="/messages" />} />
                    <Route path="/messages" component={MessagesPage} />
                    <Route path="/groups" component={GroupsPage} />
                    <Route path="/work" component={WorkPage} />
                    <Route path="/settings" component={SettingsPage} />
                  </Router>
                </ChatProvider>
              </WorkspaceProvider>
            </LayoutProvider>
          </SettingsProvider>
        </PlatformProvider>
      </DialogProvider>
    </ThemeProvider>
  )
}

export default App
```

- [ ] **Step 2: 验证 tsc**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npx tsc --noEmit
```

验证：0 errors。

- [ ] **Step 3: 验证 vite build**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npm run build
```

验证：build 成功无报错。

- [ ] **Step 4: 验证 dev 模式 app 壳渲染**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
npm run dev
```

在浏览器打开 `http://localhost:1420/app.html`。

验证：
1. 页面显示完整 app 壳：顶部标题栏 + 左侧 64px rail（4 个图标）+ 主内容区 + 右侧抽屉（可折叠）
2. 点击 rail 图标可切换路由（/messages → /groups → /work → /settings）
3. 当前页对应的 rail 图标有激活态（pressed 样式）
4. 主内容区显示对应页面的占位文字（"消息"/"群组"/"协作"/"设置"）
5. 标题栏可拖拽窗口（data-tauri-drag-region 生效）
6. 右侧抽屉的 tabs 可切换（成员/置顶/设置）
7. ResizeHandle 可拖拽调整频道树和右侧抽屉宽度
8. 控制台无报错

停掉 dev server（Ctrl+C）。

- [ ] **Step 5: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat/.worktrees/frontend-refactor-phase0
git add src/app/App.tsx
git commit -m "feat(app): wire up full Solid app shell with Router and Provider tree

- App.tsx: ThemeProvider > Font + DialogProvider > PlatformProvider > SettingsProvider > LayoutProvider > WorkspaceProvider > ChatProvider > Router
- Router root: AppLayout wrapping route children
- Routes: / → redirect /messages, /messages, /groups, /work, /settings
- Phase 1 verification: 4-page routing, rail active state, titlebar drag, drawer tabs, resize handles"
```

---

## Phase 1 验收清单

完成全部 4 个 Task 后，执行以下验收：

- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `npm run build` → 成功无报错
- [ ] `npm run dev` → `http://localhost:1420/app.html` 正常渲染完整 app 壳
- [ ] 4 页路由可切换（/messages → /groups → /work → /settings）
- [ ] rail 激活态正确（当前页图标高亮）
- [ ] 标题栏可拖拽窗口
- [ ] 右侧抽屉 tabs 可切换（成员/置顶/设置）
- [ ] ResizeHandle 可拖拽调整频道树和抽屉宽度
- [ ] 控制台无报错
- [ ] 旧 shell（`http://localhost:1420/` 或 `http://localhost:1420/index.html`）仍可正常访问
- [ ] 4 个 commit 已提交

验收通过后，开始制定 Phase 2（settings 页迁移）的实现计划。

---

## 风险与故障排查

### 风险 1：@opencode-ai/ui/v2 组件导入路径不匹配

**症状**：tsc 报 `Cannot find module '@opencode-ai/ui/v2/xxx'`。

**排查**：检查 `packages/ui/package.json` 的 `exports` 字段，确认 v2 组件的导入路径格式。可能是 `@opencode-ai/ui/v2/components/xxx` 而非 `@opencode-ai/ui/v2/xxx`。

**修复**：根据实际 exports 配置调整导入路径。运行 `ls packages/ui/src/v2/components/` 查看可用组件文件名。

### 风险 2：IconName 类型不存在

**症状**：tsc 报 `IconName` 不是 `@opencode-ai/ui/v2/icon` 的导出成员。

**修复**：把 `icon: IconName` 改为 `icon: string`，或检查 `packages/ui/src/v2/components/icon.tsx` 的实际导出类型名。

### 风险 3：TabsV2 组件 API 不匹配

**症状**：tsc 报 TabsV2 的 props 不匹配（如 `value`/`onChange` 不存在）。

**修复**：检查 `packages/ui/src/v2/components/tabs-v2.tsx` 的实际 API。可能需要用 `@kobalte/core` 的 tabs 或直接用 button 组合实现。

### 风险 4：ResizeHandle 的 props 不匹配

**症状**：tsc 报 ResizeHandle 的 `direction`/`size`/`onResize` 等 props 不存在。

**修复**：检查 `packages/ui/src/components/resize-handle.tsx` 的实际 API（v1 组件）。可能 props 名不同（如 `orientation` 代替 `direction`）。

### 风险 5：@solidjs/router 的 Router root prop 用法

**症状**：Router 的 `root` prop 不接受组件函数，或不包裹路由内容。

**修复**：确认 @solidjs/router 0.15.x 的 API。`root` 接受一个 `(props: ParentProps) => JSX.Element` 的组件，props.children 是路由匹配的内容。

### 风险 6：Tauri 拖拽区域不工作

**症状**：标题栏无法拖拽窗口。

**排查**：确认 `data-tauri-drag-region` 属性正确设置在 header 元素上。Tauri 2.0 需要在 `tauri.conf.json` 的 `app.windows.decorations` 设为 false 才能使用自定义标题栏拖拽。

**修复**：检查 `src-tauri/tauri.conf.json` 的窗口配置。如果 `decorations: true`（有原生标题栏），则 `data-tauri-drag-region` 无需生效——原生标题栏已在工作。Phase 1 验收只要求"标题栏拖拽正常"，原生或自定义均可。
