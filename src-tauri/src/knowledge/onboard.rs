use std::sync::Arc;

use deltachat::context::Context;

use crate::db::Db;
use crate::error::AppResult;
use crate::knowledge::pipeline::LlmFn;
use crate::llm::ChatMessage;

/// 新人引导服务:基于会话最近 3 条知识条目生成群概要。
pub struct OnboardService {
    db: Arc<Db>,
    llm: LlmFn,
}

impl OnboardService {
    pub fn new(db: Arc<Db>, llm: LlmFn) -> Self {
        Self { db, llm }
    }

    /// 取会话最近 3 条知识条目 → LLM 生成群概要;
    /// 无条目返回欢迎引导;LLM 失败降级返回条目标题列表。
    /// ctx 保留签名兼容(_ 前缀:本方法不查询聊天历史)。
    pub async fn build_onboard_summary(
        &self,
        _ctx: &Context,
        chat_id: u32,
    ) -> AppResult<Vec<String>> {
        let rows = self
            .db
            .list_knowledge(Some(chat_id), None, None, 1, 3)
            .await?;
        if rows.is_empty() {
            return Ok(vec![
                "欢迎新人!可发送 /ask <问题> 提问,或 /summarize save 将讨论存入知识库"
                    .to_string(),
            ]);
        }

        let mut entries = String::new();
        for r in &rows {
            entries.push_str(&format!("标题: {}\n日期: {}\n内容: {}\n\n", r.title, r.date, r.summary));
        }
        let msgs = vec![
            ChatMessage {
                role: "system".into(),
                content: "你是群知识助手,根据知识条目为新成员生成简洁群概要:群主题/常用约定/重要待办"
                    .into(),
                ..Default::default()
            },
            ChatMessage {
                role: "user".into(),
                content: entries,
                ..Default::default()
            },
        ];

        match (self.llm)(msgs).await {
            Ok(text) => Ok(crate::drivers::llm::split_reply(&text)),
            Err(e) => {
                log::warn!("knowledge onboard: LLM 调用失败,降级返回条目标题: {e}");
                Ok(rows.into_iter().map(|r| r.title).collect())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use deltachat::context::ContextBuilder;

    async fn test_env(
        llm_result: Result<String, String>,
    ) -> (tempfile::TempDir, OnboardService, deltachat::context::Context) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let llm: LlmFn = Arc::new(move |_msgs| {
            let r = llm_result.clone().map_err(AppError::Core);
            Box::pin(async move { r })
        });
        let svc = OnboardService::new(Arc::new(db), llm);
        let ctx = ContextBuilder::new(tmp.path().join("ctx.db")).with_id(1).build().await.unwrap();
        (tmp, svc, ctx)
    }

    async fn seed(svc: &OnboardService, chat_id: u32, date: &str, title: &str) {
        svc.db
            .upsert_knowledge(chat_id, date, title, &format!("内容-{title}"), "[]", 2, "manual")
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_onboard_no_entries_welcome() {
        let (_tmp, svc, ctx) = test_env(Ok("ignored".into())).await;
        let out = svc.build_onboard_summary(&ctx, 7).await.unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("欢迎新人"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_onboard_with_entries_mock_llm() {
        let (_tmp, svc, ctx) = test_env(Ok("群主题: Rust 学习小组\n重要待办: 周五代码评审".into())).await;
        seed(&svc, 7, "2026-01-01", "Rust 入门").await;
        seed(&svc, 7, "2026-01-02", "周会纪要").await;

        let out = svc.build_onboard_summary(&ctx, 7).await.unwrap();
        assert_eq!(out, vec!["群主题: Rust 学习小组\n重要待办: 周五代码评审".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_onboard_llm_err_degrades_to_titles() {
        let (_tmp, svc, ctx) = test_env(Err("mock llm 不可用".into())).await;
        seed(&svc, 7, "2026-01-01", "Rust 入门").await;
        seed(&svc, 7, "2026-01-02", "周会纪要").await;
        seed(&svc, 8, "2026-01-01", "别的群条目").await;

        let out = svc.build_onboard_summary(&ctx, 7).await.unwrap();
        let mut titles = out;
        titles.sort();
        assert_eq!(titles, vec!["Rust 入门".to_string(), "周会纪要".to_string()]);
        // chat_id=8 的条目不应出现在 chat 7 的引导里
        assert!(!titles.contains(&"别的群条目".to_string()));
    }
}
