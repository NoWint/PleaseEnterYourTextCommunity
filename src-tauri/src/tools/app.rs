//! 应用内工具:search_history / create_card / set_reminder。
//!
//! Bot 直接作用于本应用自身数据:搜索 Bot 上下文中的聊天历史、
//! 在工作区建协作卡片、为会话插入一次性定时提醒(写入 bot_schedules)。

use async_trait::async_trait;
use deltachat::chat::{self, Chat, ChatItem};
use deltachat::chatlist::Chatlist;
use deltachat::contact::{Contact, ContactId};
use deltachat::message::Message;

use crate::error::{AppError, AppResult};
use crate::tools::{Tool, ToolContext};

const SEARCH_HISTORY_LIMIT: usize = 5;
const SEARCH_MSG_RECENT: usize = 50;
const SEARCH_TEXT_PREFIX: usize = 60;

/// 搜索 Bot 聊天历史中匹配的最近消息(忽略大小写)。
pub struct SearchHistoryTool;

/// 在工作区创建一张协作卡片。
pub struct CreateCardTool;

/// 为某个会话设置一次性定时提醒。
pub struct SetReminderTool;

#[async_trait]
impl Tool for SearchHistoryTool {
    fn name(&self) -> &'static str {
        "search_history"
    }

    fn description(&self) -> &'static str {
        "搜索 Bot 聊天历史中匹配的最近消息"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" }
            },
            "required": ["query"]
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if query.is_empty() {
            return Err(AppError::Core("参数缺失: query".into()));
        }
        let q_lower = query.to_lowercase();
        let mut lines: Vec<String> = Vec::new();
        let chatlist = Chatlist::try_load(ctx.dc, 0, None, None).await?;
        for i in 0..chatlist.len() {
            if lines.len() >= SEARCH_HISTORY_LIMIT {
                break;
            }
            let chat_id = match chatlist.get_chat_id(i) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let chat = match Chat::load_from_db(ctx.dc, chat_id).await {
                Ok(c) => c,
                Err(_) => continue,
            };
            let chat_name = chat.get_name().to_string();
            let items = match chat::get_chat_msgs(ctx.dc, chat_id).await {
                Ok(v) => v,
                Err(_) => continue,
            };
            for item in items.into_iter().rev().take(SEARCH_MSG_RECENT) {
                if lines.len() >= SEARCH_HISTORY_LIMIT {
                    break;
                }
                let ChatItem::Message { msg_id } = item else {
                    continue;
                };
                let m = match Message::load_from_db(ctx.dc, msg_id).await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let text = m.get_text();
                if !text.to_lowercase().contains(&q_lower) {
                    continue;
                }
                let from_name = if m.get_from_id() == ContactId::SELF {
                    "我".to_string()
                } else {
                    Contact::get_by_id(ctx.dc, m.get_from_id())
                        .await
                        .map(|c| c.get_display_name().to_string())
                        .unwrap_or_default()
                };
                let summary: String = text.chars().take(SEARCH_TEXT_PREFIX).collect();
                lines.push(format!("[{}] {}: {}", chat_name, from_name, summary));
            }
        }
        if lines.is_empty() {
            Ok("未找到匹配的消息".to_string())
        } else {
            Ok(lines.join("\n"))
        }
    }
}

#[async_trait]
impl Tool for CreateCardTool {
    fn name(&self) -> &'static str {
        "create_card"
    }

    fn description(&self) -> &'static str {
        "在工作区创建一张协作卡片"
    }

    fn is_safe(&self) -> bool {
        false
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "workspace_id": { "type": "number" },
                "chat_id": { "type": "number" },
                "title": { "type": "string" },
                "description": { "type": "string" }
            },
            "required": ["workspace_id", "chat_id", "title"]
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if title.is_empty() {
            return Err(AppError::Core("参数缺失: title".into()));
        }
        let workspace_id = args
            .get("workspace_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| AppError::Core("参数缺失: workspace_id".into()))?;
        let chat_id = args
            .get("chat_id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| AppError::Core("参数缺失: chat_id".into()))?;
        let description = args.get("description").and_then(|v| v.as_str());
        let id = ctx
            .db
            .insert_card(
                workspace_id,
                chat_id as u32,
                "task",
                title,
                description,
                "todo",
                None,
                None,
                ContactId::SELF.to_u32(),
                chrono::Utc::now().timestamp(),
                None,
            )
            .await?;
        Ok(format!("已创建卡片 #{}: {}", id, title))
    }
}

