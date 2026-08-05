# 智能中心 + 知识库 · 实施计划(并行任务分解)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实施 `docs/superpowers/specs/2026-08-05-smart-center-knowledge-design.md`(智能中心四 Tab + 知识库 + 统一命令系统)+ `2026-08-05-llm-topic-summary-design.md`(LLM 主题总结双车道)合并大范围。全部直接在 main 开发,小步提交。

**Architecture:** 后端新增三大独立模块(命令注册表/知识库/智能运行时)+ 前端两大页面模块(主题总结、智能中心),以接口契约为界并行开发,共享文件(db.rs/dto.rs/commands.rs/lib.rs)由编排者统一集成。

**Tech Stack:** Rust(Tauri) / TypeScript / jieba-wasm(已有)

**验证方式:** `cargo test --lib`(既有 281 测试不回归 + 新单测);`npx tsc --noEmit` 干净;`npm run build`(前端构建);手动 tauri dev 冒烟。

---

## 任务分工总览(文件边界隔离,并行无冲突)

| 任务 | 归属 | 独占文件 | 依赖 |
|---|---|---|---|
| Task 0 地基 | 编排者 | db.rs / dto.rs(新增表+DTO+方法) | — |
| Task 1 前端·主题总结 | subagent A4 | `src/utils/tagParser.ts`(新)、`src/utils/summaryState.ts`(新)、`src/components/summaryDashboard.ts`(新)、`src/chat/chatView.ts` | Task 0 契约(事件/命令) |
| Task 2 前端·智能中心 | subagent A5 | `src/pages/intelligencePage.ts`(新)、`src/shell/rail.ts`、`src/shell/navPanel.ts`、`src/settingsPage.ts`、`src/components/icon.ts`、`src/components/tdesignIcons.ts`、`src/types.ts`、`src/state.ts` | Task 0 契约(命令/DTO) |
| Task 3 后端·命令系统 | subagent A1 | `src-tauri/src/commands/registry.rs`(新)、`src-tauri/src/drivers/syscmd.rs`(新)、`src-tauri/src/drivers/rule.rs`(迁移) | Task 0 |
| Task 4 后端·知识库 | subagent A2 | `src-tauri/src/knowledge/{mod,store,pipeline,ask,onboard}.rs`(新) | Task 0 |
| Task 5 后端·智能运行时 | subagent A3 | `src-tauri/src/intelligence/{mod,settings,queue,local,api,download}.rs`(新) | Task 0 |
| Task 6 集成 | 编排者 | commands.rs / lib.rs / error.rs / state.rs / docs/api-spec.md | Task 1-5 |

CSS 约定:**所有新样式用 ui.\* 组件 + 行内 cssText(var(--xxx) token)**,不得修改 styles.css(避免与并行前端 agent 冲突);styles.css 追加由编排者在 Task 6 统一完成。

提交约定:各 subagent 完成即 commit(只含自己独占文件);push 前 `git pull --rebase`;编排者 Task 6 集成后统一编译验证 + 修复 + 提交。

---

## Task 0: 地基(编排者,先行完成)

**Files:** Modify: `src-tauri/src/db.rs`, `src-tauri/src/dto.rs`

