# PEYT Chat — API 规范 / 对接文档

> 本文档描述 PEYT Chat(Tauri 2 + deltachat)前后端之间所有命令(commands)、事件(events)、数据结构(DTO)与错误模型,供前端开发、插件开发、二次集成参考。

---

## 1. 总览

PEYT Chat 是桌面即时通讯 + 团队协作应用,基于 deltachat(P2P 邮件协议)实现消息同步。UI 层为 WebView(Vite + TypeScript),逻辑层为 Rust。

- 运行时架构:Tauri 2
- 前端:`src/`(TypeScript,无框架,原生 DOM + 动态 import)
- 后端:`src-tauri/src/`(Rust,deltachat core + SQLite)
- 通信方式:Tauri IPC(`invoke` 命令 + `listen` 事件)

### 1.1 调用约定

- 所有命令通过 `window.__TAURI__.core.invoke(cmd, args)` 调用。
- **参数名使用 camelCase**;Rust 端为 snake_case,Tauri 自动转换(如 `workspace_id` ↔ `workspaceId`)。
- 所有命令返回 `Promise`,成功 resolve 返回值,失败 reject 一个错误对象(见 §3)。
- 前端统一封装在 `src/api.ts`:

```ts
import { call, onEvent } from './api.js';

const ws = await call('list_workspaces');               // 命令调用
const unsub = await onEvent('IncomingMsg', (payload) => { /* ... */ }); // 事件订阅
```

`call<T>(cmd, args?)` 失败时会调用 `showError` 并重新抛出;`onEvent(typ, cb)` 订阅 `dc-event` 并按 `typ` 过滤。

---

## 2. 命令清单(Commands)

按功能分组。所有命令已在 `src-tauri/src/lib.rs` 注册,下表参数名即为前端调用时的 camelCase 键名。

### 2.1 账号与认证

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `is_configured` | 无 | `boolean` | 是否已配置账号(启动时决定走登录页还是主界面) |
| `login` | `email: string`<br>`password: string`<br>`advanced?: AdvancedLogin` | `accountId: u32` | 登录(deltachat IMAP/SMTP 配置)。失败时 reject `AuthFailed` / `Network` / `AutoconfigNotFound` |
| `create_chatmail_account` | `display_name: string` | `accountId: u32` | 自动创建 chatmail 账号 |
| `get_self_profile` | 无 | `ProfileDto` | 当前账号资料(含头像路径、颜色) |
| `update_profile` | `name?: string`<br>`avatar_path?: string` | `()` | 更新资料。`avatar_path`: `None` 不改,`Some(path)` 设置,`Some("")` 删除 |
| `save_avatar_from_bytes` | `bytes: number[]`<br>`ext: string` | `path: string` | 保存头像文件,返回绝对路径(再传给 `update_profile`) |
| `get_my_qr` | 无 | `qr: string` | 自己的 SecureJoin 二维码数据 |
| `logout` | 无 | `()` | 退出登录(需 `location.reload()` 刷新界面) |

`AdvancedLogin`(仅自动配置失败时使用):

| 字段(camelCase) | 类型 | 说明 |
|---|---|---|
| `imapHost` | `string?` | IMAP 服务器 |
| `imapPort` | `number?` | IMAP 端口 |
| `imapSecurity` | `'ssl' \| 'tls' \| 'plain'?` | IMAP 加密方式 |
| `imapUser` | `string?` | IMAP 用户名 |
| `smtpHost` | `string?` | SMTP 服务器 |
| `smtpPort` | `number?` | SMTP 端口 |
| `smtpSecurity` | `'ssl' \| 'tls' \| 'plain'?` | SMTP 加密方式 |
| `smtpUser` | `string?` | SMTP 用户名 |
| `smtpPassword` | `string?` | SMTP 密码 |