#[async_trait]
impl Tool for SetReminderTool {
    fn name(&self) -> &'static str {
        "set_reminder"
    }

    fn description(&self) -> &'static str {
        "为某个会话设置一次性定时提醒"
    }

    fn is_safe(&self) -> bool {
        false
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "chat_id": { "type": "number" },
                "delay_minutes": { "type": "number" },
                "message": { "type": "string" }
            },
            "required": ["chat_id", "delay_minutes", "message"]
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let delay_minutes = args
            .get("delay_minutes")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| AppError::Core("参数缺失: delay_minutes".into()))?;
        if !(1..=10080).contains(&delay_minutes) {
            return Err(AppError::Core(format!(
                "delay_minutes 需在 1..=10080 分钟范围内,收到 {delay_minutes}"
            )));
        }
        let chat_id = args
            .get("chat_id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| AppError::Core("参数缺失: chat_id".into()))?;
        let message = args
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if message.is_empty() {
            return Err(AppError::Core("参数缺失: message".into()));
        }
        let next = chrono::Utc::now().timestamp() + delay_minutes * 60;
        ctx.db
            .insert_bot_schedule(ctx.bot_id, chat_id as u32, -1, -1, -1, message, next)
            .await?;
        Ok(format!("已设置提醒(约 {} 分钟后)", delay_minutes))
    }
}

#[cfg(test)]
mod tests {
    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;
    use crate::tools::ToolContext;

    /// 持有构造 ToolContext 所需的所有权对象(短生命周期,仅测试用)。
    struct TestCtx {
        _tmp: tempfile::TempDir,
        dc: Context,
        db: Db,
        data_dir: std::path::PathBuf,
    }

    impl TestCtx {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut accounts =
                deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
                    .await
                    .unwrap();
            let id = accounts.add_account().await.unwrap();
            let dc = accounts.get_account(id).unwrap();
            let db = Db::new(tmp.path().join("app.db")).await.unwrap();
            db.migrate().await.unwrap();
            let data_dir = tmp.path().to_path_buf();
            Self {
                _tmp: tmp,
                dc,
                db,
                data_dir,
            }
        }

        fn tool_ctx(&self) -> ToolContext<'_> {
            ToolContext {
                dc: &self.dc,
                db: &self.db,
                bot_id: 1,
                chat_id: ChatId::new(123),
                data_dir: &self.data_dir,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_search_history_empty_query_errors() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = SearchHistoryTool
            .execute(serde_json::json!({}), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("query"));
        let err2 = SearchHistoryTool
            .execute(serde_json::json!({ "query": "" }), &ctx)
            .await
            .unwrap_err();
        assert!(err2.to_string().contains("query"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_create_card_missing_title_errors() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = CreateCardTool
            .execute(serde_json::json!({ "workspace_id": 1, "chat_id": 2 }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("title"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_create_card_ok_creates_row() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let out = CreateCardTool
            .execute(
                serde_json::json!({
                    "workspace_id": 1,
                    "chat_id": 2,
                    "title": "设计稿评审",
                    "description": "周三前完成"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(out.contains("已创建卡片"), "应返回创建回执: {out}");
        let cards = owned.db.list_cards(1, 2).await.unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].5, "设计稿评审");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_set_reminder_invalid_delay_errors() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        for bad in [0, -5] {
            let err = SetReminderTool
                .execute(
                    serde_json::json!({ "chat_id": 9, "delay_minutes": bad, "message": "喝水" }),
                    &ctx,
                )
                .await
                .unwrap_err();
            assert!(
                err.to_string().contains("delay_minutes"),
                "delay_minutes={bad} 应报错: {err}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_set_reminder_ok_creates_schedule() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let out = SetReminderTool
            .execute(
                serde_json::json!({ "chat_id": 9, "delay_minutes": 30, "message": "喝水休息" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(out.contains("已设置提醒"), "应返回提醒回执: {out}");
        let rows = owned.db.list_bot_schedules(1).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].minute, -1);
        assert_eq!(rows[0].hour, -1);
        assert_eq!(rows[0].day_of_week, -1);
        assert_eq!(rows[0].message, "喝水休息");
        assert!(rows[0].next_run_at > chrono::Utc::now().timestamp());
    }
}
