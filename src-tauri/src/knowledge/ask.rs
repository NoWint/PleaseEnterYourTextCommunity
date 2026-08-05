use std::sync::Arc;

use deltachat::context::Context;

use crate::db::Db;
use crate::error::AppResult;
use crate::knowledge::pipeline::LlmFn;
use crate::llm::ChatMessage;

/// /ask 问答引擎:检索知识库 Top-5 → LLM 基于条目作答。
pub struct AskEngine {
    db: Arc<Db>,
    llm: LlmFn,
}

impl AskEngine {
    pub fn new(db: Arc<Db>, llm: LlmFn) -> Self {
        Self { db, llm }
    }

    /// 以 question 为关键词检索知识库(全局),命中则 LLM 生成回答;
    /// 未命中返回引导提示;LLM 失败降级返回条目标题。
    /// ctx 保留签名兼容(_ 前缀:本方法不查询聊天历史)。
    pub async fn ask(
        &self,
        _ctx: &Context,
        _chat_id: u32,
        question: &str,
    ) -> AppResult<Vec<String>> {
        let rows = self
            .db
            .list_knowledge(None, None, Some(question), 1, 5)
            .await?;
        if rows.is_empty() {
            return Ok(vec![
                "知识库暂无相关内容,可发送 /summarize save 存入总结".to_string(),
            ]);
        }

        let mut candidates = String::new();
        for r in &rows {
            candidates.push_str(&format!("标题: {}\n日期: {}\n内容: {}\n\n", r.title, r.date, r.summary));
        }
        let msgs = vec![
            ChatMessage {
                role: "system".into(),
                content: "你是知识库问答助手,基于给定知识条目回答,只回答相关问题,不确定就说不知道"
                    .into(),
                ..Default::default()
            },
            ChatMessage {
                role: "user".into(),
                content: format!("{candidates}\n问题: {question}"),
                ..Default::default()
            },
        ];

        match (self.llm)(msgs).await {
            Ok(text) => Ok(crate::drivers::llm::split_reply(&text)),
            Err(e) => {
                log::warn!("knowledge ask: LLM 调用失败,降级返回条目标题: {e}");
                let mut out = vec!["LLM 不可用,以下是相关条目".to_string()];
                out.extend(rows.into_iter().map(|r| r.title));
                Ok(out)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use deltachat::context::ContextBuilder;

    async fn test_env(llm_text: &str) -> (tempfile::TempDir, AskEngine, deltachat::context::Context) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let text = llm_text.to_string();
        let llm: LlmFn = Arc::new(move |_msgs| {
            let text = text.clone();
            Box::pin(async move { Ok(text) })
        });
        let engine = AskEngine::new(Arc::new(db), llm);
        let ctx = ContextBuilder::new(tmp.path().join("ctx.db")).with_id(1).build().await.unwrap();
        (tmp, engine, ctx)
    }

    async fn seed(engine: &AskEngine, date: &str, title: &str, summary: &str) {
        engine
            .db
            .upsert_knowledge(7, date, title, summary, "[]", 3, "manual")
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_ask_empty_kb_prompt() {
        let (_tmp, engine, ctx) = test_env("ignored").await;
        let out = engine.ask(&ctx, 7, "什么是 Rust").await.unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("知识库暂无相关内容"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_ask_with_hits_mock_llm() {
        let (_tmp, engine, ctx) = test_env("Rust 是一门系统编程语言,注重内存安全。").await;
        seed(&engine, "2026-01-01", "Rust 入门", "Rust 的所有权系统保证内存安全").await;

        let out = engine.ask(&ctx, 7, "Rust").await.unwrap();
        assert_eq!(out, vec!["Rust 是一门系统编程语言,注重内存安全。".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_ask_llm_err_degrades_to_titles() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let llm: LlmFn = Arc::new(|_msgs| {
            Box::pin(async move { Err(AppError::Core("mock llm 不可用".into())) })
        });
        let engine = AskEngine::new(Arc::new(db), llm);
        seed(&engine, "2026-01-01", "Rust 入门", "Rust 的所有权系统保证内存安全").await;
        seed(&engine, "2026-01-02", "Rust 进阶", "Rust 的生命周期与借用检查").await;

        let ctx = ContextBuilder::new(tmp.path().join("ctx.db")).with_id(1).build().await.unwrap();
        let out = engine.ask(&ctx, 7, "Rust").await.unwrap();
        assert!(out[0].contains("LLM 不可用"));
        let mut titles: Vec<String> = out[1..].to_vec();
        titles.sort();
        assert_eq!(titles, vec!["Rust 入门".to_string(), "Rust 进阶".to_string()]);
    }
}
