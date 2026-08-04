# Bot 系统大扩展 · 子项目 B2：LLM 驱动 v2(多 Provider + 工具调用基建 + 实用工具) 设计文档

> **定位**: 在 B1 驱动框架之上,把 LLM 驱动升级为多 Provider,并建立工具调用基础设施与首批实用工具,为 B3(联网/应用内/文件/插件工具 + 规则/定时驱动)打地基。
>
> **前置决策**(brainstorming 确认):
> - 多 Provider: OpenAI 兼容 / Anthropic / Gemini,统一到同一 `LlmClient`
> - 工具调用: 支持(实用/联网/应用内/插件/文件),B2 先做基建 + 实用工具
> - 参数: 每 Bot 可配 temperature/max_tokens/top_p(B1 已完成)
> - 渐进回复: 超长回复按句边界拆多条发送
> - 全部功能真实生产可用

## 1. 范围

**做**: Provider 适配、工具调用循环、Tool trait/Registry/Bridge、实用工具(时间/计算/换算)、渐进回复拆分、人设字段预留。
**不做(B3+)**: 联网/应用内/文件/插件工具、规则/定时驱动、人设模板库(B4)、前端 UI(B5)。

## 2. LLM 多 Provider(llm.rs)

### 2.1 类型

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider { OpenAi, Anthropic, Gemini }

impl Provider {
    /// provider 字符串(缺省/未知 → OpenAi)
    pub fn parse(p: &Option<String>) -> Provider;
    pub fn as_str(&self) -> &'static str; // "openai"|"anthropic"|"gemini"
}
```

扩展 `ChatMessage`(加 `Default` derive,保持既有 `ChatMessage{role,content}` 构造可用):

```rust
#[derive(Debug, Clone, Default)]
pub struct ChatMessage {
    pub role: String,              // "system"|"user"|"assistant"|"tool"
    pub content: String,           // tool 角色 = 工具返回文本
    pub tool_calls: Vec<ToolCall>, // assistant 发起的工具调用
    pub tool_call_id: Option<String>, // tool 角色回填调用 id
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,        // 由 provider 返回的调用 id
    pub name: String,
    pub arguments: String, // JSON 字符串
}

/// 一次 provider 调用的返回(文本 或 工具调用,二选一)
pub struct ProviderRound {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}
```

### 2.2 请求/响应纯函数(全部可单测)

```rust
/// openai: {model, messages, temperature[, max_tokens, top_p, tools]}
pub fn build_openai_body(cfg: &LlmConfig, msgs: &[ChatMessage], defs: &[serde_json::Value]) -> serde_json::Value;
/// anthropic: {model, max_tokens, system, messages, tools}
pub fn build_anthropic_body(cfg: &LlmConfig, msgs: &[ChatMessage], defs: &[serde_json::Value]) -> serde_json::Value;
/// gemini: {system_instruction, contents, generationConfig, tools}
pub fn build_gemini_body(cfg: &LlmConfig, msgs: &[ChatMessage], defs: &[serde_json::Value]) -> serde_json::Value;
pub fn parse_openai_response(body: &str) -> AppResult<ProviderRound>;
pub fn parse_anthropic_response(body: &str) -> AppResult<ProviderRound>;
pub fn parse_gemini_response(body: &str) -> AppResult<ProviderRound>;
```

工具 defs 格式:
- OpenAI: `{"type":"function","function":{"name","description","parameters"}}`
- Anthropic: `{"name","description","input_schema": parameters}`
- Gemini: `{"functionDeclarations":[{"name","description","parameters"}]}`

Provider 请求细节(与真实 API 对齐):
- **OpenAI**: `POST {base}/chat/completions`,`Authorization: Bearer {key}`,`messages` 中 assistant 带 `tool_calls`、tool 角色带 `tool_call_id`+`content`;解析 `choices[0].message`:有 `tool_calls` → `ProviderRound{tool_calls}`,否则 `content` → text。
- **Anthropic**: `POST https://api.anthropic.com/v1/messages`,头 `x-api-key: {key}`、`anthropic-version: 2023-06-01`、`Content-Type: application/json`;body `{model, max_tokens: cfg.max_tokens.unwrap_or(1024), system: <system 消息文本>, messages:[{role:"user"|"assistant", content:[{type:"text",text}|{type:"tool_use",id,name,input}|{type:"tool_result",tool_use_id,content}]}]}`;解析 `content[]`:`type=="tool_use"` → ToolCall(id,name,input→arguments),`type=="text"` → text。
- **Gemini**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}`;body `{system_instruction:{parts:[{text}]}, contents:[{role:"user"|"model", parts:[{text}|{functionCall:{name,args}}|{functionResponse:{name,response}}]}], generationConfig:{temperature,maxOutputTokens,topP}, tools:[{functionDeclarations:[...]}]}`;解析 `candidates[0].content.parts[]`:`functionCall` → ToolCall(id=name, name, arguments=args JSON),`text` → text。

### 2.3 LlmClient

- 保留 B1 的 `complete(cfg, messages) -> AppResult<String>`(无工具,供 test_llm_config),内部走 `call`。
- 新增:
```rust
pub async fn call(&self, cfg: &LlmConfig, msgs: Vec<ChatMessage>, defs: &[serde_json::Value]) -> AppResult<ProviderRound>;
```
- `call` 按 `Provider::parse(&cfg.provider)` 分派到 `call_<p>`;重试/退避复用 B1 的 `is_retryable`/`backoff_delay`(每次重试同 provider)。
- 错误映射沿用:非 2xx → `AppError::Http(code, truncated)`;网络 → `Network`;解析失败 → `Core`。

## 3. 工具基建(tools/ 新模块)

### 3.1 目录

```
src-tauri/src/tools/
├── mod.rs        # Tool trait + ToolContext + ToolRegistry
├── bridge.rs     # ToolBridge(插件工具的前端往返桥)
└── builtins.rs   # 实用工具:get_time/calculate/convert_units
```

### 3.2 Tool trait

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn parameters(&self) -> serde_json::Value; // JSON Schema 对象
    /// 该工具是否默认开放给 LLM(危险工具如写文件/建卡片设为 false)
    fn is_safe(&self) -> bool { true }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String>;
}

pub struct ToolContext<'a> {
    pub dc: &'a Context,          // bot 的 deltachat context
    pub db: &'a Db,
    pub bot_id: i64,
    pub chat_id: ChatId,
    pub data_dir: &'a PathBuf,    // 应用数据目录(文件沙箱根)
}
```

