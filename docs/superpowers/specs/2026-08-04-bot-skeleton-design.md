# Bot 系统骨架扩展 · B3 收尾 + B4 + B5 设计文档

> **定位**: 补齐 Bot 系统大扩展的骨架缺口(B3 规则驱动/tick 循环/命令、B4 人设/互动/统计、B5 管理中心 UI),并为后续「开发者智能伙伴」愿景(D1 GitHub 集成 / D2 项目理解与代码分析 / D3 知识沉淀 / D4 社区 AI 体验)预留项目上下文地基。
>
> **前置决策**(brainstorming 确认):
> - 本次聚焦骨架;其余四块写概念级路线图保留
> - 人设库面向开发者(程序员/代码审查官/技术文档写手等 8 套)
> - 规则驱动:关键词/正则 + 开发者指令(/summarize /whoami /help + 通用彩蛋)
> - 管理中心:完整 B5(多 Tab + 打字指示器 + 状态徽标 + 插件 registerTool + api-spec 收口)
> - tick:消息循环内 30s tick 循环
> - 预留项目上下文(ProjectContext 配置 + 基础注入,不做向量检索)
> - 落地方式:方案 A 纵向分批次(此 spec 合并三批为一份,实施时按后端→前端顺序)

## 1. 当前实现状态与缺口

已实现(B1/B2/B3 部分):
- 多驱动框架 `BotDriver` trait + `DriverRegistry`(drivers/mod.rs)
- LLM 驱动多 Provider + 工具循环 + `split_reply`(drivers/llm.rs)
- 工具基建:ToolRegistry/ToolBridge/内置工具(时间/计算/换算)/联网/文件/插件(tools/)
- 定时驱动 `ScheduleDriver` + `next_cron` 纯函数 + `bot_schedules` 表(drivers/schedule.rs)
- 活动日志 `bot_activities` 表 + `bot-activity` 实时事件(activity.rs)
- `BotConfig`/`LlmConfig`/`BotLimits` 结构化 + 旧 config_json 迁移(dto.rs)

缺口(本次补齐):
- `RuleDriver`(drivers/rule.rs)完全未实现
- `runtime::spawn` 只有消息循环,无 tick 循环 → `ScheduleDriver` 已实现但从未被调用
- lib.rs 只注册了 `LlmDriver`,未注册 `ScheduleDriver`(和未来的 RuleDriver)
- B3 命令(register_bot_tool/unregister_bot_tool/list_bot_tools/bot_tool_result/bot_list_schedules/bot_add_schedule/bot_delete_schedule)未实现未注册
- B4(人设库/互动/统计/开发者指令)未实现
- B5(管理中心 UI/list_bot_activities/插件 registerTool/api-spec)未实现
- api-spec.md 无 Bot 系统章节

## 2. B3 收尾

### 2.1 RuleDriver(drivers/rule.rs)

处理进站消息,优先级从高到低,不消耗 LLM(除 /summarize):

1. **开发者指令**(文本以 `/` 开头):
   - `/summarize [N]`:总结本会话最近 N 条消息(默认 30),走 LLM 生成总结(复用 LLM 驱动管线)
   - `/whoami`:返回 Bot 身份(display_name + 邮箱 + 所属工作区/角色,来自 project_context)
   - `/help`:列出可用指令
   - 通用彩蛋:`/dice`(1..6)、`/roll [N]`(默认 100)、`/coin`、`/8ball`(预设回答集)
2. **欢迎语**:该 (bot, chat) 首次收到消息且配置 `config.rule.welcome` → 返回欢迎语。用 `seen: StdMutex<HashSet<(i64, u32)>>` 去重,只发一次(无论 welcome 是否为空都记 seen)
3. **关键词/正则规则**:`config.rule.rules` 中 enabled 项;`is_regex=false` 用忽略大小写 `contains`;`is_regex=true` 用 `regex::Regex`;命中取 `replies` 随机一条
4. **兜底**:`config.rule.fallback` 有值 → 返回兜底
5. 以上未命中 → `Ok(vec![])`(交给 LLM 驱动)

记录活动 `RULE_REPLY`。随机用 `rand` crate。

`/summarize` 走 LLM 的实现方式:RuleDriver 持有 `Option<Arc<LlmClient>>` 与 `ToolRegistry`,复用 drivers/llm.rs 的上下文构建/拆分为「从该 chat 拉最近 N 条消息文本 → 拼 system prompt → llm.complete → split_reply」。失败时返回友好错误文本。

### 2.2 runtime tick 循环(runtime.rs)

