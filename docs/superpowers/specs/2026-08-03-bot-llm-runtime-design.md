# Bot 系统 · 子项目 B：Bot LLM 运行时 设计文档

> **定位**: 大特性「Bot 系统」的分解子项目 B（后端），在 A（Bot 账号管理）之上实现 LLM 自动回复：LLM 客户端 + 事件驱动运行时 + LLM 配置命令。
>
> **前置决策**（brainstorming 问答确认）:
> - Provider: 仅 OpenAI 兼容协议（base_url + api_key + model 覆盖 OpenAI/DeepSeek/通义/Kimi/Ollama 等）
> - 回复范围: 单聊 + 群聊都自动回复（无白名单）
> - 上下文: 每聊最近 20 条历史（含发送者名）+ 系统提示词，回复同聊
> - API Key: 明文存 SQLite `bots.config_json`（符合「仅在主账号保留设置」）
> - 自动回复条件: base_url + api_key + model 三者非空即自动（无显式开关）
> - 实现路线: B2 — 拆 `llm.rs`（纯客户端）+ `bot_llm.rs`（运行时编排）
> - 事件通道: `async_broadcast` 多接收者，运行时用自己的 `EventEmitter`，与 events.rs 转发器并存

## 1. 目标与范围

### 1.1 目标
1. OpenAI 兼容 LLM 客户端（`llm.rs`），可独立单测
2. 后台运行时（`bot_llm.rs`）：监听 `IncomingMsg`，按 `event.id` 过滤 Bot 账号，自动回复
3. LLM 配置读写命令（`update_bot_llm` / `get_bot_llm`），存 `config_json`
4. 主界面不被 Bot 收件打扰（events.rs 转发器过滤 Bot 账号事件）
5. 防 Bot 互聊死循环

### 1.2 不做（后续子项目）
- 管理页 UI / 会话 UX（C/D）
- Anthropic 等更多 Provider（当前仅 OpenAI 兼容，`dto.rs` 的 `provider` 字段预留）
- 多主账号同时运行（运行时按全量 bots 表账号处理，天然兼容后续）

## 2. LLM 配置（`bots.config_json`）

```json
{
  "system_prompt": "你是 PEYT 的助手 Bot，说话简洁。",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "model": "gpt-4o-mini"
}
```

- 自动回复条件：base_url + api_key + model 三者非空。
- `dto.rs` 新增 `LlmConfigInput`（serde Serialize/Deserialize/Clone/Debug）：`system_prompt: Option<String>, base_url: Option<String>, api_key: Option<String>, model: Option<String>, provider: Option<String>`（provider 预留，现默认 "openai"）。
- 命令（commands.rs 薄包装 → `BotService`，均校验 owner，`AppError::Core("bot not found")`）：
  - `update_bot_llm(bot_id: i64, config: LlmConfigInput) -> BotDto` — 整体覆写 `config_json`（序列化存库），返回最新 BotDto
  - `get_bot_llm(bot_id: i64) -> Option<LlmConfigInput>` — 读回配置（反序列化；config_json 为空返回 None），供 C UI 回显

## 3. `llm.rs`（OpenAI 兼容客户端）

```rust
pub struct ChatMessage { pub role: String, pub content: String } // "system"|"user"|"assistant"

pub async fn complete(cfg: &LlmConfigInput, messages: Vec<ChatMessage>) -> AppResult<String>
```

- 请求：`POST {base_url.trim_end_matches('/')}/chat/completions`
  - 头：`Authorization: Bearer {api_key}`，`Content-Type: application/json`
  - body：`{ "model", "messages", "temperature": 0.7 }`
- 解析：`choices[0].message.content`（字符串）
- 错误映射：
  - 非 2xx → `AppError::Core(format!("llm http {}: {}", code, body_truncated))`
  - 网络错误 → `AppError::Network(e.to_string())`
  - JSON 解析失败 / 无 content → `AppError::Core`
