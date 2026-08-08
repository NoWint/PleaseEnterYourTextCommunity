# Legacy 页面数据流调查(Solid 迁移前置)

> 为 6 个 legacy 页面(`src/pages/{bots,intelligence,github,inbox,debug}Page.ts` + `src/plugins/view.ts`)
> 的 Solid 迁移提供完整数据流清单。Task 1-4 以此为准,无需再读 legacy 源码。
>
> 结论摘要:**6 页共 59 条 invoke 命令调用(57 个去重命令名),全部在 `lib.rs` 注册表中存在,0 个 MISS**。
> 唯一注意:`open_external` 是 `pub fn` 而非 `pub async fn`(commands.rs:4034),但已注册,命令本身存在。

---

## 0. 验证方法

- 命令存在性:对每个命令名执行 `grep -oE "pub async fn [a-z_]+" src-tauri/src/commands.rs`(严格按 brief),
  并交叉核对 `src-tauri/src/lib.rs` 的 `invoke_handler` 注册表(189 个 `commands::*` 引用)。
- 事件订阅:核对 `src-tauri/src/events.rs`(`dc-event` 转发)、`src-tauri/src/lib.rs:129`(`bot-activity` emit)、
  `src-tauri/src/intelligence/download.rs:219` / `src-tauri/src/summary/downloader.rs`(`download-progress` emit)。
- 结论:除 `open_external`(非 async 但已注册)外,其余全部 `pub async fn` 且已注册,**0 MISS**。

---

## 1. `src/pages/botsPage.ts`(1544 行)

### 命令清单(21 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `list_bots` | — | `BotDto[]`;列表态初始加载 |
| `list_bot_personas` | — | `PersonaDto[]`;persona id → 名称映射(列表+详情头部) |
| `get_bot_config` | `{ botId }` | `BotConfig \| null`;列表行徽标(LLM/persona/规则)、详情态 cfgState |
| `bot_list_schedules` | `{ botId }` | `ScheduleDto[]`;列表行定时徽标计数(仅 enabled)、定时 Tab 列表 |
| `set_bot_io` | `{ botId, running }` | 列表态:void(失败 toast 重渲染);详情态:`BotDto`(就地更新徽标) |
| `delete_bot` | `{ botId }` | void;confirm 后删除 + 重渲染列表 |
| `bot_get_chatlist` | `{ botId }` | `ChatDto[]`;对话 Tab 左栏会话列表、LLM Tab 项目上下文勾选、定时 Tab 下拉 |
| `bot_get_chat_msgs` | `{ botId, chatId }` | `MsgDto[]`;线程渲染 / 实时刷新 reloadChat |
| `bot_send_text` | `{ botId, chatId, text }` | `MsgDto`;发送后 `renderMessage(msg, 'solo')` 追加 |
| `bot_mark_chat_seen` | `{ botId, chatId }` | void;打开会话即标记已读(失败忽略) |
| `list_github_repos` | — | `Array<{id, full_name}>`;LLM Tab 已绑定仓库下拉(失败忽略) |
| `test_llm_config` | `{ config: LlmConfig }` | `string`;测试按钮,`✓ 连接成功: ${reply.slice(0,60)}` |
| `update_bot_config` | `{ botId, config: BotConfig }` | void;LLM/规则/工具 三个 Tab 的保存(合并后全量提交) |
| `bot_add_schedule` | `{ botId, chatId, minute, hour, dayOfWeek, message }` | void;定时 Tab 添加(留空 = -1) |
| `bot_delete_schedule` | `{ scheduleId }` | void;定时行删除 |
| `list_bot_tools` | — | `BotToolDto[]`;工具 Tab;默认安全集 = `t.safe` 的工具名 |
| `list_bot_activities` | `{ botId, limit: 100 }` | `BotActivityDto[]`;时间线 Tab(后端倒序,前端 reverse) |
| `get_bot_stats` | `{ botId }` | `BotStatsDto`;统计 Tab 8 卡片 |
| `create_bot` | `{ displayName }` | `BotDto`;新建对话框 → 引导弹窗 |
| `get_chatlist` | — | `Array<{chat_id, name, is_group}>`;拉入群聊对话框(filter `is_group`) |
| `add_bot_to_chat` | `{ botId, chatId }` | void;拉入群聊 |

### 事件订阅(2 个)

