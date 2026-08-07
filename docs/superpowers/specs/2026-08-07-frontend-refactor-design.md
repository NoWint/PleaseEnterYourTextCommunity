# 前端完全重构设计：对齐 opencode 桌面端 UI

- **日期**：2026-08-07
- **状态**：已确认，待落实现计划
- **范围**：peytchat 前端整体重构（src/ 全量 + packages/ui 引入 + vite 配置升级）
- **参考实现**：`/Users/xiatian/Downloads/opencode-dev`（opencode 桌面端）
- **复用包**：`@opencode-ai/ui`（MIT，源码型发布）

---

## 1. 架构与目标边界

### 1.1 重构目标

把 peytchat 前端从 **vanilla TS DOM + Solid 岛双轨制** 重构为 **统一 SolidJS app**，视觉与交互质感完全对齐 opencode 桌面端，直接复用 `@opencode-ai/ui` 本地源码包。

### 1.2 复用边界

| 来源 | 处理方式 |
|---|---|
| `opencode-dev/packages/ui` | **整体复制进 `packages/ui/`**，作为本地 workspace 包，保留源码可改可裁剪 |
| `packages/ui` 的 v1 组件 | **不引入**（v1 是旧布局兼容路径，peytchat 无历史包袱） |
| `packages/ui` 的 v2 组件 + context + theme + icons + fonts + hooks | **全量引入** |
| `opencode-dev/packages/app` | **不搬**（强耦合 AI session + SDK sidecar + Effect-TS，IM 场景不匹配） |
| `opencode-dev/packages/session-ui` | **不搬**（绑定 AI markdown-stream/tool-call/diff 模型） |
| `opencode-dev/packages/desktop` | **不搬**（Electron IPC，Tauri 项目不适用） |
| opencode 的布局骨架结构（`layout-new`/`sidebar-shell`/`titlebar`） | **借鉴结构，自建实现**（数据线重接到 Tauri invoke） |

### 1.3 目标架构

```
peytchat/
├── packages/
│   └── ui/                    ← 从 opencode-dev 复制，本地 workspace 包（@opencode-ai/ui）
│       └── (仅保留 v2 + theme + context + icons + fonts + hooks，删 v1)
├── src/
│   ├── app/                   ← 新 Solid app 壳（替代 src/main.ts 的 renderShell）
│   │   ├── App.tsx            ← 根组件：Provider 树 + 布局骨架
│   │   ├── entry.tsx          ← render(() => <App />, root)
│   │   ├── index.css          ← @import ui 包 tailwind + v2 styles + app 层样式
│   │   ├── platform/          ← Tauri PlatformProvider（替代 opencode 的 window.api）
│   │   ├── context/           ← Solid context store（chat/channel/workspace/settings/tabs/layout/command）
│   │   ├── layout/            ← Titlebar + SidebarShell + MainRegion + RightDrawer + ToastRegion
│   │   └── pages/             ← 各页面 Solid 实现（messages/groups/work/settings）
│   ├── chat-solid/            ← 保留并升级（复用已有 timeline/composer/messages，换用 v2 组件）
│   ├── api.ts                 ← 保留（Tauri invoke 封装），被 platform/ 包装
│   ├── state.ts / types.ts    ← 迁移到 Solid context store 后删除
│   └── (旧 shell/pages/components/views/work/ 逐步删除)
├── src-tauri/                 ← 不动
├── core/                      ← 不动（submodule）
└── vite.config.ts             ← 升级 Vite 7 + 配置 solidPlugin 转译 packages/ui + @tailwindcss/vite
```

### 1.4 Provider 树

借鉴 opencode `AppBaseProviders` + `AppInterface`，裁剪 AI 专有项：

