# Bot 系统大扩展 · 子项目 B3：工具集 + 规则驱动 + 定时驱动 设计文档

> **定位**: 在 B2 工具基建之上,补齐联网/应用内/文件/插件工具;并落地规则驱动(关键词/欢迎/兜底)与定时驱动(定时消息/提醒)。B3 是"功能丰富多样"的主体。
>
> **前置决策**(brainstorming 确认):
> - 工具: 实用(B2)+ 联网(天气/网页)+ 应用内(搜历史/建卡片/提醒)+ 插件 + 沙箱文件
> - 规则: 关键词/指令触发、定时消息、进群欢迎语、兜底降级文案
> - 插件工具: 后端存定义 + 前端 JS 往返执行(B5 提供插件 API 与监听器)
> - 定时: `bot_schedules` 表 + 30s tick;cron 字段(minute/hour/day_of_week)全 -1 视为一次性提醒

## 1. 范围

**做**: 联网/应用内/文件/插件工具、规则驱动(含欢迎/兜底)、定时驱动、相关命令与 db 表。
**不做(B4+)**: 人设模板库、Bot 间互动开关、统计、彩蛋(B4)。
**不做(B5+)**: 前端管理中心 UI、插件 API 前端侧、api-spec 更新。

## 2. 配置扩展(dto.rs)

```rust
pub struct RuleDef {
    pub id: i64,
    pub pattern: String,        // 关键词子串 或 正则
    pub is_regex: bool,
    pub replies: Vec<String>,   // 随机取一条
    pub enabled: bool,
}

#[derive(Default)]
pub struct RuleConfig {
    pub rules: Vec<RuleDef>,
    pub welcome: Option<String>,        // 进群/首次消息欢迎语
    pub fallback: Option<String>,       // 无规则命中时的兜底
}

// BotConfig 追加(serde default,向后兼容旧 JSON):
//   pub rule: Option<RuleConfig>,
//   pub tools: Option<Vec<String>>,      // None = 默认安全工具集;B3 显式启用列表
//   pub persona: Option<String>,          // 预留 B4(当前人设 id)
```

`BotLimits` 追加(serde default):
```rust
pub allow_bot_interaction: bool,     // 默认 false
pub interaction_max_rounds: u32,     // 默认 3
```

`bot_activity_kind` 追加:
```rust
pub const TOOL_CALLED: &str = "tool_called";
pub const SCHEDULE_SENT: &str = "schedule_sent";
pub const RULE_REPLY: &str = "rule_reply";
```

## 3. 规则驱动(drivers/rule.rs)

```rust
pub struct RuleDriver {
    seen: StdMutex<HashSet<(i64, u32)>>,  // (bot_id, chat_id) 已见过 → 欢迎只发一次
}
impl RuleDriver {
    pub fn new() -> Self;
}
```
`BotDriver::on_message` 逻辑(优先级从高到低):
1. **指令彩蛋**(B4 完整,此处先做基础):文本以 `/` 开头 → 匹配 `dice`/`roll`/`coin`/`8ball`/`whoami` → 返回结果文本(`/roll 100` 支持上限参数)。
2. **欢迎语**:该 (bot,chat) 首次收到消息且 `config.rule.welcome` 有值 → 返回欢迎语(并写入 seen;无论 welcome 是否为空都记 seen)。
3. **关键词/正则规则**:`config.rule.rules` 中 enabled 的项;`is_regex=false` 用 `text.contains(pattern)`(忽略大小写),`is_regex=true` 用 `regex::Regex::is_match`;命中取 `replies` 随机一条。需要 `regex` crate(B3 新增依赖)。
4. **兜底**:`config.rule.fallback` 有值 → 返回兜底。
5. 以上都不命中 → `Ok(vec![])`(交给其他驱动,如 LLM)。

- 规则/欢迎不消耗 LLM;但 `BotRuntime` 里驱动是无状态的→ seen 存驱动自身。
- 记录活动:`RULE_REPLY`(summary `规则命中: {pattern}`)。

## 4. 定时驱动(drivers/schedule.rs) + tick 循环(runtime.rs)

### 4.1 驱动接口变更(drivers/mod.rs)

```rust
pub struct ScheduledSend {
    pub chat_id: u32,
    pub text: String,
}

// BotDriver 的 on_tick 签名变更(尚无调用方,安全):
async fn on_tick(&self, bot: &BotRuntime<'_>) -> AppResult<Vec<ScheduledSend>> { Ok(vec![]) }
```

