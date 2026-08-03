# 后端地图（src-tauri/，Rust + Tauri v2）

11 个 Rust 文件。全部业务在 `commands.rs`（~2728 行），应用数据在 `db.rs`（SQLite），与 deltachat 核心（submodule `core/`）对接。

---

## 1. 启动（`src-tauri/src/lib.rs`）

- `env_logger` 默认 `debug`。**无任何 tauri-plugin**，全手写 `#[tauri::command]`。
- setup：取 `app_data_dir` → `AppState::new(dir)`（block_on）→ `spawn_event_forwarder` → `app.manage(state)`。
- `invoke_handler` 注册 **100 个命令**（96 来自 commands.rs + 4 来自 terminal.rs）。**新增命令必须在这里登记**。

## 2. AppState（`src-tauri/src/state.rs`）

```rust
pub struct AppState {
    pub accounts: Arc<tokio::sync::Mutex<Accounts>>,  // deltachat 多账号管理器
    pub current_id: std::sync::Mutex<Option<u32>>,    // 当前账号 id（std mutex，同步访问）
    pub db: Arc<Db>,                                   // 应用 SQLite
    pub plugins: PluginManager,
    pub terminals: TerminalSessions,                   // PTY 会话 map
}
```

- `current()` async：取当前 Context；`set_current(id)` 同步设。
- **锁注意**：`accounts` 是 tokio Mutex（`.lock().await`）；`current_id` 是 std Mutex（同步，纳秒级持锁）。

## 3. 命令清单（100 个，按功能分组）

**Auth/Account**：`is_configured` `login` `create_chatmail_account` `get_self_profile` `update_profile` `save_avatar_from_bytes` `get_my_qr` `logout`

**Chatlist/Messages**：`get_chatlist`（`archived_only` 参数 → DC_GCL_ARCHIVED_ONLY；跳过 archived_link/allDone 虚拟会话）`get_chat_info` `get_chat_msgs`（before_msg_id 分页，窗口 50）`send_text` `delete_msg` `search_msgs`（本地遍历最后 50 条子串匹配，上限 30）`get_asset_url`（→ asset://）`get_all_messages`（debug 分页）

**归档/保存消息/草稿（Delta 对齐批次 1）**：`archive_chat`（ChatId::set_visibility → Archived/Normal）`save_msg`（chat::save_msgs → self-talk）`unsave_msg`（message::delete_msgs 删 saved 副本）`get_draft`（ChatId::get_draft）`set_draft`（ChatId::set_draft，空文本=清除）

**搜索/Gallery/邮件广播（Delta 对齐批次 2）**：`search_msgs`（可选 chat_id 会话内搜索）`get_chat_media`（按 viewtype 过滤媒体）`get_message_read_receipt_count`（广播已读数）

**语音/Webxdc（Delta 对齐批次 3）**：`send_voice`（base64 → Voice 消息）`get_webxdc_info` `get_webxdc_status_updates` `send_webxdc_status_update`

**通知/保护/多设备/备份（Delta 对齐批次 4）**：`get_appdata_dir` `export_self_keys` `import_self_keys`（core imex）`export_backup` `import_backup`（core imex 带密码）`get_contact_encryption_info`（core get_encrinfo 指纹）

**屏蔽列表**：`get_blocked_contacts` `unblock_contact`

**Contacts**：`get_contacts` `create_chat_by_email` `create_chat_by_contact`

**Chat Mgmt**：`accept_chat` `block_chat` `delete_chat` `leave_group` `mark_chat_noticed`

**Group**：`create_group` `add_group_member` `create_group_chat`

**SecureJoin**：`get_securejoin_qr`（None=个人二维码，Some=群邀请）`secure_join`

**Workspaces**：`list_workspaces` `create_workspace`（建 master 群 + 默认频道 + core 角色）`join_workspace` `update_workspace` `delete_workspace`（级联删）`leave_workspace`（只删本地元数据，不退出群）