```
MetaProvider                         (solid-router meta，可选)
└─ ThemeProvider                     ← @opencode-ai/ui/theme/context（必需，注入主题 CSS 变量）
   └─ Font                           ← @opencode-ai/ui/font（字体加载）
      └─ I18nProvider                ← @opencode-ai/ui/context（可选，IM 文案本地化）
         └─ PlatformProvider         ← 自建，封装 Tauri invoke 为 Platform 接口
            └─ DialogProvider        ← @opencode-ai/ui/context/dialog（命令式 Dialog）
               └─ FileComponentProvider  ← @opencode-ai/ui/context/file（可选）
                  └─ ChatStoreProvider   ← 自建，迁移自 chat-solid/state/chatStore.ts
                     └─ TabsProvider     ← 自建，借鉴 opencode context/tabs.tsx（标签页状态）
                        └─ LayoutProvider ← 自建，借鉴 opencode context/layout.tsx（面板宽度/折叠）
                           └─ CommandProvider ← 自建，借鉴 opencode context/command.tsx（命令面板/快捷键）
                              └─ <AppLayout />  ← 路由分发 + 页面渲染
```

**删除的 opencode Provider**（IM 场景不需要）：`QueryProvider`（@tanstack/solid-query，无 sidecar）、`WslServersProvider`、`ServerProvider`、`GlobalProvider`、`SettingsProvider` 中的 AI 设置项（保留通用设置）、`ConnectionGate`、`PermissionProvider`、`NotificationProvider`（IM 用 deltachat 自带通知）。

### 1.5 不做的事（YAGNI）

- 不引入 `@opencode-ai/sdk` / `@opencode-ai/client` / vendored tgz
- 不引入 Effect-TS / `@tanstack/solid-query` / drizzle-orm
- 不搬 AI 专有组件：markdown-stream、tool-call-card、diff-review、terminal-panel、file-tree-v2、prompt-input-v2（AI composer）
- 不引入 38 个内置主题，只保留 `oc-2` + amoled（符合"仅黑白配色"约束）
- 不做命令面板的 server session 条目（IM 无此概念）

### 1.6 成功标准

1. `packages/ui` 本地包可用，`import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"` 在 peytchat 里正常渲染且质感与 opencode 桌面端一致
2. `ThemeProvider` 注入 `oc-2` 主题后，所有 v2 组件的 `--v2-*` CSS 变量正确生效
3. 新 Solid app 壳替换 `src/main.ts` 的 `renderShell`，4 个页面（rail 导航）可在新壳内渲染
4. chat 岛升级到 v2 组件后，消息气泡/输入框/对话框质感对齐 opencode
5. `tsc 0 errors` + `vite build` 成功 + 运行时无 "Theme context must be used within a provider" 类报错
6. 旧 vanilla 代码在迁移完成后可整批删除，无残留依赖

---

## 2. 组件复用清单

v2 组件为骨架，v2 缺失的能力从 v1 补充（opencode app 自身也是 v1/v2 混用）。

### 2.1 v2 组件 → peytchat 场景映射

| v2 组件 | peytchat 场景 | 处理 |
|---|---|---|
| `button-v2` | 全局按钮 | 直接用 |
| `icon-button-v2` | rail 导航、工具栏、标题栏控件 | 直接用 |
| `icon`（v2） | 全局 SVG 图标 | 直接用 |
| `avatar-v2` | 会话/成员/联系人头像 | 直接用 |
| `project-avatar-v2` | 工作区头像 | 直接用 |
| `badge-v2` | 未读数、角色标签、在线状态 | 直接用 |
| `dialog-v2` | 创建群组、查看群组、确认删除、扫码 | 直接用 |
| `menu-v2` | 下拉菜单、右键菜单 | 直接用 |
| `tooltip-v2` | 按钮提示 | 直接用 |
| `tabs-v2` | 右侧抽屉 members/pin/settings | 直接用 |
| `switch-v2` | 设置开关 | 直接用 |
| `checkbox-v2` | 多选、设置项 | 直接用 |
| `radio-v2` | 设置单选 | 直接用 |
| `select-v2` | 主题选择、通知策略 | 直接用 |
| `text-input-v2` | 搜索框、登录、表单输入 | 直接用 |
| `textarea-v2` | chat composer 文本域 | 直接用 |
| `inline-input-v2` | 频道/群组重命名 | 直接用 |
| `field-v2` | 设置表单容器 | 直接用 |
| `segmented-control-v2` | 工作区视图切换（看板/列表/日历/时间线） | 直接用 |
| `split-button-v2` | 发送按钮（主发送 + 附件下拉） | 直接用 |
| `accordion-v2` | 频道树折叠、设置分组 | 直接用 |
| `divider-v2` | 列表分组分隔 | 直接用 |
| `tab-state-indicator` | rail 激活态指示 | 直接用 |
| `keybind-v2` | 设置页快捷键展示 | 直接用 |
| `progress-circle-v2` | 文件/语音上传进度 | 直接用 |
| `loader-v2` / `text-shimmer-v2` | 加载占位 | 直接用 |
| `toast-v2` | 全局通知 | 直接用（配 `ToastRegion`） |
| `wordmark-v2` | 标题栏品牌字 | 直接用 |

