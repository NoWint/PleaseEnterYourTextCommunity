# 数据库 schema 与数据模型

应用级数据在 `src-tauri/src/db.rs`（`peytchat.db`，rusqlite）。deltachat 核心有自己的存储（`accounts/`），二者通过 `chat_id`（u32）对接。卡片经 `[CARD]` 同步消息跨设备传输（见 conventions.md）。

---

## 1. 表 schema（10 张表，`db.rs::migrate`）

**workspaces**
```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    master_chat_id INTEGER NOT NULL,
    icon TEXT,
    created_at INTEGER NOT NULL
);
```

**channels**
```sql
CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    position INTEGER NOT NULL DEFAULT 0,
    topic TEXT,
    UNIQUE(workspace_id, chat_id)
);
-- 迁移：ALTER TABLE 加 space_type TEXT NOT NULL DEFAULT 'chat'
```

**roles**
```sql
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT
);
```

**contact_roles**
```sql
CREATE TABLE IF NOT EXISTS contact_roles (
    contact_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    PRIMARY KEY(contact_id, role_id)
);
```

**pins**
```sql
CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    channel_chat_id INTEGER NOT NULL,
    msg_id INTEGER NOT NULL,
    pinned_by INTEGER NOT NULL,
    pinned_at INTEGER NOT NULL,
    UNIQUE(channel_chat_id, msg_id)
);
```

**cards**（索引：workspace_channel / status / assignee / msg_id）
```sql
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    channel_chat_id INTEGER NOT NULL,
    msg_id INTEGER,
    type TEXT NOT NULL DEFAULT 'card',          -- ← 卡片类型：字符串
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',        -- ← 卡片状态：字符串
    assignee_contact_id INTEGER,
    due_date INTEGER,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    source_msg_id INTEGER
);
```

**inbox_events**（索引：workspace+read_at / created_at DESC）
```sql
CREATE TABLE IF NOT EXISTS inbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    source_chat_id INTEGER NOT NULL,
    msg_id INTEGER,
    actor_id INTEGER NOT NULL,
    actor_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
);
```

**activities**（索引：workspace+created_at DESC / channel+created_at DESC）
```sql
CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    channel_chat_id INTEGER,
    actor_id INTEGER NOT NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
);
```

## 2. DTO（`src-tauri/src/dto.rs`）

| DTO | 字段要点 |
|---|---|
| `AdvancedLogin` | imap/smtp host/port/security/user/password（全部 Option） |
| `ProfileDto` | id, name, addr, avatar(blobdir 路径), color |
| `ChatDto` | chat_id, name, is_group, is_contact_request, is_self_talk, last_msg, last_ts, unread |
| `MemberDto` | contact_id, name, addr, is_self, avatar, color |
| `ChatInfoDto` | chat_id, name, is_group, is_contact_request, is_self_talk, members[] |
| `MsgDto` | msg_id, from_id, from_name, text, ts, is_out, state, quote_from, quote_text, view_type, file, file_name, file_mime, file_bytes, width, height, download_state, subject |
| `EventPayload` | typ, chat_id?, msg_id?, contact_id?, progress?, comment?, text? |
| `ContactDto` | id, name, addr |
| `SearchResultDto` | msg_id, chat_id, chat_name, from_name, text(截断 80), ts |
| `WorkspaceDto` | id, name, master_chat_id, icon, created_at |
| `PeytStudioDto` | workspace, role("founder"/"member"/"existing"), invite_qr? |
| `ChannelDto` | id, workspace_id, chat_id, name, category, position, topic, unread |
| `RoleDto` | id, workspace_id, name, color |
| `PinDto` | id, workspace_id, channel_chat_id, msg_id, pinned_by, pinned_at |
| `ReactionDto` | emoji, count, senders[] |
| `ContactRoleDto` | contact_id, role_id, role_name, role_color |
| `CardDto` | id, workspace_id, channel_chat_id, msg_id, `#[serde(rename="type")] type_: String`, title, description, status: String, assignee_contact_id, assignee_name, due_date, created_by, created_by_name, created_at, updated_at, position, source_msg_id |
| `InboxEventDto` | id, workspace_id, `#[serde(rename="type")] type_`, source_chat_id, msg_id, actor_id, actor_name, summary, created_at, read_at |
| `ActivityDto` | id, workspace_id, channel_chat_id, actor_id, actor_name, action, target_type, target_id, payload, created_at |

约定：时间戳 i64（Unix epoch 秒）；id 在 API 边界 u32 / SQLite i64；`assignee_name`/`created_by_name` 是从核心联系人解析的、**不落库**。

## 3. 卡片数据模型（Work）

前端类型（`src/types.ts`）：

```ts
export type CardType = 'card' | 'task';
export type CardStatus = 'todo' | 'in_progress' | 'done';
export type SpaceType = 'chat' | 'card';   // 频道空间类型（channels.space_type）
```

**type/status 全链路是字符串**：DB TEXT、Rust String、TS 字符串联合、`[CARD]` JSON。改动数据模型（如二进制化）会牵动这些层。

### 前端比较点（改字段表示时都要同步）

`CardType` 比较（`c.type === 'task'`）：
- `src/work/kanban.ts:177` — 卡片 type 徽标
- `src/work/list.ts:154` — 表格 type 列
- `src/work/cardDetail.ts:35` — 详情 type 徽标

`CardStatus` 比较（`c.status === 'todo'|'in_progress'|'done'`）：
- `src/work/kanban.ts:32-34` — 三列过滤
- `src/work/cardDetail.ts:41-43` — status select
- CSS 状态类：`.col-status.*`（list）、`.card-status-btn`（kanban）、`.calendar-card.status-*`、`.timeline-item.status-*`

`SpaceType` 用法：
- `src/shell/navPanel.ts:27-36` — `getSpaceType(chatId)` 带 Map 缓存
- `src/pages/workPage.ts` — 过滤 `st === 'card'` 的频道
- `src/pages/groupsPage.ts` — 过滤 `st === 'chat'` 的频道

### 卡片同步机制（跨设备）

```
建卡/改卡 → 后端命令 → 构造 [CARD] JSON → 作为消息发进 deltachat 群
其他设备 → IncomingMsg → shell.ts 识别 [CARD] 前缀 → upsert_card_from_msg → 落库
```

- `[CARD]` 载荷 JSON 字段：`action`（create/update/delete）、`id`、`type`、`title`、`status`、`assignee_addr`、`due_date`、`description`、`created_by_addr`、`created_at`、可选 `source_msg_id`。
- 去重：`(channel_chat_id, title, ABS(created_at-diff) < 60s)`。
- `update_card` 的 `Clearable<T>` 三态：缺键=跳过、null=清空、值=设值（Tauri 无法区分缺键与 null）。

## 4. rusqlite 模式

- 全部经 `tokio::task::spawn_blocking`（rusqlite 同步，勿在 async 上下文直接调用）。
- 位置参数 `?1`/`?2`；单行查询 `query_row().optional()`；多行 `query_map().filter_map(ok).collect()`；`last_insert_rowid()` 取自增 id。
- 加列：`PRAGMA table_info` 检测存在后 `ALTER TABLE`。
