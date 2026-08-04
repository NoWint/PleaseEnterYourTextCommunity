# Bot 系统大扩展 · 子项目 B1：驱动框架 + 运行时健壮性 设计文档

> **定位**: 大特性「生产级好玩的 Bot 系统」的分解子项目 B1（后端基础设施），在既有 A–D 子项目（Bot 账号管理 / LLM 运行时 / 管理 UI / 会话 UX）之上，把单体内核重构为「多驱动框架」，并加固运行时健壮性，为 B2（LLM v2）、B3（工具/规则/定时）、B4（玩法）、B5（前端管理中心）打地基。
>
> **前置决策**（brainstorming 问答确认）:
> - 路线: 驱动核心先行，功能增量叠加（路线 1）
> - Bot 定义: 多驱动架构 — Bot = 账号 + 可插拔「大脑/驱动」，LLM 只是其一
> - 首期范围: B1 仅落地 LLM 驱动（移植加固），规则/定时驱动在 B3
> - 全部功能必须真实生产可用，不做摆设

## 1. 目标与范围

### 1.1 目标
1. **驱动框架**: `BotDriver` trait + 驱动注册表，事件调度器与驱动分离
2. **运行时健壮性**: 每 Bot 并发上限、全局并发上限、回复频率限制、LLM 超时/重试/退避、错误隔离
3. **可观测基础**: `bot_activities` 表 + 实时 `bot-activity` 事件
4. **配置结构化**: `BotConfig`，兼容旧 `config_json`
5. **归属修正**: `list_bots` 改 owner 范围，bot 命令补 owner 校验

### 1.2 不做（后续子项目）
- 多 Provider 适配（Anthropic/Gemini）→ B2
- 工具/函数调用 → B2/B3
- 规则驱动 / 定时驱动 → B3
- 人设模板、Bot 间互动、彩蛋 → B4
- 前端管理中心 UI（打字指示器/时间线/配置面板）→ B5
- 插件注册工具 → B3

## 2. 驱动框架与模块布局

### 2.1 模块布局

```
src-tauri/src/
├── runtime.rs          # 新:事件调度器(替代 bot_llm.rs 的 spawn/handle_incoming)
├── drivers/
│   ├── mod.rs          # 新:BotDriver trait + DriverKind + 驱动注册表
│   └── llm.rs          # 新:LLM 驱动(移植 bot_llm 逻辑 + 加固)
├── llm.rs              # 改:客户端加固(超时/重试/退避/共享 Client)
├── bots.rs             # 改:接入 runtime、owner 校验、config 读写
├── db.rs               # 改:bot_activities 表 + owner 范围 + BotConfig 迁移
├── commands.rs         # 改:list_bots owner 范围 + get/update_bot_config
├── dto.rs              # 改:BotConfig/LlmConfig/BotActivityDto
├── lib.rs              # 改:mod 声明 + bot-activity 事件接线
└── bot_llm.rs          # 删除(功能并入 runtime.rs + drivers/)
```

### 2.2 核心抽象

```rust
#[async_trait]
pub trait BotDriver: Send + Sync {
    fn kind(&self) -> DriverKind;                          // Llm | Rule | Schedule | ...
    /// 收到进站消息:返回要发送的回复文本列表。错误由调度器隔离。
    async fn on_message(&self, bot: &BotRuntime, msg: &IncomingMsg) -> DriverResult<Vec<String>>;
    /// 定时 tick(定时驱动用,B1 默认 no-op)
    async fn on_tick(&self, bot: &BotRuntime) -> DriverResult<Vec<String>> { Ok(vec![]) }
}

pub struct BotRuntime<'a> {
    pub bot_id: i64,
    pub account_id: u32,
    pub dc: &'a Context,           // bot 的 deltachat context
    pub config: &'a BotConfig,     // 结构化配置
    pub db: &'a Db,
    pub activity: &'a ActivityLog, // 落库 + 事件
}

pub struct IncomingMsg<'a> {
    pub chat_id: ChatId,
    pub msg_id: MsgId,
    pub from_addr: String,
    pub text: Option<String>,
    pub viewtype: Viewtype,
}
```