### 2.2 v2 不用（AI 专有，删除）

`diff-changes-v2`、`file-tree-v2`、`line-comment-v2` —— 从 `packages/ui/src/v2/components/` 删除，连带 `.css`/`.stories.tsx`。

### 2.3 v1 补充（v2 无对应物，从 v1 引入）

| v1 组件 | peytchat 场景 | 路径 |
|---|---|---|
| `resize-handle` | 四列布局拖拽分隔（ws-rail/channel-tree/chat-main/right-drawer） | `@opencode-ai/ui/resize-handle` |
| `scroll-view` | 消息时间线、会话列表滚动 | `@opencode-ai/ui/scroll-view` |
| `popover` | reaction picker、@mention 弹层 | `@opencode-ai/ui/popover` |
| `context-menu` | 消息右键菜单（复制/回复/置顶/删除） | `@opencode-ai/ui/context-menu` |
| `image-preview` | 图片消息点击放大 | `@opencode-ai/ui/image-preview` |
| `list` + `useFilteredList` | 联系人选择器、成员选择器 | `@opencode-ai/ui/list` + `@opencode-ai/ui/hooks` |

### 2.4 自建组件（ui 包无对应，业务定制）

| 组件 | 用途 | 位置 |
|---|---|---|
| `MessageBubble` | IM 消息气泡（含 reaction ↑/+/★/!、pin/reply、quote、@mention、code hljs） | `src/chat-solid/timeline/rows/`（已存在，升级样式） |
| `MessageTimeline` | 虚拟滚动时间线 | `src/chat-solid/timeline/`（已存在） |
| `Composer` | IM 输入区（语音/文本/回复/引用/@mention） | `src/chat-solid/composer/`（已存在，换 textarea-v2 + split-button-v2） |
| `ChannelTree` | 频道树（workspace > channel 层级） | `src/app/layout/ChannelTree.tsx`（新建） |
| `ChatHeader` | 会话头（名称/成员数/操作） | `src/chat-solid/components/ChatHeader.tsx`（已存在） |
| `RightDrawer` | 右侧抽屉（members/pin/settings 三 tab） | `src/app/layout/RightDrawer.tsx`（新建） |
| `MemberList` / `MemberDetail` | 成员列表/详情 | `src/app/components/`（新建，迁移自 `src/components/memberDetail.ts`） |
| `ContactPicker` | 联系人选择 | `src/app/components/`（新建，迁移自 `src/components/contactsPicker.ts`） |

### 2.5 删除的现有 vanilla 组件

`src/components/` 下与 v2 重复的：`avatar.ts`、`commandPalette.ts`、`contactCard.ts`、`gallery.ts`、`icon.ts`、`navBanner.ts`、`search.ts`、`ui.ts`、`viewToggle.ts`、`tdesignIcons.ts` 等，迁移完成后整批删除。保留的仅 `cloudSphere.ts`/`wordCloud.ts`/`summaryBubble.ts`/`summaryDashboard.ts`（工作区可视化，无 v2 对应），改为 Solid 组件。