### 3.3 ToolRegistry

```rust
pub struct ToolRegistry {
    tools: Vec<Arc<dyn Tool>>,
    bridge: Arc<ToolBridge>,
}
impl ToolRegistry {
    pub fn new(bridge: Arc<ToolBridge>) -> Self;
    pub fn register(&mut self, t: Arc<dyn Tool>);
    pub fn names(&self) -> Vec<&'static str>;
    /// 按 enabled 集合筛出 defs;enabled=None → 仅 is_safe()==true 的默认集
    pub fn defs_for(&self, enabled: Option<&[String]>) -> Vec<serde_json::Value>;
    pub fn execute(&self, name: &str, arguments: &str, ctx: &ToolContext<'_>) -> AppResult<String>;
    pub fn has(&self, name: &str) -> bool;
}
```
- `execute`: 找不到工具 → `AppError::Core("未知工具")`;参数解析失败/执行失败 → 返回错误文本(驱动会把错误文本喂回 LLM,而非中断)。

### 3.4 ToolBridge(插件工具往返)

```rust
pub struct ToolBridge {
    pending: StdMutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
    emit: Option<Arc<dyn Fn(serde_json::Value) + Send + Sync>>,
}
impl ToolBridge {
    pub fn new() -> Self;
    pub fn with_emitter<F: Fn(serde_json::Value) + Send + Sync + 'static>(self, f: F) -> Self;
    /// emit {kind:"tool_request", id, name, args};等待前端 bot_tool_result 回调,10s 超时
    pub async fn request(&self, name: &str, args: serde_json::Value) -> AppResult<String>;
    pub fn resolve(&self, id: &str, result: String) -> bool;
}
```

## 4. 实用工具(tools/builtins.rs)

三个工具类,`is_safe=true`:

| 工具 | 参数 | 行为 |
|---|---|---|
| `get_time` | `timezone?: string`(仅 "utc"/"local",默认 local) | 返回当前时间,如 `本地时间 2026-08-03 22:30:00 (UTC+08:00)` |
| `calculate` | `expression: string` | 递归下降安全求值,支持 `+ - * / % ^ ( )`、数字/小数、函数 `sin cos tan sqrt log ln abs floor ceil round pow`;结果如 `42`;非法输入返回错误文本 |
| `convert_units` | `value: number, from: string, to: string` | 长度(m/cm/mm/km/ft/in/mi)、重量(kg/g/mg/lb/oz/t)、温度(c/f/k)、数据(B/KB/MB/GB)、时间(s/min/h/day);结果 `{value} {to}` |