### 2.3 调度器职责（横切关注点集中）
- 接收 `IncomingMsg` → 解析 bot → 对每个启用驱动并发调度
- 应用回复频率限制（每会话间隔）→ 发送 → 记录活动日志 → emit `bot-activity`
- 驱动只负责「想说什么」，发送/限流/日志由调度器统一处理

## 3. 事件调度器与并发（runtime.rs）

### 3.1 事件循环改造
现状 `bot_llm.rs` 在循环内 `await` 完整 `handle_incoming`，一次慢 LLM 调用阻塞所有 Bot。改为：
- 循环只做**快速分发**：`recv()` → 命中 bot → `tokio::spawn` 处理任务
- 信号量控制并发，防止无限 spawn：
  - **每 Bot**: `Semaphore::new(config.limits.max_concurrent)`（默认 2）
  - **全局**: `Semaphore::new(4)` 跨所有 bot，防止打爆本地 Ollama 或触发 Provider 限流
- 未抢到 permit 的事件直接丢弃（记 `reply_skipped` 活动），不排队——桌面场景避免积压

### 3.2 防刷屏限流
- 每 Bot 维护 `Mutex<HashMap<ChatId, Instant>>` 记录每会话最近一次自动回复时间
- 距上次 < `reply_min_interval_secs`（默认 3s）→ 跳过并记 `reply_rate_limited` 活动
- 不同会话互不阻塞

### 3.3 错误隔离
- 每个 spawn 任务外层 catch-all，任何 panic/错误只记活动日志，绝不终止运行时

## 4. LLM 客户端加固（llm.rs）

- **共享 Client**：`reqwest::Client` 进程级复用（当前每次调用新建）
- **超时**：每请求默认 120s（`timeout_secs` 可配）
- **重试/退避**：错误分类纯函数 `classify_llm_error`：
  - *瞬时*：网络错误、超时、HTTP 429 / 5xx → 重试
  - *永久*：4xx（除 429）、认证失败 → 不重试
  - 指数退避 `1s * 2^n + jitter`，`max_retries` 默认 2
- **参数透传**：`temperature` / `max_tokens` / `top_p` 进请求体（替换硬编码 0.7）
- 纯函数 `build_request_body` / `parse_response` / `classify_llm_error` 全部可单测

## 5. 配置结构化与向后兼容（dto.rs + db.rs）

### 5.1 DTO

```rust
pub struct BotConfig {
    pub llm: Option<LlmConfig>,        // 存在且完整 => LLM 驱动自动回复
    pub limits: BotLimits,             // 限额
}
pub struct LlmConfig {                 // 旧 LlmConfigInput + 新参数,serde 默认值
    pub system_prompt: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,      // 预留,本期仅 "openai"
    pub temperature: Option<f64>,      // 默认 0.7
    pub max_tokens: Option<u32>,
    pub top_p: Option<f64>,
    pub timeout_secs: Option<u64>,     // 默认 120
    pub max_retries: Option<u32>,      // 默认 2
}
pub struct BotLimits {
    pub max_concurrent: u32,           // 默认 2
    pub reply_min_interval_secs: u64,  // 默认 3
}
```

### 5.2 迁移策略
- `bots.config_json` 旧格式为 `LlmConfigInput` 顶层字段
- 读：新格式 deserialize 失败 → 尝试旧格式映射到 `BotConfig.llm`（缺失参数取默认）
- 写：统一新格式
- DB 表结构**不变**（config_json 仍为 TEXT），零迁移成本

