# 前端地图（src/，Vanilla TS）

46 个 TS 文件。无框架、无路由库、无状态管理库。全部样式在单文件 `src/styles.css`（~1944 行）。

---

## 1. 入口与启动（`src/main.ts`）

`boot()` 流程：
1. `initTheme()` 应用 localStorage 里的主题。
2. `call('is_configured')` 判断后端是否有账号。
3. **已配置** → `renderShell()`（三栏骨架）→ `ensurePeytStudio()`（确保 PEYT Studio 工作区存在；若返回 `role==='founder'` 且未 dismiss，在 `#channel-tree` 顶部插 PEYT Studio 欢迎 banner）。
4. **未配置** → 动态 import `views/login.js` 的 `renderLogin(onSuccess)`，onSuccess 里 `renderShell()` + `ensurePeytStudio()`。

登录页两 tab：「快速开始」（`create_chatmail_account`，监听 `ConfigureProgress` 进度条）+「邮箱登录」（标准 Delta Chat `login`，可展开 IMAP/SMTP 高级设置）。

## 2. 全局状态与类型

### `src/state.ts`

导出 `state`（AppState 单例）+ `setState(partial)`（`Object.assign`）。各模块直接读写 `state`。

`AppState` 关键字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `currentPage` | `Page` | 当前 rail 页面：messages/groups/work/inbox/plugins/terminal/settings |
| `currentWsId` / `currentChatId` | `number \| null` | 当前 workspace / 频道 |
| `workspaces` / `channels` / `messages` / `cards` | 各 DTO 数组 | 各域数据 |
| `messagesOldestId` / `noMoreMsgs` | | 消息分页游标 |
| `currentMembers` | `MemberDto[]` | 当前聊天成员（消息头像/角色查找） |
| `currentCardId` | `number \| null` | Work 详情抽屉选中的卡片 |
| `currentView` / `viewPrefs` | `CurrentView` / `Record<number, CurrentView>` | Work 视图 + 每频道偏好 |
| `rightDrawerOpen` / `detailPanelOpen` / `detailTab` | | 右侧抽屉状态 |
| `self` / `roles` / `wsMembers` | | 个人信息 / 角色 / 每 ws 成员数 |
| `searchOpen` / `inboxUnread` / `currentWorkTab` / `peytBannerDismissed` | | 杂项 UI 状态 |

### `src/types.ts` 全部类型

```ts
export type Page = 'messages' | 'groups' | 'work' | 'inbox' | 'plugins' | 'terminal' | 'settings';
export type SettingsSection = 'account' | 'appearance' | 'team' | 'notifications' | 'plugins' | 'about';
export type PluginsTab = 'market' | 'installed';
export type PluginPermission = 'messages:read' | 'messages:send' | 'ui:css' | 'ui:theme' | 'commands' | 'llm' | 'network';
export type SpaceType = 'chat' | 'card';                 // 频道空间类型
export type CurrentView = 'kanban' | 'list' | 'calendar' | 'timeline';
export type WorkTab = 'channels' | 'activity';
export type InboxEventType = 'mention' | 'reply' | 'card_assign' | 'system';
export type MsgState = 'pending' | 'delivered' | 'failed' | 'read';
export type CardType = 'card' | 'task';                   // ← 卡片类型（字符串）
export type CardStatus = 'todo' | 'in_progress' | 'done'; // ← 卡片状态（字符串）
```

DTO 接口（与后端 `dto.rs` 对应）：`WorkspaceDto` `{ id, name, master_chat_id, icon, created_at }`；`ChannelDto` `{ id, workspace_id, chat_id, name, category, position, topic, unread }`；`MemberDto` `{ contact_id, name, addr, avatar, color, is_self }`；`MsgDto` `{ msg_id, chat_id, from_id, from_name, text, ts, state, view_type, file, file_mime, file_name, file_size, quote_text, quote_from, reactions }`；`CardDto` `{ id, workspace_id, channel_chat_id, msg_id, type, title, description, status, assignee_contact_id, assignee_name, due_date, created_at }`；`InboxEventDto` / `ActivityDto` / `SelfProfile` / `RoleDto` / `ChatListItem`。