**Channels**：`list_channels` `create_channel` `update_channel` `delete_channel` `leave_channel` `validate_channels` `get/set_channel_topic` `get_channel_pins` `toggle_pin`（pinned_by 恒为 1）`update/get_channel_space_type`

**Roles**：`list_roles` `set_contact_role` `list_all_contact_roles`

**Reactions/Replies**：`send_reaction`（chat_id 仅为 API 对称，未使用）`get_reactions` `send_reply`

**Cards/Work**（详见 3.1）：`create_card` `update_card` `delete_card` `list_cards` `get_card` `upsert_card_from_msg` `message_to_card`

**PEYT Studio**：`ensure_peyt_studio`（founder：建 master + chitchat/work 频道，发 [PEYT_INVITE]）`join_peyt_studio` `join_peyt_channel`

**Inbox/Activity**：`list_inbox_events` `mark_inbox_read` `mark_all_inbox_read` `get_inbox_unread_count` `list_activities` `record_inbox_event`

**Plugins**：`fetch_registry` `install_plugin` `install_plugin_from_zip` `uninstall_plugin` `list_plugins` `toggle_plugin` `get_plugin_js`

**Terminal**（terminal.rs）：`open_terminal` `write_terminal` `resize_terminal` `close_terminal`

### 3.1 卡片命令详解

| 命令 | 关键参数 | 行为 |
|---|---|---|
| `create_card` | workspace_id, chat_id, `type_`(String), title, description?, assignee_contact_id?, due_date? | 1) 插入卡片行（status 默认 "todo"）2) 构造 `[CARD]{"action":"create",...}` JSON 3) 作为 deltachat 消息发送 4) 回填 msg_id 5) 记 card_create 活动 6) 返回 CardDto |
| `update_card` | card_id, title?, description:Clearable, status?, assignee:Clearable, due_date:Clearable | 用 `Clearable<T>` 处理「跳过/清空/设值」三态。发 `[CARD]{"action":"update"}` |
| `delete_card` | card_id | 删 DB 行 + 发 `[CARD]{"action":"delete"}` + 记活动 |
| `list_cards` | workspace_id, chat_id | 按 status, position, created_at 排序 |
| `get_card` | card_id | 单卡 + 解析名字 |
| `upsert_card_from_msg` | msg_id, card_json | **同步处理器**。解析 action（create/update/delete）。按 `(channel_chat_id, title, ABS(created_at-diff)<60s)` 去重。create 时回填 msg_id、用 `Contact::lookup_id_by_addr` 解析 assignee/creator |
| `message_to_card` | msg_id, workspace_id, chat_id, type_, title? | 普通消息转卡片。默认 title 取消息文本前 40 字符 + "..." |

**`type_` 参数约定**（重要坑）：DB 列名是 `type`（无下划线），Rust 结构体字段是 `type_`（保留字），DTO 用 `#[serde(rename = "type")]` 序列化成 JSON 键 `"type"`。**Tauri 命令参数按位置反序列化**（默认数组传参），所以前端 invoke 传参名用 `type_`，而 `[CARD]` 载荷内的 JSON 键是 `"type"`。

`[CARD]` 协议 JSON 字段：`action`（create/update/delete）、`id`、`type`、`title`、`status`、`assignee_addr`、`due_date`、`description`、`created_by_addr`、`created_at`、可选 `source_msg_id`。

## 4. 数据库层（`src-tauri/src/db.rs`）

- `Db { conn: Arc<tokio::sync::Mutex<Connection>> }`，全部操作经 `spawn_blocking`（rusqlite 同步）。
- 建表用 `CREATE TABLE IF NOT EXISTS`；加列用 `PRAGMA table_info` 检测后 `ALTER TABLE`。
- 位置参数 `?1`/`?2`，`query_row().optional()`、`query_map().filter_map(ok)`、`last_insert_rowid()`。

**10 张表** 见 [database.md](database.md)。

**关键坑**：`list_cards`/`get_card_row` 的 16 元组里第 15 列是字面量 `0`（占位符，对应一个已废弃/从未用的字段），第 16 列是 `source_msg_id`。