---

## 3. 主题与样式

### 3.1 全局 CSS 入口（`src/app/index.css`）

```css
@import "@opencode-ai/ui/styles/tailwind";        /* base.css reset + @theme 注册（v1 组件样式冗余但无害） */
@import "@opencode-ai/ui/v2/styles/tailwind.css";  /* v2 colors.css + theme.css（真源） */
@import "tw-animate-css";                           /* 动画工具类 */
@import "./app.css";                                /* app 层局部覆盖 */
```

**为何保留 v1 的 `styles/tailwind` 入口**：虽然 1.2 节明确"v1 组件不引入"，但 `@opencode-ai/ui/styles/tailwind` 这个入口里聚合了 `base.css`（CSS reset + `data-tauri-drag-region` 兼容 + iOS 输入框防缩放）和 `@theme` 注册块（Tailwind v4 主题映射）。这两个是 v2 组件正常工作的前置依赖。v1 组件的 `.css` 会一起被 `@import` 进来，但因为没有 v1 组件实例，选择器不命中，属于无害冗余。若后续验证 v2 能脱离 v1 入口独立工作，可在 Phase 7 清理时移除该 import。

### 3.2 Tailwind v4 CSS-first 配置

- **删除** `tailwind.config.ts`（扫描范围过窄，仅 `./chat-solid/**`）
- 改用 CSS-first：在 `index.css` 用 `@source` 显式声明扫描范围
  ```css
  @source "../../packages/ui/src";
  @source "./src/app";
  @source "./src/chat-solid";
  ```
- `@tailwindcss/vite` 插件接入 `vite.config.ts`

### 3.3 主题策略（黑白配色约束）

- **仅保留 2 个主题**：`oc-2`（暗）+ `amoled`（纯黑），从 `packages/ui/src/theme/default-themes.ts` 中保留这两个，其余 36 个删除
- `ThemeProvider` 挂在根，`defaultTheme="oc-2"`
- 主题切换走 `localStorage["peyt.theme"]`（沿用现有 key，迁移 `src/theme.ts` 逻辑到 ThemeProvider）
- 字体：`Inter`（sans）+ `JetBrainsMono Nerd Font Mono`（mono），从 `packages/ui/src/assets/fonts/` 加载，由 `Font` 组件管理

### 3.4 删除的现有样式文件

| 文件 | 处理 |
|---|---|
| `src/styles.css` | 迁移有用规则到 `src/app/app.css` 后删除 |
| `src/theme.ts` / `src/msgTheme.ts` | 逻辑迁入 ThemeProvider + app.css 后删除 |
| `src/chat-solid/vendor/styles/colors.css` / `theme.css` | 删除（由 ui 包 `v2/styles/` 提供） |
| `src/chat-solid/vendor/icon-definitions.ts` | 删除（由 ui 包 `icon` 组件提供） |
| `src/chat-solid/styles/chat.css` | 保留但重写，用 `--v2-*` 变量替代手写色值 |

### 3.5 色板对齐（project_memory 约束）

现有约束色板 `#0d0d0d/#0a0a0a/#1a1a1a/#222/#1f1f1f/#161616/#e5e5e5/#888/#555` 映射到 v2 token：

| 现有色值 | v2 token |
|---|---|
| `#0d0d0d` / `#0a0a0a` | `--v2-background-bg-deep` |
| `#1a1a1a` / `#161616` | `--v2-background-bg-base` |
| `#222` / `#1f1f1f` | `--v2-background-bg-layer-01` |
| `#e5e5e5` | `--v2-text-text-base` |
| `#888` | `--v2-text-text-muted` |
| `#555` | `--v2-text-text-faint` |

