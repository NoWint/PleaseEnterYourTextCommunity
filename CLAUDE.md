# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Peytchat — 基于 [chatmail/core](https://github.com/chatmail/core)（Delta Chat 核心，git submodule）+ Tauri v2 的跨平台桌面聊天客户端。前端是 **Vanilla TypeScript + Vite，无框架**。在 Delta Chat 协议之上实现了工作区（workspace）/ 频道（channel）体系、卡片式任务管理（Work 页）、插件系统、以及一个应用内终端页面。

**注意：README.md 中的「项目结构」一节已过时**（描述的是旧的 views/api.js/state.js 布局），实际结构见下方。代码内注释为中文，新增注释请保持一致。

## 常用命令

```bash
npm install                      # 安装前端依赖
npm run tauri dev                # 开发模式（Tauri + Vite 热重载，前端端口 1420）
npm run tauri build              # 生产构建（输出 src-tauri/target/release/bundle/）
npm run dev                      # 仅 Vite 前端 dev server
npm run build                    # 仅 Vite 构建
npx tsc --noEmit                 # TypeScript 类型检查
```

- **没有测试套件，也没有配置 linter**——`tsc --noEmit` 是唯一的静态校验手段。
- 首次 `cargo build` 会编译 `core/` submodule 中的 deltachat 核心，耗时 10–30 分钟；之后增量编译很快。
- 克隆仓库必须 `git clone --recursive`；已克隆的用 `git submodule update --init --recursive` 补齐。

## 架构

### 前端（src/，Vanilla TS）

- 入口 [src/main.ts](src/main.ts)：`boot()` 判断是否已配置账号 → 渲染 shell 或登录页，然后 `ensure_peyt_studio()` 确保 PEYT Studio 工作区存在。
- 全局可变状态 [src/state.ts](src/state.ts)：单一 `AppState` 对象，各模块直接读写，无状态管理库。
- 持久化 [src/persist.ts](src/persist.ts)：把 `currentPage/currentWsId/currentChatId/currentView/viewPrefs` 等 UI 状态存到 `localStorage`。服务端侧数据（workspaces/channels/cards/inbox 事件）由后端 SQLite 持久化。
- 事件流：Delta Chat 核心事件 → Rust 事件循环（[events.rs](src-tauri/src/events.rs)）→ Tauri `dc-event` → 前端 [api.ts](src/api.ts) 的 `onEvent()`（单一事件桥，需 `capabilities/default.json` 的 `core:event:allow-listen`）。**所有订阅都集中在 [shell.ts](src/shell/shell.ts)**，`call()` 封装 Tauri invoke 并统一显示错误。`refreshSidebar` 有 150ms 防抖合并 realtime 事件风暴。
- 模块划分：
  - `shell/` — 三栏布局骨架：`rail.ts`（左侧 workspace 竖栏）、`navPanel.ts`（频道树 + 主内容路由，含「保存的消息」入口）、`rightDrawer.ts`（右侧详情抽屉）。
  - `pages/` — 顶级页面：messages、groups、inbox、settings、terminal、work、debug。
  - `chat/` — `chatView.ts`（消息列表，**Delta 式全量 DOM 渲染**：所有已加载消息都是真实 DOM 节点，浏览器原生管理滚动——根治手写虚拟化的闪烁/微动/回跳；分页每次 50 条，滚到顶 loadEarlier）、`composer.ts`（含草稿防抖保存/恢复 + 语音录音按钮）、`message.ts`（消息/emoji 反应渲染与缓存，单聊隐藏 name/role tag）。
  - `work/` — 卡片任务系统：kanban、list、calendar、timeline、cardDetail、activity。
  - `components/` — 通用组件：icon、avatar、dropdown、contextMenu、search、inlineInput/Confirm、viewToggle、navBanner、memberDetail、ui（组件库）、commandPalette（命令面板）、gallery（媒体相册）、voicePlayer（语音播放）、webxdc（webxdc 沙箱运行时）、blockedContacts（屏蔽列表）、protectionDialog（保护状态/指纹）、setupMultiDevice（多设备）、backupDialog（备份恢复）、mailingListProfile（邮件列表）。
  - `plugins/` — 插件系统前端：`manager.ts` 在启动时加载已启用插件，`createPluginApi` 注入 `peytchat` 全局对象。