### 2.2 聊天

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_chatlist` | 无 | `ChatDto[]` | 会话列表(消息页) |
| `get_chat_info` | `chatId: u32` | `ChatInfoDto` | 会话详情(含成员列表) |
| `get_chat_msgs` | `chatId: u32`<br>`beforeMsgId?: u32` | `MsgDto[]` | 拉取消息。`beforeMsgId` 用于向上翻页(传某条 msg_id 取更早消息),`null` 取最新一页 |
| `send_text` | `chatId: u32`<br>`text: string` | `msgId: u32` | 发送文本消息 |
| `send_reply` | `chatId: u32`<br>`text: string`<br>`quoteMsgId: u32` | `msgId: u32` | 发送引用回复 |
| `send_reaction` | `chatId: u32`<br>`msgId: u32`<br>`emoji: string` | `()` | 添加/移除表情回应 |
| `get_reactions` | `msgId: u32` | `ReactionDto[]` | 获取某消息的所有回应 |
| `delete_msg` | `msgId: u32` | `()` | 删除消息 |
| `mark_chat_noticed` | `chatId: u32` | `()` | 标记会话已读 |
| `accept_chat` | `chatId: u32` | `()` | 接受联系人请求会话 |
| `block_chat` | `chatId: u32` | `()` | 屏蔽会话/联系人 |
| `delete_chat` | `chatId: u32` | `()` | 删除会话 |
| `leave_group` | `chatId: u32` | `()` | 退出群组 |
| `create_group` | `name: string`<br>`memberEmails: string[]` | `chatId: u32` | 创建群组(按邮箱加人) |
| `create_group_chat` | `name: string` | `chatId: u32` | 创建群组(空群,先建后加人) |
| `add_group_member` | `chatId: u32`<br>`email: string` | `chatId: u32` | 添加成员 |
| `create_chat_by_email` | `email: string` | `chatId: u32` | 与邮箱建立 1:1 会话 |
| `create_chat_by_contact` | `contactId: u32` | `chatId: u32` | 与联系人建立 1:1 会话 |
| `get_securejoin_qr` | `chatId?: u32` | `qr: string` | 获取会话(群)的加入二维码 |
| `secure_join` | `qr: string` | `chatId: u32` | 通过二维码加入群/会话 |
| `get_channel_topic` | `chatId: u32` | `string \| null` | 获取频道主题 |
| `set_channel_topic` | `chatId: u32`<br>`topic: string` | `()` | 设置频道主题 |
| `search_msgs` | `query: string` | `SearchResultDto[]` | 全局消息搜索 |

### 2.3 联系人

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_contacts` | 无 | `ContactDto[]` | 全部联系人 |

### 2.4 工作区与频道(Workspace / Channel)

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_workspaces` | 无 | `WorkspaceDto[]` | 全部工作区 |
| `create_workspace` | `name: string` | `WorkspaceDto` | 创建工作区 |
| `update_workspace` | `id: i64`<br>`name?: string`<br>`icon?: string` | `()` | 更新工作区 |
| `delete_workspace` | `id: i64` | `()` | 删除工作区 |
| `join_workspace` | `qr: string` | `WorkspaceDto` | 通过二维码加入工作区 |
| `leave_workspace` | `id: i64` | `()` | 退出工作区 |
| `list_channels` | `workspaceId: i64` | `ChannelDto[]` | 工作区频道列表 |
| `create_channel` | `workspaceId: i64`<br>`name: string`<br>`category: string` | `ChannelDto` | 创建频道(同时创建 deltachat 群) |
| `update_channel` | `chatId: u32`<br>`name?: string`<br>`topic?: string`<br>`category?: string` | `()` | 更新频道 |
| `delete_channel` | `chatId: u32` | `()` | 删除频道 |
| `leave_channel` | `chatId: u32` | `()` | 退出频道 |
| `get_channel_pins` | `chatId: u32` | `PinDto[]` | 频道置顶消息列表 |
| `toggle_pin` | `workspaceId: i64`<br>`chatId: u32`<br>`msgId: u32` | `boolean` | 切换置顶,返回置顶后状态 |
| `validate_channels` | 无 | `u32` | 校验/修复频道与 deltachat 群的关联 |
| `get_channel_space_type` | `chatId: u32` | `string \| null` | 频道空间类型(`chat` / `card`) |
| `update_channel_space_type` | `chatId: u32`<br>`spaceType: string` | `()` | 设置空间类型 |
| `ensure_peyt_studio` | 无 | `PeytStudioDto` | 确保默认 PEYT Studio 工作区存在 |
| `join_peyt_studio` | `qr: string` | `PeytStudioDto` | 通过二维码加入 PEYT Studio |
| `join_peyt_channel` | `workspaceId: i64`<br>`qr: string`<br>`name: string`<br>`category: string`<br>`spaceType?: string` | `chatId: u32` | 通过二维码加入 PEYT 频道 |

### 2.5 角色与成员

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_roles` | `workspaceId: i64` | `RoleDto[]` | 工作区角色列表 |
| `set_contact_role` | `workspaceId: i64`<br>`contactId: u32`<br>`roleId: i64` | `()` | 给联系人分配角色 |
| `list_all_contact_roles` | `workspaceId: i64` | `ContactRoleDto[]` | 全部联系人的角色(含角色名/颜色,用于右侧面板分组) |

