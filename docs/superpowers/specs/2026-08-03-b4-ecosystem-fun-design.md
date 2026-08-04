# Bot 系统大扩展 · 子项目 B4：生态与玩法(人设模板库 + Bot 间互动 + 统计 + 彩蛋) 设计文档

> **定位**: 在 B2/B3 之上补齐"好玩"与"可观测统计"维度:人设模板一键套用、Bot 间互动(带防死循环轮数上限)、活动统计、彩蛋指令。
>
> **前置决策**(brainstorming 确认): 人设模板库、Bot 间互动、统计、彩蛋全部要做。

## 1. 范围

**做**: 人设模板库(8 套)+ `list_bot_personas`/`apply_bot_persona`、Bot 间互动开关 + 轮数上限、`get_bot_stats` 统计、彩蛋指令。
**不做(B5+)**: 管理中心 UI 展示、时间线页。

## 2. 人设模板库(personas.rs)

```rust
pub struct PersonaDef {
    pub id: String,           // "assistant"|"sarcastic"|"translator"|"programmer"|"therapist"|"jokester"|"night_radio"|"weather_host"
    pub name: String,         // 中文名
    pub description: String,  // 一句话说明
    pub system_prompt: String,
}

pub const PERSONAS: &[PersonaDef] = &[ ... 8 套 ... ];

pub fn find_persona(id: &str) -> Option<&'static PersonaDef>;
```

8 套人设(系统提示词要有鲜明风格,含 emoji 使用指令):
1. `assistant` 贴心助手:温和、简洁、结构化,少量使用 ✅/⭐
2. `sarcastic` 毒舌吐槽:幽默毒舌、爱抬杠、口嫌体正直,多用 😏
3. `translator` 翻译官:自动中英互译,保留语气,每次给原文+译文
4. `programmer` 程序员:代码感、技术梗、给示例代码,爱用 ` 反引号
5. `therapist` 心理咨询师:共情、引导式提问、不评判,语速慢
6. `jokester` 冷笑话王:优先讲冷笑话,冷到不行
7. `night_radio` 深夜电台:慵懒温柔 DJ 腔,聊人生
8. `weather_host` 天气主播:热情播报风,爱用 ☀️/🌧️/🌪️

## 3. 命令(commands.rs,owner 校验)

| 命令 | 入参 | 返回 |
|---|---|---|
| `list_bot_personas` | 无 | `Vec<PersonaDto>`(id/name/description;不含 system_prompt,避免泄露内部 prompt) |
| `apply_bot_persona` | `botId: i64, personaId: String` | `BotDto` |

`apply_bot_persona` 语义:
- `config = get_config(owner, bot_id).unwrap_or_default()`
- `config.persona = Some(persona_id)`
- `config.llm.get_or_insert_with(LlmConfig::default…)` → 若无 llm 配置则 `LlmConfig::from(LlmConfigInput{..Default})`(缺省参数自动补全,provider 默认 openai)
- `config.llm.system_prompt = persona.system_prompt`
- `save_config` → 返回最新 `BotDto`

## 4. Bot 间互动(runtime.rs)

- 现有"发送者是 Bot 一律跳过"改为条件:
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
- `bot_rounds: Arc<Mutex<HashMap<(u32, u32), u32>>>`(bot 账号 id, chat) → 轮数,放 `runtime::spawn` 内创建,传入 `handle_bot_message`。
- 每次 Bot 收到 Bot 消息时该 (bot,chat) 轮数 +1;非 Bot 消息清空该 chat 全部计数;限制 Bot 间对话最多 max 轮后停止,防死循环。

## 5. 统计(db.rs + commands.rs)

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

## 6. 彩蛋指令(drivers/rule.rs,随 B3 一并落地,这里定义行为)

规则驱动指令处理扩展(文本以 `/` 开头):
| 指令 | 行为 |
|---|---|
| `/roll [N]` | 1..N 随机(默认 100),如 `🎲 你掷出了 42 (1-100)` |
| `/dice` | 1..6,如 `🎲 骰子: 4` |
| `/coin` | `🪙 正面` / `🪙 反面` |
| `/8ball` | 随机回答:`🎱 是的` / `不太可能` / `问问你的内心` 等 10 条 |
| `/whoami` | 返回 bot 身份(display_name + 邮箱) |
| `/help` | 列出可用指令 |

- 随机用 `rand` crate(新增依赖,`rand = "0.8"`)或手写 LCG;建议用 `rand`(标准)。
- 记录活动 `RULE_REPLY`。

## 7. 测试验收

### 单元测试
- personas.rs:`PERSONAS.len()==8`、`find_persona` 命中/未命中、每个 persona 有非空 system_prompt。
- runtime.rs:互动轮数逻辑(纯函数 `fn interaction_allowed(rounds, max) -> bool` 或把计数逻辑抽小函数单测)。
- db.rs:`get_bot_stats` 对空/有记录 bot 聚合正确。
- rule.rs:彩蛋指令 `/roll 10` 结果 ∈ 1..10、`/coin` ∈ {正面,反面}、`/8ball` ∈ 预设集、`/whoami` 含 bot 名。
- 既有测试不回归。

### 编译/手动
- [ ] `cargo build`/`cargo test --lib` 通过;`npx tsc --noEmit` 干净
- [ ] 手动:`apply_bot_persona('jokester')` → Bot 回复变冷笑话风;`/roll 100` → 随机数;`/whoami` → 身份
- [ ] `allow_bot_interaction=true` → 两个 Bot 能对话,但 3 轮后停;`false` → 依旧互不回复
- [ ] `get_bot_stats` 返回真实计数

## 8. 改动文件

- 新增:`src-tauri/src/personas.rs`
- 修改:`dto.rs`(若需 PersonaDto/BotStatsDto)、`db.rs`(统计 SQL)、`runtime.rs`(互动计数)、`drivers/rule.rs`(彩蛋)、`commands.rs`、`bots.rs`(若 apply 复用 config 读写)、`lib.rs`、`Cargo.toml`(加 `rand`)
