# 智能中心 + 知识库 · 合并大设计(LLM 主题总结 + D3 知识沉淀 + 统一命令系统)

日期:2026-08-05
状态:设计定稿(已过 brainstorming 确认)
范围:三个子系统**合并实施、一份大 spec**:① LLM 主题总结双车道(已有 `2026-08-05-llm-topic-summary-design.md` 定稿,本文档整合其决策为实施依据,细节以该文档为准);② D3 知识沉淀(知识库 + /ask 问答 + 新人引导);③ 统一斜杠命令系统(全局命令注册表,Bot 与用户侧共用)。全部开发直接在 `main` 分支上进行;另一前端 agent 并行开发,与本实现互不干扰(以命令契约为界)。

## 1. 背景与动机

- LLM 主题总结:现有词频聚类 `computeTopics`(wordAnalysis.ts)升级为 LLM 智能总结——本地小模型(旁路 llama-server)或 OpenAI 兼容 API 双来源,气泡短摘要 + 详情看板。spec 已定稿(`2026-08-05-llm-topic-summary-design.md`),尚未实现。
- D3 知识沉淀:既有 `/summarize`(rule.rs,拉最近 N 条→LLM 总结→直接回复,**不持久化**)升级为知识库:总结结构化入库、/ask 问答、新人入群引导。
- 统一命令系统:斜杠命令从 Bot 驱动(rule.rs)抽出为全局命令注册表,Bot 驱动与用户侧共用同一套解析与处理;无 Bot 会话由「系统命令处理器」接管回复。

### 全局约束(用户确认)

1. **生产级真实可用**:所有代码必须真实运行,可依赖现有基础设施(llm.rs / tools / dto / db / commands 既有模式),不引入未验证的抽象。
2. **设置颗粒度尽可能细**:每会话独立配置、可调参数全部暴露为设置项。
3. **合并实施**:主题总结 + 知识库 + 命令系统一次实施,一份 plan。
4. **直接 main 开发**;另一前端 agent 并行,冲突以文件边界隔离(见 §13)。
5. **智能中心聚合页**:rail 新增「智能」入口 → 大页面四 Tab(知识库 | 主题总结 | 自动总结配置 | 智能设置)。

## 2. 已敲定决策汇总

| 维度 | 决策 |
|---|---|
| 引擎 | llama-server 旁路进程(tokio Command 拉起,HTTP 查询)+ API 双来源(复用 llm.rs LlmClient) |
| 本地模型档位 | 0.5B / 1.5B 两档,Q4_K_M,ModelScope 优先(HF 兜底),sha256 校验 |
| 输出 | 气泡短摘要 + 详情看板(每分析类型独立请求),两车道均 SSE 流式 |
| 上下文 | 上次分析 + 最近 N 条(N 可调 10-200,默认 50);每行注入绝对时间 `YYYY-MM-DD HH:MM`;4000 字硬上限 |
| 附件隔离 | 只传 `payload.text`;附件留 `[附件: 文件名]`;信封非 text 字段不带 |
| AI 引用 | `msg_id`(数字);标签 `<message='...'>`/`<user='...'>` 白名单 + 模糊匹配 |
| 命令系统 | 后端 CommandRegistry 全局注册表;B Bot 路径与用户路径双调用;不双回复;`/whoami` `/roll` 保持 Bot-only |
| 知识库 | `knowledge` 表;`UNIQUE(chat_id, date)` 去重替换;结构化条目(title/summary/tags/msg_count/source) |
| 入库触发 | 手动 `/summarize` 可选入库 + 每日自动总结(每会话独立配置:开关/时间/窗口/入库) |
| /ask | 关键词/标签检索 Top-N(默认 5)+ LLM 回答;全局默认,可切会话 |
| 新人引导 | 新成员入群 → 近 N 条知识条目(默认 3)生成群概要;有 Bot 由 Bot 发,无 Bot 系统身份发;与既有欢迎语并存 |
| LLM 配置 | 共享智能配置(本地/API 双来源,主题总结与知识库共用同一套引擎与队列) |
| 智能中心 | rail 入口 → 四 Tab:知识库 / 主题总结 / 自动总结配置 / 智能设置 |
| 持久化 | 偏好→localStorage(`peyt.summary.*`);引擎状态+摘要缓存→`app-data/summary_state.json`;API 凭据→后端设置表;知识条目→knowledge 表 |