### 2.6 卡片(Cards,协作任务)

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_cards` | `workspaceId: i64`<br>`chatId: u32` | `CardDto[]` | 频道卡片列表 |
| `get_card` | `cardId: i64` | `CardDto` | 卡片详情 |
| `create_card` | `workspaceId: i64`<br>`chatId: u32`<br>`type: string`<br>`title: string`<br>`description?: string`<br>`assigneeContactId?: u32`<br>`dueDate?: i64` | `CardDto` | 创建卡片 |
| `update_card` | `cardId: i64`<br>`title?: string`<br>`description?: Clearable<string>`<br>`status?: string`<br>`assigneeContactId?: Clearable<u32>`<br>`dueDate?: Clearable<i64>` | `CardDto` | 更新卡片。**Clearable 语义**:不传键 = 不修改;传 `null` = 清空;传值 = 更新 |
| `delete_card` | `cardId: i64` | `()` | 删除卡片 |
| `message_to_card` | `msgId: u32`<br>`workspaceId: i64`<br>`chatId: u32`<br>`type: string`<br>`title?: string` | `CardDto` | 把消息转为卡片 |
| `upsert_card_from_msg` | `msgId: u32`<br>`cardJson: string` | `CardDto \| null` | 从消息中的 `[CARD]` JSON 同步卡片 |

> `Clearable<T>` 是后端自定义反序列化包装。前端示例:
> `update_card({ cardId: 5, description: null })` → 清空描述;
> `update_card({ cardId: 5 })` → 仅不修改其他字段。

### 2.7 Inbox 通知中心(SP6)

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_inbox_events` | `limit?: i64` | `InboxEventDto[]` | 通知列表(默认 100 条) |
| `mark_inbox_read` | `eventId: i64` | `()` | 标记单条已读 |
| `mark_all_inbox_read` | 无 | `()` | 全部已读 |
| `get_inbox_unread_count` | 无 | `i64` | 未读通知数(rail 角标) |
| `record_inbox_event` | `eventType: string`<br>`sourceChatId: i64`<br>`msgId?: i64`<br>`actorId: i64`<br>`actorName: string`<br>`summary: string` | `()` | 记录通知(内部调用,前端一般不用) |

`eventType` 取值:`mention` / `reply` / `card_assign` / `system`。

