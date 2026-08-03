# B1 驱动框架 + 运行时健壮性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Bot 系统从单体 LLM 运行时重构为多驱动框架,并加固并发/限流/重试/可观测,为后续子项目(B2 LLM v2、B3 工具/规则、B4 玩法、B5 UI)打地基。

**Architecture:** `BotDriver` trait(驱动 = Bot 的「大脑」) + `DriverRegistry`(注册表) + `runtime.rs` 事件调度器(限流/并发/错误隔离/活动日志为横切关注点,统一在调度器)。驱动只负责「想说什么」,调度器负责「能不能发、怎么发、记什么日志」。配置从扁平的 `LlmConfigInput` 升级为结构化 `BotConfig`(兼容旧 `config_json`)。活动日志落库 `bot_activities` 表并通过 `bot-activity` 事件实时推送。

**Tech Stack:** Rust + Tauri 2 + deltachat core(SQLite、tokio、serde、reqwest、rusqlite),新增 `async-trait`。前端本期零改动。

## Global Constraints

- Rust edition 2021,stable toolchain;不用 nightly 特性。
- 新增依赖仅限 `async-trait = "0.1"`;除 jitter 用系统时钟外不引入随机数库。
- 沿用现有代码风格:模块注释用中文,`Db` 访问一律 `conn.blocking_lock()` 包在 `tokio::task::spawn_blocking` 里。
- 测试沿用现有模式:tempfile 临时目录 + 假账号,不触发真实网络。
- Tauri 命令参数:前端 camelCase ↔ Rust snake_case 自动转换,命令名 snake_case。
- 验证命令:`cargo test --lib <filter>`(首次编译 deltachat core 需 10–30 分钟,属预期);`npx tsc --noEmit`(前端应保持绿)。
- 每个任务结束必须 `cargo test --lib` 通过当前 crate 全部测试(不回归)。
- 删除 `bot_llm.rs` 前先确保其全部功能已迁移(runtime.rs + drivers/)。
- 提交信息遵循仓库风格:中文 + `feat`/`refactor`/`test` 前缀。

---

### Task 1: dto.rs — BotConfig/LlmConfig/BotLimits/BotActivityDto + 旧配置迁移

**Files:**
- Modify: `src-tauri/src/dto.rs`(在现有 `LlmConfigInput` 之后追加)

**Interfaces:**
- Consumes: 现有 `LlmConfigInput`(保留不动,前端兼容用)
- Produces(后续任务依赖):
  - `pub struct LlmConfig { system_prompt, base_url, api_key, model, provider: Option<String>, temperature: f64, max_tokens: Option<u32>, top_p: Option<f64>, timeout_secs: u64, max_retries: u32 }`,含 `pub fn is_complete(&self) -> bool`
  - `pub struct BotLimits { max_concurrent: u32, reply_min_interval_secs: u64 }`(Clone/Copy + `Default`:2/3)
  - `pub struct BotConfig { llm: Option<LlmConfig>, limits: BotLimits }`,含 `pub fn parse(raw: Option<&str>) -> Option<BotConfig>`
  - `pub struct BotActivityDto { id, bot_id, kind, chat_id, msg_id, summary, detail_json, created_at }`(Serialize/Deserialize)
  - `pub mod bot_activity_kind` 常量:`REPLY_SENT/REPLY_SKIPPED/REPLY_RATE_LIMITED/LLM_ERROR/NO_CONFIG/DRIVER_DISABLED`
  - `impl From<LlmConfigInput> for LlmConfig`(缺省参数取默认)

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/dto.rs` 的 `mod tests` 中追加:

```rust
fn default_llm_config() -> LlmConfig {
    LlmConfig {
        system_prompt: Some("你是助手".into()),
        base_url: Some("https://api.openai.com/v1".into()),
        api_key: Some("sk-test".into()),
        model: Some("gpt-4o-mini".into()),
        provider: Some("openai".into()),
        temperature: 0.7,
        max_tokens: Some(256),
        top_p: Some(1.0),
        timeout_secs: 120,
        max_retries: 2,
    }
}

#[test]
fn test_bot_limits_defaults() {
    let l = BotLimits::default();
    assert_eq!(l.max_concurrent, 2);
    assert_eq!(l.reply_min_interval_secs, 3);
}

#[test]
fn test_llm_config_is_complete() {
    assert!(default_llm_config().is_complete());
    let mut no_model = default_llm_config();
    no_model.model = None;
    assert!(!no_model.is_complete());
    let mut blank_key = default_llm_config();
    blank_key.api_key = Some("   ".into());
    assert!(!blank_key.is_complete());
}

#[test]
fn test_bot_config_parse_new_format() {
    let json = r#"{"llm":{"base_url":"https://x/v1","api_key":"k","model":"m","temperature":0.3,"max_tokens":100},"limits":{"max_concurrent":5,"reply_min_interval_secs":7}}"#;
    let cfg = BotConfig::parse(Some(json)).expect("parse new format");
    let llm = cfg.llm.expect("llm present");
    assert_eq!(llm.temperature, 0.3);
    assert_eq!(llm.max_tokens, Some(100));
    assert_eq!(llm.timeout_secs, 120);      // 缺省取默认
    assert_eq!(llm.max_retries, 2);          // 缺省取默认
    assert_eq!(cfg.limits.max_concurrent, 5);
    assert_eq!(cfg.limits.reply_min_interval_secs, 7);
}

#[test]
fn test_bot_config_parse_legacy_format() {
    // 旧格式:顶层字段,无 llm 包裹
    let json = r#"{"system_prompt":"旧提示","base_url":"https://old/v1","api_key":"old-key","model":"old-model","provider":"openai"}"#;
    let cfg = BotConfig::parse(Some(json)).expect("parse legacy");
    let llm = cfg.llm.expect("llm migrated");
    assert_eq!(llm.base_url.as_deref(), Some("https://old/v1"));
    assert_eq!(llm.model.as_deref(), Some("old-model"));
    assert_eq!(llm.temperature, 0.7);        // 迁移补默认
    assert_eq!(llm.timeout_secs, 120);
    assert_eq!(cfg.limits.max_concurrent, 2); // 迁移补默认
}