| 事件类型 | 订阅方式 | 处理逻辑 |
|---|---|---|
| `bot-activity` | **直接 `listen('bot-activity')`**(`@tauri-apps/api/event`,不走 dc-event 桥;模块级单例 `activityUnlisten`) | 分发三态:①列表态 `listRowBadges` 徽标 thinking/运行中;②详情态-对话 `chatCtx` 打字指示器 + `reloadChat()`(仅匹配 `activeChatId()`);③详情态-时间线 `timelineCtx.append()` |
| `IncomingMsg` | `onEvent('IncomingMsg')`(`incomingUnlisten`,每次清 live ctx 时注销) | `e.chat_id === activeChat.chat_id` 时 `reloadChat()`(保留滚动位置) |

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 入口(导出) | `export async function renderBots(main: HTMLElement): Promise<void>` — 列表态 |
| 详情态(未导出) | `async function renderBotDetail(bot: BotDto, main: HTMLElement, initialTab: DetailTab): Promise<void>` — `DetailTab = 'chat'\|'llm'\|'rule'\|'schedule'\|'tools'\|'timeline'\|'stats'` |
| Tab 渲染 | `renderChatTab→buildChatPane(bot, content)`、`renderLlmTab(bot, content, getCfg, setCfg)`、`renderRuleTab(bot, content, getCfg, setCfg)`、`renderScheduleTab(bot, content)`、`renderToolsTab(bot, content, getCfg, setCfg)`、`renderTimelineTab(bot, content)`、`renderStatsTab(bot, content)` — 均 `(bot, content: HTMLElement, ...)` 写 `content` |
| 行渲染 | `renderBotRow(bot, cfg, scheduleCount, personaName, onChanged, main)` |

### 内部导航(需替换为路由)

- **列表 ↔ 详情**:`renderBots(main)` ↔ `renderBotDetail(bot, main, 'chat'\|'llm')` — 同一 `main` 元素整体清空重渲染(行点击、操作按钮、创建引导、返回列表)。
- **详情内 Tab**:`ui.tabs` onChange → `tab = id` + `renderTabContent()`(清空 content 区)。
- **实时上下文切换**:模块级 `chatCtx`/`timelineCtx` + `listRowBadges`/`listRowRunning` Map;每次重渲染先 `clearLiveCtx()`。Solid 迁移注意:这些是模块级副作用,需转为组件级 signal/effect。
- 无 shell 级导航调用(不碰 rail/navPanel/rightDrawer)。

### 导入依赖

`../api.js`(call, onEvent)、`../components/ui.js`(ui)、`../components/icon.js`(iconSvg)、`../chat/message.js`(renderMessage)、`../types.js`(MsgDto)。注意依赖 `renderMessage`(chat 模块,迁移时必须保留)。

---

## 2. `src/pages/intelligencePage.ts`(837 行)

### 命令清单(11 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `list_knowledge` | `{ page: 1, pageSize: 200 }` | `KnowledgeDto[]`;知识库 Tab(过滤/搜索全部前端做) |
| `summarize_store_now` | `{ chatId, count }` | `KnowledgeDto`;「总结本会话入库」(count 夹在 1-200) |
| `update_knowledge` | `{ id, title, summary, tags }` | void;详情弹窗保存 → `mainRefresher?.()` |
| `delete_knowledge` | `{ id }` | void;详情弹窗删除 → `mainRefresher?.()` |
| `list_knowledge_config` | — | `KnowledgeConfigDto[]`;自动总结配置 Tab |
| `set_knowledge_config` | `{ chatId, dailyEnabled, dailyTime, windowCount, autoStore }` | void;每会话配置保存 |
| `get_intelligence_settings` | — | `IntelligenceSettingsDto`;智能设置 Tab 表单预填(失败忽略) |
| `set_intelligence_settings` | `{ mode, source, modelTier, windowN, baseUrl, apiKey, model }` | void;保存(API 模式才传 baseUrl/apiKey/model) |
| `get_llm_model_status` | — | `ModelStatusDto`;运行状态卡 + 下载后刷新 |
| `start_engine_download` | `{ which: 'engine'\|'model' }` | void;下载按钮(完成后刷新 status) |
| `test_llm_config` | `{ config: { base_url?, api_key?, model? } }` | `string`;API 来源测试连接 |

### 事件订阅(1 个)