## 3. 架构总览

```
┌─ 前端 (webview) ──────────────────────────────────────────────────┐
│  智能中心页(intelligencePage.ts,四 Tab):知识库/主题总结/自动总结配置/智能设置 │
│  聊天流:用户发 /ask /summarize → 进聊天流(与 Bot 行为一致,其他成员可见)    │
│  气泡状态机(idle/summarizing/done/error/fallback)+ 详情看板            │
│  设置页「智能」区 → 跳转智能中心 Tab4(单一配置界面)                     │
└──────────────┬──────────────────────────────────────────────────────┘
               │ invoke(界面命令) / send_text(命令消息) / events(summary-event)
┌─ Rust 后端 ──▼─────────────────────────────────────────────────────┐
│  CommandRegistry(统一命令注册表,全局单例)                             │
│   ├─ Bot 路径:rule.rs 调注册表 handler(带 BotRuntime)                │
│   └─ 用户路径:SystemCommandProcessor 监听新消息事件,系统身份回复        │
│  KnowledgeStore(knowledge 表 CRUD + 去重替换)                       │
│  SummarizePipeline(手动入库 / 每日自动,共享智能运行时)                │
│  AskEngine(检索 Top-N + LlmClient 回答)                             │
│  OnboardService(新人入群 → 知识条目生成群概要)                        │
│  SummaryQueue(本地串行 + API 并发;每 chat 每 lane 保留最新)          │
│  LocalRunner(llama-server 子进程)/ ApiRunner(LlmClient)             │
│  Downloader(引擎 + 模型下载,进度事件,断点续传,sha256)                │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计点**

1. 窗口由前端决定、后端只推理(主题总结);知识库窗口由后端构造(无前端持有消息的场景不同——知识库后端读 core 历史,与 Bot 的 build_history 一致)。
2. 后端队列 = 本地串行 + API 并发;主题总结与知识库**共用同一队列**与引擎生命周期(空闲 10 分钟 kill,懒启动)。
3. 引擎 + 模型一键下载,不进安装包;零重编译负担(tokio Command + reqwest 已有)。
4. 命令注册表 = 单层解析 + 双调用路径,不新增消息通道。

## 4. 统一命令系统(新增)

### 4.1 CommandRegistry

```rust
// src-tauri/src/commands/core.rs(新)或 src-tauri/src/commands/registry.rs(新)
pub struct CommandRegistry { /* 进程级单例,OnceLock */ }

pub enum CommandScope { Bot, User, Both }

pub struct CommandSpec {
    pub name: &'static str,          // "summarize" / "ask" / "whoami" / "roll"
    pub aliases: &'static [&'static str],
    pub scope: CommandScope,
    pub description: &'static str,
    pub handler: CommandHandler,     // 见下
}

// 统一 handler 签名(两路径共用;上下文不同,用 trait object 或 enum 区分)
pub type CommandHandler = fn(&CommandCtx) -> BoxFuture<'static, AppResult<CommandReply>>;

pub struct CommandCtx<'a> {
    pub kind: CommandKind,           // Bot(BotRuntime) | System(仅 chat_id)
    pub chat_id: u32,
    pub msg_id: u32,
    pub args: Vec<String>,           // 解析后的参数
    pub raw: String,                 // 原文
}