字号 `11/13/9/10px` + 字重 `500/600` 保留，通过 `app.css` 的 `[data-component="..."]` 局部覆盖对齐。

---

## 4. 路由与状态迁移

### 4.1 路由方案

引入 `@solidjs/router`（opencode 同款），替代 `navPanel.ts` 的手动 `switch(state.currentPage)`。

```
/              → 重定向到 /messages
/messages      → MessagesPage（单聊/私聊/非工作区群）
/groups        → GroupsPage（工作区群聊）
/work          → WorkPage（工作协作模式）
/settings      → SettingsPage
/login         → LoginPage（未登录态）
```

rail 导航的 4 页对应 4 个路由，`state.currentPage` 废弃。

**次级页面处理决策**：现有 `navPanel.ts` 里的 debug/github/intelligence/plugins/bots/inbox 等页面，在重构中**全部移除路由**。理由：
- debug/github/intelligence/plugins/bots 属于实验性/未稳定功能，不在 4 页 rail 导航的核心范围内
- inbox 功能由 deltachat 自带通知 + messages 页未读会话覆盖，无需独立页
- 若后续需要恢复，作为新路由增量添加，不影响主架构

Phase 7 清理时删除对应的 `src/pages/{bots,debug,github,inbox,intelligence,plugins}Page.ts`。

### 4.2 状态管理迁移

| 现有 | 迁移目标 |
|---|---|
| `src/state.ts`（全局可变 `state: AppState`） | 拆分为多个 Solid context store |
| `src/persist.ts`（`saveState`） | `@solid-primitives/storage` + `persisted` helper（借鉴 opencode `utils/persist.ts`） |
| `src/chat-solid/state/chatStore.ts` | 保留，升级为 `ChatStoreProvider` 挂到 Provider 树 |
| `src/chat-solid/state/signals.ts` | 合并入 ChatStoreProvider |

新建 context store（`src/app/context/`）：

| Store | 职责 | 借鉴 |
|---|---|---|
| `workspace.tsx` | workspaces/channels/currentWsId | opencode `context/global.tsx` 结构 |
| `chat.tsx` | currentChatId/chatMeta/unread | 已有 chatStore 迁移 |
| `tabs.tsx` | 多会话标签页 | opencode `context/tabs.tsx` |
| `layout.tsx` | 面板宽度/折叠/右侧抽屉 tab | opencode `context/layout.tsx` |
| `settings.tsx` | 主题/字号/通知/feature flags | opencode `context/settings.tsx`（裁剪 AI 项） |
| `command.tsx` | 命令注册 + 快捷键 | opencode `context/command.tsx` |

### 4.3 持久化 scope

按 opencode 模式做 server/workspace scope 持久化，但 peytchat 无 server 概念，scope 简化为 `peyt:<store-name>`。

---

## 5. 页面迁移顺序

按依赖深度与风险递增排序，每步可独立验收、可回退。

| 序 | 迁移对象 | 验收点 | 依赖 |
|---|---|---|---|
| 1 | settings 页 | v2 表单组件（switch/select/radio/field）渲染正常，主题切换生效 | Phase 0/1 |
| 2 | messages 页 + chat 岛升级 | chat-solid 挂载，MessageBubble/Composer 换 v2 组件，reaction/pin/reply 正常 | settings |
| 3 | groups 页 | 群组列表 + 创建群组 dialog + 查看群组 dialog + 成员管理 | messages |
| 4 | work 页 | 工作区 segmented-control 视图切换（kanban/list/calendar/timeline）+ activity | groups |
| 5 | 登录页 | 登录表单 + 扫码 + secure_join 流程 | — |
| 6 | 命令面板 | Cmd+K 命令面板（会话切换/操作命令，无 AI 条目） | 全部页面 |
| 7 | 旧代码清理 | 删除 `src/shell/`、`src/pages/`、`src/views/`、`src/components/`（保留可视化组件改 Solid）、`src/state.ts`/`persist.ts`/`theme.ts` | 全部迁移完成 |