| 事件类型 | 订阅方式 | 处理逻辑 |
|---|---|---|
| `download-progress` | `onEvent('download-progress')`(`settingsUnlisten`,重入设置 Tab 先注销) | `{ id, bytesDone, total, rate }`;200ms 节流更新进度条 `fill.style.width` + 文本;`progressWrap` 断连则跳过 |

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 侧栏(导出) | `export async function renderIntelligenceNav(panel: HTMLElement): Promise<void>` — 标题 + 刷新按钮(调 `mainRefresher`) |
| 主区(导出) | `export async function renderIntelligenceMain(main: HTMLElement): Promise<void>` — 玻璃工具条 + Tab 条 + 内容区 |
| Tab 渲染(未导出) | `renderKnowledgeTab(body)`、`renderSummaryTab(body)`、`renderConfigTab(body)`、`renderSettingsTab(body)` — 均 `(body: HTMLElement)` 写传入容器 |
| 详情弹窗 | `openKnowledgeDetail(k: KnowledgeDto)` — `ui.dialog` 内联编辑 |

### 内部导航(需替换为路由/路由参数)

- **Tab 切换**:`state.intelligenceTab = tab.id` + `saveState()` + `syncTabActive()` + `renderEditorContent()`(contentRenderToken 防竞态,每次渲染独立 wrap 容器)。
- **侧栏 ↔ 主区**:模块级 `mainRefresher` 回调(侧栏刷新按钮 → 主区当前 Tab 重渲染)。
- **right-drawer 清理**:进入页面时 `state.detailTab='members'`、`detailPanelOpen=false`、`rightDrawerOpen=false`;若原为打开则 `saveState()` + 动态 import `../shell/rightDrawer.js` 的 `renderRightDrawer()` 重渲染。
- 无 rail/navPanel 调用;`openKnowledgeDetail` 保存/删除后回调 `mainRefresher?.()`。

### 导入依赖

`../api.js`(call, onEvent, DcEvent)、`../components/ui.js`、`../components/icon.js`(iconSvg, IconName)、`../components/escape.js`(escapeHtml)、`../state.js`(state)、`../persist.js`(saveState)、`../types.js`(IntelligenceTab)。依赖共享 `state.intelligenceTab` + localStorage 持久化。

---

## 3. `src/pages/githubPage.ts`(1215 行)

### 命令清单(16 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `get_github_settings` | — | `GithubSettingsDto { token? }`;ghHasToken/ghTokenValue 模块态 |
| `set_github_token` | `{ token: string \| null }` | void;保存/清除 → `ghReloadRepos()` |
| `list_github_repos` | — | `GithubRepoDto[]`;仓库树 + 选中恢复(`state.currentGithubRepo`) |
| `add_github_repo` | `{ owner, repo }` | void;添加对话框 → `ghReloadRepos()` |
| `remove_github_repo` | `{ id }` | void;confirm 后解除绑定 → `ghReloadRepos()` |
| `github_repo` | `{ owner, repo }` | `RepoDto`;仓库元数据(语言/星标/描述;`ghRepoMeta` Map 缓存)+ 详情 Tab |
| `github_list_issues` | `{ owner, repo, state: 'open' }` | `IssueDto[]`;Issues Tab |
| `github_get_issue` | `{ owner, repo, number }` | `IssueDto`;Issue 详情弹窗 |
| `github_list_pulls` | `{ owner, repo, state: ghPullState }` | `PullDto[]`;Pulls Tab(open/closed/all 筛选,模块级 `ghPullState` 跨切换保留) |
| `github_list_commits` | `{ owner, repo, page }` | `CommitDto[]`;Commits Tab 分页(每页 30,满页「加载更多」;`withTimeout` 30s) |
| `github_search_repo` | `{ query }` | `SearchRepoDto[]`;侧栏搜索(无 token 也可) |
| `github_search_code` | `{ query }` | `SearchCodeDto[]`;侧栏搜索(需 token) |
| `github_list_events` | `{ owner, repo }` | `EventDto[]`;动态 Tab 时间线 |
| `github_get_content` | `{ owner, repo, path }` | `ContentDto[]`;三种用法:文件 Tab 目录列表、文件内容(`.then(a=>a[0])`)、README 查找 |
| `project_data_source` | `{ owner, repo }` | `string`('local'/'github');文件 Tab 数据源徽标(失败静默) |
| `open_external` | `{ url }` | void;Token 教程「打开 GitHub Token 生成页」⚠ 命令存在但为 `pub fn`(commands.rs:4034,非 async) |

### 事件订阅