pub enum CommandReply { Text(String), Texts(Vec<String>) }
```

- 注册:进程启动时(装配处)注册 `summarize`、`ask`、`whoami`、`roll`。
- `parse(text) -> Option<CommandInvocation>`:统一解析层(trim → 首个 `/` → 命令名 + 参数按空白分割;支持引号内参数;未知命令返回 `Some(UnknownCommand)` 由调用方提示)。
- 迁入 rule.rs 现有命令:`whoami`(scope=Bot)、`roll`(scope=Bot)把逻辑从 rule.rs 搬到注册表 handler;rule.rs 保留欢迎语/关键词/兜底逻辑,指令分支改调注册表。

### 4.2 双调用路径

| 路径 | 触发 | 处理 | 回复 |
|---|---|---|---|
| Bot 路径 | Bot 收到消息,rule.rs 判定指令 | rule.rs 调 `registry.handle_bot(name, args, &BotRuntime)` | Bot 消息回复(现状) |
| 用户路径 | 新消息事件(同挂点,无 Bot 时) | `SystemCommandProcessor` 识别用户命令 → 调 `registry.handle_system(...)` | 系统身份回复(进聊天流) |

### 4.3 不双回复规则

- 会话**有 Bot 且该 Bot 配置完整**(LLM 配置齐):Bot 路径优先,系统处理器跳过该命令。
- 会话无 Bot 或 Bot 未配置 LLM:系统处理器接管。
- 判定:`bot 已配置且 llm 完整 && 命令 scope 含 Bot` → Bot 处理;否则若 scope 含 User → 系统处理;否则回复「该命令仅 Bot 可用」。
- 实现:系统处理器在命令执行前查该 chat 是否有 running bot(复用 `list_all_running_bots` / db 查询)。

### 4.4 命令清单

| 命令 | scope | 行为 |
|---|---|---|
| `/summarize [N] [save]` | Both | 总结最近 N 条(默认 30,上限 200);`save` 后缀 → 入库(见 §5.2)。无 LLM → 「LLM 未配置」 |
| `/ask <问题>` | Both | 知识库检索 + LLM 回答(§5.4) |
| `/whoami` | Bot | 身份 + 工作区(从 rule.rs 迁入) |
| `/roll <N>` | Bot | 随机数(从 rule.rs 迁入) |
| 未知命令 | — | 「未知命令,发送 /help 查看可用命令」 |

### 4.5 系统身份回复

- 系统处理器生成回复:调 `send_text(chat_id, text)`,与 Bot 回复同一通道,以「系统」命名(可配,默认显示「系统」);无 Bot 的会话成员可见回复。
- 记录:写入 bot activity?不——系统回复不走 bot activity(无 bot 归属);加轻量日志。

## 5. 知识库(D3 核心)

### 5.1 数据模型

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,               -- 'YYYY-MM-DD',去重键
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,               -- 结构化要点正文
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON 数组(LLM 提取 + 用户可编辑)
  msg_count   INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'daily'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(chat_id, date)
);
```

Db 方法:`list_knowledge(filter 会话/标签/关键字/日期范围, 分页)`、`get_knowledge(id)`、`upsert_knowledge(chat_id, date, title, summary, tags, msg_count, source)`(UNIQUE 冲突 → 更新现有行,保留 id)、`delete_knowledge(id)`、`count_knowledge(chat_id)`。

DTO:`KnowledgeDto { id, chat_id, chat_name, date, title, summary, tags: Vec<String>, msg_count, source, created_at, updated_at }`(chat_name 联查,不存在时显示 chat_id)。

### 5.2 入库流程(手动 + 每日自动共用)

```
窗口消息(后端读 core 历史,复用 build_history_n;自动任务按窗口配置)
→ LLM 生成 {title, summary(结构化要点), tags}(JSON 输出,「只输出 JSON」约束)
→ upsert_knowledge(chat_id, date=today 或配置日期)
→ 手动:回复「已存入知识库:<title>」
→ 每日自动:静默,记日志
```

- 手动 `/summarize save`:现有 `/summarize` 逻辑 + save 后缀触发入库(同一次 LLM 调用,输出两段:回复文本 + JSON 知识载荷——用分隔符约束,或两次调用。**推荐一次调用**:prompt 要求输出 `摘要文本` + `===KNOWLEDGE===` + JSON,后端按标记切分;简化则两次调用(先总结后入库),实施时定,倾向一次调用)。
- 每日自动:`Scheduler`(复用现有调度)每会话独立:开关/时间(HH:MM)/窗口(最近 N 条,10-200,默认 100)/自动入库(默认 on)。到点取最近 N 条(截止当前)总结入库。
- 日期语义:`date` = 总结覆盖的日期(每日自动 = 触发当日;手动 = 当日)。同会话同日再总结 → 替换。

### 5.3 每会话配置

新增表(或并入 bot 配置?不——知识库独立于 Bot,无 Bot 会话也需配置):

```sql
CREATE TABLE IF NOT EXISTS knowledge_config (
  chat_id     INTEGER PRIMARY KEY,
  daily_enabled   INTEGER NOT NULL DEFAULT 0,
  daily_time      TEXT NOT NULL DEFAULT '00:00',
  window_count    INTEGER NOT NULL DEFAULT 100,
  auto_store      INTEGER NOT NULL DEFAULT 1,
  daily_run_date  TEXT,                    -- 当日已执行标记 'YYYY-MM-DD'(NULL=当日未跑)
  updated_at      INTEGER NOT NULL
);
```

