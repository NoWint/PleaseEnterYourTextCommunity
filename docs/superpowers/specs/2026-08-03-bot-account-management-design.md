# Bot 系统 · 子项目 A：Bot 账号管理 设计文档

> **定位**: 大特性「Bot 系统」的分解子项目 A（后端 + DB），为 B（LLM 运行时）/ C（管理 UI）/ D（会话 UX）打地基。
>
> **前置决策**（brainstorming 问答确认）:
> - 子项目范围: A = Bot 账号生命周期管理（后端 + DB），不含 LLM/自动回复/前端 UI
> - Bot 配号: 复用 chatmail 自动配号（`dcaccount:https://yzjtiantian.cn/new`），点击创建即得一个 Bot 邮箱账号
> - IO 生命周期: app 启动时为当前主账号全部 Bot 自动 `start_io`；提供 `set_bot_io` 单个启停
> - 删除语义: 彻底删除 — `remove_account` 清掉底层账号数据（chatmail 账号可随时重建）
> - 实现路线: A2 — 新增 `bots.rs` 的 `BotService` 服务层（与 PluginManager/TerminalSessions 同构），commands 薄包装
> - 运行状态: 核心无 `is_io_running` API，故用 `bots.status` 列自行跟踪

## 1. 目标与范围

### 1.1 目标
1. 主账号（当前选中账号）可创建多个 Bot：自动配号 chatmail 邮箱账号 + 显示名，与主账号关联
2. 列出当前主账号的全部 Bot（含邮箱地址与运行状态）
3. 单个 Bot 启停 IO（后台收发）
4. 删除 Bot：彻底删除底层 Delta 账号与 db 记录
5. app 启动时自动为当前主账号的全部 Bot 开启 IO

### 1.2 不做（后续子项目）
- LLM 调用、自动回复、系统提示词/模型/provider 设置（B）
- Bot 事件流按账号分发、Bot 会话前端 UX（B/D）
- 管理页 UI（C）
- 多主账号同时运行（当前架构仍是单当前账号，db 用 owner_account_id 预留多账号）

## 2. DB 表（`db.rs` migrate 新增）

```sql
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_account_id INTEGER NOT NULL,      -- 主账号的 deltachat account id
  bot_account_id INTEGER NOT NULL,        -- Bot 账号的 deltachat account id
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'stopped' (自身记录)
  config_json TEXT,                       -- 预留:B 阶段写入 LLM 系统提示词/模型/provider
  created_at INTEGER NOT NULL,
  UNIQUE(owner_account_id, bot_account_id)
);
```

- `config_json` 现留空，B 阶段直接写入，无需 ALTER。
- Db 新增方法：`insert_bot` / `list_bots(owner_id)` / `get_bot(owner_id, bot_id)` / `delete_bot(owner_id, bot_id)`。

## 3. BotService 模块（`src-tauri/src/bots.rs`）

```rust
pub struct BotService {
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
}

impl BotService {
    pub async fn create(&self, owner_id: u32, display_name: String) -> AppResult<BotDto>;
    pub async fn list(&self, owner_id: u32) -> AppResult<Vec<BotDto>>;
    pub async fn delete(&self, owner_id: u32, bot_id: i64) -> AppResult<()>;
    pub async fn set_io(&self, owner_id: u32, bot_id: i64, running: bool) -> AppResult<BotDto>;
    pub async fn start_all_for_owner(&self, owner_id: u32) -> AppResult<()>;
}
```

### 3.1 create
1. `accounts.add_account()` → 拿 `Context`
2. `ctx.add_transport_from_qr("dcaccount:https://yzjtiantian.cn/new")`（与 `create_chatmail_account` 同源）
3. `ctx.set_config(Config::Displayname, display_name)`
4. `db.insert_bot(...)`（owner/bot id、display_name、status='running'）
5. `ctx.start_io()`
6. **失败回滚**: 配号失败 → `accounts.remove_account(bot_id)` + 清理 db 行，错误映射 `AppError::Network`/`AutoconfigNotFound`（与 login 对齐）

### 3.2 delete
校验 bot 属于该 owner（否则 `AppError::NotFound`）→ `ctx.stop_io()` → `accounts.remove_account(bot_id)` → 删 db 行。

### 3.3 list
db 行 + `ctx.get_config(Config::ConfiguredAddr)` 填 BotDto.addr。

### 3.4 set_io
校验 owner → `running ? ctx.start_io() : ctx.stop_io()` → 更新 db status → 返回最新 BotDto。

### 3.5 start_all_for_owner
遍历该 owner 的全部 bot 逐个 `start_io`；单个失败仅记日志不回滚，保证其余 Bot 正常。

## 4. 启动钩子 + 命令

### 4.1 启动钩子（`lib.rs` setup）
`AppState::new()` 后调用 `state.bots.start_all_for_owner(current_id)`。

### 4.2 命令（commands.rs 薄包装）
| 命令 | 入参 | 返回 |
|---|---|---|
| `create_bot` | `display_name: String` | `BotDto` |
| `list_bots` | — | `Vec<BotDto>` |
| `delete_bot` | `bot_id: i64` | — |
| `set_bot_io` | `bot_id: i64, running: bool` | `BotDto` |

- owner 一律取 `state.current_id`。
- 在 `lib.rs` 的 `invoke_handler` 登记 4 个命令。
- `state.rs` 的 `AppState` 加 `bots: BotService` 并在 `new()` 构造；`lib.rs` 声明 `mod bots;`。

## 5. DTO（`dto.rs`）

```rust
pub struct BotDto {
    pub id: i64,
    pub bot_account_id: u32,
    pub display_name: String,
    pub addr: Option<String>,   // 邮箱地址
    pub io_running: bool,       // 来自 status 列
    pub created_at: i64,
}
```

## 6. 测试验收

### 6.1 单元测试（`cargo test`）
- db.rs: bots 表 insert/list/delete、owner 过滤、UNIQUE 约束
- bots.rs: `set_io` 对已配置账号启停（临时目录 + 假账号，不触发网络）、`delete` 清理、owner 不匹配报 `NotFound`
- create 完整配号依赖 chatmail 网络，不写单测（与现有 create_chatmail_account 一致），靠手动验证

### 6.2 编译/手动
- [ ] `cargo build` 通过
- [ ] `npm run tauri dev`: 创建 Bot → `list_bots` 返回带邮箱地址的 Bot → 另一账号给 Bot 邮箱发信，Bot 后台 IMAP 连接正常 → `set_bot_io(false)` 停掉 → `delete_bot` 后账号目录消失
