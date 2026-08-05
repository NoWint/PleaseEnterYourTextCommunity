use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use deltachat::chat::ChatId;
use deltachat::context::Context;

use crate::db::Db;
use crate::dto::KnowledgeDto;
use crate::error::{AppError, AppResult};
use crate::knowledge::store::row_to_dto;
use crate::llm::ChatMessage;

/// BoxFuture 别名(std 定义,避免引入 futures 依赖)。
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// LLM 调用回调,由集成者注入真实实现(调智能运行时),知识库模块不直接依赖 LlmClient。
pub type LlmFn =
    Arc<dyn Fn(Vec<ChatMessage>) -> BoxFuture<'static, AppResult<String>> + Send + Sync>;

/// 聊天历史回调(chat_id, count) → 消息列表;默认走 build_history_n,测试注入假历史。
pub type HistoryFn = Arc<
    dyn Fn(u32, usize) -> BoxFuture<'static, AppResult<Vec<ChatMessage>>> + Send + Sync,
>;

/// 总结入库流水线:取历史 → LLM 生成结构化知识条目(JSON)→ upsert 入库。
pub struct SummarizePipeline {
    db: Arc<Db>,
    llm: LlmFn,
    /// None = 生产默认(用 ctx 调 build_history_n);Some = 测试/集成注入的假历史。
    history: Option<HistoryFn>,
}

impl SummarizePipeline {
    pub fn new(db: Arc<Db>, llm: LlmFn) -> Self {
        Self {
            db,
            llm,
            history: None,
        }
    }

    /// 注入历史回调(测试用假历史,或集成者自定义历史来源)。
    pub fn with_history(mut self, history: HistoryFn) -> Self {
        self.history = Some(history);
        self
    }

    /// 替换 LLM 回调(测试注入假 LLM)。
    pub fn with_llm(mut self, llm: LlmFn) -> Self {
        self.llm = llm;
        self
    }

    /// 总结最近 count 条消息并入库(同 chat+date 重复调用走 upsert 更新)。
    pub async fn store_summary(
        &self,
        ctx: &Context,
        chat_id: u32,
        count: usize,
        source: &str,
    ) -> AppResult<KnowledgeDto> {
        let history = match &self.history {
            Some(f) => f(chat_id, count).await?,
            None => crate::drivers::llm::build_history_n(ctx, ChatId::new(chat_id), count).await?,
        };
        if history.is_empty() {
            return Err(AppError::Core(format!(
                "chat {chat_id} 无历史消息,无法生成知识条目"
            )));
        }

        let mut msgs = Vec::with_capacity(history.len() + 1);
        msgs.push(ChatMessage {
            role: "system".into(),
            content: "你是聊天知识沉淀助手。根据聊天记录生成结构化知识条目,只输出 JSON,不要解释。\
                      格式:{\"title\": 标题, \"summary\": 结构化要点, \"tags\": 标签数组}"
                .into(),
            ..Default::default()
        });
        msgs.extend(history.clone());

        let raw = match (self.llm)(msgs).await {
            Ok(text) => text,
            Err(e) => {
                log::warn!("knowledge store_summary: LLM 调用失败,降级为原文条目: {e}");
                String::new()
            }
        };
        let (title, summary, tags) = parse_knowledge_json(&raw, &history);

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
        let id = self
            .db
            .upsert_knowledge(chat_id, &today, &title, &summary, &tags_json, count as u32, source)
            .await?;
        let row = self.db.get_knowledge(id).await?;
        row.map(row_to_dto).ok_or_else(|| {
            AppError::Core(format!("知识条目 {id} upsert 后查询失败"))
        })
    }

    /// 每日自动总结:遍历启用 daily 的配置,到点且当日未跑则执行。
    /// 单会话失败只记日志不中断,返回成功会话数。
    pub async fn run_daily(&self, ctx: &Context) -> AppResult<usize> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let now_hhmm = chrono::Local::now().format("%H:%M").to_string();
        let cfgs = self.db.list_knowledge_configs().await?;