Db:`get_knowledge_config(chat_id)` / `set_knowledge_config(chat_id, ...)`。
调度:在现有 Bot tick 循环(运行时 tick,已存在)中**并行挂一个独立的每日扫描器**(与 Bot 无关):每 tick 检查启用项是否到点(当前 HH:MM 已过且当日未执行——用 `knowledge_config.daily_run_date` 记当日已跑,避免重复),到点触发总结入库。与 Bot 调度完全解耦,无 Bot 会话同样生效。

### 5.4 /ask 问答(AskEngine)

```
解析问题 → 检索:SELECT * FROM knowledge
  WHERE (:chat_id IS NULL OR chat_id = :chat_id)
  AND (title LIKE ? OR summary LIKE ? OR tags LIKE ?)   -- 问题分词后的关键词 OR 匹配
  按 msg_count 降序(或 updated_at 降序)取 Top-N(默认 5,可配)
→ 无条目 → 「知识库暂无相关内容,可发送 /summarize 或 /summarize save 存入总结」
→ 有条目 → 组装 LLM 上下文:候选条目(title+summary+会话名+日期,加分隔)
  + 问题 → LlmClient 回答(纯文本补全,共享智能运行时)
→ 回复进聊天流
```

- 关键词分词:简单按空白 + 中文子串(标题/摘要包含即命中),不做复杂分词;标签命中(tags LIKE)。
- 检索范围:默认全局(所有会话);`/ask --chat <chat_id>` 或设置默认会话(可选,先做全局)。
- LLM 不可用(未配置/引擎未就绪)→ 直接返回候选条目文本列表(降级,仍有用)。

### 5.5 新人引导(OnboardService)

```
新成员入群事件(复用现有群成员变更监听,若有;无则加监听)
→ 查 knowledge WHERE chat_id=该群 ORDER BY updated_at DESC LIMIT N(默认 3)
→ 有条目:LLM 汇总生成「群概要」(主题/常用约定/待办),发送
→ 无条目:发送「欢迎新人!可发送 /ask <问题> 提问,或 /summarize save 将讨论存入知识库」
→ 发送目标:群内 @新人(默认)/ 私聊(配置项)
→ 有 Bot:由 Bot 回复(欢迎语之后追加概要,不冲突);无 Bot:系统身份发送
```

配置项:开关(默认 on)、目标(群内@ / 私聊,默认群内@)、条目数(默认 3)、群概要长度(默认 300 字)。

## 6. LLM 主题总结(整合 `2026-08-05-llm-topic-summary-design.md`,实施以其为准)

本节只列与合并相关的要点与差异,细节见原 spec:

- 双车道:bubble(一句话 ≤60 字,高优先抢占)/ detail(看板 7 类分析,每类独立请求独立状态)。
- 分析类型注册表:`AnalysisKind = summary|participation|action_items|resources|open_questions|timeline|decisions`;引擎三种:`llm|local_stats|stats_plus_llm`;participation 用 stats_plus_llm(前端统计 0 token + LLM 解读)。
- 看板(巨大 dashboard):区块平铺,独立 streaming/刷新;summary 顶部 → decisions 底部。
- 标签解析:`escapeHtml` 先行 + 白名单 `<message>`/`<user>` 解包;`<message>` 精确 id → 模糊匹配 → Top3 popup → 跳转滚动高亮。
- 气泡状态机:前端纯状态机,事件驱动(`summary-event`);`done→summarizing` 旧摘要保留不闪空;`cancelled` 静默。
- 错误码:engine_not_ready/engine_start_failed/engine_timeout/engine_crash/api_auth/api_quota/api_rate_limit/api_bad_request/api_network/window_empty/cancelled。
- 降级链:LLM done → 失败 → 词频聚类(fallback)→ 失败 → 隐藏气泡。
- 下载器:llama.cpp GitHub releases(锁 tag b10276,CPU 产物)+ GGUF(ModelScope 优先/HF 兜底);落地 `app-data/models/`;post-process 跨端收一个函数(Windows 解压 zip / macOS xattr 去隔离 / Linux chmod +x)。
- 引擎生命周期:空闲 10 分钟 kill;懒启动 /health 检查;崩溃自愈重启一次。
- 超时:bubble 60s / detail 120s。
- **与知识库共享**:SummaryQueue(同一队列)、智能设置(同一份)、llama-server 进程(同一实例)、错误码表(同一套)。