## 3. 持久化（`src/persist.ts`）

`saveState()` / `loadState()`。存入 localStorage：`peyt.currentPage` / `peyt.currentWsId` / `peyt.currentChatId` / `peyt.currentView` / `peyt.detailPanelOpen` / `peyt.currentWorkTab` / `peyt.viewPrefs` / `peyt.peytBannerDismissed` / `peyt.currentSettingsSection`。

其他散落 key：`peyt.theme`（theme.ts）、`peyt.navWidth`/`peyt.drawerWidth`（columnResizer）、`collapsedCategories`（groupsPage）、`peyt.term.history`（terminalPage）、`peyt.badgeEnabled`、`peyt.plugin.perms`、`plugin:*`（插件存储）。

## 4. API 层（`src/api.ts`）

- `call<T>(cmd, args?)`：`invoke` 封装，出错 `showError` 并 re-throw。
- `onEvent(typ, cb)`：订阅统一 `dc-event` 流，按 `payload.typ` 过滤。
- `transformBlobURL(path)`：路径 → `asset://` URL（带缓存 Map）。
- `showError` / `clearError`：顶部错误条。

## 5. 路由（无路由库）

`state.currentPage` + `renderMain()`/`renderNavPanel()` 分发，都在 `shell/navPanel.ts`。

**`renderNavPanel()` → `#channel-tree`**：

| page | 渲染 |
|---|---|
| messages | `messagesPage.ts` 聊天列表 + 用户栏 |
| groups | `groupsPage.ts` 频道树（按 category 分组，只显示 chat 频道） |
| work | `workPage.ts`（channels tab 显示 card 频道 / activity tab） |
| inbox | 占位头（主区看通知） |
| plugins | `plugins/view.ts`（market/installed tab 导航） |
| terminal | `terminalPage.ts` 快捷命令面板 |
| settings | `settingsPage.ts` 设置导航 |

**`renderMain()` → `#chat-main`**：

| page | 渲染 |
|---|---|
| terminal | terminalPage 自己管 main |
| plugins | plugins/view renderPluginsMain |
| settings | settingsPage renderSettingsMain |
| inbox | inboxPage renderInboxMain（通知中心） |
| work | 按 `viewPrefs[chatId] ?? currentView` 分发 kanban/list/calendar/timeline |
| messages/groups | `chatView.renderChatView(chatId)` |

**`renderRightDrawer()` → `#right-drawer`**：settings 隐藏；work + 有 currentCardId → cardDetail；messages/groups → members 或 pins tab。

导航 `navigateToPage(page)`（rail.ts）：设 currentPage → saveState → 重渲染 rail → navPanel → rightDrawer → main。

## 6. 页面（`src/pages/`）

- **messagesPage**：非 workspace 私聊列表。新建按钮下拉（邮箱/QR/群/加入 PEYT Studio）。右键菜单（信息/拉黑/删除）。
- **groupsPage**：workspace 频道树（只 chat 类型），category 折叠（localStorage 持久化），每分类 + 建频道，右键菜单。
- **inboxPage**：通知中心（mention/reply/card_assign/system），点击跳转源频道并定位消息。
- **settingsPage**：account（头像上传/显示名）、appearance（主题选择器，含插件主题）、team、notifications（桌面通知/徽标）、plugins、about。
- **terminalPage**：xterm.js + 工具栏（工作目录/会话/expert 开关）。**离开页面时 `cleanupTerminalPage()` 必须关闭 PTY 会话并移除监听**（renderMain 调用）。
- **workPage**：nav 是 channels/activity 两 tab；channels 只显示 `spaceType === 'card'` 的频道。

## 7. 聊天（`src/chat/`）

### chatView.ts — 核心聊天渲染 + 虚拟化