- 可测性：抽纯函数
  - `build_request_body(cfg, messages) -> Value`（单测断言结构/字段）
  - `parse_response(json: &str) -> AppResult<String>`（单测：正常/缺 choices/缺 content）

## 4. `bot_llm.rs`（运行时）

```rust
pub async fn spawn(accounts: Arc<Mutex<Accounts>>, db: Arc<Db>, bot_ids: Arc<Mutex<HashSet<u32>>>)
```

- `tokio::spawn` 后台任务；`accounts.get_event_emitter()` 建自有接收端（async_broadcast 多接收者，与 events.rs 并存）。
- 循环 `recv()`，命中 `EventType::IncomingMsg { chat_id, msg_id }` 且 `event.id ∈ bot_ids` 且该 Bot `status == 'running'` 且 LLM 配置齐全：
  1. 短取 `accounts.get_account(event.id)` 得 Bot context；`Message::load_from_db` 加载消息，取发送者 `Contact`
  2. 防死循环：取发送者 `Contact::get_addr()`，若落在所有 Bot 账号的 `ConfiguredAddr` 集合内（即发送者是另一个 Bot）→ 跳过
  3. `chat::get_chat_msgs(bot_ctx, chat_id)` 取尾部 20 条 `ChatItem::Msg`：文本消息渲染 `「{name}: {text}」`，非文本记 `[图片]`/`[文件]`/`[语音]`/`[App]` 等
  4. `messages = [ChatMessage(system, 提示词)] + 历史`，调 `llm::complete`
  5. `Message::new(Viewtype::Text)` + `chat::send_msg(bot_ctx, chat_id, &mut msg)` 回复同聊
  6. LLM 或发送失败 → `log::warn!` 后继续（不向用户回错误、不重试，避免刷屏）
- 死锁规避：事件循环内不长时间持有 `accounts` 锁，仅取 context/加载数据时短暂获取。
- 运行状态检查：`db` 查询该 Bot 行 status；`bot_ids` 集合由 BotService 维护（见第 5 节）。
- 单测：防死循环过滤逻辑 + 20 条裁剪逻辑（临时目录 + 假账号，不触发 LLM 网络）。

## 5. 接线与前端过滤

- `BotService` 增加 `bot_ids: Arc<Mutex<HashSet<u32>>>`：
  - `create` 成功 → 插入；`delete` → 移除；`start_all_for_owner` / boot → 重新填充当前全部 bot 账号
  - 新方法 `pub fn bot_ids(&self) -> Arc<Mutex<HashSet<u32>>>`
- `BotService::spawn_runtime()`：`bot_llm::spawn(accounts.clone(), db.clone(), bot_ids.clone())`
- `events.rs` `spawn_event_forwarder(app, accounts, bot_ids)` 加参：`event.id ∈ bot_ids` 的事件**不转发前端**（`continue`）
- `lib.rs` setup：`state.bots.start_all_for_owner(current_id)` 之后调用 `state.bots.spawn_runtime()`（仅一次）
- 改动文件：`llm.rs`(新) / `bot_llm.rs`(新) / `bots.rs` / `events.rs` / `commands.rs` / `dto.rs` / `lib.rs`（`mod llm; mod bot_llm;` + 2 命令登记）

## 6. 测试验收

### 6.1 单元测试（`cargo test`）
- llm.rs: `build_request_body` / `parse_response` 纯函数单测
- bot_llm.rs: 防死循环过滤、20 条裁剪
- 既有 22 个测试不回归

### 6.2 编译/手动
- [ ] `cargo build` 通过
- [ ] `npm run tauri dev`: 创建 Bot → `update_bot_llm` 配真实 key → 主账号向 Bot 发消息 → Bot 自动回复同聊
- [ ] `set_bot_io(false)` 后 Bot 不再回复；`set_bot_io(true)` 恢复
- [ ] 两个 Bot 互发不产生死循环
- [ ] 主界面不出现 Bot 收件通知（events.rs 过滤生效）