### 4.2 表(db.rs)

```sql
CREATE TABLE IF NOT EXISTS bot_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT -1,   -- -1=任意,0-59
  hour INTEGER NOT NULL DEFAULT -1,     -- -1=任意,0-23
  day_of_week INTEGER NOT NULL DEFAULT -1, -- -1=任意,0=周日..6=周六
  message TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_schedules_due ON bot_schedules(next_run_at);
```
Db 方法:`insert_bot_schedule` / `list_bot_schedules(bot_id)` / `get_bot_schedule(id)` / `delete_bot_schedule(id)` / `set_schedule_next_run(id, ts)` / `list_due_schedules(now)`。

### 4.3 ScheduleDriver

```rust
pub struct ScheduleDriver; // 无状态
```
`on_tick`:查该 bot 的 enabled schedules,`next_run_at <= now` → 收集为 `ScheduledSend`;对每条:`next_run_at` 全 -1(一次性提醒)→ 直接删除该行;否则重算下次(cron 语义)并 `set_schedule_next_run`。

### 4.4 runtime tick 循环

`runtime::spawn` 内新增一个常驻循环:
```rust
// 每 30s:对每个 running bot 构建 BotRuntime,逐个驱动调 on_tick,
// 收集 ScheduledSend → 用 bot ctx chat::send_msg 发送 → 记录活动 SCHEDULE_SENT。
```
- 从 `db.list_all_bots()` 遍历;status != running 跳过;`BotConfig::parse` 失败跳过。
- 发送用 `deltachat::chat::send_msg(&ctx, ChatId::new(chat_id), &mut out)`。
- 活动:`SCHEDULE_SENT`(summary `定时消息 → {chat_id}`)。
- tick 与消息循环并行(`tokio::join!` 两个循环,或各 spawn 一个任务)。

## 5. 工具集(tools/)

### 5.1 联网工具(tools/net.rs)

| 工具 | 参数 | 行为 | safe |
|---|---|---|---|
| `get_weather` | `city?: string, latitude?: number, longitude?: number` | city → Open-Meteo geocoding(`https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1`);再用 `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current_weather=true`;返回温度/天气码/风速,天气码映射中文(0 晴/1-3 多云/45-48 雾/51-67 雨/71-77 雪/80-99 强降水) | true |
| `fetch_url` | `url: string` | reqwest GET(url 白名单校验:仅 http/https),正文取前 2000 字符(剥 HTML 标签→纯文本) | true |
| `web_search` | `query: string` | DuckDuckGo Instant Answer(`https://api.duckduckgo.com/?q={q}&format=json&no_html=1`),取 `AbstractText`/`RelatedTopics[0].Text`,否则返回"无直接结果" | true |

### 5.2 应用内工具(tools/app.rs)

| 工具 | 参数 | 行为 | safe |
|---|---|---|---|
| `search_history` | `query: string` | 遍历 bot chatlist + 消息,文本包含 query(忽略大小写)取最近 5 条,返回 `[聊天名] 发送者: 摘要` | true |
| `create_card` | `workspace_id: number, chat_id: number, title: string, description?: string` | 复用 `db.create_card(workspace_id, chat_id, "task", title, ...)`;返回 `卡片 #id 已创建` | false |
| `set_reminder` | `chat_id: number, delay_minutes: number, message: string` | 插入一次性 `bot_schedules`(cron 全 -1,next_run_at=now+delay*60);返回 `已设置提醒` | false |

- `search_history` 复用 `search_msgs` 的 Chatlist+遍历模式(commands.rs:1392 起),针对 bot 的 ctx 实现。

### 5.3 沙箱文件工具(tools/file.rs)

| 工具 | 参数 | 行为 | safe |
|---|---|---|---|
| `read_file` | `path: string` | 读取 `data_dir/bot_files/{bot_id}/{path}`,≤64KB | true |
| `write_file` | `path: string, content: string` | 写入(≤256KB),自动建父目录 | false |
| `list_files` | `path?: string` | 列目录(相对路径) | true |

**沙箱防护**:`fn resolve_safe(data_dir, bot_id, rel) -> AppResult<PathBuf>` —— 拼接后 `canonicalize` 校验前缀在 `bot_files/{bot_id}` 内;拒绝绝对路径/`..`/`~`;路径以相对路径处理(统一 `join` 后 normalize)。越界 → `AppError::Core("路径越界")`。