- 计算器为手写递归下降(零新依赖):词法(token) → 语法(expr → term → factor → power → unary → primary);`calculate` 校验输入长度 ≤200、字符白名单,防注入。
- `get_time` 用 `chrono::Local`/`Utc`。
- `convert_units` 用基准单位换算表(category → (unit, factor))。

## 5. LLM 驱动升级(drivers/llm.rs)

- `LlmDriver::new(client: LlmClient, registry: Arc<ToolRegistry>)`。
- `on_message` 改为工具循环:
  1. 构建 messages(system prompt + history,历史用 `ChatMessage`)
  2. `let enabled = bot.config.tools.as_deref(); let defs = registry.defs_for(enabled);`
  3. 循环 `for _ in 0..5`:
     - `let round = client.call(cfg, msgs.clone(), &defs).await?;`
     - 有 `text` → 记录结果,break
     - 有 `tool_calls` → 把 assistant(tool_calls) 消息 push;逐个 `registry.execute`(失败也把错误文本当结果),push tool 消息;记录活动 `tool_called`(summary `调用工具 {name}`);继续循环
     - 无 text 无 tool_calls → break
  4. 循环结束仍无最终文本 → `AppError::Core("工具循环未产出最终回复")`
  5. 最终文本 → `split_reply(text)` 拆多条返回
- `split_reply(text, max_len=400) -> Vec<String>`:按 `。！？.!?\n` 句边界拆;句子超长按字符硬切;空段丢弃。
- 防 bot 互聊/限流/发送仍由 runtime 处理(不变)。

## 6. 接线(lib.rs + commands.rs)

- lib.rs:`let bridge = Arc::new(ToolBridge::new().with_emitter(emit)); let mut reg = ToolRegistry::new(bridge); reg.register(Arc::new(GetTimeTool)); reg.register(...); ...; LlmDriver::new(LlmClient::new(), Arc::new(reg))`。
  - 注:bridge 的 emit 在 B5 才真正被前端使用;B2 里 emit 回调暂只记日志。
- 新 activity kind:`pub const TOOL_CALLED: &str = "tool_called";`(dto.rs bot_activity_kind)。
- commands.rs: `test_llm_config` 保持走 `shared_client()`。

## 7. 测试验收

### 单元测试(`cargo test --lib`)
- llm.rs:`Provider::parse`(缺省→openai、未知→openai)、三个 provider 的 body 构造(断言结构/字段)、响应解析(正常/缺字段/工具调用)、错误映射。
- tools/builtins.rs:`calculate` 表达式(`2+3*4`=14、`2^10`=1024、`sqrt(16)+1`=5、非法输入报错、除零报错)、`convert_units`(100cm→1m、32f→0c、1GB→1024MB、非法单位报错)、`get_time` 非空。
- tools/registry.rs:注册/查找/未知工具错误、`defs_for(None)` 只含 safe、`defs_for(Some([...]))` 按集合过滤。
- drivers/llm.rs:`split_reply`(短文本原样、超长按句拆、单句超长硬切)。
- B1 既有 51 测试不回归。

### 编译/手动
- [ ] `cargo build` / `cargo test --lib` 通过;`npx tsc --noEmit` 干净(前端无改动)
- [ ] 手动:Bot 配 `provider=anthropic` + Claude key → 正常回复;`provider=gemini` + Gemini key → 正常回复;OpenAI 兼容(DeepSeek/Ollama)不回归
- [ ] Bot 发 `请计算 (25*4+10)/5 等于多少` → LLM 调用 calculate 工具 → 回复正确结果(工具循环生效)
- [ ] 长回复被拆成多条发送

## 8. 改动文件

- 新增:`src-tauri/src/tools/{mod,registry→并入 mod,bridge,builtins}.rs`(registry 并入 mod.rs)
- 修改:`llm.rs`、`dto.rs`(activity kind + LlmConfig 无需改,provider 字段已有)、`drivers/llm.rs`、`drivers/mod.rs`(如需)、`lib.rs`、`commands.rs`(如需)、`Cargo.toml`(无新依赖,如无则不改)