- 常量：`ITEM_HEIGHT=60`（估算消息高）、`BUFFER=20`（上下缓冲）、`VIEWPORT=30`。
- `renderChatView(chatId)`：用 `main.dataset.renderedChatId` 判断是否同频道已渲染（跳过全量重渲染）。切频道才重置分页。加载 roles/topic/pins/members → 渲染骨架（header + `#messages` + `#composer-area`）→ `refreshMessages`。
- `renderVisibleMessages(box, start, end)`：**off-DOM temp 构建完整 HTML（含 awaits），再同步原子替换**，保存/恢复 scrollTop——避免闪烁。
- 消息分组（WhatsApp 式连续发送者折叠：solo/first/middle/last），日期分隔线，「新消息」未读分隔线。
- `appendNewMessages(chatId)`：实时增量（拉最新 50 条去重 push 重渲染），到底自动滚。
- `appendOptimisticMessage(tmpMsg)`：composer 乐观发送。

### composer.ts

输入框 + 发送；回复预览；`@`/`#` 提及自动补全浮层；`/` 斜杠命令路由到 `window.__peytchat_commands`。发送流程：乐观 tmp → `send_text`/`send_reply` → onSent 刷新；失败标 failed 可点击重发。

### message.ts

`renderMessage(m, groupRole)` 返回 HTML（头像、名字、时间、role tag、引用、代码高亮 hljs、@提及高亮、附件 Image/Gif/Sticker/File/Audio/Video、反应胶囊、hover 操作栏、发送状态图标、反应选择器）。`stateLabel` 映射 pending/delivered/read/failed 到 lucide 图标。**模块级缓存** `reactionsCache`（Map）和 `pinnedMsgIds`（Set）避免虚拟化重渲染时反复 IPC。右键菜单：复制/回复/置顶/转为卡片/转发(WIP)/删除（`showInlineConfirm`）。

## 8. 协作卡片（`src/work/`）

- **kanban.ts**：三列（Todo/In Progress/Done）。卡片显示 title、type 徽标（Task/Card）、截止日（逾期变色）、负责人。卡片内状态分段按钮。底部 + 内联建卡。点卡片 → cardDetail。
- **list.ts**：表格视图，可排序（title/status/assignee/due/created）。
- **calendar.ts**：月历网格，卡片作为截止日上的 chip；底部「未排期」区。
- **timeline.ts**：按日期分组的纵向时间线。
- **cardDetail.ts**：右侧抽屉详情。title/description contenteditable，status select，due date，保存只发变更字段（`update_card`）。
- **activity.ts**：workspace 活动流（card_created/updated/deleted/status_changed 等）。

**卡片字段**：`type`（'card'|'task'）、`status`（'todo'|'in_progress'|'done'）、title、description、assignee、due_date。**type/status 全链路是字符串**（DB TEXT、Rust String、TS 字符串联合）。详见 [database.md](database.md)。

## 9. Shell（`src/shell/`）

- **shell.ts**：骨架 HTML + **`handleIncomingMsg`**（[CARD]/[PEYT_INVITE] 前缀，见 conventions.md）+ 全部事件订阅（见 events.md）+ 全局快捷键（Cmd/Ctrl+K 搜索，Esc 关浮层/清回复/折叠抽屉）+ `updateBadge`（Dock 徽标）。
- **rail.ts**：最左 56px 图标栏。页面图标 + 插件 + 终端 + 设置 + 底部头像（主题/账号设置/登出）。
- **navPanel.ts**：路由分发 + `refreshChannels()` + `getSpaceType(chatId)`（带 Map 缓存）。
- **rightDrawer.ts**：members（按角色分组 + 搜索）/ pins tab；折叠后显示悬浮展开按钮。
- **columnResizer.ts**：pointer 拖拽调列宽（NAV 180–460 / DRAWER 220–520，橡皮筋阻尼，`--nav-w`/`--drawer-w` CSS 变量，localStorage 持久化）。

## 10. 组件（`src/components/`）