无(不订阅任何事件;纯拉取式)。

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 侧栏(导出) | `export async function renderGithubNav(panel: HTMLElement): Promise<void>` — 仓库树 + 搜索 + 设置入口 |
| 主区(导出) | `export async function renderGithubMain(main: HTMLElement): Promise<void>` — 延迟构建编辑区(`ensureEditor`,无选中仓库时右侧留空) |
| 数据 Tab(未导出) | `renderGhIssues(body, repo)`、`renderGhPulls(body, repo)`、`renderGhCommits(body, repo)`、`renderGhFiles(body, repo)`、`renderGhEvents(body, repo)`、`renderGhDetails(body, repo)` — 均 `(body: HTMLElement, repo: GithubRepoRef)` |
| 详情弹窗 | `openGhIssue(it, repo)`、`openGhPull(p)`、`openGhFile(it, repo)` — 均 `ui.dialog` |
| 工具函数 | `ghLoadSettings()`、`ghReloadRepos()`、`ghSelectRepo(fullName)`、`ghFetchRepoMeta(r)`、`ghSaveToken(clear, raw)`、`ghAddRepo(input)`、`ghRemoveRepo(r)`、`doSearch(queryEl, resultsEl)`、`ghRefreshAll()`、`ghCopyRepoUrl(r?)` |

### 内部导航(需替换为路由/路由参数)

- **侧栏 ↔ 主区联动(核心)**:模块级回调三件套 —— `editorRenderer`(选仓库 → 主区切换)、`mainRepoSync`(数据变化 → 主区同步)、`sidebarRefresher`(仓库树重渲染)。选中仓库写 `state.currentGithubRepo` + `state.githubTab='issues'` + `saveState()`。
- **Tab 切换**:`state.githubTab` + `saveState()` + `renderEditorContent()`;GitHub 式橙色指示线 `ghTabTarget`/`positionTabThumb` + 全局 resize 监听。
- **文件 Tab 内部导航**:模块级 `ghFilesPath`/`ghFilesRepoKey` 面包屑(进入目录 / 上一级 / 根按钮重渲染 `renderGhFiles`)。
- **right-drawer 清理**:同 intelligencePage 模式(置 detailTab='members' 等 + 重渲染 rightDrawer)。
- **Pulls 筛选**:模块级 `ghPullState`(open/closed/all)。
- 无 rail/navPanel 调用。

### 导入依赖

`../api.js`(call)、`../components/ui.js`、`../components/icon.js`(iconSvg, IconName)、`../components/escape.js`、`../state.js`、`../persist.js`(saveState)、`../types.js`(GithubRepoRef, GithubTab)。

---

## 4. `src/pages/inboxPage.ts`(197 行)

### 命令清单(3 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `list_inbox_events` | `{ limit: 100 }` | `InboxEventDto[]`(倒序);通知列表渲染 |
| `mark_inbox_read` | `{ eventId }` | void;单条标记已读(更新 `state.inboxUnread` + rail 角标) |
| `mark_all_inbox_read` | — | void;全部已读(清空未读 + 重渲染列表 + rail) |

### 事件订阅

无(不订阅;未读角标依赖 `state.inboxUnread`,由其他页面/事件更新)。

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 主区(导出) | `export async function renderInboxMain(main: HTMLElement): Promise<void>` — header + 列表容器 |
| 辅助 | `renderInboxListInto(container)`、`attachInboxItemHandlers(container, list)`、`markAllInboxRead(container)`、`renderInboxItem(ev) => string`、`updateInboxSubtitle(container)`、`isCardSpace(chatId) => Promise<boolean>` |

> 注:无 `renderInboxNav` —— nav-panel 仅占位,通知主体渲染到 chat-main(`navPanel.ts:149` 调 `renderInboxMain`)。

### 内部导航(需替换为路由 —— 本页最重)

- **点击通知跳转**:标记已读后,`isCardSpace(chatId)`(动态 import `shell/navPanel.js` 的 `getSpaceType`)判断卡片频道 → 目标页 `'work'`(设 `state.currentView='kanban'`)或 `'messages'`;写 `state.currentPage` + `state.currentChatId` + `saveState()`,然后**顺序重渲染整个 shell**:
  1. `import('../shell/rail.js')` → `renderRail()`
  2. `import('../shell/navPanel.js')` → `renderNavPanel()` + `renderMain()`
  3. `import('../shell/rightDrawer.js')` → `renderRightDrawer()`
- **消息定位**:非卡片频道且有 `msg_id` 时,setTimeout 200ms 后 `querySelector('[data-msg=id]')` `scrollIntoView` + 2s 背景高亮(依赖 messages 页 DOM 结构)。
- 全部已读/单条已读都重渲染 rail(`renderRail()`)。