## 7. 智能中心聚合页(前端新增)

### 7.1 入口与布局

- rail(navPanel.ts)新增「智能」入口(sparkles 图标,与 inbox/work/github 平级)。
- `src/pages/intelligencePage.ts` 新建:复用 GitHubPage 式布局(玻璃工具栏 + Tab 导航 + 内容区)。

### 7.2 四 Tab

| Tab | 内容 | 数据来源(界面命令) |
|---|---|---|
| **知识库** | 条目列表(按会话/日期/标签过滤 + 搜索)+ 条目详情(标题/摘要/标签可编辑/删除)+ 手动「总结本会话入库」按钮(选会话 → 立即总结入库) | list_knowledge / get_knowledge / delete_knowledge / update_knowledge(标签编辑用 upsert?新增 update_knowledge 命令) / summarize_store_now(选会话立即总结入库) |
| **主题总结** | 各会话气泡摘要状态列表 + 点击打开详情看板 | summary 状态经 summary-event;看板渲染复用聊天弹窗看板组件 |
| **自动总结配置** | 会话列表 + 每会话:开关/时间/窗口条数/自动入库 | list_knowledge_config / set_knowledge_config |
| **智能设置** | 复用主题总结 spec §8:模式开关(off/词频/LLM)/来源(本地/API)/模型档位(0.5B/1.5B)/下载按钮+进度/API 配置(base_url/api_key/model/测试)/上下文条数 N | get_llm_model_status / 下载事件 / test_llm_config / API 配置命令 |

### 7.3 设置页关系

- settingsPage.ts 的「智能」section:保留入口,点击跳转智能中心 Tab4;智能中心为唯一配置界面(不做双份表单)。

### 7.4 聊天流联动

- 用户侧 `/ask` `/summarize` 命令仍进聊天流(§4);聊天中气泡/看板行为不变(主题总结 spec)。

## 8. 界面命令清单(commands.rs 新增,全部非 Bot 特定)

| 命令 | 入参 | 返回 |
|---|---|---|
| `list_knowledge` | `chatId?`, `tag?`, `keyword?`, `dateFrom?`, `dateTo?`, `page?`, `pageSize?` | `Vec<KnowledgeDto>`(分页) |
| `get_knowledge` | `id` | `KnowledgeDto` |
| `delete_knowledge` | `id` | `()` |
| `update_knowledge` | `id`, `title?`, `summary?`, `tags?` | `KnowledgeDto` |
| `summarize_store_now` | `chatId`, `count?` | `KnowledgeDto`(立即总结入库,返回新/更新条目) |
| `list_knowledge_config` | — | `Vec<KnowledgeConfigDto>`(全部会话) |
| `set_knowledge_config` | `chatId`, `dailyEnabled`, `dailyTime`, `windowCount`, `autoStore` | `KnowledgeConfigDto` |
| `list_chats_for_knowledge` | — | 可配置会话列表(复用现有 get_chatlist 即可,不新增) |
| 智能设置命令 | 见主题总结 spec §8(引擎状态/下载/API 配置/测试) | — |

DTO:`KnowledgeDto`、`KnowledgeConfigDto { chat_id, chat_name, daily_enabled, daily_time, window_count, auto_store }`。

## 9. 数据层汇总

- 新表:`knowledge`、`knowledge_config`(§5.1/5.3);API 凭据→现有设置表模式(github_settings 同款 `intelligence_settings` 或复用,实施时定,倾向独立表 `intelligence_settings(id=1, base_url, api_key, model, mode, source, model_tier, window_n)`——**一份智能设置,主题总结与知识库共用**)。
- 既有不动:github_settings/github_repos/bot 系列表。
- `app-data/summary_state.json`:引擎/模型状态 + 版本 + sha256 + 摘要缓存(后端读写,主题总结 spec §8.4)。

## 10. 错误处理

- 共享错误码表(§6),知识库复用:`llm_not_configured`(提示去智能设置)、`engine_not_ready`(降级词频/返回检索结果)、`no_knowledge`(知识库空提示)。
- 每日自动失败:记日志,次日再触发;不静默吞掉(日志可查)。
- 命令层:未知命令提示、scope 不符提示、参数非法(复用 parse_summarize 语义,默认值兜底)。
- 不双回复:系统处理器跳过规则(§4.3),防止 Bot 与系统同时回复。

## 11. 测试

