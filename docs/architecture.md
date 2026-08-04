# PEYT Chat — 架构文档

> 说明 PEYT Chat 的系统架构:技术栈、分层、模块职责、数据流、持久化与关键子系统。

---

## 1. 概述

PEYT Chat(工程名 `peytchat`,仓库 PleaseEnterYourTextCommunity)是一款基于 **deltachat** 的桌面即时通讯与团队协作应用。消息通过 P2P 邮件协议(deltachat core)在多端间同步,不依赖中心服务器;工作区/频道/卡片等团队数据结构存储在本地 SQLite。

- **产品形态**:桌面应用(macOS / Windows / Linux)
- **技术栈**:Tauri 2 + Rust + Vite + TypeScript(无前端框架)
- **核心依赖**:`deltachat`(本地 crate `../core`)、`portable-pty`(终端)、`rusqlite`(SQLite)、`reqwest`(插件市场)、`xterm.js`(终端 UI)

```
┌──────────────────────────────────────────────────────────────┐
│                     WebView (前端, src/)                       │
│  shell · pages · work · chat · plugins · components · theme   │
└──────────────┬───────────────────────────────┬────────────────┘
               │  Tauri IPC                     │  事件
        invoke(cmd, args)                listen('dc-event')
               │                             │
┌──────────────▼─────────────────────────────▼────────────────┐
│                    Rust 主进程 (src-tauri/src/)               │
│  commands.rs · db.rs · events.rs · plugins.rs · terminal.rs  │
│            state.rs (AppState) · dto.rs · error.rs           │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────────────┐  │
│  │ deltachat   │  │ SQLite   │  │ 插件市场 / PTY / 文件系统 │  │
│  │ core (P2P)  │  │ peyt.db  │  │                        │  │
│  └─────────────┘  └──────────┘  └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 进程与线程模型

| 组成 | 说明 |
|---|---|
| Rust 主进程 | Tauri 应用;管理 deltachat Accounts、SQLite、插件、PTY;`events.rs` 的转发 task 常驻后台把 deltachat 事件推给前端 |
| WebView | 前端 UI 与交互;与 Rust 通过 IPC 双向通信 |
| 后台线程 | deltachat IO 线程;`terminal.rs` 每个会话一个读线程;`db.rs` 用 `spawn_blocking` 执行 SQLite 写操作 |

`AppState`(`state.rs`)是全局共享状态,经 `app.manage(state)` 注入:

```rust
pub struct AppState {
    accounts: Arc<Mutex<Accounts>>,      // deltachat 多账号
    current_id: StdMutex<Option<u32>>,   // 当前选中账号
    db: Arc<Db>,                         // SQLite 封装
    plugins: PluginManager,              // 插件磁盘管理
    terminals: TerminalSessions,         // PTY 会话表
}
```

---

## 3. 后端模块职责

| 模块 | 职责 |
|---|---|
| `lib.rs` | 应用装配:setup 初始化 AppState、启动事件转发、注册全部 Tauri 命令 |
| `commands.rs` | 全部命令实现(约 80 个),直接调用 deltachat core / Db |
| `db.rs` | SQLite 访问层:7 张业务表 + 索引 + 迁移;封装为 `Db` struct |
| `dto.rs` | 序列化数据结构(所有 DTO),供 `serde` 输出 JSON |
| `error.rs` | `AppError` 枚举 + `AppResult` 别名;统一错误透传前端 |
| `events.rs` | 后台转发 task:订阅 deltachat `EventType` → 转为 `EventPayload` → `app.emit("dc-event", ...)` |
| `state.rs` | `AppState` 全局状态 |
| `plugins.rs` | `PluginManager`:远程市场拉取、安装(zip/registry)、卸载、启停、读 JS 入口 |
| `terminal.rs` | `TerminalSessions`:portable-pty 会话管理(open/write/resize/close + 输出事件) |

### 3.1 数据持久化(数据库表)

SQLite 数据库 `peytchat.db`,启动时自动 `migrate()`:

| 表 | 用途 |
|---|---|
| `workspaces` | 工作区(id, name, master_chat_id, icon) |
| `channels` | 频道映射(id, workspace_id, chat_id, category, position, topic;UNIQUE(workspace_id, chat_id)) |
| `roles` | 工作区角色(id, workspace_id, name, color) |
| `contact_roles` | 联系人-角色分配(contact_id, role_id, workspace_id) |
| `pins` | 置顶消息(channel_chat_id, msg_id;UNIQUE 防重复) |
| `cards` | 协作卡片(title, description, status, assignee, due_date, type, position;按 workspace+channel 索引) |
| `inbox_events` | 通知中心(mention/reply/card_assign/system;按 workspace+read_at 索引) |
| `activities` | 活动流(action, target_type, actor;按 workspace/channel + 时间索引) |

deltachat 自身的消息/联系人/会话数据由 deltachat core 管理(在 `app_data_dir/accounts` 下),SQLite 只存"团队结构"数据。

### 3.2 本地存储(前端)

`localStorage` 持久化 UI 状态(`persist.ts` + `theme.ts` + `state.ts`):

| Key | 内容 |
|---|---|
| `peyt.currentPage` / `currentChatId` / `currentWsId` 等 | 当前导航状态 |
| `peyt.viewPrefs` | 每个频道的视图偏好(kanban/list/calendar/timeline) |
| `peyt.theme` | 当前主题(nowint / violet / goldenhour) |
| `peyt.term.history` | 终端命令历史 |

---

## 4. 前端模块职责

无框架 SPA,`main.ts` 启动:初始化主题 → `is_configured` → 登录页或 `renderShell()` → 静默确保 PEYT Studio。

### 4.1 布局与路由

`renderShell()` 渲染四栏骨架:

```
┌──────────┬─────────────┬──────────────────────┬─────────────┐
│ rail     │ nav-panel   │ chat-main            │ right-drawer│
│ (图标栏) │ (导航树)    │ (主内容区)           │ (右侧面板)  │
└──────────┴─────────────┴──────────────────────┴─────────────┘
```

路由无路由库,由 `state.currentPage` 驱动:

| 模块 | 职责 |
|---|---|
| `shell/shell.ts` | 骨架渲染、全局事件订阅、快捷键(Cmd+K 搜索、ESC)、角标 |
| `shell/rail.ts` | 左侧图标栏(消息/群组/协作/通知/插件/终端/设置) |
| `shell/navPanel.ts` | 左侧导航树:按 `currentPage` 动态 import 页面组件 |
| `shell/rightDrawer.ts` | 右侧成员/置顶面板 |

`Page` 类型:`messages` / `groups` / `work` / `inbox` / `plugins` / `terminal` / `settings`。

### 4.2 页面与功能模块

| 模块 | 页面 | 功能 |
|---|---|---|
| `pages/messagesPage.ts` | 消息页 | 会话列表 |
| `pages/groupsPage.ts` | 群组页 | 群组列表 |
| `pages/workPage.ts` | 协作页 | 频道树 + 活动 tab |
| `pages/inboxPage.ts` | 通知页 | Inbox 通知中心 |
| `pages/settingsPage.ts` | 设置页 | 账号/外观/团队/通知/插件/关于 |
| `pages/terminalPage.ts` | 终端页 | xterm.js + PTY |
| `work/*` | 协作视图 | kanban / list / calendar / timeline + cardDetail |
| `chat/*` | 聊天 | chatView / composer / message |
| `components/*` | 通用组件 | avatar、dropdown、contextMenu、inlineConfirm、search、viewToggle、navBanner、icon 等 |
| `plugins/*` | 插件子系统 | manager / api / permissions / settings / storage / view / types |
| `views/login.ts` | 登录视图 | 邮箱登录 / 自动创建账号 / 高级设置 |

### 4.3 状态管理

`state.ts` 导出单例 `state`(`AppState` 类型见 `types.ts`),模块直接读写,无响应式框架。页面重渲染由事件/命令手动触发。

---

## 5. 关键子系统

### 5.1 消息同步(事件驱动)

1. deltachat core 产生事件 → `events.rs` 后台 task 转成 `EventPayload` → `emit("dc-event")`
2. 前端 `shell.ts` 注册 20+ 个 `onEvent` 处理器
3. 处理器按需刷新:`refreshSidebar()`(工作区/频道/rail)、`refreshCurrentChat()`(增量追加消息)、`updateBadge()`(角标)

### 5.2 插件系统

```
市场(远端)                磁盘                      前端
registry.json ──fetch──▶ app_data/plugins/<name>/   list_plugins()
   │                          ├─ plugin.json         ├─ loadPlugins()
   │                          ├─ <entry>.js          ├─ new Function('peytchat', js)(api)
   │                          └─ enabled(标记)       └─ 权限门控(permissions.ts)
zip 安装 ──install_plugin_from_zip──▶ 解压
```

- 插件即一段 JS + manifest,权限在 设置→插件 中配置
- 前端 `manager.ts` 启动时加载所有已启用插件;`api.ts` 构造权限门控的 API 对象;卸载时执行 cleanup 回调
- 插件注册的主题/命令/LLM/设置进入 `window.__peytchat_*` 注册表

### 5.3 终端子系统

- 后端 `terminal.rs`:每会话一个 `portable-pty` PTY(shell = `$SHELL` / cmd),读线程按 UTF-8 边界切分输出并经 `terminal-output` 事件推送
- 前端 `terminalPage.ts`:xterm.js 渲染;白名单校验(前端,回车时匹配命令);专家模式跳过校验;命令历史存 localStorage;主题从 CSS 变量映射
- 会话随页面切换销毁(离开页面 `close_terminal`)

### 5.4 主题系统

- `theme.ts`:`data-theme` 属性切换(`nowint`/`violet`/`goldenhour`);CSS 变量定义在 `styles.css :root` 与 `[data-theme]` 块
- 终端等特殊 UI 通过 `getComputedStyle` 读取变量适配
- 插件可注册自定义主题(`registerTheme`)

---

## 6. 目录结构

```
.
├── src/                    # 前端(TypeScript)
│   ├── main.ts             # 启动入口
│   ├── api.ts              # IPC 封装(call / onEvent)
│   ├── state.ts            # 全局状态单例
│   ├── persist.ts          # localStorage 持久化
│   ├── theme.ts            # 主题
│   ├── types.ts            # 前端类型定义
│   ├── shell/              # 布局骨架
│   ├── pages/              # 页面
│   ├── views/              # 登录视图
│   ├── work/  chat/        # 协作视图 / 聊天
│   ├── components/         # 通用组件
│   └── plugins/            # 插件子系统
├── src-tauri/              # 后端(Rust)
│   └── src/                # commands/db/dto/error/events/plugins/state/terminal
├── core/                   # deltachat core(本地依赖)
└── docs/                   # 文档
    ├── api-spec.md         # API 规范 / 对接文档
    └── architecture.md     # 本文档
```

---

## 7. 开发与构建

```bash
npm install          # 前端依赖
npm run tauri dev    # 开发模式(启动 WebView + Rust)
npm run tauri build  # 打包
```

验证:`npx tsc --noEmit`(前端类型)、`cargo check`(Rust 编译)、`npm run build`(产物构建)。

调试注意:macOS GUI 下 stderr 被吞,`commands.rs` 提供 `dbg!` 式辅助写入项目根 `debug.log`。

---

## 8. 设计要点与权衡

- **无框架前端**:页面靠 `state.currentPage` 手动路由 + 动态 import,保持轻量;代价是状态变更需手动刷新
- **团队数据本地化**:SQLite 存工作区/频道/卡片结构,消息走 deltachat P2P,无中心服务器
- **Clearable<T> 反序列化**:区分"不传 / 传 null / 传值"三种更新语义,解决 Tauri 命令参数不支持 `#[serde]` 属性的限制
- **终端白名单为前端校验**:PTY 模式下后端无法可靠拦截 shell 拼接,采用"默认白名单 + 专家模式"产品层约束
- **事件全量转发**:`events.rs` 对齐 Plzdelta 覆盖关键事件,前端按 `typ` 过滤,减少轮询