### 导入依赖

`../api.js`(call)、`../state.js`、`../persist.js`(saveState)、`../toast.js`(showToast)、`../components/icon.js`(iconSvg, IconName)、`../components/escape.js`、`../types.js`(InboxEventDto, InboxEventType, Page)。依赖 `state.channels` 查频道名。

---

## 5. `src/pages/debugPage.ts`(349 行)

### 命令清单(2 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `debug_chatlist` | — | `Array<{chat_id, name, type, is_contact_request}>`;侧栏会话诊断(按类型分组) |
| `get_all_messages` | `{ cursor, limit: 20 }` | `RawMsgDto[]`;消息原文分页(`cursor` = 末条 `ts`;过滤后空页自动续拉) |

### 事件订阅

无订阅,但**读共享 `eventLog`**(`api.ts` 的 `dc-event` 日志,最多 50 条),事件流面板用 `window.setInterval(1000)` 轮询刷新(非订阅式)。

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 侧栏(导出) | `export async function renderDebugNav(panel: HTMLElement): Promise<void>` — 5 卡片:路由/账号/工作区/消息/会话 |
| 主区(导出) | `export async function renderDebugMain(main: HTMLElement): Promise<void>` — 消息原文分页列表 + 事件流面板 |
| 辅助 | `renderRouteCard()`、`renderSelfCard()`、`renderWorkspacesCard()`、`renderMsgStatsCard()`、`renderChatlist()`、`renderEventLog()`、`loadMore()`、`render()` |

### 内部导航

无(纯只读诊断页;仅 filter 分段 + 分页 + 定时刷新)。读 `state.currentPage/currentWsId/currentChatId/self/workspaces/channels/messages/messagesOldestId/noMoreMsgs`。

### 导入依赖

`../api.js`(call, eventLog, DcEvent)、`../state.js`、`../components/icon.js`、`../components/escape.js`。

---

## 6. `src/plugins/view.ts`(252 行)

### 命令清单(6 个,全部 OK)

| 命令 | 参数 | 返回值 / 用途 |
|---|---|---|
| `list_plugins` | — | `PluginStatus[]`;市场已安装映射、已安装树(`refreshPluginTree`)、已安装列表 |
| `fetch_registry` | — | `RegistryPlugin[] \| null`;市场列表(失败显示「暂无可用插件」) |
| `install_plugin` | `{ name }` | `RegistryPlugin`;安装 → `loadPlugin(name, title)` |
| `install_plugin_from_zip` | `{ dataBase64 }` | `RegistryPlugin`;文件 → 分块(0x8000)btoa → 安装 → `loadPlugin` |
| `uninstall_plugin` | `{ name }` | void;confirm 后卸载 + `unloadPlugin(name)` |
| `toggle_plugin` | `{ name, enabled }` | void;已安装列表开关(失败回滚 checkbox) |

### 事件订阅

无。

### 渲染函数签名

| 函数 | 签名 |
|---|---|
| 侧栏(导出) | `export async function renderPluginsNav(panel: HTMLElement): Promise<void>` — 市场/已安装 toggle + 插件树 |
| 树(导出) | `export async function refreshPluginTree(): Promise<void>` — 按类型分组列已安装插件(Steam 库风格;供 navPanel 复用) |
| 主区(导出) | `export async function renderPluginsMain(main: HTMLElement): Promise<void>` — 按 `state.pluginsTab` 分发 |
| 内部 | `renderMarket(main)`、`renderInstalled(main)` |

### 内部导航(需替换为路由)

- **nav Tab 切换**:`state.pluginsTab = 'market'|'installed'` → 动态 import `../shell/navPanel.js` 的 `renderMain()` 重渲染主区 + `refreshPluginTree()`。Solid 迁移后应替换为本地状态/路由参数。
- 安装/卸载/开关后各视图内自刷新(`renderMarket(main)` / `renderInstalled(main)` / `refreshPluginTree()`)。

### 导入依赖

`../api.js`(call)、`../state.js`(pluginsTab)、`../toast.js`(showToast)、`../components/icon.js`(iconSvg)、`../components/escape.js`、`./confirm.js`(showPluginConfirm)、`./manager.js`(loadPlugin, unloadPlugin)、`./types.js`(PluginStatus, RegistryPlugin)。

---

## 7. `src/plugins/` 模块分类