## 5. DTO（`src-tauri/src/dto.rs`）

全部 DTO：`AdvancedLogin`（输入）、`ProfileDto`、`ChatDto`、`MemberDto`、`ChatInfoDto`、`MsgDto`、`EventPayload`、`ContactDto`、`SearchResultDto`、`WorkspaceDto`、`PeytStudioDto`、`ChannelDto`、`RoleDto`、`PinDto`、`ReactionDto`、`ContactRoleDto`、`CardDto`、`InboxEventDto`、`ActivityDto`。完整字段见 [database.md](database.md#2-dto)。

- **serde 重命名**：`CardDto.type_`、`InboxEventDto.type_`、`RegistryPlugin.plugin_type` 都 `#[serde(rename = "type")]`。
- 时间戳 i64（Unix epoch 秒）；chat/contact id 在 API 边界是 u32，SQLite 里是 i64。
- `MsgDto.state` 是字符串（"pending"/"failed"/"delivered"/"read"/"other"）；`view_type` 字符串（"Text"/"Image"/"Gif"/"Sticker"/"File"...）。

## 6. 插件后端（`src-tauri/src/plugins.rs`）

- 市场：`https://ieshishinjin.github.io/PleaseEnterYourTextCommunityPluginsMarket/`。`registry.json` 缓存在 `plugins/registry_cache.json`。
- 磁盘结构：`plugins/<name>/{plugin.json, plugin.js, enabled}`（`enabled` 为空标记文件，存在=启用）。
- `install_plugin_from_zip` 是**同步**的（std::fs），小 zip 会短暂阻塞命令线程。
- `toggle_plugin` 删 enabled 文件时静默忽略错误。

## 7. 终端（`src-tauri/src/terminal.rs`）

- `TerminalSessions(Mutex<HashMap<String, TerminalSession>>)`；session id 用 `static AtomicU64` 自增。
- `open_terminal(workdir?)`：native_pty_system() → 默认 shell（`$SHELL` 或 /bin/sh，Windows 是 cmd.exe）→ 80x24 → **std::thread**（非 tokio）读输出，按 UTF-8 边界切分（`from_utf8_lossy` 补偿），emit `terminal-output` 事件；EOF 时发 `"[terminal session ended]"`。
- **后端无命令白名单/expert 模式**——白名单在终端前端实现。PTY 是真 shell，可跑任意命令（安全注意）。

## 8. 错误处理（`src-tauri/src/error.rs`）

```rust
#[serde(tag = "kind", content = "message")]
pub enum AppError { AuthFailed, Network(String), AutoconfigNotFound, Core(String), Io(String), Db(String), Plugin(String) }
```

JSON 形如 `{ "kind": "AuthFailed", "message": null }`。前端可 switch `kind`。Tauri v2 自动序列化错误，无需显式 InvokeError impl。

## 9. 配置

- `tauri.conf.json`：**CSP 为 null**（插件要注入任意 JS）；`assetProtocol.enable=true` scope `$APPDATA/**`、`$HOME/**`（加载头像/附件，需 `protocol-asset` feature）；单窗口 1000x700（min 800x600）。
- `Cargo.toml` 关键依赖：`deltachat = { path = "../core" }`（submodule）、tauri `protocol-asset`、`socket2`（`all` feature，netwatch 需要）、`chrono`（`clock`）、`uuid`（envelope 协议）。**零 tauri-plugin-***。
- **capabilities/ 目录存在**（`src-tauri/capabilities/default.json`）：包含 `core:default` + `core:event:allow-listen`/`allow-unlisten` + `core:window:allow-set-badge-count`/`allow-set-title`。**这是 realtime 事件能到前端的关键**——Tauri v2 默认 deny `listen`，没有 `core:event:allow-listen` 前端收不到 `dc-event`。
- `main.rs`：`windows_subsystem = "windows"`（release 隐藏控制台）；`build.rs` 标准 `tauri_build::build()`。