---

## 6. IPC 适配层

### 6.1 Platform 接口（借鉴 opencode `createPlatform`）

新建 `src/app/platform/tauri.ts`，把现有 `src/api.ts` 的 `invoke` 封装包装成 `Platform` 接口，注入 `PlatformProvider`。

```ts
export interface Platform {
  storage: { get(key): Promise<string|null>; set(key, val): Promise<void>; delete(key): Promise<void> }
  draftStore: { get(chatId): Promise<string|null>; set(chatId, val): Promise<void>; delete(chatId): Promise<void> }
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  readClipboardImage(): Promise<string|null>
  setTitlebar(mode: "light"|"dark"): Promise<void>
  setZoomFactor(factor: number): Promise<void>
  // IM 专有（deltachat 命令）
  chat: { createChatByEmail, acceptChat, blockChat, deleteChat, leaveGroup, markChatNoticed, getChatInfo, ... }
  securejoin: { getQr, join }
  profile: { get, generateQr, logout }
  message: { delete }
  workspace: { update, delete }
  channel: { update, delete }
}
```

### 6.2 适配映射

| opencode `window.api.*` | peytchat 实现 |
|---|---|
| `store-get/set/delete` | Tauri invoke `store_get`/`store_set`/`store_delete`（或 localStorage fallback） |
| `draft-get/set/delete` | Tauri invoke 对应命令（或 localStorage） |
| `open-external` | `@tauri-apps/plugin-shell` `open()` |
| `open-path`/`reveal-path` | `@tauri-apps/plugin-shell` `open()`/`revealItemInDir()` |
| `read-clipboard-image` | `@tauri-apps/plugin-clipboard-manager` |
| `set-titlebar` | Tauri `window.setTheme()` 或原生标题栏联动 |
| `set-zoom-factor` | Tauri `webview.setZoom()` |
| `kill-sidecar`/`updater-*`/`wsl-*` | 不需要（无 sidecar） |

### 6.3 事件流

deltachat 事件（收到消息/会话变更/连接状态）通过 Tauri event（`listen`）订阅，转成 Solid signal，注入 ChatStoreProvider。替代 opencode 的 `sdk().event.listen`。

---

## 7. 分阶段计划

| Phase | 内容 | 产出 | 验收 |
|---|---|---|---|
| **0. 基础设施** | 复制 `packages/ui`（裁剪 v1/AI 组件）；升级 Vite 7 + solid-plugin 转译配置 + `@tailwindcss/vite`；`index.css` 三行 import；根挂 ThemeProvider + DialogProvider；空 `<App />` 渲染一个 `<ButtonV2>` | `tsc 0 errors` + `vite build` 通过 + ButtonV2 在 oc-2 主题下渲染质感对齐 | 视觉验收 |
| **1. app 壳** | Titlebar + SidebarShell（64px rail + 4 图标）+ MainRegion（路由 outlet）+ RightDrawer 空壳 + ToastRegion；@solidjs/router 4 路由；PlatformProvider + 空 context store | 4 页路由可切换，rail 激活态正确，标题栏拖拽/窗口控件正常 | 路由验收 |
| **2. settings 页** | 迁移 settingsPage.ts → Solid；主题切换 + 字号 + 通知 + feature flags；用 v2 switch/select/radio/field | 设置项生效，主题切换实时应用 | 功能验收 |
| **3. messages + chat 岛升级** | chat-solid 挂载到 /messages 路由；MessageBubble/Composer/ChatHeader 换 v2 组件；reaction/pin/reply/quote/@mention/code hljs 全保留；ChatStoreProvider 接 Tauri 事件 | 消息收发正常，质感对齐 opencode | 完整 IM 验收 |
| **4. groups 页** | 群组列表 + createGroupDialog（v2 dialog-v2）+ viewGroupDialog + memberPicker（v1 list + useFilteredList）+ 成员管理 | 群组 CRUD 正常 | 功能验收 |
| **5. work 页** | 工作区 segmented-control 4 视图（kanban/list/calendar/timeline）+ activity + cardDetail；cloudSphere/wordCloud/summaryBubble 改 Solid | 视图切换正常，工作区数据流转 | 功能验收 |
| **6. 登录页 + 命令面板** | 登录表单 + 扫码 + secure_join；Cmd+K 命令面板（会话切换/操作命令） | 登录流程通，命令面板可用 | 端到端验收 |
| **7. 清理** | 删除 `src/shell/`/`src/pages/`/`src/views/`/旧 `src/components/`/`state.ts`/`persist.ts`/`theme.ts`/`msgTheme.ts`/`styles.css`/`chat-solid/vendor/`；移除 `peyt.useSolidChat` flag | 旧代码 0 残留，`tsc` + `vite build` 通过 | 体积验收 |