| 文件 | 分类 | 说明 | 消费者 |
|---|---|---|---|
| `view.ts`(252 行) | **视图(迁移目标)** | 插件页 nav + main | `shell/navPanel.ts:92,128`(动态 import `renderPluginsNav`/`renderPluginsMain`) |
| `settings.ts`(147 行) | **视图(独立于 6 页清单,也需处理)** | 设置页「插件」区块 `renderPluginSettings(main)`;用同一组命令(`list_plugins`/`toggle_plugin`/`uninstall_plugin`/`install_plugin_from_zip 仅在 view.ts 使用)+ 权限管理 UI | `pages/settingsPage.ts:65`(动态 import `renderPluginSettings`) |
| `manager.ts`(68 行) | **纯工具(必须保留)** | `loadPlugins()`(应用启动)/`loadPlugin`/`unloadPlugin` + 已加载插件注册表;import api.js + types.js | **`shell/shell.ts:4`(启动时静态 import `loadPlugins`)**;view.ts / settings.ts |
| `api.ts`(173 行) | **纯工具(必须保留)** | `createPluginApi` 构造注入插件的 `peytchat` 沙箱 API;内部 `onEvent('IncomingMsg')` 分发 + `listen('bot-tool-request')` 回写;import permissions.js + storage.js + types.js | 仅 manager.ts(链式);无页面直接 import |
| `types.ts`(91 行) | **纯类型(必须保留)** | PluginApi/PluginStatus/RegistryPlugin/PluginPermission 等 | manager/api/permissions/settings/view |
| `permissions.ts`(50 行) | **纯工具(必须保留)** | localStorage 权限存储 + PERMISSION_LABELS;import 自根 ../types.ts | api.ts(运行时校验)/ settings.ts(UI) |
| `storage.ts`(19 行) | **纯工具(必须保留)** | 插件作用域 localStorage KV(`getPluginSetting`/`setPluginSetting`/`deletePluginSetting`);无 import | api.ts(peytchat.store)/ settings.ts |
| `confirm.ts`(69 行) | **轻量 DOM 工具(可保留或替换)** | `showPluginConfirm(anchor, message, onConfirm)` 浮动确认卡;无 API 调用 | view.ts / settings.ts |

**结论**:插件系统为运行时注入模型(`new Function` 执行插件 JS),`api.ts`/`manager.ts`/`types.ts`/`permissions.ts`/`storage.ts` 是底层运行时,**必须原样保留**;`view.ts` 是本次迁移的页面之一,`settings.ts` 是另一个独立视图(不在 6 页清单,建议后续处理);`confirm.ts` 是小组件,可保留或由 Solid 组件替代。`shell/shell.ts` 启动时静态 import `manager.js`,此依赖链不可破坏。

---

## 8. 汇总

| 页面 | 命令数 | 事件订阅 | 渲染函数(导出) | shell 级导航 | MISS |
|---|---|---|---|---|---|
| botsPage.ts | 21 | 2(`bot-activity` 原生 listen + `IncomingMsg`) | `renderBots(main)` | 无 | 0 |
| intelligencePage.ts | 11 | 1(`download-progress`) | `renderIntelligenceNav(panel)` + `renderIntelligenceMain(main)` | 仅 rightDrawer 清理 | 0 |
| githubPage.ts | 16 | 0 | `renderGithubNav(panel)` + `renderGithubMain(main)` | 仅 rightDrawer 清理 | 0 |
| inboxPage.ts | 3 | 0 | `renderInboxMain(main)` | **完整 shell 重渲染**(rail+navPanel+main+rightDrawer) | 0 |
| debugPage.ts | 2 | 0(读 `eventLog` + setInterval) | `renderDebugNav(panel)` + `renderDebugMain(main)` | 无 | 0 |
| plugins/view.ts | 6 | 0 | `renderPluginsNav(panel)` + `refreshPluginTree()` + `renderPluginsMain(main)` | 调 `navPanel.renderMain()` | 0 |

- 去重命令名共 **58 个**,全部存在(其中 `open_external` 为 `pub fn` 非 async,已注册)。**0 MISS**。
- 共享依赖注意:`renderMessage`(chat/message.js, botsPage 用)、`eventLog`(api.ts, debugPage 用)、`state.*` + `saveState()`(持久化路由状态)、`renderRail/renderNavPanel/renderMain/renderRightDrawer`(shell, inboxPage 用)、`getSpaceType`(navPanel, inboxPage 用)。
- 后端侧还需保留的事件:`bot-activity`(lib.rs:129)、`download-progress`(intelligence/download.rs + summary/downloader.rs)、`dc-event`(events.rs,全 app 事件总线)。