#[test]
fn test_bot_config_parse_none_or_invalid() {
    assert!(BotConfig::parse(None).is_none());
    assert!(BotConfig::parse(Some("not json".into())).is_none());
    // 新格式 llm 显式 null 且不是旧格式 → None
    assert!(BotConfig::parse(Some(r#"{"llm":null,"limits":{"max_concurrent":4}}"#.into())).is_none());
}

#[test]
fn test_llm_config_from_input() {
    let input = LlmConfigInput {
        system_prompt: Some("p".into()),
        base_url: Some("https://b/v1".into()),
        api_key: Some("k".into()),
        model: Some("m".into()),
        provider: Some("openai".into()),
    };
    let cfg = LlmConfig::from(input);
    assert_eq!(cfg.base_url.as_deref(), Some("https://b/v1"));
    assert_eq!(cfg.temperature, 0.7);
    assert_eq!(cfg.max_tokens, None);
    assert!(cfg.is_complete());
}

#[test]
fn test_bot_activity_dto_round_trip() {
    let dto = BotActivityDto {
        id: 1, bot_id: 9, kind: "reply_sent".into(),
        chat_id: Some(3), msg_id: Some(7),
        summary: "回复 alice".into(), detail_json: None, created_at: 1,
    };
    let json = serde_json::to_string(&dto).unwrap();
    let back: BotActivityDto = serde_json::from_str(&json).unwrap();
    assert_eq!(back.kind, "reply_sent");
    assert_eq!(back.bot_id, 9);
    assert_eq!(back.chat_id, Some(3));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib dto::tests::test_bot_limits_defaults -- --nocapture`
Expected: FAIL(编译错误,`BotLimits`/`BotConfig`/`LlmConfig`/`BotActivityDto` 未定义)

- [ ] **Step 3: 实现**

在 `src-tauri/src/dto.rs` 现有 `LlmConfigInput`(约 265–273 行)之后追加:

```rust
/// 活动类型常量(见 bot_activities.kind)。
pub mod bot_activity_kind {
    pub const REPLY_SENT: &str = "reply_sent";
    pub const REPLY_SKIPPED: &str = "reply_skipped";
    pub const REPLY_RATE_LIMITED: &str = "reply_rate_limited";
    pub const LLM_ERROR: &str = "llm_error";
    pub const NO_CONFIG: &str = "no_config";
    pub const DRIVER_DISABLED: &str = "driver_disabled";
}

/// Bot 活动日志 DTO(时间线页/统计用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotActivityDto {
    pub id: i64,
    pub bot_id: i64,
    pub kind: String,
    pub chat_id: Option<u32>,
    pub msg_id: Option<u32>,
    pub summary: String,
    pub detail_json: Option<String>,
    pub created_at: i64,
}

fn default_temperature() -> f64 {
    0.7
}
fn default_timeout_secs() -> u64 {
    120
}
fn default_max_retries() -> u32 {
    2
}
fn default_max_concurrent() -> u32 {
    2
}
fn default_reply_interval() -> u64 {
    3
}

/// 结构化 LLM 驱动配置(旧 LlmConfigInput 的超集)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub system_prompt: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

impl LlmConfig {
    /// base_url + api_key + model 三者非空即视为可自动回复。
    pub fn is_complete(&self) -> bool {
        let non_empty = |s: &Option<String>| s.as_deref().map_or(false, |s| !s.trim().is_empty());
        non_empty(&self.base_url) && non_empty(&self.api_key) && non_empty(&self.model)
    }
}

impl From<LlmConfigInput> for LlmConfig {
    fn from(i: LlmConfigInput) -> Self {
        Self {
            system_prompt: i.system_prompt,
            base_url: i.base_url,
            api_key: i.api_key,
            model: i.model,
            provider: i.provider,
            temperature: default_temperature(),
            max_tokens: None,
            top_p: None,
            timeout_secs: default_timeout_secs(),
            max_retries: default_max_retries(),
        }
    }
}

/// Bot 运行时限额。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BotLimits {
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
    #[serde(default = "default_reply_interval")]
    pub reply_min_interval_secs: u64,
}

impl Default for BotLimits {
    fn default() -> Self {
        Self {
            max_concurrent: default_max_concurrent(),
            reply_min_interval_secs: default_reply_interval(),
        }
    }
}

/// Bot 完整配置(存于 bots.config_json)。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BotConfig {
    #[serde(default)]
    pub llm: Option<LlmConfig>,
    #[serde(default)]
    pub limits: BotLimits,
}

impl BotConfig {
    /// 解析 config_json:优先新格式;新格式 llm 为空时回退旧格式(顶层 LLM 字段)。
    pub fn parse(raw: Option<&str>) -> Option<BotConfig> {
        let s = raw?;
        if let Ok(cfg) = serde_json::from_str::<BotConfig>(s) {
            if cfg.llm.is_some() {
                return Some(cfg);
            }
        }
        Self::from_legacy(s)
    }

    fn from_legacy(s: &str) -> Option<BotConfig> {
        #[derive(serde::Deserialize)]
        struct Legacy {
            system_prompt: Option<String>,
            base_url: Option<String>,
            api_key: Option<String>,
            model: Option<String>,
            provider: Option<String>,
        }
        let legacy: Legacy = serde_json::from_str(s).ok()?;
        Some(BotConfig {
            llm: Some(LlmConfig {
                system_prompt: legacy.system_prompt,
                base_url: legacy.base_url,
                api_key: legacy.api_key,
                model: legacy.model,
                provider: legacy.provider,
                temperature: default_temperature(),
                max_tokens: None,
                top_p: None,
                timeout_secs: default_timeout_secs(),
                max_retries: default_max_retries(),
            }),
            limits: BotLimits::default(),
        })
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib dto::tests -- --nocapture`
Expected: PASS(6 个新测试 + 既有 `test_advanced_login_deserialize_snake_case` 不回归)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/dto.rs
git commit -m "feat(dto): BotConfig/LlmConfig/BotLimits/BotActivityDto + 旧配置迁移"
```

---

### Task 2: db.rs — bot_activities 表 + insert/list + owner 查询

**Files:**
- Modify: `src-tauri/src/db.rs`

**Interfaces:**
- Consumes: 无(独立于 Task 1,可并行)
- Produces(后续任务依赖):
  - `pub struct BotActivityRow { id, bot_id, kind, chat_id: Option<u32>, msg_id: Option<u32>, summary, detail_json: Option<String>, created_at }`(定义在本文件,db 内部行结构)
  - `pub async fn insert_bot_activity(&self, bot_id: i64, kind: &str, chat_id: Option<u32>, msg_id: Option<u32>, summary: &str, detail_json: Option<&str>) -> AppResult<i64>`
  - `pub async fn list_bot_activities(&self, bot_id: i64, limit: u32) -> AppResult<Vec<BotActivityRow>>`

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/db.rs` 的 `mod tests` 中追加:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn test_bot_activity_insert_and_list() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::new(tmp.path().join("test.db")).await.unwrap();
    db.migrate().await.unwrap();

    let id1 = db
        .insert_bot_activity(9, "reply_sent", Some(3), Some(7), "回复 alice", None)
        .await
        .unwrap();
    let id2 = db
        .insert_bot_activity(9, "llm_error", Some(3), Some(8), "llm 失败", Some("{\"error\":\"timeout\"}"))
        .await
        .unwrap();
    db.insert_bot_activity(10, "no_config", None, None, "无配置", None).await.unwrap();

    let rows = db.list_bot_activities(9, 10).await.unwrap();
    // ORDER BY id DESC → 最新在前
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, id2);
    assert_eq!(rows[0].kind, "llm_error");
    assert_eq!(rows[0].detail_json.as_deref(), Some("{\"error\":\"timeout\"}"));
    assert_eq!(rows[1].id, id1);
    assert_eq!(rows[1].chat_id, Some(3));
    assert_eq!(rows[1].msg_id, Some(7));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_bot_activity_list_limit_and_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::new(tmp.path().join("test.db")).await.unwrap();
    db.migrate().await.unwrap();
    for _ in 0..3 {
        db.insert_bot_activity(5, "reply_sent", None, None, "r", None).await.unwrap();
    }
    let limited = db.list_bot_activities(5, 2).await.unwrap();
    assert_eq!(limited.len(), 2);
    assert!(db.list_bot_activities(99, 10).await.unwrap().is_empty());
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib db::tests::test_bot_activity_insert_and_list -- --nocapture`
Expected: FAIL(编译错误,`insert_bot_activity`/`list_bot_activities`/`BotActivityRow` 未定义)

- [ ] **Step 3: 实现**

(1) 在 `db.rs` 顶部 `BotRow` 定义附近新增行结构:

```rust
/// bot_activities 表行结构。
pub struct BotActivityRow {
    pub id: i64,
    pub bot_id: i64,
    pub kind: String,
    pub chat_id: Option<u32>,
    pub msg_id: Option<u32>,
    pub summary: String,
    pub detail_json: Option<String>,
    pub created_at: i64,
}
```

(2) 在 `migrate()` 第一个 `spawn_blocking` 的大 SQL 字符串里,`bots` 表定义之后追加(约 141–142 行):

```sql
CREATE TABLE IF NOT EXISTS bot_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    chat_id INTEGER,
    msg_id INTEGER,
    summary TEXT NOT NULL,
    detail_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_activities_bot ON bot_activities(bot_id, created_at DESC);
```

(3) 在 `Db` impl 的 `// ── Bot 系统` 区块末尾(约 1068 行处)追加:

```rust
    // ── Bot 活动日志 ──────────────────────────────────────────────────────

    pub async fn insert_bot_activity(
        &self,
        bot_id: i64,
        kind: &str,
        chat_id: Option<u32>,
        msg_id: Option<u32>,
        summary: &str,
        detail_json: Option<&str>,
    ) -> AppResult<i64> {
        let conn = self.conn.clone();
        let kind = kind.to_string();
        let summary = summary.to_string();
        let detail_json = detail_json.map(|s| s.to_string());
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO bot_activities (bot_id, kind, chat_id, msg_id, summary, detail_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    bot_id,
                    kind,
                    chat_id.map(|v| v as i64),
                    msg_id.map(|v| v as i64),
                    summary,
                    detail_json,
                    now
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn list_bot_activities(&self, bot_id: i64, limit: u32) -> AppResult<Vec<BotActivityRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<BotActivityRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, bot_id, kind, chat_id, msg_id, summary, detail_json, created_at
                 FROM bot_activities WHERE bot_id = ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![bot_id, limit], |r| {
                Ok(BotActivityRow {
                    id: r.get(0)?,
                    bot_id: r.get(1)?,
                    kind: r.get(2)?,
                    chat_id: r.get::<_, Option<i64>>(3)?.map(|v| v as u32),
                    msg_id: r.get::<_, Option<i64>>(4)?.map(|v| v as u32),
                    summary: r.get(5)?,
                    detail_json: r.get(6)?,
                    created_at: r.get(7)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib db::tests -- --nocapture`
Expected: PASS(2 个新测试 + 既有 db 测试不回归,含 bots 表 owner 过滤测试 `test_db_*`)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): bot_activities 表 + insert/list 活动日志查询"
```

---

### Task 3: activity.rs — ActivityLog 记录器(落库 + 实时回调)

**Files:**
- Create: `src-tauri/src/activity.rs`
- Modify: `src-tauri/src/lib.rs`(仅加 `mod activity;` 声明,接线在 Task 9)

**Interfaces:**
- Consumes: Task 1 的 `BotActivityDto`;Task 2 的 `Db::insert_bot_activity`
- Produces(后续任务依赖):
  - `#[derive(Clone)] pub struct ActivityLog`
  - `impl ActivityLog { pub fn new(db: Arc<Db>) -> Self; pub fn with_callback<F>(self, cb: F) -> Self where F: Fn(BotActivityDto) + Send + Sync + 'static; pub async fn record(&self, bot_id: i64, kind: &str, chat_id: Option<u32>, msg_id: Option<u32>, summary: impl Into<String>, detail_json: Option<String>) }`
  - 语义:`record` 落库成功后将带真实 id 的 `BotActivityDto` 交给回调;落库失败只记日志。

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/activity.rs`:

```rust
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use crate::db::Db;
use crate::dto::BotActivityDto;

/// 活动日志记录器:落库 + 可选实时回调(如 emit 到前端)。
/// 回调在成功落库后被调用;回调或落库失败只记日志,不影响主流程。
#[derive(Clone)]
pub struct ActivityLog {
    db: Arc<Db>,
    on_record: Option<Arc<dyn Fn(BotActivityDto) + Send + Sync>>,
}

impl ActivityLog {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db, on_record: None }
    }

    pub fn with_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(BotActivityDto) + Send + Sync + 'static,
    {
        self.on_record = Some(Arc::new(cb));
        self
    }

    /// 记录一条 bot 活动:落库 + 触发回调。失败只记日志。
    pub async fn record(
        &self,
        bot_id: i64,
        kind: &str,
        chat_id: Option<u32>,
        msg_id: Option<u32>,
        summary: impl Into<String>,
        detail_json: Option<String>,
    ) {
        let summary = summary.into();
        match self
            .db
            .insert_bot_activity(bot_id, kind, chat_id, msg_id, &summary, detail_json.as_deref())
            .await
        {
            Ok(id) => {
                let dto = BotActivityDto {
                    id,
                    bot_id,
                    kind: kind.to_string(),
                    chat_id,
                    msg_id,
                    summary,
                    detail_json,
                    created_at: chrono::Utc::now().timestamp(),
                };
                if let Some(cb) = &self.on_record {
                    cb(dto);
                }
            }
            Err(e) => log::warn!("activity log insert failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> (tempfile::TempDir, Arc<Db>) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::new(tmp.path().join("test.db")).await.unwrap());
        db.migrate().await.unwrap();
        (tmp, db)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_record_without_callback_persists() {
        let (_tmp, db) = test_db().await;
        let log = ActivityLog::new(db.clone());
        log.record(9, "reply_sent", Some(3), Some(7), "回复 alice", None).await;

        let rows = db.list_bot_activities(9, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "reply_sent");
        assert_eq!(rows[0].chat_id, Some(3));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_record_invokes_callback_with_real_id() {
        let (_tmp, db) = test_db().await;
        let seen: Arc<StdMutex<Vec<BotActivityDto>>> = Arc::new(StdMutex::new(Vec::new()));
        let seen_clone = seen.clone();
        let log = ActivityLog::new(db.clone()).with_callback(move |dto| {
            seen_clone.lock().unwrap().push(dto);
        });

        log.record(5, "llm_error", None, None, "llm 失败", Some("{\"e\":1}".into())).await;

        let got = seen.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].id > 0);
        assert_eq!(got[0].bot_id, 5);
        assert_eq!(got[0].kind, "llm_error");
        let rows = db.list_bot_activities(5, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
    }
}
```

- [ ] **Step 2: 运行确认失败**

先在 `lib.rs` 顶部加 `mod activity;`(仅此一行,接线留到 Task 9),然后:
Run: `cargo test --lib activity::tests -- --nocapture`
Expected: FAIL(编译错误,`ActivityLog` 未定义)

- [ ] **Step 3: 实现**

把 Step 1 中完整文件写入 `src-tauri/src/activity.rs`(含实现与测试)。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib activity::tests -- --nocapture`
Expected: PASS(2 个新测试)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/activity.rs src-tauri/src/lib.rs
git commit -m "feat(activity): ActivityLog 活动日志记录器(落库+实时回调)"
```

---

### Task 4: llm.rs — LlmClient 加固(共享 client/超时/重试退避/参数) + error.rs 增 Http

**Files:**
- Modify: `src-tauri/src/llm.rs`(整体重写)
- Modify: `src-tauri/src/error.rs`(追加 `Http` 变体)

**Interfaces:**
- Consumes: Task 1 的 `LlmConfig`
- Produces(后续任务依赖):
  - `pub struct LlmClient { http: reqwest::Client }`,含 `pub fn new() -> Self`、`pub async fn complete(&self, cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String>`
  - `pub fn build_request_body(cfg: &LlmConfig, messages: Vec<ChatMessage>) -> serde_json::Value`(含 temperature/max_tokens/top_p)
  - `pub fn parse_response(body: &str) -> AppResult<String>`(签名不变)
  - `pub fn is_retryable(e: &AppError) -> bool`
  - `pub fn backoff_delay(attempt: u32) -> std::time::Duration`
  - `AppError::Http(u16, String)` 变体
  - `ChatMessage`(不变)

- [ ] **Step 1: 写失败测试**

重写 `src-tauri/src/llm.rs` 的 `mod tests`,先按目标 API 写(编译即失败):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::LlmConfig;

    fn cfg() -> LlmConfig {
        LlmConfig {
            system_prompt: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            api_key: Some("test-key".to_string()),
            model: Some("gpt-4o-mini".to_string()),
            provider: Some("openai".to_string()),
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            timeout_secs: 120,
            max_retries: 2,
        }
    }

    #[test]
    fn test_build_request_body_with_params() {
        let messages = vec![ChatMessage { role: "user".into(), content: "你好".into() }];
        let body = build_request_body(&cfg(), messages.clone());
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["max_tokens"], serde_json::Value::Null); // 未设则不输出
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");

        let mut c = cfg();
        c.temperature = 0.2;
        c.max_tokens = Some(100);
        c.top_p = Some(0.9);
        let body = build_request_body(&c, messages);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 100);
        assert_eq!(body["top_p"], 0.9);
    }

    #[test]
    fn test_parse_response_success() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好，我是助手"}}]}"#;
        assert_eq!(parse_response(body).unwrap(), "你好，我是助手");
    }

    #[test]
    fn test_parse_response_missing_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant"}}]}"#;
        assert!(parse_response(body).is_err());
    }

    #[test]
    fn test_is_retryable() {
        assert!(is_retryable(&AppError::Network("timeout".into())));
        assert!(is_retryable(&AppError::Http(429, "limit".into())));
        assert!(is_retryable(&AppError::Http(500, "srv".into())));
        assert!(is_retryable(&AppError::Http(503, "srv".into())));
        assert!(!is_retryable(&AppError::Http(400, "bad".into())));
        assert!(!is_retryable(&AppError::Http(401, "auth".into())));
        assert!(!is_retryable(&AppError::Core("other".into())));
    }

    #[test]
    fn test_backoff_delay_scales_with_attempt() {
        assert!(backoff_delay(2) > backoff_delay(1));
        assert!(backoff_delay(1) >= backoff_delay(0));
    }

    #[tokio::test]
    async fn test_complete_missing_api_key() {
        let client = LlmClient::new();
        let mut c = cfg();
        c.api_key = Some(String::new());
        let err = client.complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("api_key")));
    }

    #[tokio::test]
    async fn test_complete_missing_base_url() {
        let client = LlmClient::new();
        let mut c = cfg();
        c.base_url = None;
        let err = client.complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("base_url")));
    }
}
```

在 `error.rs` 追加一个测试(在现有 mod tests 前,若无 mod tests 则新建):

```rust
#[test]
fn test_http_error_serialization() {
    let e = AppError::Http(500, "boom".into());
    let json = serde_json::to_string(&e).unwrap();
    assert!(json.contains("\"kind\":\"Http\""));
    assert!(json.contains("boom"));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib llm::tests -- --nocapture`
Expected: FAIL(编译错误,`LlmClient`/`is_retryable`/`backoff_delay` 未定义,`AppError::Http` 不存在)

- [ ] **Step 3: 实现**

(1) `error.rs` 的 `AppError` 枚举追加变体(在 `Plugin` 之后):

```rust
    #[error("HTTP {0}: {1}")]
    Http(u16, String),
```

(2) 重写 `llm.rs` 主体:

```rust
use std::time::Duration;

use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};

/// OpenAI 兼容 chat 消息
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// 构造 chat/completions 请求体 (纯函数,便于单测)
pub fn build_request_body(cfg: &LlmConfig, messages: Vec<ChatMessage>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg.model.clone().unwrap_or_default(),
        "messages": messages.into_iter().map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        }).collect::<Vec<_>>(),
        "temperature": cfg.temperature,
    });
    if let Some(v) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(v);
    }
    if let Some(v) = cfg.top_p {
        body["top_p"] = serde_json::json!(v);
    }
    body
}

/// 解析 chat/completions 响应 (纯函数,便于单测)
pub fn parse_response(body: &str) -> AppResult<String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Core(format!("llm parse response: 无效 JSON: {e}")))?;
    let choices = parsed
        .get("choices")
        .and_then(|c| c.as_array())
        .ok_or_else(|| AppError::Core("llm parse response: 缺少 choices 字段".into()))?;
    if choices.is_empty() {
        return Err(AppError::Core("llm parse response: choices 为空".into()));
    }
    let content = choices[0]
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AppError::Core("llm parse response: 缺少 message.content".into()))?;
    Ok(content.to_string())
}

/// 错误是否值得重试:网络错误、429、5xx 视为瞬时。
pub fn is_retryable(e: &AppError) -> bool {
    match e {
        AppError::Network(_) => true,
        AppError::Http(code, _) => matches!(code, 429 | 500 | 502 | 503 | 504),
        _ => false,
    }
}

/// 指数退避延迟:1s * 2^attempt + 0–499ms 抖动(基于系统时钟,避免新增随机依赖)。
pub fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = 1000u64.saturating_mul(1u64 << attempt.min(10));
    let jitter_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 500)
        .unwrap_or(0);
    Duration::from_millis(base_ms + jitter_ms as u64)
}

/// LLM 客户端:共享 reqwest 连接池 + 超时 + 瞬时错误重试退避。
pub struct LlmClient {
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    /// 调用 chat/completions;瞬时错误按 cfg.max_retries 指数退避重试。
    pub async fn complete(&self, cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let base = cfg.base_url.as_deref().unwrap_or("").trim_end_matches('/');
        if base.is_empty() {
            return Err(AppError::Core("llm missing base_url".into()));
        }
        let url = format!("{base}/chat/completions");
        let body = build_request_body(cfg, messages);

        let max_retries = cfg.max_retries;
        for attempt in 0..=max_retries {
            match self.call_once(cfg, &url, &body).await {
                Ok(text) => return Ok(text),
                Err(e) if is_retryable(&e) && attempt < max_retries => {
                    log::warn!("llm attempt {attempt} failed (will retry): {e}");
                    tokio::time::sleep(backoff_delay(attempt)).await;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("complete loop always returns")
    }

    async fn call_once(
        &self,
        cfg: &LlmConfig,
        url: &str,
        body: &serde_json::Value,
    ) -> AppResult<String> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        let resp = self
            .http
            .post(url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .json(body)
            .timeout(Duration::from_secs(cfg.timeout_secs.max(1)))
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let truncated: String = text.chars().take(200).collect();
            return Err(AppError::Http(status.as_u16(), truncated));
        }
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        parse_response(&text)
    }
}

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib llm::tests -- --nocapture` 和 `cargo test --lib error:: -- --nocapture`
Expected: PASS(新测试全过)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/llm.rs src-tauri/src/error.rs
git commit -m "feat(llm): LlmClient 共享连接池/超时/重试退避 + 生成参数透传"
```

---

### Task 5: drivers/mod.rs + drivers/llm.rs — BotDriver trait + 注册表 + LLM 驱动

**Files:**
- Create: `src-tauri/src/drivers/mod.rs`
- Create: `src-tauri/src/drivers/llm.rs`
- Modify: `src-tauri/src/Cargo.toml`(加 `async-trait = "0.1"`)
- Modify: `src-tauri/src/lib.rs`(仅加 `mod drivers;` 声明)

**Interfaces:**
- Consumes: Task 1 `LlmConfig`/`BotConfig`;Task 3 `ActivityLog`;Task 4 `LlmClient`/`ChatMessage`
- Produces(后续任务依赖):
  - `pub enum DriverKind { Llm, Rule, Schedule }`(Clone/Copy/PartialEq/Eq/Debug)
  - `pub struct IncomingMsg<'a> { chat_id: ChatId, msg_id: MsgId, from_addr: &'a str, text: Option<&'a str>, viewtype: Viewtype }`
  - `pub struct BotRuntime<'a> { bot_id: i64, account_id: u32, dc: &'a Context, config: &'a BotConfig, db: &'a Db, activity: &'a ActivityLog }`
  - `#[async_trait] pub trait BotDriver: Send + Sync { fn kind(&self) -> DriverKind; async fn on_message(&self, bot: &BotRuntime<'_>, msg: &IncomingMsg<'_>) -> AppResult<Vec<String>>; async fn on_tick(&self, bot: &BotRuntime<'_>) -> AppResult<Vec<String>> { Ok(vec![]) } }`
  - `#[derive(Clone, Default)] pub struct DriverRegistry { drivers: Vec<Arc<dyn BotDriver>> }` + `new/register/drivers()`
  - `pub struct LlmDriver { client: LlmClient }` + `pub fn new(client: LlmClient) -> Self`(实现 BotDriver)
  - 历史构建纯函数(自 bot_llm.rs 移植):`pub fn build_history(ctx, chat_id) -> AppResult<Vec<ChatMessage>>`、`pub async fn sender_name(...)`、`pub fn render_viewtype_label(&Viewtype) -> &'static str`、`pub fn format_message_line(&str, &str) -> String`

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/drivers/llm.rs` 含测试(编译失败因为 mod 未挂载):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use deltachat::message::Viewtype::*;

    #[test]
    fn test_render_viewtype_label() {
        assert_eq!(render_viewtype_label(&Image), "[图片]");
        assert_eq!(render_viewtype_label(&File), "[文件]");
        assert_eq!(render_viewtype_label(&Voice), "[语音]");
        assert_eq!(render_viewtype_label(&Webxdc), "[App]");
        assert_eq!(render_viewtype_label(&Text), "[其他]");
        assert_eq!(render_viewtype_label(&Video), "[其他]");
    }

    #[test]
    fn test_format_message_line() {
        let line = format_message_line("小明", "你好呀");
        assert_eq!(line, "「小明: 你好呀」");
        assert!(line.contains("小明"));
        assert!(line.contains("你好呀"));
    }

    #[test]
    fn test_driver_registry_register_and_list() {
        use crate::llm::LlmClient;
        let client = LlmClient::new();
        let mut registry = DriverRegistry::new();
        registry.register(Arc::new(LlmDriver::new(client)));
        assert_eq!(registry.drivers().len(), 1);
        assert_eq!(registry.drivers()[0].kind(), DriverKind::Llm);
    }

    #[test]
    fn test_driver_kind_debug_eq() {
        assert_eq!(DriverKind::Llm, DriverKind::Llm);
        assert_ne!(DriverKind::Llm, DriverKind::Rule);
        assert_ne!(DriverKind::Rule, DriverKind::Schedule);
    }
}
```

- [ ] **Step 2: 运行确认失败**

在 `lib.rs` 加 `mod drivers;`,在 `Cargo.toml` 加依赖,然后:
Run: `cargo test --lib drivers -- --nocapture`
Expected: FAIL(编译错误,`BotDriver`/`DriverRegistry`/`LlmDriver` 未定义)

- [ ] **Step 3: 实现**

`Cargo.toml` `[dependencies]` 追加一行:`async-trait = "0.1"`。

`src-tauri/src/drivers/mod.rs`:

```rust
use std::sync::Arc;

use async_trait::async_trait;
use deltachat::chat::ChatId;
use deltachat::context::Context;
use deltachat::message::{MsgId, Viewtype};

use crate::activity::ActivityLog;
use crate::db::Db;
use crate::dto::BotConfig;
use crate::error::AppResult;

pub mod llm;

/// 驱动类型标识。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverKind {
    Llm,
    Rule,
    Schedule,
}

/// 驱动处理一条进站消息所需的上下文快照(短生命周期)。
pub struct IncomingMsg<'a> {
    pub chat_id: ChatId,
    pub msg_id: MsgId,
    pub from_addr: &'a str,
    pub text: Option<&'a str>,
    pub viewtype: Viewtype,
}

/// 驱动可用的 Bot 运行上下文。
pub struct BotRuntime<'a> {
    pub bot_id: i64,
    pub account_id: u32,
    pub dc: &'a Context,
    pub config: &'a BotConfig,
    pub db: &'a Db,
    pub activity: &'a ActivityLog,
}

/// 驱动接口:一种「大脑」。返回要发送的回复文本列表;发送/限流/日志由调度器处理。
#[async_trait]
pub trait BotDriver: Send + Sync {
    fn kind(&self) -> DriverKind;
    async fn on_message(&self, bot: &BotRuntime<'_>, msg: &IncomingMsg<'_>) -> AppResult<Vec<String>>;
    /// 定时 tick(规则/定时驱动用);默认不处理。
    async fn on_tick(&self, bot: &BotRuntime<'_>) -> AppResult<Vec<String>> {
        let _ = bot;
        Ok(vec![])
    }
}

/// 驱动注册表:B1 由 lib.rs 装配,后续可被插件扩展。
#[derive(Clone, Default)]
pub struct DriverRegistry {
    drivers: Vec<Arc<dyn BotDriver>>,
}

impl DriverRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, driver: Arc<dyn BotDriver>) {
        self.drivers.push(driver);
    }

    pub fn drivers(&self) -> &[Arc<dyn BotDriver>] {
        &self.drivers
    }
}

/// 人类可读的驱动名(日志/活动用)。
pub fn driver_kind_label(k: DriverKind) -> &'static str {
    match k {
        DriverKind::Llm => "llm",
        DriverKind::Rule => "rule",
        DriverKind::Schedule => "schedule",
    }
}
```

`src-tauri/src/drivers/llm.rs`:

```rust
use std::sync::Arc;

use async_trait::async_trait;
use deltachat::chat::{self, ChatId};
use deltachat::chat::ChatItem;
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, MsgId, Viewtype};

use super::{BotDriver, BotRuntime, DriverKind, IncomingMsg};
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};

/// LLM 自动回复驱动:读取 BotConfig.llm,用聊天历史 + 系统提示词调用 LLM 返回回复。
pub struct LlmDriver {
    client: LlmClient,
}

impl LlmDriver {
    pub fn new(client: LlmClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl BotDriver for LlmDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Llm
    }

    async fn on_message(&self, bot: &BotRuntime<'_>, msg: &IncomingMsg<'_>) -> AppResult<Vec<String>> {
        let Some(llm) = bot.config.llm.as_ref() else {
            return Ok(vec![]);
        };
        if !llm.is_complete() {
            return Ok(vec![]);
        }

        let history = build_history(bot.dc, msg.chat_id).await?;

        let mut messages = Vec::new();
        if let Some(p) = llm
            .system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            messages.push(ChatMessage {
                role: "system".into(),
                content: p.to_string(),
            });
        }
        messages.extend(history);

        let reply = self.client.complete(llm, messages).await?.trim().to_string();
        if reply.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![reply])
    }
}

// ── 历史构建(自 bot_llm.rs 移植) ────────────────────────────────────────

/// 构建最近 20 条聊天历史,每条渲染为「name: text」的 user 消息。
pub async fn build_history(ctx: &Context, chat_id: ChatId) -> AppResult<Vec<ChatMessage>> {
    let items = chat::get_chat_msgs(ctx, chat_id)
        .await
        .map_err(|e| AppError::Core(format!("get_chat_msgs: {e}")))?;
    let mut last: Vec<MsgId> = items
        .into_iter()
        .filter_map(|it| match it {
            ChatItem::Message { msg_id } => Some(msg_id),
            _ => None,
        })
        .rev()
        .take(20)
        .collect();
    last.reverse();

    let mut history = Vec::with_capacity(last.len());
    for mid in last {
        let m = match Message::load_from_db(ctx, mid).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = sender_name(ctx, &m).await;
        let text = m.get_text();
        let line = if text.trim().is_empty() {
            format!("{name}: {}", render_viewtype_label(&m.get_viewtype()))
        } else {
            format_message_line(&name, &text)
        };
        history.push(ChatMessage {
            role: "user".into(),
            content: line,
        });
    }
    Ok(history)
}

/// 取消息发送者展示名,为空时退回邮箱地址。
pub async fn sender_name(ctx: &Context, m: &Message) -> String {
    match Contact::get_by_id(ctx, m.get_from_id()).await {
        Ok(c) => {
            let name = c.get_display_name().trim();
            if name.is_empty() {
                c.get_addr().to_string()
            } else {
                name.to_string()
            }
        }
        Err(_) => "未知".to_string(),
    }
}

/// 无文本消息的 viewtype 中文标签。
pub fn render_viewtype_label(v: &Viewtype) -> &'static str {
    match v {
        Viewtype::Image => "[图片]",
        Viewtype::File => "[文件]",
        Viewtype::Voice => "[语音]",
        Viewtype::Webxdc => "[App]",
        _ => "[其他]",
    }
}

/// 渲染单条历史消息行:「name: text」。
pub fn format_message_line(name: &str, text: &str) -> String {
    format!("「{name}: {text}」")
}

#[cfg(test)]
mod tests {
    use super::*;
    use deltachat::message::Viewtype::*;

    #[test]
    fn test_render_viewtype_label() {
        assert_eq!(render_viewtype_label(&Image), "[图片]");
        assert_eq!(render_viewtype_label(&File), "[文件]");
        assert_eq!(render_viewtype_label(&Voice), "[语音]");
        assert_eq!(render_viewtype_label(&Webxdc), "[App]");
        assert_eq!(render_viewtype_label(&Text), "[其他]");
        assert_eq!(render_viewtype_label(&Video), "[其他]");
    }

    #[test]
    fn test_format_message_line() {
        let line = format_message_line("小明", "你好呀");
        assert_eq!(line, "「小明: 你好呀」");
        assert!(line.contains("小明"));
        assert!(line.contains("你好呀"));
    }

    #[test]
    fn test_driver_registry_register_and_list() {
        let mut registry = DriverRegistry::new();
        registry.register(Arc::new(LlmDriver::new(LlmClient::new())));
        assert_eq!(registry.drivers().len(), 1);
        assert_eq!(registry.drivers()[0].kind(), DriverKind::Llm);
    }

    #[test]
    fn test_driver_kind_debug_eq() {
        assert_eq!(DriverKind::Llm, DriverKind::Llm);
        assert_ne!(DriverKind::Llm, DriverKind::Rule);
        assert_ne!(DriverKind::Rule, DriverKind::Schedule);
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib drivers -- --nocapture`
Expected: PASS(4 个新测试)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/drivers src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(drivers): BotDriver trait + DriverRegistry + LLM 驱动(历史构建移植)"
```

---

### Task 6: runtime.rs — 事件调度器(并发/限流/错误隔离/活动日志)

**Files:**
- Create: `src-tauri/src/runtime.rs`
- Modify: `src-tauri/src/lib.rs`(仅加 `mod runtime;` 声明)

**Interfaces:**
- Consumes: Task 2 `Db::get_bot_by_account_id`;Task 3 `ActivityLog`;Task 4 `LlmClient`(不经此任务直接使用);Task 5 `BotDriver/BotRuntime/DriverRegistry/IncomingMsg/driver_kind_label`;Task 1 `BotConfig`/`bot_activity_kind`/`LlmConfig`
- Produces(后续任务依赖):
  - `pub async fn spawn(accounts: Arc<Mutex<Accounts>>, db: Arc<Db>, bot_ids: Arc<Mutex<HashSet<u32>>>, activity: ActivityLog, registry: DriverRegistry)` — 常驻后台,自行 tokio::spawn,不阻塞调用方
  - `pub struct RateLimiter` + `pub fn new()` / `pub fn with_clock<F: Fn() -> Instant + Send + Sync + 'static>(f: F) -> Self` / `pub fn try_acquire(&self, bot_id: i64, chat_id: u32, interval: Duration) -> bool`(测试用可注入时钟)
  - 内部工具:`fn is_bot_addr(&str, &HashSet<String>) -> bool`、`fn truncate(&str, usize) -> String`(pub(crate) 供测试)

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/runtime.rs` 含测试(编译失败因为 mod 未挂载):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn test_is_bot_addr() {
        let mut addrs = HashSet::new();
        addrs.insert("bot1@example.com".to_string());
        addrs.insert("bot2@example.com".to_string());
        assert!(is_bot_addr("bot1@example.com", &addrs));
        assert!(is_bot_addr("bot2@example.com", &addrs));
        assert!(!is_bot_addr("alice@example.com", &addrs));
        assert!(!is_bot_addr("", &addrs));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("short", 40), "short");
        assert_eq!(truncate("a", 1), "a");
        let s = truncate("这是一个很长的回复内容", 5);
        assert_eq!(s.chars().count(), 6); // 5 字符 + 省略号
        assert!(s.ends_with('…'));
    }

    #[test]
    fn test_rate_limiter_enforces_interval() {
        let ms = Arc::new(AtomicU64::new(0));
        let ms_clone = ms.clone();
        let start = Instant::now();
        let limiter = RateLimiter::with_clock(move || start + Duration::from_millis(ms_clone.load(Ordering::Relaxed)));

        let interval = Duration::from_millis(1000);
        assert!(limiter.try_acquire(1, 100, interval));
        // 同一会话立刻再来 → 拒绝
        assert!(!limiter.try_acquire(1, 100, interval));
        // 不同会话 → 允许
        assert!(limiter.try_acquire(1, 101, interval));
        // 同一 bot 不同会话不互相影响
        assert!(limiter.try_acquire(2, 100, interval));

        // 时间推进 1000ms → 同一会话允许
        ms.store(1000, Ordering::Relaxed);
        assert!(limiter.try_acquire(1, 100, interval));
        // 未达间隔仍拒绝
        ms.store(1499, Ordering::Relaxed);
        assert!(!limiter.try_acquire(1, 100, interval));
        ms.store(1500, Ordering::Relaxed);
        assert!(limiter.try_acquire(1, 100, interval));
    }
}
```

- [ ] **Step 2: 运行确认失败**

在 `lib.rs` 加 `mod runtime;`,然后:
Run: `cargo test --lib runtime::tests -- --nocapture`
Expected: FAIL(编译错误,`runtime` 内符号未定义)

- [ ] **Step 3: 实现**

写完整 `src-tauri/src/runtime.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use deltachat::accounts::Accounts;
use deltachat::chat::{self, ChatId};
use deltachat::config::Config;
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, MsgId, Viewtype};
use deltachat::EventType;
use tokio::sync::{Mutex, Semaphore};

use crate::activity::ActivityLog;
use crate::db::Db;
use crate::dto::{BotConfig, bot_activity_kind as act};
use crate::drivers::{BotDriver, BotRuntime, DriverRegistry, IncomingMsg, driver_kind_label};
use crate::error::AppResult;

/// 全局并发上限:跨所有 bot 的 LLM/驱动调用总数。
const GLOBAL_MAX_CONCURRENT: usize = 4;

/// 启动 bot 事件调度器。常驻后台:接收所有账号 IncomingMsg,
/// 命中 bot_ids 后快速 spawn 处理任务(并发受信号量限制)。
pub async fn spawn(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    bot_ids: Arc<Mutex<HashSet<u32>>>,
    activity: ActivityLog,
    registry: DriverRegistry,
) {
    let emitter = {
        let accounts = accounts.lock().await;
        accounts.get_event_emitter()
    };
    let global = Arc::new(Semaphore::new(GLOBAL_MAX_CONCURRENT));
    let per_bot: Arc<Mutex<HashMap<u32, Arc<Semaphore>>>> = Arc::new(Mutex::new(HashMap::new()));
    let rate: Arc<RateLimiter> = Arc::new(RateLimiter::new());

    while let Some(event) = emitter.recv().await {
        let EventType::IncomingMsg { chat_id, msg_id } = event.typ else {
            continue;
        };
        let account_id = event.id;
        let is_bot = {
            bot_ids.lock().await.contains(&account_id)
        };
        if !is_bot {
            continue;
        }

        let accounts = accounts.clone();
        let db = db.clone();
        let bot_ids = bot_ids.clone();
        let activity = activity.clone();
        let registry = registry.clone();
        let global = global.clone();
        let per_bot = per_bot.clone();
        let rate = rate.clone();
        tokio::spawn(async move {
            let Ok(permit) = global.acquire().await else {
                return;
            };
            let _permit = permit;
            handle_bot_message(
                &accounts, &db, &bot_ids, &activity, &registry, &per_bot, &rate,
                account_id, chat_id, msg_id,
            )
            .await;
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_bot_message(
    accounts: &Arc<Mutex<Accounts>>,
    db: &Arc<Db>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
    activity: &ActivityLog,
    registry: &DriverRegistry,
    per_bot: &Arc<Mutex<HashMap<u32, Arc<Semaphore>>>>,
    rate: &Arc<RateLimiter>,
    account_id: u32,
    chat_id: ChatId,
    msg_id: MsgId,
) {
    let row = match db.get_bot_by_account_id(account_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return,
        Err(e) => {
            log::warn!("bot {account_id}: query row failed: {e}");
            return;
        }
    };
    let bot_id = row.id;
    if row.status != "running" {
        log::debug!("bot {bot_id}: status != running, skip");
        return;
    }

    let Some(config) = BotConfig::parse(row.config_json.as_deref()) else {
        activity
            .record(
                bot_id,
                act::NO_CONFIG,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                format!("bot {bot_id}: 无有效配置,跳过自动回复"),
                None,
            )
            .await;
        return;
    };

    // 每 bot 并发信号量(按账号缓存)
    let max_concurrent = config.limits.max_concurrent.max(1) as usize;
    let sema = {
        let mut map = per_bot.lock().await;
        map.entry(account_id)
            .or_insert_with(|| Arc::new(Semaphore::new(max_concurrent)))
            .clone()
    };
    let Ok(permit) = sema.acquire().await else {
        return;
    };
    let _permit = permit;

    // 短取 context + 触发消息 + 发送者
    let ctx = {
        accounts.lock().await.get_account(account_id)
    };
    let Some(ctx) = ctx else {
        log::warn!("bot {bot_id} (account {account_id}) context unavailable");
        return;
    };
    let m = match Message::load_from_db(&ctx, msg_id).await {
        Ok(m) => m,
        Err(e) => {
            log::warn!("bot {bot_id}: load msg failed: {e}");
            return;
        }
    };
    let from_addr = match Contact::get_by_id(&ctx, m.get_from_id()).await {
        Ok(c) => c.get_addr().to_string(),
        Err(e) => {
            log::warn!("bot {bot_id}: sender contact load failed: {e}");
            return;
        }
    };

    // 防循环:发送者是另一个 bot → 跳过
    if is_bot_addr(&from_addr, collect_bot_addrs(accounts, bot_ids).await) {
        activity
            .record(
                bot_id,
                act::REPLY_SKIPPED,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                "跳过回复(发送者是另一个 Bot)",
                None,
            )
            .await;
        return;
    }

    // 每会话回复间隔限流
    let interval = Duration::from_secs(config.limits.reply_min_interval_secs.max(1));
    if !rate.try_acquire(bot_id, chat_id.to_u32(), interval) {
        activity
            .record(
                bot_id,
                act::REPLY_RATE_LIMITED,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                "回复过于频繁,本次跳过",
                None,
            )
            .await;
        return;
    }

    // 组装运行时上下文,逐个驱动调度
    let runtime = BotRuntime {
        bot_id,
        account_id,
        dc: &ctx,
        config: &config,
        db,
        activity,
    };
    let incoming = IncomingMsg {
        chat_id,
        msg_id,
        from_addr: from_addr.as_str(),
        text: Some(m.get_text().as_str()),
        viewtype: m.get_viewtype(),
    };

    let mut replies: Vec<String> = Vec::new();
    for driver in registry.drivers() {
        match driver.on_message(&runtime, &incoming).await {
            Ok(rs) => replies.extend(rs),
            Err(e) => {
                activity
                    .record(
                        bot_id,
                        act::LLM_ERROR,
                        Some(chat_id.to_u32()),
                        Some(msg_id.to_u32()),
                        format!("驱动 {} 执行失败: {e}", driver_kind_label(driver.kind())),
                        Some(format!("{{\"error\":\"{e}\"}}")),
                    )
                    .await;
            }
        }
    }

    for reply in replies {
        let mut out = Message::new(Viewtype::Text);
        out.set_text(reply.clone());
        match chat::send_msg(&ctx, chat_id, &mut out).await {
            Ok(_) => {
                activity
                    .record(
                        bot_id,
                        act::REPLY_SENT,
                        Some(chat_id.to_u32()),
                        Some(msg_id.to_u32()),
                        format!("回复 {from_addr}: {}", truncate(&reply, 40)),
                        None,
                    )
                    .await;
            }
            Err(e) => log::warn!("bot {bot_id}: send reply failed: {e}"),
        }
    }
}

/// 收集所有 bot 账号的已配置邮箱地址,用于防 bot 互聊。
async fn collect_bot_addrs(
    accounts: &Arc<Mutex<Accounts>>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
) -> HashSet<String> {
    let ids: Vec<u32> = bot_ids.lock().await.iter().copied().collect();
    let mut addrs = HashSet::new();
    for id in ids {
        let ctx = {
            accounts.lock().await.get_account(id)
        };
        if let Some(ctx) = ctx {
            if let Ok(Some(addr)) = ctx.get_config(Config::ConfiguredAddr).await {
                addrs.insert(addr);
            }
        }
    }
    addrs
}

/// 判断地址是否属于某个 bot 账号(用于阻止 bot 之间互聊)。
fn is_bot_addr(addr: &str, bot_addrs: &HashSet<String>) -> bool {
    bot_addrs.contains(addr)
}

/// 截断字符串到 n 个字符,超长加省略号。
fn truncate(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    let t: String = s.chars().take(n).collect();
    format!("{t}…")
}

/// 每会话回复间隔限流(时钟可注入,便于单测)。
pub struct RateLimiter {
    last: StdMutex<HashMap<(i64, u32), Instant>>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_clock(Instant::now)
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_clock<F>(now: F) -> Self
    where
        F: Fn() -> Instant + Send + Sync + 'static,
    {
        Self {
            last: StdMutex::new(HashMap::new()),
            now: Box::new(now),
        }
    }

    /// 返回 true 表示允许(距上次回复 >= interval),并在允许时记录本次时间。
    pub fn try_acquire(&self, bot_id: i64, chat_id: u32, interval: Duration) -> bool {
        let mut last = self.last.lock().unwrap();
        let key = (bot_id, chat_id);
        match last.get(&key) {
            Some(t) if (self.now)() - *t < interval => false,
            _ => {
                last.insert(key, (self.now)());
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn test_is_bot_addr() {
        let mut addrs = HashSet::new();
        addrs.insert("bot1@example.com".to_string());
        addrs.insert("bot2@example.com".to_string());
        assert!(is_bot_addr("bot1@example.com", &addrs));
        assert!(is_bot_addr("bot2@example.com", &addrs));
        assert!(!is_bot_addr("alice@example.com", &addrs));
        assert!(!is_bot_addr("", &addrs));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("short", 40), "short");
        assert_eq!(truncate("a", 1), "a");
        let s = truncate("这是一个很长的回复内容", 5);
        assert_eq!(s.chars().count(), 6);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn test_rate_limiter_enforces_interval() {
        let ms = Arc::new(AtomicU64::new(0));
        let ms_clone = ms.clone();
        let start = Instant::now();
        let limiter = RateLimiter::with_clock(move || {
            start + Duration::from_millis(ms_clone.load(Ordering::Relaxed))
        });

        let interval = Duration::from_millis(1000);
        assert!(limiter.try_acquire(1, 100, interval));
        assert!(!limiter.try_acquire(1, 100, interval));
        assert!(limiter.try_acquire(1, 101, interval));
        assert!(limiter.try_acquire(2, 100, interval));

        ms.store(1000, Ordering::Relaxed);
        assert!(limiter.try_acquire(1, 100, interval));
        ms.store(1499, Ordering::Relaxed);
        assert!(!limiter.try_acquire(1, 100, interval));
        ms.store(1500, Ordering::Relaxed);
        assert!(limiter.try_acquire(1, 100, interval));
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib runtime::tests -- --nocapture`
Expected: PASS(3 个新测试)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/runtime.rs src-tauri/src/lib.rs
git commit -m "feat(runtime): 事件调度器(并发信号量/会话限流/错误隔离/活动日志)"
```

---

### Task 7: bots.rs — config 读写 + owner 校验 + 移除 spawn_runtime

**Files:**
- Modify: `src-tauri/src/bots.rs`

**Interfaces:**
- Consumes: Task 1 `BotConfig`/`LlmConfig`/`LlmConfigInput`;Task 2 现有 owner-scoped db 方法(`get_bot`/`delete_bot`/`set_bot_config`/`get_bot_config`/`set_bot_status`)
- Produces(后续任务依赖):
  - `pub async fn list(&self, owner_id: u32) -> AppResult<Vec<BotDto>>`(改为 owner 范围)
  - `pub async fn delete(&self, owner_id: u32, bot_id: i64) -> AppResult<()>`
  - `pub async fn set_io(&self, owner_id: u32, bot_id: i64, running: bool) -> AppResult<BotDto>`
  - `pub async fn ctx_for_bot(&self, owner_id: u32, bot_id: i64) -> AppResult<Context>`
  - `pub async fn get_config(&self, owner_id: u32, bot_id: i64) -> AppResult<Option<BotConfig>>`
  - `pub async fn save_config(&self, owner_id: u32, bot_id: i64, config: &BotConfig) -> AppResult<()>`
  - `pub async fn update_llm(&self, owner_id: u32, bot_id: i64, input: LlmConfigInput) -> AppResult<BotDto>`(替代旧 update_bot_llm)
  - `pub async fn llm_of(&self, owner_id: u32, bot_id: i64) -> AppResult<Option<LlmConfig>>`(替代旧 get_bot_llm)
  - `pub async fn dto(&self, owner_id: u32, bot_id: i64) -> AppResult<BotDto>`(供命令复用)
  - 删除 `spawn_runtime`(接线移往 lib.rs Task 9)

- [ ] **Step 1: 改测试以匹配新签名**

在 `src-tauri/src/bots.rs` 的 `mod tests` 中,把既有 `svc.list()` → `svc.list(owner_id)`,`svc.delete(999)` → `svc.delete(owner_id, 999)`,`svc.set_io(bot_id, false)` → `svc.set_io(owner_id, bot_id, false)`,`svc.ctx_for_bot(bot_id)` → `svc.ctx_for_bot(owner_id, bot_id)`,`svc.update_bot_llm(bot_id, ...)` → `svc.update_llm(owner_id, bot_id, ...)`,`svc.get_bot_llm(bot_id)` → `svc.llm_of(owner_id, bot_id)`。并追加:

```rust
/// list 只返回当前 owner 的 bot;owner 不匹配的 get_config 报 not found。
#[tokio::test(flavor = "multi_thread")]
async fn test_list_and_config_owner_scoped() {
    let tmp = tempfile::tempdir().unwrap();
    let (accounts, db, svc) = test_env(&tmp).await;

    let owner_id = 1u32;
    let bot_account_id = {
        let mut accounts = accounts.lock().await;
        accounts.add_account().await.unwrap()
    };
    let bot_id = db
        .insert_bot(owner_id, bot_account_id, "ScopedBot", chrono::Utc::now().timestamp())
        .await
        .unwrap();

    // owner 正确
    assert_eq!(svc.list(owner_id).await.unwrap().len(), 1);
    assert_eq!(svc.get_config(owner_id, bot_id).await.unwrap(), None);
    // 非 owner 一律 not found
    assert!(svc.list(999).await.unwrap().is_empty());
    let err = svc.get_config(999, bot_id).await.unwrap_err();
    assert!(matches!(err, AppError::Core(_)));
    let err = svc.ctx_for_bot(999, bot_id).await.unwrap_err();
    assert!(matches!(err, AppError::Core(_)));
}

/// update_llm → llm_of 往返一致;llm_of 返回可读回的 LlmConfig。
#[tokio::test(flavor = "multi_thread")]
async fn test_update_llm_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let (accounts, db, svc) = test_env(&tmp).await;

    let owner_id = 1u32;
    let bot_account_id = {
        let mut accounts = accounts.lock().await;
        accounts.add_account().await.unwrap()
    };
    let bot_id = db
        .insert_bot(owner_id, bot_account_id, "LlmBot", chrono::Utc::now().timestamp())
        .await
        .unwrap();

    let input = LlmConfigInput {
        system_prompt: Some("你是助手".to_string()),
        base_url: Some("https://api.example.com/v1".to_string()),
        api_key: Some("sk-test".to_string()),
        model: Some("gpt-4o-mini".to_string()),
        provider: Some("openai".to_string()),
    };
    svc.update_llm(owner_id, bot_id, input.clone()).await.unwrap();

    let read = svc.llm_of(owner_id, bot_id).await.unwrap().expect("llm config present");
    assert_eq!(read.system_prompt, input.system_prompt);
    assert_eq!(read.model, input.model);
    assert_eq!(read.temperature, 0.7);
    assert!(read.is_complete());

    // 整包 get_config 也能读回
    let cfg = svc.get_config(owner_id, bot_id).await.unwrap().expect("config present");
    assert!(cfg.llm.is_some());
    assert_eq!(cfg.limits.max_concurrent, 2);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib bots::tests -- --nocapture`
Expected: FAIL(编译错误,签名不匹配)

- [ ] **Step 3: 实现**

改 `src-tauri/src/bots.rs`:

(1) `list` 改为 owner 范围:

```rust
    /// 列出指定用户的所有 bot,读取其账号地址与 IO 运行状态。
    /// 账号上下文不可用时优雅跳过(addr = None)。
    pub async fn list(&self, owner_id: u32) -> AppResult<Vec<BotDto>> {
        let rows = self.db.list_bots(owner_id).await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let ctx = self.accounts.lock().await.get_account(row.bot_account_id);
            let addr = match &ctx {
                Some(ctx) => ctx.get_config(Config::ConfiguredAddr).await.ok().flatten(),
                None => None,
            };
            out.push(BotDto {
                id: row.id,
                bot_account_id: row.bot_account_id,
                display_name: row.display_name,
                addr,
                io_running: row.status == "running",
                created_at: row.created_at,
            });
        }
        Ok(out)
    }
```

(2) `delete` 加 owner:

```rust
    /// 删除 bot:校验归属 → 停 IO → 移除 accounts 账号 → 删除 db 行。
    pub async fn delete(&self, owner_id: u32, bot_id: i64) -> AppResult<()> {
        let row = self
            .db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        if let Some(ctx) = self.accounts.lock().await.get_account(row.bot_account_id) {
            ctx.stop_io().await;
        }
        self.accounts
            .lock()
            .await
            .remove_account(row.bot_account_id)
            .await?;
        self.db.delete_bot(owner_id, bot_id).await?;
        self.bot_ids.lock().await.remove(&row.bot_account_id);
        Ok(())
    }
```

(3) `set_io` 加 owner(把 `get_bot_by_id`/`set_bot_status_by_id` 换成 owner 版本):

```rust
    /// 启/停单个 bot 的 IO(校验归属),并把状态写回 db,返回最新 DTO。
    pub async fn set_io(&self, owner_id: u32, bot_id: i64, running: bool) -> AppResult<BotDto> {
        let row = self
            .db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let ctx = self.accounts.lock().await.get_account(row.bot_account_id);
        if let Some(ctx) = &ctx {
            if running {
                ctx.start_io().await;
            } else {
                ctx.stop_io().await;
            }
        }
        let status = if running { "running" } else { "stopped" };
        self.db.set_bot_status(owner_id, bot_id, status).await?;
        self.dto(owner_id, bot_id).await
    }
```

(4) `ctx_for_bot` 加 owner:

```rust
    /// 返回 bot 的 deltachat Context(校验归属)。
    pub async fn ctx_for_bot(&self, owner_id: u32, bot_id: i64) -> AppResult<Context> {
        let row = self
            .db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let ctx = self
            .accounts
            .lock()
            .await
            .get_account(row.bot_account_id)
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        Ok(ctx)
    }
```

(5) 删除旧 `update_bot_llm` / `get_bot_llm`,替换为 config 系列 + `dto` helper:

```rust
    /// 读取某个 bot 的结构化配置(BotConfig);未配置或非法返回 None。
    pub async fn get_config(&self, owner_id: u32, bot_id: i64) -> AppResult<Option<BotConfig>> {
        self.db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let raw = self.db.get_bot_config(owner_id, bot_id).await?;
        Ok(BotConfig::parse(raw.as_deref()))
    }

    /// 整体覆写某个 bot 的结构化配置。
    pub async fn save_config(&self, owner_id: u32, bot_id: i64, config: &BotConfig) -> AppResult<()> {
        self.db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let json = serde_json::to_string(config)
            .map_err(|e| AppError::Core(format!("config serialize: {e}")))?;
        self.db.set_bot_config(owner_id, bot_id, Some(&json)).await
    }

    /// 更新某个 bot 的 LLM 配置(兼容旧命令 update_bot_llm),返回最新 DTO。
    pub async fn update_llm(
        &self,
        owner_id: u32,
        bot_id: i64,
        input: LlmConfigInput,
    ) -> AppResult<BotDto> {
        let mut config = self.get_config(owner_id, bot_id).await?.unwrap_or_default();
        config.llm = Some(LlmConfig::from(input));
        self.save_config(owner_id, bot_id, &config).await?;
        self.dto(owner_id, bot_id).await
    }

    /// 读取某个 bot 的 LLM 配置(兼容旧命令 get_bot_llm);未配置返回 None。
    pub async fn llm_of(&self, owner_id: u32, bot_id: i64) -> AppResult<Option<LlmConfig>> {
        Ok(self.get_config(owner_id, bot_id).await?.and_then(|c| c.llm))
    }

    /// 组装某个 bot 的最新 DTO(供命令复用)。
    pub async fn dto(&self, owner_id: u32, bot_id: i64) -> AppResult<BotDto> {
        let row = self
            .db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let ctx = self.accounts.lock().await.get_account(row.bot_account_id);
        let addr = match &ctx {
            Some(ctx) => ctx.get_config(Config::ConfiguredAddr).await?,
            None => None,
        };
        Ok(BotDto {
            id: row.id,
            bot_account_id: row.bot_account_id,
            display_name: row.display_name,
            addr,
            io_running: row.status == "running",
            created_at: row.created_at,
        })
    }
```

(6) 删除 `spawn_runtime` 方法(整段)。

同时更新 `use` 行:顶部 `use crate::dto::{BotDto, LlmConfigInput};` 改为 `use crate::dto::{BotConfig, BotDto, LlmConfig, LlmConfigInput};`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib bots::tests -- --nocapture`
Expected: PASS(既有测试改签名后全过 + 2 个新测试)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/bots.rs
git commit -m "refactor(bots): owner 校验 + BotConfig 读写 + 移除 spawn_runtime"
```

---

### Task 8: commands.rs — owner 校验 + get/update_bot_config + 旧命令薄包装

**Files:**
- Modify: `src-tauri/src/commands.rs`(bot 命令区块,约 2982–3119 行)

**Interfaces:**
- Consumes: Task 7 `BotService` 新签名(`list(owner)`/`delete(owner,..)`/`set_io(owner,..)`/`ctx_for_bot(owner,..)`/`get_config`/`save_config`/`update_llm`/`llm_of`/`dto`);Task 4 `LlmClient`;`current_owner_id` helper(已存在,约 2974 行)
- Produces: 前端命令 `get_bot_config(bot_id) -> Option<BotConfig>`、`update_bot_config(bot_id, config) -> BotDto`(新);既有 `update_bot_llm`/`get_bot_llm` 保持签名但改走 `update_llm`/`llm_of`;其余 bot 命令全部过 owner 校验。

- [ ] **Step 1: 先编译确认当前基线**

Run: `cargo check`
Expected: FAIL(Task 7 已改签名,commands.rs 调旧签名报错)——这是预期,step 3 修复。

- [ ] **Step 2: 改命令实现**

逐个替换(新命令与兼容包装给出完整代码;`bot_get_chatlist` / `bot_get_chat_msgs` / `bot_send_text` / `bot_mark_chat_noticed` / `bot_mark_chat_seen` / `add_bot_to_chat` 只改一处——把 `ctx_for_bot(bot_id)` 换成 `ctx_for_bot(current_owner_id(&state)?, bot_id)`):

```rust
/// 列出当前用户的所有 bot。
#[tauri::command]
pub async fn list_bots(state: State<'_, AppState>) -> AppResult<Vec<BotDto>> {
    let owner_id = current_owner_id(&state)?;
    state.bots.list(owner_id).await
}

/// 删除当前用户的一个 bot。
#[tauri::command]
pub async fn delete_bot(state: State<'_, AppState>, bot_id: i64) -> AppResult<()> {
    let owner_id = current_owner_id(&state)?;
    state.bots.delete(owner_id, bot_id).await
}

/// 启/停当前用户某个 bot 的 IO。
#[tauri::command]
pub async fn set_bot_io(state: State<'_, AppState>, bot_id: i64, running: bool) -> AppResult<BotDto> {
    let owner_id = current_owner_id(&state)?;
    state.bots.set_io(owner_id, bot_id, running).await
}

/// 更新当前用户某个 bot 的 LLM 配置(兼容旧前端)。
#[tauri::command]
pub async fn update_bot_llm(
    state: State<'_, AppState>,
    bot_id: i64,
    config: crate::dto::LlmConfigInput,
) -> AppResult<BotDto> {
    let owner_id = current_owner_id(&state)?;
    state.bots.update_llm(owner_id, bot_id, config).await
}

/// 读取当前用户某个 bot 的 LLM 配置(兼容旧前端;未配置时为 None)。
#[tauri::command]
pub async fn get_bot_llm(
    state: State<'_, AppState>,
    bot_id: i64,
) -> AppResult<Option<crate::dto::LlmConfig>> {
    let owner_id = current_owner_id(&state)?;
    state.bots.llm_of(owner_id, bot_id).await
}

/// 读取当前用户某个 bot 的完整结构化配置。
#[tauri::command]
pub async fn get_bot_config(
    state: State<'_, AppState>,
    bot_id: i64,
) -> AppResult<Option<crate::dto::BotConfig>> {
    let owner_id = current_owner_id(&state)?;
    state.bots.get_config(owner_id, bot_id).await
}

/// 整体覆写当前用户某个 bot 的完整结构化配置。
#[tauri::command]
pub async fn update_bot_config(
    state: State<'_, AppState>,
    bot_id: i64,
    config: crate::dto::BotConfig,
) -> AppResult<BotDto> {
    let owner_id = current_owner_id(&state)?;
    state.bots.save_config(owner_id, bot_id, &config).await?;
    state.bots.dto(owner_id, bot_id).await
}
```

其余命令统一替换 `ctx_for_bot(bot_id)` → `ctx_for_bot(current_owner_id(&state)?, bot_id)`:
- `bot_get_chatlist` / `bot_get_chat_msgs` / `bot_send_text` / `bot_mark_chat_noticed` / `bot_mark_chat_seen` / `add_bot_to_chat`

`test_llm_config` 改为走 `LlmClient`:

```rust
/// 测试 LLM 配置:用固定示例消息调用一次,返回回复文本(用于配置对话框的「测试连接」)。
#[tauri::command]
pub async fn test_llm_config(config: crate::dto::LlmConfigInput) -> AppResult<String> {
    let client = crate::llm::LlmClient::new();
    let msg = crate::llm::ChatMessage {
        role: "user".into(),
        content: "你好，请用一句话回复。".into(),
    };
    client.complete(&crate::dto::LlmConfig::from(config), vec![msg]).await
}
```

- [ ] **Step 3: 运行确认通过**

Run: `cargo check`
Expected: PASS

- [ ] **Step 4: 全量测试**

Run: `cargo test --lib`
Expected: PASS(全部既有 + 新增测试)

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): bot 命令 owner 校验 + get/update_bot_config + 旧命令兼容包装"
```

---

### Task 9: lib.rs — 装配 runtime + 事件接线 + 删除 bot_llm.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Delete: `src-tauri/src/bot_llm.rs`

**Interfaces:**
- Consumes: Task 3 `ActivityLog`;Task 4 `LlmClient`;Task 5 `DriverRegistry`/`LlmDriver`;Task 6 `runtime::spawn`;Task 8 新命令;`tauri::Emitter`
- Produces: 运行时可用的完整装配;`bot-activity` 事件实时推送。

- [ ] **Step 1: 编译基线(应失败于 bot_llm 引用)**

Run: `cargo check`
Expected: FAIL(`bot_llm` 模块引用或 `state.bots.spawn_runtime` 不存在)——预期,Step 3 修复。

- [ ] **Step 2: 改 lib.rs**

(1) 模块声明区(1–12 行)改为:

```rust
mod activity;
mod bots;
mod commands;
mod db;
mod drivers;
mod dto;
mod envelope;
mod error;
mod events;
mod llm;
mod plugins;
mod runtime;
mod state;
```

(2) `setup` 闭包内,把 `state.bots.spawn_runtime();`(约 42 行)替换为完整装配:

```rust
            // 活动日志:落库 + 实时 bot-activity 事件(时间线页/打字指示器通道)
            let activity = {
                let handle = app.handle().clone();
                crate::activity::ActivityLog::new(state.db.clone()).with_callback(move |a| {
                    use tauri::Emitter;
                    let _ = handle.emit("bot-activity", &a);
                })
            };
            // 驱动注册:B1 只有 LLM 驱动(后续 B3 加规则/定时)
            let mut registry = crate::drivers::DriverRegistry::new();
            registry.register(std::sync::Arc::new(crate::drivers::llm::LlmDriver::new(
                crate::llm::LlmClient::new(),
            )));
            // 挂载事件调度器(常驻后台)
            tauri::async_runtime::spawn(crate::runtime::spawn(
                state.accounts.clone(),
                state.db.clone(),
                state.bots.bot_ids(),
                activity,
                registry,
            ));
```

(3) `invoke_handler` 的 Bot 系统区块(约 158–173 行)追加两个命令:

```rust
            commands::get_bot_config,
            commands::update_bot_config,
```

(4) 删除文件 `src-tauri/src/bot_llm.rs`。

- [ ] **Step 3: 运行确认通过**

Run: `cargo check` → PASS
Run: `cargo test --lib` → 全部通过(确认旧 bot_llm 测试已随文件删除,其逻辑测试已迁至 drivers/llm.rs)

- [ ] **Step 4: 前端类型检查(无改动,应保持绿)**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git rm src-tauri/src/bot_llm.rs
git add src-tauri/src/lib.rs
git commit -m "refactor(lib): 装配 driver runtime + bot-activity 事件,删除 bot_llm.rs"
```

---

## 手动验收(全部任务完成后)

- [ ] `npm run tauri dev` 启动无报错;创建 Bot 后 `list_bots` 正常
- [ ] 配旧格式 config_json 的既有 Bot:`get_bot_llm` 读回正常(`BotConfig::parse` 迁移生效)
- [ ] 两个 Bot 同时收到消息:慢 LLM 不阻塞另一个(每 bot + 全局信号量生效)
- [ ] 连续快速发多条:按 `reply_min_interval_secs` 间隔回复,其余记 `reply_rate_limited`
- [ ] 错误 api_key:不重试,记 `llm_error`;5xx 后端:重试 2 次后退避
- [ ] `bot_activities` 表有记录;前端能收到 `bot-activity` 事件