        let mut ok = 0usize;
        for cfg in cfgs {
            if !cfg.daily_enabled {
                continue;
            }
            if !is_due(&now_hhmm, &cfg.daily_time, cfg.daily_run_date.as_deref(), &today) {
                continue;
            }
            if let Err(e) = self.db.mark_daily_run(cfg.chat_id, &today).await {
                eprintln!("knowledge run_daily: mark_daily_run(chat={}) 失败: {e}", cfg.chat_id);
                continue;
            }
            match self
                .store_summary(ctx, cfg.chat_id, cfg.window_count as usize, "daily")
                .await
            {
                Ok(_) => ok += 1,
                Err(e) => {
                    eprintln!("knowledge run_daily: chat={} 总结失败: {e}", cfg.chat_id);
                }
            }
        }
        Ok(ok)
    }
}

/// 解析 LLM 输出的结构化知识条目;失败降级:
/// title=首条消息文本截断 50 字,summary=LLM 原文(空则取首条消息),tags=[]。
pub fn parse_knowledge_json(raw: &str, history: &[ChatMessage]) -> (String, String, Vec<String>) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(title) = v.get("title").and_then(|t| t.as_str()) {
            let title = title.to_string();
            let summary = v
                .get("summary")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let tags = v
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            return (title, summary, tags);
        }
    }
    let first = history.first().map(|m| m.content.as_str()).unwrap_or("");
    let title: String = first.chars().take(50).collect();
    let summary = if raw.trim().is_empty() {
        first.to_string()
    } else {
        raw.to_string()
    };
    (title, summary, Vec::new())
}