- **icon.ts**：三处同步图标系统，见 conventions.md。
- **avatar.ts**：`renderAvatarHtml(member)`（有 avatar 路径则 `<img>`，否则首字母色块）。
- **dropdown.ts**：单例下拉。同 anchor 再点 = toggle 关闭；关闭触发：外部点击（setTimeout 防同点击误关）/Esc/菜单 mouseleave。**关闭动画**：加 `.closing` 类 120ms 后移除 DOM。`transformOrigin` 按 position 映射。
- **contextMenu.ts**：右键菜单（消息上用）。
- **search.ts**：Cmd+K 搜索浮层。空查询显示命令列表（跳转页面/切视图/切主题/标记已读）；非空搜消息（`search_msgs`）+ 本地频道/成员匹配。分组 + 方向键导航。
- **viewToggle.ts**：work 四视图切换（kanban/list/calendar/timeline），更新 viewPrefs。
- **inlineInput.ts**：零弹窗内联输入（确认/取消，Enter/Esc，错误标红）。
- **inlineConfirm.ts**：零弹窗内联确认（替代 `confirm()`），支持 undo toast，3s 自动取消。
- **navBanner.ts**：PEYT Studio 欢迎 banner。
- **memberDetail.ts**：右抽屉成员详情（发消息/返回）。

## 11. 插件系统前端（`src/plugins/`）

见 conventions.md 的插件系统端到端。

## 12. 主题（`src/theme.ts`）

- `ThemeName = 'nowint' | 'violet' | 'goldenhour'`，默认 nowint（无 `data-theme` 属性）。
- `applyTheme(theme)`：设 `data-theme` 属性；`initTheme()` boot 时调用。
- CSS 变量在 `styles.css`：`:root`（nowint）、`[data-theme="violet"]`、`[data-theme="goldenhour"]`。
- 插件主题 ID 形如 `plugin-<name>-<id>`。

## 13. 动效（当前状态）

**没有 `motion.ts`**。动效全在 CSS + 少量 JS 手动模式：
- `@media (prefers-reduced-motion: no-preference)` 块内：`.dropdown-menu` pop-in 130ms、`.msg` msg-fade-in 150ms、`.right-drawer` width 200ms、`.search-overlay` fade-in 150ms、`.search-dialog` pop-in 160ms、`.img-fullscreen-overlay` fade-in 180ms、`.nav-banner` pop-in、`.inline-confirm-active` fade-in、`.reply-preview`、`.mention-list` 等。
- **`.closing` 模式**（JS 驱动出场）：关闭时 JS 加 `.closing` 类 → CSS 播放 `pop-out`/`fade-out`（forwards）→ 120ms 后 `remove()`。用于 dropdown、confirm、search overlay、图片全屏。
- keyframes：`msg-fade-in`、`pop-in`、`fade-in`、`pop-out`、`fade-out`、`mention-pop` 等。
- `@media (prefers-reduced-motion: reduce)` 块：全部 `animation: none !important`。
- 没有 `--motion-*` token，时长是硬编码值。

## 14. 模块依赖要点

```
main → api, theme, shell/shell, views/login(动态)
shell/shell → api, state, persist, shell/rail, shell/navPanel, shell/rightDrawer,
              shell/columnResizer, chat/chatView, chat/message, plugins/manager, toast
navPanel → pages/*(动态), work/*(动态), chat/chatView(动态), plugins/view(动态)
rail → api, state, persist, toast, components/avatar|icon|dropdown, theme, navPanel(动态)
rightDrawer → api, state, toast, persist, components/avatar|icon|memberDetail, work/cardDetail(动态)
chatView → api, state, persist, toast, chat/message, chat/composer, components/icon
message → api, state, toast, components/dropdown|inlineConfirm|icon
composer → api, state, toast, chat/chatView(appendOptimisticMessage), components/icon
```

**性能注意**：页面整块 `innerHTML` 替换（重挂载）。chatView 用虚拟化只渲染可视区 ~70 条。message.ts 有反应/置顶缓存。