```
spawn():
  let (msg_loop, tick_loop) = tokio::join!(消息循环, tick循环);
tick循环(30s tokio interval):
  for row in db.list_all_running_bots():
    构建 BotRuntime → 逐个 driver.on_tick()
    收集 ScheduledSend → chat::send_msg → 记录 SCHEDULE_SENT
```

- 每个 bot tick 独立 spawn + 错误隔离(catch-all),单个失败只记活动不中断
- `ScheduleDriver` 的 on_tick 逻辑已实现(查 due、发消息、重算 next_run、一次性删除),只需接入循环
- tick 与消息循环并行

### 2.3 B3 命令(commands.rs,全部 owner 校验)

| 命令 | 入参 | 返回 |
|---|---|---|
| `register_bot_tool` | `name: String, description: String, parameters: Value` | `()` |
| `unregister_bot_tool` | `name: String` | `()` |
| `list_bot_tools` | — | `Vec<{name, description, safe}>`(插件工具 + 内置工具名) |
| `bot_tool_result` | `id: String, result: String` | `()`(bridge.resolve 回填) |
| `bot_list_schedules` | `botId: i64` | `Vec<ScheduleDto>` |
| `bot_add_schedule` | `botId: i64, chatId: u32, minute: i32, hour: i32, dayOfWeek: i32, message: String` | `ScheduleDto` |
| `bot_delete_schedule` | `scheduleId: i64` | `()` |

`register_bot_tool` 后热刷新运行时 `ToolRegistry.reload_plugin_tools()`(从 db 全量重读)。

`ScheduleDto { id, bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at }`。

新增依赖:`regex`、`rand`。

## 3. B4:人设库 + 互动 + 统计

### 3.1 开发者向人设库(personas.rs)

```rust
pub struct PersonaDef {
    pub id: String,
    pub name: String,         // 中文名
    pub description: String,  // 一句话说明
    pub system_prompt: String,
}
pub const PERSONAS: &[PersonaDef] = &[ /* 8 套 */ ];
pub fn find_persona(id: &str) -> Option<&'static PersonaDef>;
```

8 套(开发者向,含 emoji 使用指令,贴合开发者社区愿景):

1. `programmer` 程序员:代码感、给示例代码、技术梗,爱用反引号
2. `code_reviewer` 代码审查官:指出问题、给改进建议、安全提示
3. `tech_writer` 技术文档写手:生成 README/API 文档、结构化输出
4. `pair_programmer` 结对编程搭档:引导式思考、共同调试
5. `tech_lead` 技术负责人:方案权衡、决策辅助、任务拆分
6. `architect` 架构顾问:系统设计、权衡分析
7. `debugger` Debug 专家:系统化排查、复现步骤、二分定位
8. `onboarding_mentor` 新人引导师:帮助理解项目、耐心解释

### 3.2 命令(commands.rs,owner 校验)

| 命令 | 入参 | 返回 |
|---|---|---|
| `list_bot_personas` | — | `Vec<PersonaDto>`(id/name/description;不含 system_prompt,避免泄露内部 prompt) |
| `apply_bot_persona` | `botId: i64, personaId: String` | `BotDto` |

`apply_bot_persona` 语义:
- `config = get_config(owner, bot_id).unwrap_or_default()`
- `config.persona = Some(persona_id)`
- `config.llm.get_or_insert_with(...)`(无则建默认,缺省参数自动补全)
- `config.llm.system_prompt = persona.system_prompt`
- `save_config` → 返回最新 `BotDto`

### 3.3 Bot 间互动(runtime.rs)

现状:发送者是 Bot 一律跳过。改为:

```rust
if is_bot_addr(&from_addr, &bot_addrs) {
    if !config.limits.allow_bot_interaction {
        record REPLY_SKIPPED("发送者是另一个 Bot"); return;
    }
    let max = config.limits.interaction_max_rounds.max(1);
    let rounds = bot_rounds.entry((account_id, chat)).or_insert(0);
    if *rounds >= max { record REPLY_SKIPPED("互动轮数达上限"); return; }
    *rounds += 1;
} else {
    // 非 Bot 消息重置该会话的互动计数
    bot_rounds.retain(|&(_, c), _| c != chat_id.to_u32());
}
```

- `bot_rounds: Arc<Mutex<HashMap<(u32, u32), u32>>>`(bot 账号 id, chat) → 轮数,放 `runtime::spawn` 内创建,传入 `handle_bot_message`
- 防 Bot 间死循环:最多 max 轮后停止;非 Bot 消息清空该 chat 计数

### 3.4 统计(db.rs + commands.rs)