---

## 8. 风险与回退

### 8.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Vite 5.4 → 7 升级 | 构建配置/插件兼容性 | Phase 0 先验证空壳构建通过再继续 |
| `solid-js@1.9.14`（peytchat）vs `1.9.10`（opencode 带 patch） | 细微行为差异 | 保持 1.9.14 不打 patch，Phase 0 跑通 Storybook 验证；若遇问题再评估打 patch |
| Tailwind v4 `@source` 扫描范围 | 类名漏扫/样式失效 | 显式 `@source` 指向 `packages/ui/src` + `src/app` + `src/chat-solid` |
| `ThemeProvider` 的 `import.meta.glob("./themes/*.json")` | 主题加载失败 | 只保留 oc-2/amoled 两个 JSON，放 `packages/ui/src/theme/themes/` |
| chat 岛升级破坏现有 IM 功能 | 消息收发/reaction/回复回归 | Phase 3 保留 `peyt.useSolidChat=false` 回退路径，验收通过后再固化 |
| Tauri 2.0 vs Electron IPC 差异 | Platform 接口适配遗漏 | Phase 1 先建 Platform 接口骨架，逐命令补全 |
| 工作区可视化组件改 Solid | cloudSphere/wordCloud 重写成本 | Phase 5 评估是否保留，若成本高可暂时 vanilla 嵌入 Solid |

### 8.2 回退策略

- **全局 feature flag**：扩展现有 `peyt.useSolidChat` 为 `peyt.useSolidApp`（localStorage，默认 `true`）。
  - `true` → 新 Solid app 壳
  - `false` → 旧 vanilla shell（`src/main.ts` 的 `renderShell`）
- 每个 Phase 完成后保留旧实现不删，直到 Phase 7 统一清理。
- Phase 0–2 期间，旧 shell 完全可用，新 app 壳可并行开发。
- Phase 3（chat 岛升级）是最关键回退点：若验收失败，`peyt.useSolidChat=false` 回到旧 chat 岛，不影响其他页面。

### 8.3 不可回退点

Phase 7（清理）执行后不可回退。执行前需满足：全部 6 个 Phase 验收通过 + 连续运行 24h 无回归。

---

## 附录 A：现有项目关键事实

### A.1 技术栈现状

- 框架：SolidJS 1.9.14（仅 `src/chat-solid/` 岛）+ vanilla TS DOM（shell/pages/components）
- 构建：Vite 5.4 + `vite-plugin-solid`
- 桌面：Tauri 2.0
- 样式：Tailwind v4（扫描仅 `./chat-solid/**`）+ 原生 CSS
- 测试：Vitest 3 + jsdom + `@solidjs/testing-library`

### A.2 现有双轨制

- **vanilla 侧**：`src/main.ts` → `renderShell` → `navPanel.ts` 路由分发 → `src/pages/*Page.ts`
- **Solid 岛**：`src/chat-solid/index.tsx` → `mountChat(el)`，由 `navPanel.ts` 的 `useSolidChat()` flag 决定挂载
- **flag**：`localStorage["peyt.useSolidChat"]`（默认开启，`'false'` 才关）