### 2.8 Activity 活动流(SP6)

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_activities` | `channelChatId?: i64`<br>`limit?: i64` | `ActivityDto[]` | 活动流(工作区或指定频道) |

`action` 取值:`card_create` / `card_update` / `card_delete` / `pin_toggle` / `message_to_card` / `channel_create`;
`target_type` 取值:`card` / `message` / `channel`。

### 2.9 插件系统

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `fetch_registry` | 无 | `RegistryPlugin[]` | 从远程市场拉取插件列表(GitHub Pages,失败时可用本地缓存) |
| `install_plugin` | `name: string` | `RegistryPlugin` | 从市场安装插件(下载 manifest + JS) |
| `install_plugin_from_zip` | `dataBase64: string` | `RegistryPlugin` | 从本地 zip(base64)安装插件 |
| `uninstall_plugin` | `name: string` | `()` | 卸载插件 |
| `list_plugins` | 无 | `PluginStatus[]` | 已安装插件列表(含启用状态) |
| `toggle_plugin` | `name: string`<br>`enabled: boolean` | `()` | 启用/禁用插件 |
| `get_plugin_js` | `name: string` | `js: string` | 读取插件入口 JS 源码 |

> 插件 JS 由前端 `new Function('peytchat', js)` 执行,`peytchat` 为注入的 API 对象(见 §5 插件 API)。

### 2.10 终端(PTY)

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `open_terminal` | `workdir?: string` | `sessionId: string` | 启动 PTY shell 会话(默认 `$SHELL`,Windows 为 cmd) |
| `write_terminal` | `sessionId: string`<br>`input: string` | `()` | 写入输入到 PTY |
| `resize_terminal` | `sessionId: string`<br>`cols: number`<br>`rows: number` | `()` | 同步终端尺寸 |
| `close_terminal` | `sessionId: string` | `()` | 结束会话并杀进程 |

终端输出经事件 `terminal-output` 推送(见 §4.2),不受白名单限制;白名单校验仅在前端 `terminalPage.ts` 实现。

### 2.11 Bot 系统

Bot 是应用级后台服务(以独立 deltachat 账号运行),所有 bot 命令归属当前登录账号(owner),前端参数名沿用 camelCase。

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `create_bot` | `displayName: string` | `BotDto` | 创建 bot 账号(chatmail 邮箱),归属当前账号 |
| `list_bots` | 无 | `BotDto[]` | 当前账号的全部 bot |
| `delete_bot` | `botId: i64` | `()` | 删除 bot |
| `set_bot_io` | `botId: i64`<br>`running: boolean` | `BotDto` | 启/停 bot IO(后台收发消息) |
| `get_bot_config` | `botId: i64` | `BotConfig \| null` | 读取完整结构化配置 |
| `update_bot_config` | `botId: i64`<br>`config: BotConfig` | `BotDto` | 整体覆写配置 |
| `get_bot_llm` | `botId: i64` | `LlmConfig \| null` | 读取 LLM 配置(**兼容旧前端**) |
| `update_bot_llm` | `botId: i64`<br>`config: LlmConfigInput` | `BotDto` | 更新 LLM 配置(**兼容旧前端**) |
| `test_llm_config` | `config: LlmConfigInput` | `string` | 用固定示例消息测试 LLM 配置,返回回复文本(配置对话框「测试连接」) |
| `bot_get_chatlist` | `botId: i64` | `ChatDto[]` | 以 bot 账号身份拉取会话列表 |
| `bot_get_chat_msgs` | `botId: i64`<br>`chatId: u32` | `MsgDto[]` | 以 bot 身份拉取会话消息(最近 50 条) |
| `bot_send_text` | `botId: i64`<br>`chatId: u32`<br>`text: string` | `MsgDto` | 以 bot 身份发送文本消息 |
| `bot_mark_chat_noticed` | `botId: i64`<br>`chatId: u32` | `()` | 标记 bot 会话已读 |
| `bot_mark_chat_seen` | `botId: i64`<br>`chatId: u32` | `()` | 标记 bot 会话已读并发送已读回执 |
| `add_bot_to_chat` | `botId: i64`<br>`chatId: u32` | `()` | 把 bot 拉入群/频道(主账号生成邀请 QR,bot 通过 securejoin 加入) |
| `list_bot_personas` | 无 | `PersonaDto[]` | 全部人设模板(id/name/description,不含 system_prompt) |
| `apply_bot_persona` | `botId: i64`<br>`personaId: string` | `BotDto` | 套用人设(写 persona_id 并覆盖 system_prompt) |
| `get_bot_stats` | `botId: i64` | `BotStatsDto` | bot 活动统计(按 kind 聚合) |
| `list_bot_activities` | `botId: i64`<br>`limit?: i64` | `BotActivityDto[]` | 活动时间线(倒序;默认 50,上限 500) |
| `bot_list_schedules` | `botId: i64` | `ScheduleDto[]` | bot 定时任务列表 |
| `bot_add_schedule` | `botId: i64`<br>`chatId: u32`<br>`minute: i32`<br>`hour: i32`<br>`dayOfWeek: i32`<br>`message: string` | `ScheduleDto` | 添加定时任务(自动计算下次运行时间) |
| `bot_delete_schedule` | `scheduleId: i64` | `()` | 删除定时任务 |
| `list_bot_tools` | 无 | `BotToolDto[]` | 全部可用工具(内置 + 插件) |
| `register_bot_tool` | `name: string`<br>`description: string`<br>`parameters: object` | `()` | 注册插件工具(入库 + 热加载) |
| `unregister_bot_tool` | `name: string` | `()` | 注销插件工具 |
| `bot_tool_result` | `id: string`<br>`result: string` | `()` | 插件工具执行结果回填 |

> `parameters` 为描述工具入参结构的 JSON Schema 对象(展示用);真正执行由前端插件 handler 完成:后端触发时推送 `bot-tool-request` 事件(§4.4),插件执行后调 `bot_tool_result(id, result)` 回填,超时 10s 后端报错。

> **`get_bot_config` / `update_bot_config`**:除 `llm` 外还涵盖 `limits` / `tools` / `rule` / `persona` / `project_context`(前端 LLM Tab「项目上下文」区配置 `project_context`,LLM 驱动会把 `description` 与关联频道 `chat_ids` 的最近消息注入为 system 消息)。

### 2.12 GitHub 集成(D1)

GitHub 访问层:`src-tauri/src/github/`(`client.rs` 共享 HTTP 客户端 + `api.rs` 纯函数端点 + `types.rs` 响应 DTO)。命令层全部使用**全局 token**(`github_settings.token`),无 token 时公开只读;`search_code` 等需 token 的命令无 token 时 reject `Core("需要 GitHub token")`。

| 命令 | 参数(camelCase) | 返回 | 说明 |
|---|---|---|---|
| `get_github_settings` | 无 | `GithubSettingsDto` | 全局 GitHub 设置(token) |
| `set_github_token` | `token?: string` | `()` | 设置/更新全局 token;`token: null` 清除 |
| `list_github_repos` | 无 | `GithubRepoDto[]` | 已绑定仓库列表 |
| `add_github_repo` | `owner: string`<br>`repo: string` | `GithubRepoDto` | 绑定仓库(校验:非空、不含 `/`、仅 `[A-Za-z0-9._-]`) |
| `remove_github_repo` | `id: i64` | `()` | 解除绑定 |
| `github_repo` | `owner: string`<br>`repo: string` | `RepoDto` | 仓库详情 |
| `github_list_issues` | `owner: string`<br>`repo: string`<br>`state?: string` | `IssueDto[]` | Issue 列表(`state`: `open` / `closed` / `all`,默认全部;已过滤混入的 PR) |
| `github_get_issue` | `owner: string`<br>`repo: string`<br>`number: i64` | `IssueDto` | Issue 详情 |
| `github_list_pulls` | `owner: string`<br>`repo: string`<br>`state?: string` | `PullDto[]` | PR 列表 |
| `github_list_commits` | `owner: string`<br>`repo: string`<br>`path?: string` | `CommitDto[]` | Commit 列表(可限定路径) |
| `github_search_repo` | `query: string` | `SearchRepoDto[]` | 仓库搜索 |
| `github_search_code` | `query: string` | `SearchCodeDto[]` | 代码搜索(**需 token**) |
| `github_list_events` | `owner: string`<br>`repo: string` | `EventDto[]` | 仓库动态事件 |
| `github_get_content` | `owner: string`<br>`repo: string`<br>`path: string` | `ContentDto[]` | 仓库内容:目录返回条目数组;单文件返回 1 项(带 base64 `content`);`path` 传空串取根目录 |

> 错误路径:假/过期 token → `GitHubAuth`;不存在仓库/资源 → `GitHubNotFound`;限速(429/403)→ `GitHubRateLimit`(附 reset 提示);5xx → `GitHubServer`(见 §3)。

---

## 3. 错误模型

命令失败时 reject 的错误对象包含:

| 字段 | 说明 |
|---|---|
| `code` / `message` | Tauri 包装的错误信息(`InvokeError` 或后端错误文本) |

后端 `AppError` 变体(错误消息会透传到前端):

| 变体 | 场景 |
|---|---|
| `AuthFailed` | 登录认证失败 |
| `Network(String)` | 网络错误 |
| `AutoconfigNotFound` | 自动配置未找到 |
| `Core(String)` | deltachat / 通用核心错误 |
| `Io(String)` | 文件系统错误 |
| `Db(String)` | SQLite 错误 |
| `Plugin(String)` | 插件相关错误(安装/解析/下载) |
| `GitHubRateLimit(String)` | GitHub 限速(429/403),错误消息附 `X-RateLimit-Reset` 换算的等待秒数提示 |
| `GitHubAuth(String)` | GitHub 认证失败(401),提示检查 token |
| `GitHubServer(String)` | GitHub 服务器错误(5xx) |
| `GitHubNotFound(String)` | GitHub 资源不存在(404,仓库/文件/Issue 等) |

> **bot 所有权校验**:所有 bot 命令会先校验 bot 归属当前账号。bot 不存在或不属于当前账号时,统一 reject `Core("bot not found")`(例如跨账号访问他人 bot、`get_bot_stats` / `list_bot_activities` / `bot_list_schedules` / `bot_get_*` 等)。

前端捕获约定:所有 `call()` 失败会显示顶部错误条并 reject;业务代码通常 `try/catch` 后用 `showToast` 提示。

```ts
try {
  await call('send_text', { chatId, text });
} catch (err) {
  showToast(err instanceof Error ? err.message : String(err));
}
```

---

## 4. 事件系统

前端通过 `listen('dc-event', ...)` 接收 deltachat 事件,`api.ts` 的 `onEvent(typ, cb)` 已按 `typ` 过滤。另有独立事件 `terminal-output`。

### 4.1 `dc-event` — deltachat 核心事件

统一 payload:`{ typ: string, chat_id?, msg_id?, contact_id?, progress?, comment?, text? }`

| `typ` | 触发时机 | 附带字段 |
|---|---|---|
| `IncomingMsg` | 收到新消息 | `chat_id`, `msg_id`, `text`(摘要,供通知) |
| `MsgsChanged` | 会话内消息变更 | `chat_id`, `msg_id` |
| `MsgsNoticed` | 已读状态同步 | `chat_id` |
| `MsgDelivered` | 消息送达 | `chat_id`, `msg_id` |
| `MsgFailed` | 消息发送失败 | `chat_id`, `msg_id` |
| `MsgRead` | 对方已读 | `chat_id`, `msg_id` |
| `MsgDeleted` | 消息被删除 | `chat_id`, `msg_id` |
| `ReactionsChanged` | 回应变更 | `chat_id`, `msg_id`, `contact_id` |
| `IncomingReaction` | 收到新回应 | `chat_id`, `msg_id`, `contact_id` |
| `IncomingMsgBunch` | 批量消息(如导入) | 无 |
| `ContactsChanged` | 联系人变化 | `contact_id?` |
| `SelfavatarChanged` | 自己头像变化 | 无 |
| `ConfigureProgress` | 登录配置进度 | `progress`(0–1000), `comment` |
| `ChatlistItemChanged` | 会话列表项变化 | `chat_id` |
| `ChatModified` | 会话被修改 | `chat_id` |
| `ChatDeleted` | 会话被删除 | `chat_id` |
| `ChatEphemeralTimerModified` | 阅后即焚计时变化 | `chat_id` |
| `SecurejoinJoinerProgress` | 加入方 securejoin 进度 | `contact_id`, `progress` |
| `SecurejoinInviterProgress` | 邀请方 securejoin 进度 | `contact_id`, `progress` |
| `WebxdcStatusUpdate` | webxdc 状态更新 | `msg_id` |
| `WebxdcRealtimeData` | webxdc 实时数据 | `msg_id` |
| `WebxdcInstanceDeleted` | webxdc 实例删除 | `msg_id` |

### 4.2 `terminal-output` — 终端输出

```ts
interface TerminalOutputPayload { session_id: string; data: string; }
```
PTY 输出增量(已按 UTF-8 边界切分),`data` 直接 `term.write()` 即可。会话结束时后端推送 `\r\n[终端会话已结束]\r\n`。

### 4.3 `bot-activity` — Bot 活动实时事件

Bot 每次活动(思考/回复/错误等)实时推送,payload 为 `BotActivityDto` 的原始序列化(字段 snake_case)。前端用于时间线页即时更新与打字指示器。

```ts
interface BotActivityPayload {
  id: number; bot_id: number; kind: string;
  chat_id: number | null; msg_id: number | null;
  summary: string; detail_json: string | null; created_at: number;
}
```

`kind` 取值(与 `list_bot_activities` 一致):`thinking` / `reply_sent` / `reply_skipped` / `reply_rate_limited` / `llm_error` / `no_config` / `driver_disabled` / `rule_reply` / `schedule_sent` / `tool_called`。

### 4.4 `bot-tool-request` — 插件工具执行请求

Bot 驱动需要调用插件工具时推送,payload 为:

```ts
interface BotToolRequestPayload { kind: 'tool_request'; id: string; name: string; args: unknown; }
```

前端插件模块(`src/plugins/api.ts`)监听该事件,按 `name` 匹配 `registerTool` 注册的 handler,执行后调 `bot_tool_result(id, result)` 回填(`result` 为字符串);超时 10s 后端报错。

---

## 5. 插件 API(前端注入)

插件入口通过 `new Function('peytchat', js)` 执行,`peytchat` 为 `PluginApi` 对象。各接口受插件权限门控。

| API | 签名 | 所需权限 |
|---|---|---|
| `sendText` | `(chatId: number, text: string) => Promise<unknown>` | `messages:send` |
| `onMessage` | `(cb: (payload) => void) => Promise<unsubscribe>` | `messages:read` |
| `addCSS` | `(css: string) => () => void` | `ui:css` |
| `registerTheme` | `(config: PluginThemeConfig) => void` | `ui:theme` |
| `onCommand` | `(name: string, cb: (args, chatId) => unknown) => void` | `commands` |
| `registerLLM` | `(name: string, config) => void` | `llm` |
| `registerTool` | `(name: string, description: string, parameters: object, handler: (args: unknown) => Promise<string>) => Promise<void>` | `tools` |
| `unregisterTool` | `(name: string) => Promise<void>` | `tools` |
| `http.get / http.post` | `(url, body?) => Promise<T>` | `network` |
| `store.get / set / delete` | 插件本地键值存储 | — |
| `registerSetting` | `(config: PluginSettingConfig) => void` | — |
| `log.info / warn / error` | `(msg: string) => void` | — |

> `registerTool` 需带 `tools` 权限:前端 `call('register_bot_tool', { name, description, parameters })` 入库并热加载,插件卸载时自动 `unregister_bot_tool`;bot 触发该工具时经 `bot-tool-request` 事件(§4.4)回调,`handler` 返回字符串并经 `bot_tool_result` 回填。

权限键:`messages:read` / `messages:send` / `ui:css` / `ui:theme` / `commands` / `llm` / `network` / `tools`,在 设置 → 插件 中配置。

示例插件:

```js
peytchat.onCommand('hello', (args) => `Hi, ${args || 'world'}!`);
peytchat.sendText(chatId, 'from plugin');
```

---

## 6. 快速示例

```ts
import { call, onEvent } from './api.js';

