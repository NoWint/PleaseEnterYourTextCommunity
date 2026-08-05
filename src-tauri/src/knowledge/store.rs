use std::sync::Arc;

use crate::db::{Db, KnowledgeRow};
use crate::dto::KnowledgeDto;
use crate::error::AppResult;

/// 知识库纯数据访问层:包装 db.knowledge 表方法,输出 DTO。
pub struct KnowledgeStore {
    db: Arc<Db>,
}

impl KnowledgeStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    /// 动态过滤列表:会话/标签/关键词,分页,按更新时间倒序。
    pub async fn list(
        &self,
        chat_id: Option<u32>,
        tag: Option<&str>,
        keyword: Option<&str>,
        page: i64,
        page_size: i64,
    ) -> AppResult<Vec<KnowledgeDto>> {
        let rows = self
            .db
            .list_knowledge(chat_id, tag, keyword, page, page_size)
            .await?;
        Ok(rows.into_iter().map(row_to_dto).collect())
    }

    /// 单条知识条目。
    pub async fn get(&self, id: i64) -> AppResult<Option<KnowledgeDto>> {
        Ok(self.db.get_knowledge(id).await?.map(row_to_dto))
    }

    /// 删除知识条目。
    pub async fn delete(&self, id: i64) -> AppResult<()> {
        self.db.delete_knowledge(id).await
    }

    /// 更新知识条目(仅非 None 字段),返回更新后的 DTO。
    pub async fn update(
        &self,
        id: i64,
        title: Option<&str>,
        summary: Option<&str>,
        tags: Option<&str>,
    ) -> AppResult<Option<KnowledgeDto>> {
        self.db.update_knowledge(id, title, summary, tags).await?;
        self.get(id).await
    }

    /// 全部会话知识库配置。
    pub async fn list_configs(&self) -> AppResult<Vec<crate::dto::KnowledgeConfigDto>> {
        let rows = self.db.list_knowledge_configs().await?;
        Ok(rows
            .into_iter()
            .map(|r| crate::dto::KnowledgeConfigDto {
                chat_id: r.chat_id,
                chat_name: r.chat_id.to_string(),
                daily_enabled: r.daily_enabled,
                daily_time: r.daily_time,
                window_count: r.window_count,
                auto_store: r.auto_store,
            })
            .collect())
    }

    /// 写每会话知识库配置,返回写入后的 DTO。
    pub async fn set_config(
        &self,
        chat_id: u32,
        daily_enabled: bool,
        daily_time: &str,
        window_count: i64,
        auto_store: bool,
    ) -> AppResult<crate::dto::KnowledgeConfigDto> {
        self.db
            .set_knowledge_config(chat_id, daily_enabled, daily_time, window_count, auto_store)
            .await?;
        let row = self
            .db
            .get_knowledge_config(chat_id)
            .await?
            .ok_or_else(|| crate::error::AppError::Core(format!("会话 {chat_id} 配置写入失败")))?;
        Ok(crate::dto::KnowledgeConfigDto {
            chat_id: row.chat_id,
            chat_name: row.chat_id.to_string(),
            daily_enabled: row.daily_enabled,
            daily_time: row.daily_time,
            window_count: row.window_count,
            auto_store: row.auto_store,
        })
    }
}

/// KnowledgeRow → KnowledgeDto。tags 按 JSON 数组解析。
/// chat_name 需要 per-account deltachat Context 查询会话名,store 层不持有,
/// 暂以 chat_id 字符串占位 —— 集成者在命令层接入会话名后替换。
pub(crate) fn row_to_dto(row: KnowledgeRow) -> KnowledgeDto {
    let tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
    KnowledgeDto {
        id: row.id,
        chat_id: row.chat_id,
        chat_name: row.chat_id.to_string(),
        date: row.date,
        title: row.title,
        summary: row.summary,
        tags,
        msg_count: row.msg_count,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn test_store() -> (tempfile::TempDir, KnowledgeStore) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let store = KnowledgeStore::new(Arc::new(db));
        (tmp, store)
    }

    async fn seed(store: &KnowledgeStore, chat_id: u32, date: &str, title: &str, tags: &[&str]) -> i64 {
        let tags = serde_json::to_string(tags).unwrap();
        store
            .db
            .upsert_knowledge(chat_id, date, title, &format!("摘要: {title}"), &tags, 5, "manual")
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_roundtrip() {
        let (_tmp, store) = test_store().await;
        seed(&store, 7, "2026-01-01", "Rust 所有权", &["rust", "语言"]).await;
        seed(&store, 7, "2026-01-02", "会议纪要", &["会议"]).await;

        let all = store.list(None, None, None, 1, 10).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chat_name, "7", "chat_name 占位为 chat_id 字符串");

        let by_tag = store.list(None, Some("rust"), None, 1, 10).await.unwrap();
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].tags, vec!["rust".to_string(), "语言".to_string()]);

        let by_keyword = store.list(None, None, Some("纪要"), 1, 10).await.unwrap();
        assert_eq!(by_keyword.len(), 1);
        assert_eq!(by_keyword[0].title, "会议纪要");

        let by_chat = store.list(Some(99), None, None, 1, 10).await.unwrap();
        assert!(by_chat.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_update_delete_roundtrip() {
        let (_tmp, store) = test_store().await;
        let id = seed(&store, 7, "2026-01-01", "原标题", &["a"]).await;

        let got = store.get(id).await.unwrap().unwrap();
        assert_eq!(got.title, "原标题");
        assert_eq!(got.msg_count, 5);

        let updated = store
            .update(id, Some("新标题"), Some("新摘要"), Some("[\"b\",\"c\"]"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.summary, "新摘要");
        assert_eq!(updated.tags, vec!["b".to_string(), "c".to_string()]);

        let partial = store.update(id, Some("只改标题"), None, None).await.unwrap().unwrap();
        assert_eq!(partial.title, "只改标题");
        assert_eq!(partial.summary, "新摘要", "未传字段保持不变");

        store.delete(id).await.unwrap();
        assert!(store.get(id).await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_update_missing_id_returns_none() {
        let (_tmp, store) = test_store().await;
        let r = store.update(9999, Some("x"), None, None).await.unwrap();
        assert!(r.is_none());
    }
}