### A.3 后端链路

前端 TS（`src/api.ts` 调 `invoke`）→ Tauri 命令（`src-tauri/src/commands/`）→ `deltachat` crate（来自 `core/` submodule）→ IMAP/SMTP/SQLite/E2EE

### A.4 已 vendored 的 opencode 资产（将被真正的 ui 包替代）

- `src/chat-solid/vendor/styles/colors.css`、`theme.css`（v2 token CSS）
- `src/chat-solid/vendor/icon-definitions.ts`

---

## 附录 B：opencode-dev 关键事实

### B.1 技术栈

- 桌面壳：Electron 42.3.3（非 Tauri）
- UI 框架：SolidJS 1.9.10（带 patch）+ `@solidjs/router`
- 构建：Vite 7.1.4 + `@tailwindcss/vite`
- 样式：Tailwind v4 CSS-first（无 `tailwind.config.js`）+ CSS variables（OKLCH）
- 包管理：Bun 1.3.14 workspaces + Turbo
- 数据：`effect@4.0.0-beta.83` + `@tanstack/solid-query` + drizzle-orm

### B.2 `@opencode-ai/ui` 包特性

- 版本 1.18.13，MIT，`publishConfig.access: public`
- **源码型发布**：无根 `.` 导出，按子路径 import（`@opencode-ai/ui/button`、`@opencode-ai/ui/v2/button-v2`）
- **无 prebuild bundle**：运行时直接用 `.tsx` 源码，消费方 bundler 负责转译
- **强依赖 Vite**：`theme/context.tsx` 用 `import.meta.glob("./themes/*.json")`
- **peerDeps**：`solid-js@^1.9.0` + `@solidjs/meta@^0.29.0`
- **必需 Provider**：`ThemeProvider`（否则 CSS 变量缺失，样式塌）、`DialogProvider`（`useDialog()` 强制）、`FileComponentProvider`（`useFileComponent()` 强制）

### B.3 不可搬的强耦合

- `packages/app`：依赖 `@opencode-ai/sdk` + vendored client tgz + Effect-TS + sidecar 模型
- `packages/session-ui`：绑定 AI markdown-stream/tool-call/diff
- `packages/desktop`：Electron IPC（`ipcMain`/`contextBridge`）

---

## 附录 C：决策记录

### C.1 为何选方案 A（本地源码包 + 自建 app 壳）

1. **质感对齐达成**——用同一个 `@opencode-ai/ui` 本地源码包 + 主题系统 + 布局骨架结构，视觉/交互质感与 opencode 桌面端一致。
2. **避免业务模型错配**——IM 的 chat/channel/workspace 与 AI session 是两套模型，自建 app 壳比强行复刻 `packages/app` 更干净。
3. **可控渐进**——沿用已有 `peyt.useSolidChat` flag 思路扩展为全局 feature flag，逐页迁移、可回退、可灰度。
4. **复用边界清晰**——`packages/ui`（组件库 + 主题 + icons + fonts + hooks + context）整体复用；`packages/app`/`session-ui`/`desktop` 不搬，只借鉴结构。

### C.2 为何不选方案 B（保留 vanilla shell + 选择性引入）

vanilla/Solid 双轨长期共存，`state.ts` 全局可变对象与 Solid 响应式割裂，质感对齐不彻底（shell 骨架的交互细节仍是手写 DOM），违背"完全重构"意图，技术债越积越重。

### C.3 为何不选方案 C（全量复刻 packages/app）

opencode app 强依赖 `@opencode-ai/sdk` + vendored client tgz + Effect-TS + `@tanstack/solid-query` + sidecar 模型，IM 场景下大量 store（server-sync/session-cache/event-reducer/eviction…）是死代码或需重写；`session-ui` 的 markdown-stream/tool-call/diff 与 IM 消息流不匹配；依赖矩阵爆炸；迁移风险极高。