```rust
pub struct BotStatsDto {
    pub total_activities: i64,
    pub reply_sent: i64,
    pub rule_reply: i64,
    pub schedule_sent: i64,
    pub tool_called: i64,
    pub llm_error: i64,
    pub rate_limited: i64,
    pub last_activity_at: Option<i64>,
    pub first_seen_at: Option<i64>,
}
```
`db.get_bot_stats(bot_id) -> AppResult<BotStatsDto>`:单条 SQL 按 kind 聚合 `COUNT(*)` + `MAX(created_at)` + `MIN(created_at)`。
命令:`get_bot_stats(botId: i64) -> BotStatsDto`(owner 校验)。

## 4. 项目上下文预留

`BotConfig` 新增(serde default,向后兼容):

```rust
pub struct ProjectContext {
    pub workspace_id: Option<i64>,
    pub chat_ids: Vec<u32>,          // 关联频道
    pub description: Option<String>, // 项目一句话描述
    pub repo_path: Option<String>,   // 预留:Git 仓库路径(后续块用)
}
// BotConfig 追加:
//   pub rule: Option<RuleConfig>,
//   pub tools: Option<Vec<String>>,      // None = 默认安全工具集;显式启用列表
//   pub persona: Option<String>,
//   pub project_context: Option<ProjectContext>,
```

- **LLM 驱动**:`project_context.description` 存在 → 拼入 system prompt;关联 `chat_ids` → 注入这些频道最近 N 条消息摘要作为对话背景(基础版,不做向量检索)
- **B5 LLM Tab**:「项目上下文」配置区(工作区/频道多选 + 项目描述 + 预留 repo_path)
- **`/whoami`**:返回身份 + 工作区/角色(利用 project_context)
- 为后续 D1-D4 块提供地基,本期只做配置 + 基础注入

`RuleConfig`/`RuleDef` 已在 B3 预留(确认存在),补全实现。

## 5. B5:管理中心 UI + 插件 API + api-spec

### 5.1 后端补充(commands.rs)

| 命令 | 入参 | 返回 |
|---|---|---|
| `list_bot_activities` | `botId: i64, limit?: i64`(默认 50) | `Vec<BotActivityDto>`(倒序) |

### 5.2 botsPage.ts 重构

```
renderBots(main)              列表态(保留现有,加强徽标)
  每行:头像 / 名称+邮箱 / 状态徽标(运行中·已停止·思考中)/
       已配 LLM·规则·定时·人设徽标 + 配置/启停/删除
  点击行 → renderBotDetail(bot)

renderBotDetail(bot, main)    详情态(替换主区)
  顶栏:返回 + 头像/名称/邮箱 + 状态徽标 + 人设徽标
  Tab 栏:对话 | LLM | 规则 | 定时 | 工具 | 时间线 | 统计
```

- **对话**:现有双栏(会话列表 + 消息线程 + 输入框)搬入
- **LLM**:Provider 下拉(openai/anthropic/gemini)+ Base URL + API Key(密码框)+ 模型 + 温度滑条(0–2)/max_tokens/top_p + 系统提示词(textarea)+ 项目上下文区(工作区/频道多选 + 项目描述 + repo_path)+「测试连接」;保存 → `update_bot_config`
- **规则**:规则列表(模式/是否正则/回复集合/启用)+ 增删改;欢迎语 textarea;兜底 textarea → `config.rule`
- **定时**:会话下拉(bot_get_chatlist)+ minute/hour/dayOfWeek(-1=任意)+ 消息;列表(下次触发)+ 删除 → `bot_list_schedules`/`bot_add_schedule`/`bot_delete_schedule`
- **工具**:内置工具清单(名/说明/默认开放标记)+ 开关(存 `config.tools`)+ 已注册插件工具
- **时间线**:`list_bot_activities` + 实时 `bot-activity` 追加(仅当前 bot)
- **统计**:`get_bot_stats` 卡片组

### 5.3 打字指示器与状态徽标

前端 `onEvent('bot-activity', ...)`:
- `kind === 'thinking'` → 当前打开的 bot 会话线程顶部显示「正在输入…」
- `kind === 'reply_sent'` → 隐藏 typing;有 chat_id 且在当前线程 → 刷新追加消息
- `kind === 'llm_error'` → 隐藏 typing,toast 提示
- 列表徽标依据 config 存在性 + 最近活动刷新

### 5.4 插件工具前端 API(plugins/api.ts + types.ts)

```ts
registerTool(name: string, description: string, parameters: unknown, handler: (args: any) => Promise<string>): Promise<void>;
unregisterTool(name: string): Promise<void>;
```
- `registerTool` → `call('register_bot_tool', { name, description, parameters })`
- 监听 `bot-tool-request` → 按 payload.name 匹配已注册 handler → await handler(args) → `call('bot_tool_result', { id, result })`;handler 抛错 → 回传「工具执行失败」
- 插件卸载时自动 unregisterTool
- 新权限 `tools`(permissions.ts 新增)