### 5.3 API
- 新增 `get_bot_config(bot_id) -> BotConfig` / `update_bot_config(bot_id, config)` 为规范入口
- 旧 `get_bot_llm` / `update_bot_llm` 保留为薄包装（读写 `BotConfig.llm` 子段），现有前端 C 期不破
- `llm::complete` 入参类型改为 `&LlmConfig`；`test_llm_config(config: LlmConfigInput)` 与 `update_bot_llm` 内部做 `LlmConfigInput → LlmConfig`（缺省参数取默认）映射，前端无需改动

## 6. 活动日志与实时事件（db.rs + lib.rs）

### 6.1 表结构

```sql
CREATE TABLE IF NOT EXISTS bot_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- reply_sent | reply_skipped | reply_rate_limited | llm_error | no_config | driver_disabled
  chat_id INTEGER,
  msg_id INTEGER,
  summary TEXT NOT NULL,     -- 人类可读一行
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_activities_bot ON bot_activities(bot_id, created_at DESC);
```

### 6.2 Db 方法
- `insert_bot_activity`
- `list_bot_activities(bot_id, limit)`（B5 时间线页用）

### 6.3 实时事件
- 调度器每记一条活动，同时 `app.emit("bot-activity", payload)`（B5 打字指示器/时间线的实时通道，本期铺好）
- 已记录的核心事件：`reply_sent`（谁→谁→回复摘要）、`reply_rate_limited`、`reply_skipped`（无 LLM 配置）、`llm_error`（含重试后仍失败的 detail）

## 7. 归属修正与 API 一致性（commands.rs + bots.rs）

- `list_bots`：由 app 级 `list_all_bots()` 改为 `list_bots(current_owner_id)`
- `delete_bot` / `set_bot_io` / `update_bot_config` / `get_bot_config` / `bot_get_chatlist` / `bot_get_chat_msgs` / `bot_send_text` / `bot_mark_chat_noticed` / `bot_mark_chat_seen` / `add_bot_to_chat` 统一加 owner 校验：`owner_account_id != current_owner_id` → `AppError::Core("bot not found")`
- `ctx_for_bot` 加 owner 参数
- 纯后台逻辑（`start_all` / `ensure_selected_not_bot`）保持 app 级不变

## 8. 测试与验收

### 8.1 单元测试（`cargo test`，沿用 tempfile+假账号模式，不触发网络）
- `drivers/llm.rs`：历史构建、防 bot 互聊过滤、20 条裁剪（移植现有测试）
- `llm.rs`：`classify_llm_error`（429/5xx=瞬时，401/400=永久）、`build_request_body` 带新参数、`parse_response`（现有）
- `runtime.rs`：限流器纯逻辑（可注入时钟）、并发信号量、错误隔离
- `dto.rs`：旧 `config_json` → 新 `BotConfig` 迁移回读（缺失参数取默认）、round-trip
- `db.rs`：`bot_activities` insert/list、bot 表 owner 过滤
- 既有 20+ 测试不回归

### 8.2 编译/手动验收
- [ ] `cargo build` / `cargo test` 通过；`npx tsc --noEmit` 通过（前端无改动，应保持绿）
- [ ] 双 Bot 同时收到消息，慢 LLM 不再阻塞另一个（并发生效）
- [ ] 连续快速发多条 → 只按 `reply_min_interval_secs` 间隔回复，其余记 `reply_rate_limited`
- [ ] 配错误 api_key → 不重试，记 `llm_error`；配 5xx 后端 → 重试 2 次后退避
- [ ] `bot_activities` 有记录；前端能收到 `bot-activity` 事件
- [ ] 旧格式 `config_json` 的既有 Bot 读回正常，`get_bot_llm` 仍工作

## 9. 改动文件清单

- 新增：`src-tauri/src/runtime.rs`、`src-tauri/src/drivers/mod.rs`、`src-tauri/src/drivers/llm.rs`
- 修改：`llm.rs` / `bots.rs` / `db.rs` / `commands.rs` / `dto.rs` / `lib.rs` / `state.rs`
- 删除：`src-tauri/src/bot_llm.rs`