// 登录
const accountId = await call('login', { email, password });

// 拉取工作区与频道
const workspaces = await call('list_workspaces');
const channels = await call('list_channels', { workspaceId: workspaces[0].id });

// 发消息并订阅新消息
await call('send_text', { chatId, text: 'hello' });
const unsub = await onEvent('IncomingMsg', (e) => console.log(e.text));
unsub(); // 退订
```

---

## 7. 附录:DTO 定义

> 字段名为后端 Rust DTO 序列化后的 **snake_case**(命令返回值、事件 payload 均按原字段名输出)。Tauri 仅对命令**参数**做 camelCase → snake_case 转换(见 §1.1);响应/事件**不做** camelCase 转换,前端按 snake_case 消费。`i64` / `u32` / `i32` 在前端均以 `number` 表示。

### BotDto

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | bot 记录 ID |
| `bot_account_id` | `number` | 关联的 deltachat 账号 id |
| `display_name` | `string` | 显示名 |
| `addr` | `string \| null` | bot 邮箱地址 |
| `io_running` | `boolean` | IO 是否在运行 |
| `created_at` | `number` | 创建时间戳 |

### LlmConfig(结构化 LLM 配置)

`get_bot_config` / `update_bot_config` 使用;`LlmConfigInput` 为其子集(仅前 5 个可选字段)。

| 字段 | 类型 | 说明 |
|---|---|---|
| `system_prompt` | `string?` | 系统提示词 |
| `base_url` | `string?` | API 地址 |
| `api_key` | `string?` | API 密钥 |
| `model` | `string?` | 模型名 |
| `provider` | `string?` | 供应商 |
| `temperature` | `number` | 默认 `0.7` |
| `max_tokens` | `number?` | 最大输出 token |
| `top_p` | `number?` | 采样参数 |
| `timeout_secs` | `number` | 默认 `120` |
| `max_retries` | `number` | 默认 `2` |

### BotConfig(完整结构化配置,存于 `bots.config_json`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `llm` | `LlmConfig \| null` | LLM 驱动配置 |
| `limits` | `BotLimits` | 运行时限额(见下) |
| `tools` | `string[] \| null` | 显式启用的工具名集合;`null` = 使用默认安全工具集 |
| `rule` | `RuleConfig \| null` | 规则驱动配置 |
| `persona` | `string \| null` | 人设 id |
| `project_context` | `ProjectContext \| null` | 项目上下文(预留,D1-D3 地基) |

### ProjectContext(项目上下文)

| 字段 | 类型 | 说明 |
|---|---|---|
| `workspace_id` | `number \| null` | 关联工作区 id(预留) |
| `chat_ids` | `number[]` | 关联频道;LLM 驱动回复时会注入这些频道最近消息作为对话背景 |
| `description` | `string?` | 项目一句话描述;有值注入为 system 消息「项目背景:…」 |
| `repo_path` | `string?` | GitHub 仓库标识 `owner/repo`(如 `octocat/Hello-World`),纯 API 访问,无本地克隆 |
| `github_token` | `string?` | 每 Bot 的 GitHub token;工具调用时**优先**使用,回退全局 settings token |

### BotLimits

| 字段 | 类型 | 说明 |
|---|---|---|
| `max_concurrent` | `number` | 默认 `2` |
| `reply_min_interval_secs` | `number` | 最小回复间隔秒数,默认 `3` |
| `allow_bot_interaction` | `boolean` | 是否允许 Bot 与 Bot 对话,默认 `false` |
| `interaction_max_rounds` | `number` | 互动最大轮数,默认 `3` |

### RuleConfig / RuleDef(规则驱动)

`RuleConfig`:

| 字段 | 类型 | 说明 |
|---|---|---|
| `rules` | `RuleDef[]` | 规则列表 |
| `welcome` | `string?` | 欢迎语 |
| `fallback` | `string?` | 兜底回复 |

`RuleDef`:

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 规则 ID |
| `pattern` | `string` | 关键词子串或正则 |
| `is_regex` | `boolean` | 是否为正则 |
| `replies` | `string[]` | 候选回复(随机取一条) |
| `enabled` | `boolean` | 是否启用 |

### ScheduleDto(定时任务)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 任务 ID |
| `bot_id` | `number` | 所属 bot |
| `chat_id` | `number` | 目标会话 |
| `minute` | `number` | 分(-1 = 任意) |
| `hour` | `number` | 时(-1 = 任意) |
| `day_of_week` | `number` | 星期(-1 = 任意) |
| `message` | `string` | 要发送的消息 |
| `enabled` | `boolean` | 是否启用 |
| `next_run_at` | `number` | 下次运行时间戳 |

### BotStatsDto(活动统计,按 `kind` 聚合)

| 字段 | 类型 | 说明 |
|---|---|---|
| `total_activities` | `number` | 活动总数 |
| `reply_sent` | `number` | 已回复 |
| `rule_reply` | `number` | 规则回复 |
| `schedule_sent` | `number` | 定时发送 |
| `tool_called` | `number` | 工具调用 |
| `llm_error` | `number` | LLM 错误 |
| `rate_limited` | `number` | 被限流 |
| `last_activity_at` | `number \| null` | 最近活动时间 |
| `first_seen_at` | `number \| null` | 首次活动时间 |

### PersonaDto(人设模板,不含 `system_prompt`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 人设 id |
| `name` | `string` | 名称 |
| `description` | `string` | 描述 |

### BotToolDto(工具元信息,内置 + 插件)

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 工具名 |
| `description` | `string` | 描述 |
| `safe` | `boolean` | 是否默认安全(安全工具无需显式启用即可被 bot 使用) |

### BotActivityDto(活动日志)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 活动 ID |
| `bot_id` | `number` | 所属 bot |
| `kind` | `string` | 活动类型(见 §4.3) |
| `chat_id` | `number \| null` | 相关会话 |
| `msg_id` | `number \| null` | 相关消息 |
| `summary` | `string` | 摘要 |
| `detail_json` | `string \| null` | 附加详情(JSON 字符串) |
| `created_at` | `number` | 时间戳 |

### GithubSettingsDto(全局 GitHub 设置)

| 字段 | 类型 | 说明 |
|---|---|---|
| `token` | `string?` | 全局 GitHub token;`null` = 公开只读 |

### GithubRepoDto(已绑定仓库)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 绑定记录 ID |
| `owner` | `string` | owner(校验:非空、不含 `/`、仅 `[A-Za-z0-9._-]`) |
| `repo` | `string` | repo 名(同上) |
| `full_name` | `string` | `owner/repo` 标识,唯一 |

### RepoDto(仓库详情,`github_repo`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `full_name` | `string` | `owner/repo` |
| `description` | `string \| null` | 仓库描述 |
| `language` | `string \| null` | 主要语言 |
| `stargazers_count` | `number` | 星标数 |
| `forks_count` | `number` | fork 数 |
| `open_issues_count` | `number` | open issue 数 |
| `default_branch` | `string` | 默认分支 |
| `html_url` | `string` | GitHub 页面 URL |

### IssueDto(Issue 列表/详情)

| 字段 | 类型 | 说明 |
|---|---|---|
| `number` | `number` | 编号 |
| `title` | `string` | 标题 |
| `state` | `string` | `open` / `closed` |
| `user` | `string` | 提交者 login |
| `created_at` | `string` | 创建时间(ISO) |
| `updated_at` | `string` | 更新时间(ISO) |
| `labels` | `string[]` | 标签名列表 |
| `body` | `string \| null` | 正文 |
| `html_url` | `string` | GitHub 页面 URL |

### PullDto(PR 列表/详情)

| 字段 | 类型 | 说明 |
|---|---|---|
| `number` | `number` | 编号 |
| `title` | `string` | 标题 |
| `state` | `string` | `open` / `closed` |
| `user` | `string` | 提交者 login |
| `created_at` | `string` | 创建时间(ISO) |
| `updated_at` | `string` | 更新时间(ISO) |
| `merged_at` | `string \| null` | 合并时间 |
| `additions` | `number` | 新增行数 |
| `deletions` | `number` | 删除行数 |
| `html_url` | `string` | GitHub 页面 URL |

### CommitDto(Commit 列表项)

| 字段 | 类型 | 说明 |
|---|---|---|
| `sha` | `string` | 完整 SHA |
| `message` | `string` | 首行消息(截断 80 字符) |
| `author` | `string \| null` | 作者名 |
| `date` | `string \| null` | 提交时间(ISO) |

### EventDto(仓库动态)

| 字段 | 类型 | 说明 |
|---|---|---|
| `typ` | `string` | 事件类型(如 `PushEvent` / `IssuesEvent`) |
| `actor` | `string \| null` | 触发者 login |
| `created_at` | `string` | 时间(ISO) |
| `summary` | `string` | 摘要(如「3 次提交」「opened: Bug in UI」) |

### ContentDto(仓库内容:文件或目录)

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 名称 |
| `path` | `string` | 相对仓库根路径 |
| `typ` | `string` | `file` / `dir` |
| `size` | `number` | 字节数(目录为 0) |
| `content` | `string \| null` | 文件 base64 内容(仅单文件请求时;目录为 `null`) |

### SearchRepoDto(仓库搜索结果)

| 字段 | 类型 | 说明 |
|---|---|---|
| `full_name` | `string` | `owner/repo` |
| `description` | `string \| null` | 描述 |
| `stargazers_count` | `number` | 星标数 |
| `language` | `string \| null` | 主要语言 |
| `html_url` | `string` | GitHub 页面 URL |

### SearchCodeDto(代码搜索结果)

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 文件名 |
| `path` | `string` | 仓库内路径 |
| `repo_full_name` | `string` | 所属仓库 `owner/repo` |
| `html_url` | `string` | GitHub 页面 URL |