### 5.5 api-spec.md 收口

- §2 新增命令:Bot 系统整段(create/list/delete_bot、set_bot_io、get/update_bot_config、bot_get_chatlist、bot_get_chat_msgs、bot_send_text、bot_mark_chat_*、test_llm_config、add_bot_to_chat、register/unregister_bot_tool、list_bot_tools、bot_tool_result、bot_list/add/delete_schedule、list_bot_personas、apply_bot_persona、get_bot_stats、list_bot_activities)
- §4 事件新增:`bot-activity`(BotActivityDto)、`bot-tool-request`(bridge)
- §5 插件 API 新增:`registerTool/unregisterTool` + 权限 `tools`
- DTO 章节:BotConfig/LlmConfig/BotLimits/RuleConfig/RuleDef/ProjectContext/ScheduleDto/BotStatsDto/PersonaDto/BotActivityDto

## 6. 测试与验收

### 单元测试(cargo test --lib)
- `drivers/rule.rs`:指令匹配(/roll 结果∈范围、/coin∈{正反}、/8ball∈预设、/whoami 含 bot 名)、关键词忽略大小写、正则匹配、随机回复取自列表、优先级(指令>欢迎>规则>兜底)、欢迎只发一次(seen 去重)
- `runtime.rs`:next_cron 既有测试保留、互动轮数计数纯逻辑、tick 循环不 panic(临时账号)
- `personas.rs`:`PERSONAS.len()==8`、`find_persona` 命中/未命中、每个有非空 system_prompt
- `db.rs`:`get_bot_stats` 对空/有记录 bot 聚合正确、schedules CRUD(既有)、plugin tools upsert/delete/list
- `tools/file.rs` 沙箱 resolve_safe(既有)
- B1+B2 既有测试不回归

### 编译/手动
- [ ] `cargo build` / `cargo test --lib` 通过;`npx tsc --noEmit` 干净
- [ ] 关键词规则命中 → 固定回复;首次进群 → 欢迎语一次;无命中 → 兜底;再交给 LLM
- [ ] `/whoami` 返回身份+工作区;`/summarize` 总结最近讨论;`/roll 100` 随机数
- [ ] 定时:设置每天 9 点消息 → 到点自动发;一次性提醒 → 发后自动删除
- [ ] `apply_bot_persona('code_reviewer')` → Bot 回复变审查官风格
- [ ] `allow_bot_interaction=true` → 两 Bot 对话 3 轮后停;false → 依旧互不回复
- [ ] `get_bot_stats` 返回真实计数
- [ ] 管理中心:LLM/规则/定时/工具 Tab 配置生效;时间线实时;打字指示器;统计增长
- [ ] 项目上下文:配 description+频道 → LLM 回复体现上下文
- [ ] 插件 registerTool → Bot 触发 → 前端 handler 返回 → LLM 使用结果
- [ ] 错误路径:Bot 配错 key → 时间线显示 llm_error,无崩溃

## 7. 路线图(其余四块,概念级,后续逐个设计)

| 块 | 定位 | 依赖本骨架 |
|---|---|---|
| D1 GitHub 集成 | 仓库/Issue/PR/Commit/代码变更连接;AI 理解项目环境 | `repo_path` 预留 |
| D2 项目理解与代码分析 | 项目结构、代码分析、Debug 辅助(沙箱/索引) | `project_context` + repo_path |
| D3 知识沉淀 | 讨论总结入库、知识资产、新人引导 | `project_context` + /summarize |
| D4 社区 AI 体验 | 团队信息同步、智能分类、总结推送 | 时间线/统计基础 |

## 8. 改动文件清单

- 新增:`src-tauri/src/drivers/rule.rs`、`src-tauri/src/personas.rs`
- 修改:`dto.rs`(RuleConfig/BotConfig 扩展/ProjectContext/ScheduleDto/BotStatsDto/PersonaDto)、`db.rs`(get_bot_stats、list_all_running_bots)、`commands.rs`(B3/B4/list_bot_activities)、`runtime.rs`(tick 循环 + 互动轮数 + 项目上下文注入)、`lib.rs`(装配驱动 + tick + 新命令注册)、`Cargo.toml`(+regex +rand)
- 前端:`src/pages/botsPage.ts`(重构)、`src/plugins/api.ts`、`src/plugins/types.ts`、`src/plugins/permissions.ts`
- 文档:`docs/api-spec.md`、本设计文档

## 9. 变更记录

- 2026-08-04 初稿。整合 B3 收尾 + B4 + B5 为一份 spec(用户要求合并实施,跳过独立 plan)。将愿景的其余四块列为概念级路线图 D1-D4。
