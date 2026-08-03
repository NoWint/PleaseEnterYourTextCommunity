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