### 后端（src-tauri/，Rust + Tauri v2）

- [lib.rs](src-tauri/src/lib.rs)：`AppState::new()` 初始化 → 注册全部 Tauri command（`invoke_handler`，100 个）。**新增后端命令必须在这里登记**。
- [commands.rs](src-tauri/src/commands.rs)（~2728 行）：所有业务命令：登录/账号、聊天、群组、SecureJoin、workspace/channel、reaction/reply、卡片、Inbox/Activity、插件、归档/保存消息/草稿、语音/webxdc、imex（多设备/备份）、加密信息。
- [envelope.rs](src-tauri/src/envelope.rs)：`[PEYT]` 信封协议发送端构建器（`build_envelope`），发送端已接卡片/项目邀请。
- [db.rs](src-tauri/src/db.rs)：rusqlite + SQLite，存 workspaces/channels/cards/inbox_events/roles 等应用级数据（与 deltachat 核心自己的消息存储分离）。`migrate()` 用 `CREATE TABLE IF NOT EXISTS` 做建表迁移。
- [plugins.rs](src-tauri/src/plugins.rs)：插件注册表拉取、安装（zip）、卸载、启停。
- [terminal.rs](src-tauri/src/terminal.rs)：`portable-pty` 启动真实 PTY shell 会话，后台线程按 UTF-8 边界切分输出，经 `terminal-output` Tauri 事件推给前端。
- [state.rs](src-tauri/src/state.rs)：`AppState`，持有账号 manager、Db、`TerminalSessions` 等。
- [capabilities/default.json](src-tauri/capabilities/default.json)：Tauri v2 ACL，含 `core:event:allow-listen`（**realtime 事件到前端的关键**）。

### 特殊消息前缀

[shell.ts](src/shell/shell.ts) 的 `handleIncomingMsg` 识别两类带前缀的消息，**不当作普通消息渲染**：
- `[CARD]` — 卡片数据同步，调用 `upsert_card_from_msg` 写入卡片库。
- `[PEYT_INVITE]` — 工作区频道邀请（含 general_qr/work_qr），自动 securejoin 并关联 workspace。

### 终端页面（近期功能）

[terminalPage.ts](src/pages/terminalPage.ts) + xterm.js。带**命令白名单**（`WHITELIST`，如 git/npm/ls 等）与 expert 模式开关；会话历史存 localStorage。Windows 默认 shell 是 `cmd.exe`。

### 主题系统

[theme.ts](src/theme.ts)：三个主题（`nowint` 默认 / `violet` / `goldenhour`），通过 `<html data-theme>` 切换，CSS 变量定义在 [index.html](src/index.html) 的 `<style>` 中。xterm 终端从这些 CSS 变量读取颜色。

### 图标系统

[icon.ts](src/components/icon.ts)：基于 `lucide` 图标包。**新增图标必须三处同步**：lucide import、`IconName` 类型、`iconMap` 记录。历史上这里出过重复 import/类型块导致构建失败的冲突。

## 开发约定

- 前端 import 一律用 `.js` 扩展名（Vite 解析 .ts 文件）——新增/移动文件时别写成 `.ts`。
- 图标添加按「图标系统」一节三处同步。
- 新增 Tauri 命令需在 `lib.rs` 的 `invoke_handler` 登记。
- 前端页面路由无路由库：靠 `state.currentPage` + `renderMain()` 分发。
- 设计驱动的开发流程：`docs/superpowers/specs/`（设计规格）与 `docs/superpowers/plans/`（实施计划）成对出现（如 `2026-07-31-terminal-page-design.md` 对应 `2026-07-31-full-ux-redesign-design.md` 等），改功能前先读对应 spec。