/// 到点判定:当前 HH:MM >= 配置时间 且 当日尚未运行过(字符串比较依赖 HH:MM 零填充)。
pub fn is_due(now_hhmm: &str, cfg_time: &str, run_date: Option<&str>, today: &str) -> bool {
    run_date != Some(today) && now_hhmm >= cfg_time
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use deltachat::context::ContextBuilder;

    async fn test_env() -> (tempfile::TempDir, SummarizePipeline) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let llm = fake_llm("");
        let pipe = SummarizePipeline::new(Arc::new(db), llm);
        (tmp, pipe)
    }

    /// 假 LLM:固定返回 text。
    fn fake_llm(text: &str) -> LlmFn {
        let text = text.to_string();
        Arc::new(move |_msgs| {
            let text = text.clone();
            Box::pin(async move { Ok(text) })
        })
    }

    /// 假历史:固定返回 msgs。
    fn fake_history(msgs: Vec<ChatMessage>) -> HistoryFn {
        Arc::new(move |_chat_id, _count| {
            let msgs = msgs.clone();
            Box::pin(async move { Ok(msgs) })
        })
    }

    fn msg(content: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: content.into(),
            ..Default::default()
        }
    }

    /// 最小可用 deltachat Context(测试中仅作签名占位,历史已注入不会真正查询)。
    async fn dummy_ctx(tmp: &tempfile::TempDir) -> deltachat::context::Context {
        ContextBuilder::new(tmp.path().join("ctx.db")).with_id(1).build().await.unwrap()
    }

    fn sample_history() -> Vec<ChatMessage> {
        vec![
            msg("今天讨论了 Rust 的所有权模型,生命周期是重点。"),
            msg("下周计划:完成知识库模块的代码评审。"),
        ]
    }

    #[test]
    fn test_parse_valid_json() {
        let raw = r#"{"title":"Rust 周会","summary":"1. 所有权;2. 生命周期","tags":["rust","会议"]}"#;
        let (title, summary, tags) = parse_knowledge_json(raw, &sample_history());
        assert_eq!(title, "Rust 周会");
        assert_eq!(summary, "1. 所有权;2. 生命周期");
        assert_eq!(tags, vec!["rust".to_string(), "会议".to_string()]);
    }

    #[test]
    fn test_parse_invalid_json_fallback() {
        let raw = "完全不是 JSON 的输出";
        let (title, summary, tags) = parse_knowledge_json(raw, &sample_history());
        assert_eq!(title, "今天讨论了 Rust 的所有权模型,生命周期是重点。");
        assert_eq!(summary, raw);
        assert!(tags.is_empty());
    }

    #[test]
    fn test_parse_json_missing_title_fallback() {
        let raw = r#"{"summary":"只有摘要"}"#;
        let (title, _, tags) = parse_knowledge_json(raw, &sample_history());
        assert_eq!(title, "今天讨论了 Rust 的所有权模型,生命周期是重点。");
        assert!(tags.is_empty());
    }

    #[test]
    fn test_parse_truncates_title_to_50_chars() {
        let long = "长".repeat(80);
        let (title, _, _) = parse_knowledge_json("bad", &[msg(&long)]);
        assert_eq!(title.chars().count(), 50);
    }

    #[test]
    fn test_is_due() {
        let today = "2026-01-01";
        assert!(is_due("10:00", "09:00", None, today));
        assert!(is_due("09:00", "09:00", None, today), "相等时间视为到点");
        assert!(!is_due("09:00", "10:00", None, today), "未到点");
        assert!(!is_due("10:00", "09:00", Some(today), today), "当日已跑不重复");
        assert!(is_due("10:00", "09:00", Some("2025-12-31"), today), "昨日已跑今天重跑");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_store_summary_happy_path() {
        let (tmp, pipe) = test_env().await;
        let pipe = pipe
            .with_history(fake_history(sample_history()))
            .with_llm(fake_llm(
                r#"{"title":"Rust 周会","summary":"1. 所有权;2. 生命周期","tags":["rust"]}"#,
            ));
        let ctx = dummy_ctx(&tmp).await;

        let dto = pipe.store_summary(&ctx, 42, 2, "manual").await.unwrap();
        assert_eq!(dto.title, "Rust 周会");
        assert_eq!(dto.summary, "1. 所有权;2. 生命周期");
        assert_eq!(dto.tags, vec!["rust".to_string()]);
        assert_eq!(dto.msg_count, 2);
        assert_eq!(dto.source, "manual");
        assert_eq!(dto.chat_id, 42);
        assert_eq!(dto.date, chrono::Local::now().format("%Y-%m-%d").to_string());

        let rows = pipe.db.list_knowledge(Some(42), None, None, 1, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_store_summary_llm_invalid_json_degrades() {
        let (tmp, pipe) = test_env().await;
        let pipe = pipe
            .with_history(fake_history(sample_history()))
            .with_llm(fake_llm("这不是 JSON"));
        let ctx = dummy_ctx(&tmp).await;

        let dto = pipe.store_summary(&ctx, 42, 2, "manual").await.unwrap();
        // 非法 JSON → 降级:title=首条消息 50 字,summary=LLM 原文,tags=[]
        assert_eq!(dto.title, "今天讨论了 Rust 的所有权模型,生命周期是重点。");
        assert_eq!(dto.summary, "这不是 JSON");
        assert!(dto.tags.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_store_summary_llm_err_degrades() {
        let (tmp, pipe) = test_env().await;
        let llm_err: LlmFn = Arc::new(|_msgs| {
            Box::pin(async move { Err(AppError::Core("mock llm 不可用".into())) })
        });
        let pipe = pipe
            .with_history(fake_history(sample_history()))
            .with_llm(llm_err);
        let ctx = dummy_ctx(&tmp).await;

        let dto = pipe.store_summary(&ctx, 42, 2, "manual").await.unwrap();
        // LLM 报错 → 降级:title=首条消息,summary=首条消息(无原文可用),tags=[]
        assert_eq!(dto.title, "今天讨论了 Rust 的所有权模型,生命周期是重点。");
        assert_eq!(dto.summary, "今天讨论了 Rust 的所有权模型,生命周期是重点。");
        assert!(dto.tags.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_store_summary_empty_history_err() {
        let (tmp, pipe) = test_env().await;
        let pipe = pipe.with_history(fake_history(vec![]));
        let ctx = dummy_ctx(&tmp).await;
        let err = pipe.store_summary(&ctx, 42, 2, "manual").await.unwrap_err();
        assert!(matches!(err, AppError::Core(_)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_store_summary_dedup_same_chat_date() {
        let (tmp, pipe) = test_env().await;
        let pipe = pipe
            .with_history(fake_history(sample_history()))
            .with_llm(fake_llm(r#"{"title":"周会","summary":"要点","tags":[]}"#));
        let ctx = dummy_ctx(&tmp).await;

        let a = pipe.store_summary(&ctx, 7, 2, "manual").await.unwrap();
        let b = pipe.store_summary(&ctx, 7, 5, "manual").await.unwrap();
        assert_eq!(a.id, b.id, "同 chat+date 二次调用应 upsert 更新而非新增");
        assert_eq!(b.msg_count, 5, "内容随第二次调用更新");

        let rows = pipe.db.list_knowledge(Some(7), None, None, 1, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
    }
}