### Rust(cargo test --lib)

| 测什么 | 断言 |
|---|---|
| 命令解析 | /cmd、/cmd arg1 arg2、引号参数、未知命令、/ask 多词参数 |
| scope 限制 | whoami/roll 在系统路径 → 「仅 Bot 可用」 |
| 不双回复判定 | 有完整 Bot → 系统跳过;无 → 系统接管 |
| knowledge upsert | 同 (chat_id,date) 更新保留 id;新插入;标签 JSON 往返 |
| 检索 | 关键词命中/标签命中/Top-N/空库/会话过滤 |
| 总结载荷切分 | 「===KNOWLEDGE===」标记解析(若采用单次调用) |
| summarize_store_now | 窗口构造、入库返回 |
| 调度 | 每日任务到点触发、窗口截断 |
| 主题总结(原 spec §11) | 窗口序列化/SSE 解析/标签白名单/队列信号量 |

### 前端(Vitest,src/ 侧)

| 测什么 | 断言 |
|---|---|
| tagParser | 合法/非法/转义/嵌套 |
| 模糊匹配 | 精确/多结果/0 条 |
| 气泡状态机 | 状态转移/降级路径 |
| 智能中心 Tab | 渲染/切换/知识库条目操作调用正确命令 |

### 手动(tauri dev)

- 下载流程、首次总结流式、popup 看板、降级链、跨端冒烟(原 spec §11)。
- /ask 有条目/无条目;每日自动到点入库;新人入群引导(群内@/私聊);命令不双回复;智能中心四 Tab。

## 12. 明确不做(本期)

- 向量检索、知识条目跨设备同步、LLM 语义去重合并、用户侧 whoami/roll。
- 不内置 Ollama、不做引擎自动更新检查、不做附件正文进上下文、不做增量窗口(after_id)。

## 13. 文件边界与并行策略

另一前端 agent 并行开发;本实现按文件边界隔离,冲突点集中在共享文件,规则:

- `src/shell/navPanel.ts`(rail 入口):**双方都可能加入口**——本实现以「追加不删除」为原则,提交前检查是否存在冲突并合并。
- `src/pages/intelligencePage.ts`(新文件)、`src/components/wordCloud.ts`、`src/utils/wordAnalysis.ts`:本实现独占(新增/扩展)。
- `src/chat/chatView.ts`:主题总结气泡挂载点;若对方已改,实施时先 git pull 再合。
- `src-tauri/**`:本实现独占(对方为前端 agent)。
- 提交策略:小步提交,每完成一个任务即 commit,直接 push main;push 前 `git pull --rebase` 处理对方冲突。

## 14. 改动文件清单

- 新增:`src-tauri/src/commands/registry.rs`(命令注册表)、`src-tauri/src/knowledge/{mod,store,pipeline,ask,onboard}.rs`、`src-tauri/src/intelligence/{mod,settings}.rs`(智能设置,若独立)、`src/pages/intelligencePage.ts`、`src/utils/tagParser.ts`(若前端侧,见原 spec)、`src/components/summaryDashboard.ts`(看板组件)。
- 修改:`commands.rs`(知识库/智能设置/主题总结命令 + 注册)、`dto.rs`(KnowledgeDto/KnowledgeConfigDto/智能设置 DTO)、`db.rs`(knowledge/knowledge_config 表 + 方法)、`error.rs`(智能错误变体)、`state.rs`/`lib.rs`(装配注册表 + 系统处理器 + 新命令 + 智能运行时)、`drivers/rule.rs`(指令分支迁入注册表)、`src/shell/navPanel.ts`(智能入口)、`src/settingsPage.ts`(智能区跳转)、`src/chat/chatView.ts`(气泡挂载)、`src/plugins/api.ts`(类型契约)、`docs/api-spec.md`。
- 实施引据:`2026-08-05-llm-topic-summary-design.md`(主题总结细节)。

## 15. 变更记录

- 2026-08-05 初稿。brainstorming 确认:完整版知识库(入库+问答+新人引导)、手动+每日自动入库、每会话独立配置、独立知识存储(与主题总结功能独立)、统一命令系统(后端注册表 + 系统命令处理器 + 不双回复)、命令进聊天流、结构化条目+全局检索、按会话+日期去重、共享智能配置、智能中心四 Tab 聚合页、合并实施、直接 main 开发、与并行前端 agent 以文件边界隔离。