### 5.4 插件工具(tools/plugin.rs)

```rust
pub struct PluginTool { name: String, description: String, parameters: serde_json::Value, bridge: Arc<ToolBridge> }
// execute: bridge.request(&self.name, args).await  → 前端往返结果
```
- 定义存 db 表:
```sql
CREATE TABLE IF NOT EXISTS bot_plugin_tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,      -- JSON Schema 字符串
  created_at INTEGER NOT NULL
);
```
- `is_safe=false`(需显式启用)。

## 6. 命令(commands.rs,全部 owner 校验)

| 命令 | 入参 | 返回 |
|---|---|---|
| `register_bot_tool` | `name, description, parameters: Value` | `()` |
| `unregister_bot_tool` | `name` | `()` |
| `list_bot_tools` | 无 | `Vec<{name, description, safe}>`(db 中插件工具 + 内置工具名) |
| `bot_tool_result` | `id: String, result: String` | `()`(经 bridge.resolve 回填) |
| `bot_list_schedules` | `botId: i64` | `Vec<ScheduleDto>` |
| `bot_add_schedule` | `botId, chatId, minute, hour, dayOfWeek, message` | `ScheduleDto` |
| `bot_delete_schedule` | `scheduleId: i64` | `()` |

- `ScheduleDto { id, bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at }`。
- `register_bot_tool` 后需刷新运行时的 ToolRegistry(内存热加载):`ToolRegistry` 提供 `pub fn reload_plugin_tools(&mut self, list: &[PluginToolDef])`(db 全量重读替换 PluginTool 集合)。

## 7. 接线(lib.rs)

1. `ToolRegistry` 注册全部内置工具(B2 实用 + B3 联网/应用内/文件)+ 从 db 加载插件工具。
2. `registry.register(Arc::new(RuleDriver::new())); registry.register(Arc::new(ScheduleDriver));`
3. `runtime::spawn` 内 tick 循环调用驱动 `on_tick`。
4. bridge emitter 接 `app.emit("bot-tool-request", ...)`(B5 前端监听)。
5. 新命令登记 invoke_handler。

## 8. 测试验收

### 单元测试
- rule.rs:`Regex` 是否启用依赖 `regex` crate;测试 contains 匹配(忽略大小写)、正则匹配、随机回复取自列表、优先级(指令>欢迎>规则>兜底)、seen 去重(欢迎只发一次,驱动内部 clock 不需要)。
- db.rs:`bot_schedules` insert/list/delete/next_run 更新、due 查询、`bot_plugin_tools` upsert/delete/list。
- runtime.rs:tick 的 cron 计算(`fn next_cron(now, minute, hour, dow) -> i64` 纯函数单测:任意域=下一分钟/小时对齐、一次性全 -1 返回 None)。
- tools/file.rs:沙箱 `resolve_safe`(合法相对路径通过、`../` 拒绝、绝对路径拒绝)。
- tools/app.rs:search_history 对假消息遍历不 panic(临时账号)。
- tools/net.rs:`get_weather` 参数校验(无 city 无经纬度 → 错误提示),不触发真实网络。
- B1+B2 既有测试不回归。

### 编译/手动
- [ ] `cargo build`/`cargo test --lib` 通过;`npx tsc --noEmit` 干净
- [ ] 手动:规则驱动命中关键词 → 固定回复;首次进群 → 欢迎语一次;无命中 → 兜底
- [ ] 定时:设置每天 9 点消息 → 到点自动发;一次性提醒 → 发后自动删除
- [ ] 工具:Bot 问天气 → 联网返回;问搜索历史 → 返回聊天摘要;写文件 → 沙箱目录内生成
- [ ] 插件工具:前端注册 + `bot-tool-request` 往返(需 B5 前端)

## 9. 改动文件

- 新增:`src-tauri/src/drivers/rule.rs`、`src-tauri/src/drivers/schedule.rs`、`src-tauri/src/tools/{net,app,file,plugin}.rs`
- 修改:`dto.rs`、`db.rs`、`drivers/mod.rs`(ScheduledSend + on_tick 签名)、`runtime.rs`(tick + BotRuntime 复用于 tick)、`tools/mod.rs`(reload_plugin_tools)、`commands.rs`、`lib.rs`、`Cargo.toml`(加 `regex`)