- [ ] **Step 1: db.rs 新增三表**(migrate() execute_batch 追加 CREATE TABLE IF NOT EXISTS):

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  msg_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, date)
);
CREATE TABLE IF NOT EXISTS knowledge_config (
  chat_id INTEGER PRIMARY KEY,
  daily_enabled INTEGER NOT NULL DEFAULT 0,
  daily_time TEXT NOT NULL DEFAULT '00:00',
  window_count INTEGER NOT NULL DEFAULT 100,
  auto_store INTEGER NOT NULL DEFAULT 1,
  daily_run_date TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intelligence_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'off',      -- 'off' | 'wordfreq' | 'llm'
  source TEXT NOT NULL DEFAULT 'api',    -- 'local' | 'api'
  model_tier TEXT NOT NULL DEFAULT '0.5b',
  window_n INTEGER NOT NULL DEFAULT 50,
  base_url TEXT, api_key TEXT, model TEXT,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: db.rs 新增行结构 + 方法**(仿 list_all_bots 风格,spawn_blocking):

```
structs: KnowledgeRow { id, chat_id, date, title, summary, tags, msg_count, source, created_at, updated_at }
        KnowledgeConfigRow { chat_id, daily_enabled, daily_time, window_count, auto_store, daily_run_date, updated_at }
        IntelligenceSettingsRow { id, mode, source, model_tier, window_n, base_url, api_key, model, updated_at }

methods:
  upsert_knowledge(chat_id: u32, date: &str, title: &str, summary: &str, tags: &str, msg_count: u32, source: &str) -> AppResult<i64>
    -- INSERT ... ON CONFLICT(chat_id, date) DO UPDATE SET title/summary/tags/msg_count/source/updated_at; 返回最后插入/更新的 id
  list_knowledge(chat_id: Option<u32>, tag: Option<&str>, keyword: Option<&str>, page: i64, page_size: i64) -> AppResult<Vec<KnowledgeRow>>
    -- WHERE 动态拼;tag 用 tags LIKE '%"tag"%' 子串匹配;keyword 用 (title LIKE ? OR summary LIKE ?);ORDER BY updated_at DESC;LIMIT/OFFSET
  get_knowledge(id: i64) -> AppResult<Option<KnowledgeRow>>
  delete_knowledge(id: i64) -> AppResult<()>
  update_knowledge(id: i64, title: Option<&str>, summary: Option<&str>, tags: Option<&str>) -> AppResult<()>
    -- 只更新非 None 字段
  get_knowledge_config(chat_id: u32) -> AppResult<Option<KnowledgeConfigRow>>
  set_knowledge_config(chat_id: u32, daily_enabled: bool, daily_time: &str, window_count: i64, auto_store: bool) -> AppResult<()>
    -- INSERT OR REPLACE(保留 daily_run_date 不动:先 SELECT 旧值再合并)
  list_knowledge_configs() -> AppResult<Vec<KnowledgeConfigRow>>
  mark_daily_run(chat_id: u32, date: &str) -> AppResult<()>  -- UPDATE daily_run_date
  get_intelligence_settings() -> AppResult<Option<IntelligenceSettingsRow>>
  set_intelligence_settings(mode, source, model_tier, window_n, base_url, api_key, model) -> AppResult<()> -- UPSERT id=1
  chat_has_running_bot(chat_id: u32) -> AppResult<bool>
    -- SELECT COUNT(*) FROM bots b WHERE b.status='running' AND EXISTS(SELECT 1 FROM contacts c WHERE c.chat_id=? AND c.addr IN (SELECT configure_key FROM config...))——实施时用简单可靠版:仿 collect_bot_addrs 拿 running bot 地址集,查该 chat 成员是否有匹配(可用 core api 或 contact 表;若不可行,降级为「该 chat 是否存在于任一 running bot 的已加入群列表」——实施时与 A1 协商,以能编译+单测为准)
```

- [ ] **Step 3: dto.rs 新增 DTO**:

```rust
pub struct KnowledgeDto { id: i64, chat_id: u32, chat_name: String, date: String, title: String,
    summary: String, tags: Vec<String>, msg_count: u32, source: String, created_at: i64, updated_at: i64 }
pub struct KnowledgeConfigDto { chat_id: u32, chat_name: String, daily_enabled: bool,
    daily_time: String, window_count: i64, auto_store: bool }
pub struct IntelligenceSettingsDto { mode: String, source: String, model_tier: String,
    window_n: i64, base_url: Option<String>, api_key: Option<String>, model: Option<String> }
pub struct ModelStatusDto { mode: String, source: String, engine_ready: bool, model_ready: bool,
    engine_path: Option<String>, model_path: Option<String>, engine_version: Option<String>, model_sha256: Option<String> }
```

- [ ] **Step 4: commit**(`feat(db/dto): 智能中心地基——knowledge/knowledge_config/intelligence_settings 表+方法+DTO`)

---

## Task 1: 前端·主题总结双车道(subagent A4)

**Files:** Modify: `src/chat/chatView.ts`;Create: `src/utils/tagParser.ts`, `src/utils/summaryState.ts`, `src/components/summaryDashboard.ts`

- [ ] **Step 1: `src/utils/tagParser.ts`** — 白名单标签解析(按 spec §6.1):`parseSafeTags(input: string): string`(整体 escapeHtml 后,白名单正则替换 `<message='...'>`/`<user='...'>` 为受控 HTML,参数值 escapeHtml;返回 HTML 片段)+ `extractMessageRefs(html 或 input) -> { id?: number, query?: string }[]`。
- [ ] **Step 2: `src/utils/summaryState.ts`** — 气泡状态机(纯 TS,按 spec §9):`type BubbleStatus = 'idle'|'summarizing'|'done'|'error'|'fallback'`;`createSummaryStore() -> { map: Map<chatId, {lane, status, text}>; transition(...) }`;`summary-event` 监听包装:`listenSummaryEvents(handler)`(用 src/api.ts 的 call/事件桥,事件名 `summary-event`)。

**契约(enqueue_summary 命令,Task 5 提供):**
```
invoke('enqueue_summary', { chatId, lane: 'bubble'|'detail', kind?: string, context: SummaryContext })
SummaryContext { lines: string[], prevAnalysis?: string }   // 前端从 state.messages 组装窗口(信封解析 resolveMessageText)
事件 summary-event payload { chatId, lane, kind?, status: 'idle'|'summarizing'|'done'|'error'|'fallback',
                             delta?: string, result?: string, error?: { code: string, message: string } }
```

- [ ] **Step 3: `src/components/summaryDashboard.ts`** — 详情看板(按 spec §9 看板 + §9.5 注册表):`renderSummaryDashboard(chatId, mountEl)` — 7 区块(summary/participation/action_items/resources/open_questions/timeline/decisions)平铺,每区块独立 idle/streaming/done/error 状态,独立刷新按钮,独立 `enqueue_summary({lane:'detail', kind})`;participation 前端统计 + LLM 解读(stats 用 state.messages 算:发言数/消息数/活跃时段);渲染用 tagParser;内容空显示占位;被新消息打断显示「分析已过期」。
- [ ] **Step 4: `src/chat/chatView.ts` 挂载气泡** — 在 `data-topic-chip` 旁新增 LLM 气泡挂载点:读智能设置模式(调用 `get_intelligence_settings`);模式=llm → 气泡状态机(呼吸灯 + 流式 delta 追加 + done 摘要 + error 降级词频 + 可点刷新);模式=off/wordfreq → 现词频行为不变。窗口组装:最近 N 条(设置 window_n)经 `resolveMessageText` + 绝对时间 `YYYY-MM-DD HH:MM` + `[id=<msg_id>] <from_name>: <text>` 行。切会话取消(发 cancelled 语义:重新入队即可)。气泡点击 → `openSummaryDashboard(chatId)`。
- [ ] **Step 5: 单测**(Vitest,若无框架则 node --experimental-strip-types 跑纯函数断言):tagParser 合法/非法/转义/嵌套;模糊匹配(精确 id/多结果/0 条);状态机转移/降级。
- [ ] **Step 6: commit**(`feat(web): 主题总结双车道——tagParser/气泡状态机/详情看板/chatView 挂载`)

---

## Task 2: 前端·智能中心聚合页(subagent A5)

**Files:** Modify: `src/types.ts`, `src/state.ts`, `src/shell/rail.ts`, `src/shell/navPanel.ts`, `src/settingsPage.ts`, `src/components/icon.ts`, `src/components/tdesignIcons.ts`;Create: `src/pages/intelligencePage.ts`

- [ ] **Step 1: 图标与类型** — tdesignIcons.ts 加 `sparkles` 条目(lucide sparkles 路径);icon.ts `IconName` 加 `'sparkles'`;types.ts `Page` 加 `'intelligence'`;state.ts 加 `intelligenceTab: 'knowledge'|'summary'|'config'|'settings'`(参考 githubTab)。
- [ ] **Step 2: rail 入口** — rail.ts 手工 icon HTML 区(github 之后)加智能入口:`data-page="intelligence"`,iconSvg('sparkles');激活高亮逻辑复用。
- [ ] **Step 3: 路由分发** — navPanel.ts:renderNavPanel switch 加 `case 'intelligence'`(懒加载 `renderIntelligenceNav`);renderMain 加 `case 'intelligence'`(懒加载 `renderIntelligenceMain`,失败显示 empty)。
- [ ] **Step 4: `src/pages/intelligencePage.ts`** — 复刻 githubPage 1+3 布局(玻璃工具栏 + Tab 条 + 内容区):

**契约(界面命令,Task 4 提供):**
```
list_knowledge({ chatId?, tag?, keyword?, page?, pageSize? }) -> KnowledgeDto[]
get_knowledge({ id }) -> KnowledgeDto
delete_knowledge({ id }) -> ()
update_knowledge({ id, title?, summary?, tags? }) -> KnowledgeDto
summarize_store_now({ chatId, count? }) -> KnowledgeDto
list_knowledge_config() -> KnowledgeConfigDto[]
set_knowledge_config({ chatId, dailyEnabled, dailyTime, windowCount, autoStore }) -> KnowledgeConfigDto
get_intelligence_settings() / set_intelligence_settings({ mode, source, modelTier, windowN, baseUrl?, apiKey?, model? })
get_llm_model_status() -> ModelStatusDto
start_engine_download({ which: 'engine'|'model' }) -> ()
事件 download-progress { id: 'engine'|'model', bytesDone, total, rate }
```

四 Tab:
1. **知识库**:工具条(会话过滤 select + 标签过滤 + 搜索 input + 刷新);条目卡片列表(标题/日期/会话名/标签 chip/来源/msg_count,点击展开详情);详情区(标题/摘要 textarea/标签 chips 可编辑/保存=update_knowledge/删除=delete_knowledge);「总结本会话入库」按钮(summarize_store_now,结果刷新列表)。
2. **主题总结**:各会话摘要状态列表(调 enqueue_summary bubble 或展示已存状态)+ 点击打开 summaryDashboard(复用 Task 1 组件,若未完成用占位)。
3. **自动总结配置**:会话列表 + 每会话表单(开关 switch_/时间 input time/window slider/auto_store switch)→ set_knowledge_config。
4. **智能设置**:模式 segmented(off/词频/LLM)+ 来源 segmented(本地/API)+ 模型档位 radio(0.5B/1.5B)+ 下载按钮+进度面板(download-progress 事件渲染,节流 200ms)+ API 配置表单(base_url/api_key/model + 测试按钮 → test_llm_config)+ 上下文条数 slider(10-200)。set/get_intelligence_settings + get_llm_model_status。

- [ ] **Step 5: settingsPage.ts** — sections 数组加 `{ id: 'intelligence', icon: 'sparkles', label: '智能' }`(types.ts SettingsSection 加值);渲染区:跳转说明卡 + 「打开智能中心」按钮 → `state.currentPage='intelligence'; state.intelligenceTab='settings'; navigateToPage('intelligence')`(不复制表单)。
- [ ] **Step 6: 前端单测**(node strip-types):Tab 切换状态、知识库列表渲染数据映射。
- [ ] **Step 7: commit**(`feat(web): 智能中心聚合页四 Tab + rail 入口 + 设置页智能区`)

---

## Task 3: 后端·统一命令系统(subagent A1)

**Files:** Create: `src-tauri/src/commands/registry.rs`, `src-tauri/src/drivers/syscmd.rs`;Modify: `src-tauri/src/drivers/rule.rs`

- [ ] **Step 1: `src-tauri/src/commands/registry.rs`** — CommandRegistry(OnceLock 单例):

```rust
pub enum CommandScope { Bot, User, Both }
pub enum CommandKind { Bot, System }
pub struct CommandInvocation { pub name: String, pub args: Vec<String>, pub unknown: bool }
pub struct CommandCtx<'a> {
    pub kind: CommandKind, pub chat_id: u32, pub msg_id: u32,
    pub args: Vec<String>, pub raw: &'a str,
}
pub type CommandHandler = fn(&CommandCtx<'_>) -> BoxFuture<'static, AppResult<Vec<String>>>;

pub struct CommandSpec { pub name: &'static str, pub scope: CommandScope, pub description: &'static str, pub handler: CommandHandler }
impl CommandRegistry {
    pub fn register(&self, spec: CommandSpec);
    pub fn parse(&self, text: &str) -> Option<CommandInvocation>;   // /name arg1 arg2;支持引号
    pub fn lookup(&self, name: &str) -> Option<&CommandSpec>;
    pub fn handle(&self, ctx: CommandCtx<'_>) -> BoxFuture<'static, AppResult<Vec<String>>>;
}
pub fn global_registry() -> &'static CommandRegistry;
```

注册 4 命令:`summarize`(Both,handler 调 Task 4 的 pipeline——**Task 3 先提供骨架 handler,由编排者 Task 6 接真实实现**)、`ask`(Both,同上)、`whoami`(Bot,从 rule.rs 迁移)、`roll`(Bot,从 rule.rs 迁移)。

- [ ] **Step 2: `src-tauri/src/drivers/syscmd.rs`** — `SystemCommandProcessor` 实现 `BotDriver::on_message`(drivers/mod.rs:54 trait):调 `registry.parse`;非命令返回空;命令 scope 校验(User/Both);**不双回复判定**(调 `db.chat_has_running_bot(chat_id)` → 该 chat 有 running bot 且命令 scope 含 Bot → 返回空,让 RuleDriver 处理);执行 handler;回复:调 `commands::send_text_impl(state, chat_id, text)`(经编排者提供的回调,或直接依赖 crate::commands 的 pub 函数;若不方便,注册时由编排者注入发送回调——实施时与编排者确认,以能编译为准)。record 到 activity(act::RULE_REPLY 语义,或新增 act 变体——实施时看既有枚举,倾向复用)。
- [ ] **Step 3: `rule.rs` 迁移** — on_message 指令分支改为先调 `registry.parse` + `registry.handle`(scope=Bot 命令),命中即返回;`/summarize` `/whoami` `/roll` 逻辑迁入注册表 handler(handle_summarize 移到 registry 或保持函数被 handler 调用);保留欢迎语/关键词/兜底/seen 逻辑不动。注册顺序:syscmd 在 RuleDriver **之前**(registry 里先判定),保证系统优先判定、Bot 优先执行(不双回复由 syscmd 判空)。
- [ ] **Step 4: 单测**:parse 各种形式(`/cmd`、`/cmd a b`、引号、未知命令)、scope 校验、registry 注册/查找、syscmd 非命令返回空。
- [ ] **Step 5: commit**(`feat(commands): 统一命令注册表 + 系统命令处理器 + rule.rs 迁移`)

---

## Task 4: 后端·知识库(subagent A2)

**Files:** Create: `src-tauri/src/knowledge/{mod,store,pipeline,ask,onboard}.rs`

- [ ] **Step 1: `store.rs`** — KnowledgeStore(包装 db 方法 + 会话名联查):`list(chat_id/tag/keyword/page/page_size) -> Vec<KnowledgeDto>`(chat_name 经 db 或 core 查,缺失显示 chat_id)、`get(id)`、`delete(id)`、`update(id, title/summary/tags)`、`upsert_from_pipeline(...)`。
- [ ] **Step 2: `pipeline.rs`** — SummarizePipeline:核心 `pub async fn store_summary(ctx, chat_id, count, source) -> AppResult<KnowledgeDto>`:
  - 取窗口:`drivers::llm::build_history_n(ctx, chat_id, count)` 复用(无文本消息跳过);空 → Err("暂无可总结的消息")
  - LLM 生成:调 **Task 5 提供的共享入口**(契约:`intelligence::complete_text(messages: Vec<ChatMessage>) -> AppResult<String>`,编排者保证存在)——prompt 要求 JSON 输出:`{"title": "...", "summary": "...", "tags": ["..."]}`(只输出 JSON 约束);解析失败 → 降级(直接用首行做 title,原文做 summary,tags=[])
  - `db.upsert_knowledge(chat_id, today, ...)`;返回 DTO
  - 每日自动:`pub async fn run_daily(ctx) -> AppResult<usize>`:遍历 list_knowledge_configs 中 daily_enabled 的项,检查到点(当前 HH:MM >= daily_time)且当日未跑(daily_run_date != today)→ 先 `mark_daily_run` 再 store_summary;统计成功数。
- [ ] **Step 3: `ask.rs`** — AskEngine:`pub async fn ask(ctx, chat_id, question) -> AppResult<Vec<String>>`:
  - 检索:`db.list_knowledge(None/chat_id=None 全局, keyword=question, page=1, page_size=5)`
  - 空 → 「知识库暂无相关内容,可发送 /summarize save 存入总结」拆分返回
  - 非空 → 组装 LLM messages(候选条目 + 问题)→ `intelligence::complete_text`;失败 → 直接返回候选条目文本(降级)
- [ ] **Step 4: `onboard.rs`** — OnboardService:`pub async fn on_member_joined(ctx, chat_id)`(供事件监听调用,若现有代码已有成员变更事件挂点则由编排者接线;无则本期提供函数 + 编排者接 tick 或事件):取该群最近 3 条条目 → 有 → LLM 生成群概要(「群概要」prompt)→ 发送(有 running bot → 返回文本让 Bot 驱动发;无 → 走发送回调);无条目 → 欢迎提示文本。
- [ ] **Step 5: `mod.rs`** — 导出 + 装配构造函数(`pub fn new(db: Arc<Db>) -> Self`,不持有 AppState,依赖经参数注入)。
- [ ] **Step 6: 单测**:JSON 解析(合法/非法/降级)、upsert 去重(同 chat+date 更新)、检索排序、空库、daily 到点判定(mock 时间或传 now 参数——用 `daily_time` 比较函数纯测)。
- [ ] **Step 7: commit**(`feat(knowledge): 知识库 store/pipeline/ask/onboard 模块`)

---

## Task 5: 后端·智能运行时(subagent A3)

**Files:** Create: `src-tauri/src/intelligence/{mod,settings,queue,local,api,download}.rs`

- [ ] **Step 1: `settings.rs`** — 智能设置读写(包装 db.get/set_intelligence_settings)+ `pub async fn complete_text(cfg: &IntelligenceSettingsRow, messages: Vec<ChatMessage>) -> AppResult<String>`(统一入口,供 Task 4 与主题总结调用;mode!=llm → Err(llm_not_configured);source=api → api::complete;source=local → local::complete)。
- [ ] **Step 2: `api.rs`** — ApiRunner:复用 `crate::llm::shared_client()` + LlmConfig(base_url/api_key/model 来自 settings);`pub fn build_llm_config(s) -> LlmConfig` + `pub async fn complete(cfg, messages) -> AppResult<String>`;错误映射(401→api_auth、402/body quota→api_quota、429→api_rate_limit、400→api_bad_request、网络→api_network)。
- [ ] **Step 3: `local.rs`** — LocalRunner(llama-server 旁路进程):
  - `pub struct LocalRunner { port: u16, child: Mutex<Option<Child>> }`
  - `ensure_running()`:检查 `app-data/models/llama-server` 存在 → spawn(参数: `-m <model> --port <12700+> -c 4096 -ngl 0`);`GET /health` 轮询就绪(最多 30s)
  - `complete(cfg, messages)`:POST `/v1/chat/completions` stream=true → SSE 解析(增量 delta 累积返回最终文本;流式回调 `on_delta: Option<fn(String)>` 可选)
  - 空闲 10 分钟 kill(记录 last_used,后台检查);崩溃自愈(退出码非 0 → 重启一次);超时 60s
  - SSE 解析器:`pub fn parse_sse_line(line: &str) -> Option<String>` 纯函数(测)
- [ ] **Step 4: `queue.rs`** — SummaryQueue:本地串行(信号量=1)+ API 并发;每 (chat_id, lane) 保留最新(新入队丢旧);
  - `pub struct SummaryQueue` + `enqueue(req: SummaryRequest)`
  - `SummaryRequest { chat_id: u32, lane: 'bubble'|'detail', kind: Option<String>, context: SummaryContext, source: SummarySource(api|local) }`
  - 执行时:组装 prompt(按 spec §4.5 定稿 prompt;bubble 一句话 ≤60 字;detail 按 kind 变体——prompt 常量放本文件),调 local/api,SSE 增量 → **emit summary-event**(tauri AppHandle,事件 payload 契约见 Task 1;流式每 token 发 `{status:'summarizing', delta}`)
  - 错误 → emit `{status:'error', error:{code,message}}`;错误码表按 spec §10.2
  - 引擎未就绪入队 → pending 挂起,就绪后消费
- [ ] **Step 5: `download.rs`** — Downloader:引擎(llaama.cpp GitHub releases 锁 tag b10276,CPU 产物,按平台选资产:win-x64 zip/macos-arm64 tgz/macos-x64 tgz/ubuntu-x64 tgz/ubuntu-arm64 tgz)+ 模型 GGUF(0.5B/1.5B,ModelScope 优先 resolve/master/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf,HF 兜底);
  - `pub async fn start(which: 'engine'|'model', handle: &AppHandle)` — 下载到 `app-data/models/` 临时文件 → sha256 校验 → post-process(win 解压 zip/mac xattr 去隔离/linux chmod +x)→ 更新 summary_state.json
  - 进度:`app.emit("download-progress", {id, bytesDone, total, rate})` 节流;断点续传(Range);失败返回错误码
  - `pub fn engine_status() -> ModelStatusDto`(从 summary_state.json 读)
- [ ] **Step 6: `mod.rs`** — 装配:`pub struct Intelligence { settings, queue, local: Arc<LocalRunner>, api: Arc<ApiRunner>, downloader, state_path }`;`pub fn new(data_dir: PathBuf, handle: AppHandle) -> Self`;`pub async fn complete_text(...)` 转发 settings+local/api;队列启动 task(engine 就绪检查在 enqueue 时懒启动)。
- [ ] **Step 7: 单测**:SSE 解析(多 chunk)、错误码映射、queue 同 chat 丢旧留新、JSON prompt 组装、下载器 post-process 分支(路径计算纯函数)。
- [ ] **Step 8: commit**(`feat(intelligence): 智能运行时——settings/api/local/queue/download`)

---

## Task 6: 集成(编排者)

**Files:** Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/error.rs`, `src-tauri/src/state.rs`, `src-tauri/src/runtime.rs`, `src-tauri/src/drivers/mod.rs`, `src-tauri/src/llm.rs`(如需), `src/styles.css`, `docs/api-spec.md`

- [ ] **Step 1**: lib.rs 装配:`Intelligence` 构造挂 AppState(仿 bot_tools 字段);CommandRegistry 注册命令(registry handler 接 Task 4 pipeline / Task 5 complete_text);syscmd 注册进 DriverRegistry(Rule 之前);runtime.rs tick_loop 挂每日扫描器(`knowledge::pipeline::run_daily` 独立 task,30s 粒度 + daily_run_date 防重跑)+ 主题总结 enqueue_summary 消费 task。
- [ ] **Step 2**: commands.rs 新增全部界面命令(薄包装调各模块):list_knowledge/get_knowledge/delete_knowledge/update_knowledge/summarize_store_now/list_knowledge_config/set_knowledge_config/get_intelligence_settings/set_intelligence_settings/get_llm_model_status/start_engine_download/enqueue_summary(+ 内部智能命令);lib.rs generate_handler 追加。
- [ ] **Step 3**: error.rs 加智能错误变体;events.rs 或 runtime.rs 接成员入群事件 → onboard(若既有挂点不存在,先提供 tick 扫描版本:每 30s 检查新增成员,防漏——实施时以简单可靠为准)。
- [ ] **Step 4**: 编译修复:`cargo build` 18 warnings 基线不增;`cargo test --lib` 281 基线 + 新测试全绿;`npx tsc --noEmit`;`npm run build`。
- [ ] **Step 5**: styles.css 追加智能中心/看板/气泡所需最小全局类(如 .ig-tabs/.ig-tab/.ig-card,对齐既有 .gh-editor-tabs 风格)。
- [ ] **Step 6**: docs/api-spec.md 补命令/DTO/事件;最终 commit。
