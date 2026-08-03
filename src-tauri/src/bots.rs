use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::Mutex;

use deltachat::accounts::Accounts;
use deltachat::config::Config;

use crate::bot_llm;
use crate::db::Db;
use crate::dto::{BotDto, LlmConfigInput};
use crate::error::{AppError, AppResult};

/// Bot 系统服务：管理"机器人"账号的创建/查询/删除/IO 启停。
///
/// 每个 bot 都是一个独立的 Delta Chat 账号（chatmail 邮箱），归属某个用户账号，
/// 通过 bots 表与 deltachat core 的账号库建立关联。
pub struct BotService {
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    /// 所有 bot 账号 id 集合，供事件转发过滤与 LLM 自动回复运行时使用
    pub bot_ids: Arc<Mutex<HashSet<u32>>>,
}

impl BotService {
    pub fn new(accounts: Arc<Mutex<Accounts>>, db: Arc<Db>) -> Self {
        Self {
            accounts,
            db,
            bot_ids: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 返回 bot 账号 id 集合的 Arc 克隆，供事件转发器 / LLM 运行时共享。
    pub fn bot_ids(&self) -> Arc<Mutex<HashSet<u32>>> {
        self.bot_ids.clone()
    }

    /// 为指定用户创建一个 bot 账号：chatmail 邮箱 provisioning → 落库 → 启动 IO。
    ///
    /// `add_account` 之后的任何一步失败都会回滚：移除 accounts 中未配置完成的账号，
    /// 并清理已插入的 bots 表行。
    pub async fn create(&self, owner_id: u32, display_name: String) -> AppResult<BotDto> {
        let id = {
            let mut accounts = self.accounts.lock().await;
            accounts.add_account().await?
        };
        let ctx = self
            .accounts
            .lock()
            .await
            .get_account(id)
            .ok_or_else(|| AppError::Core("account gone".into()))?;

        let mut inserted_bot_id: Option<i64> = None;
        let result: AppResult<BotDto> = async {
            // 与 create_chatmail_account 一致的 chatmail provisioning 与错误映射
            ctx.add_transport_from_qr("dcaccount:https://yzjtiantian.cn/new")
                .await
                .map_err(|e| {
                    let msg = e.to_string().to_lowercase();
                    if msg.contains("network") || msg.contains("connection") || msg.contains("timeout")
                    {
                        AppError::Network(msg)
                    } else {
                        AppError::Core(e.to_string())
                    }
                })?;

            ctx.set_config(Config::Displayname, Some(&display_name))
                .await?;

            let now_ts = chrono::Utc::now().timestamp();
            let bot_id = self
                .db
                .insert_bot(owner_id, id, &display_name, now_ts)
                .await?;
            inserted_bot_id = Some(bot_id);
            self.bot_ids.lock().await.insert(id);

            ctx.start_io().await;
            let addr = ctx.get_config(Config::ConfiguredAddr).await?;
            Ok(BotDto {
                id: bot_id,
                bot_account_id: id,
                display_name,
                addr,
                io_running: true,
                created_at: now_ts,
            })
        }
        .await;

        match result {
            Ok(dto) => Ok(dto),
            Err(e) => {
                // 回滚：移除账号 + 清理可能已插入的 db 行
                let _ = self.accounts.lock().await.remove_account(id).await;
                if let Some(bot_id) = inserted_bot_id {
                    let _ = self.db.delete_bot(owner_id, bot_id).await;
                }
                Err(e)
            }
        }
    }

    /// 列出指定用户的所有 bot，读取其账号地址与 IO 运行状态。
    /// 账号上下文不可用时优雅跳过（addr = None）。
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

    /// 删除 bot：停 IO → 移除 accounts 账号 → 删除 db 行。
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

    /// 启/停单个 bot 的 IO，并把状态写回 db，返回最新 DTO。
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
        let addr = match &ctx {
            Some(ctx) => ctx.get_config(Config::ConfiguredAddr).await?,
            None => None,
        };
        Ok(BotDto {
            id: row.id,
            bot_account_id: row.bot_account_id,
            display_name: row.display_name,
            addr,
            io_running: running,
            created_at: row.created_at,
        })
    }

    /// 启动某个用户名下所有 bot 的 IO。单个 bot 失败只记日志，不向外传播。
    pub async fn start_all_for_owner(&self, owner_id: u32) -> AppResult<()> {
        let rows = self.db.list_bots(owner_id).await?;
        // 重建 bot 账号 id 集合(清空后重新插入该 owner 的全部 bot)
        {
            let mut ids = self.bot_ids.lock().await;
            ids.clear();
            for row in &rows {
                ids.insert(row.bot_account_id);
            }
        }
        for row in rows {
            if let Some(ctx) = self.accounts.lock().await.get_account(row.bot_account_id) {
                ctx.start_io().await;
            } else {
                log::warn!(
                    "bot {} (account {}) context unavailable, skipping",
                    row.id,
                    row.bot_account_id
                );
            }
        }
        Ok(())
    }

    /// 更新某个 bot 的 LLM 配置，并返回最新 DTO。
    pub async fn update_bot_llm(
        &self,
        owner_id: u32,
        bot_id: i64,
        config: LlmConfigInput,
    ) -> AppResult<BotDto> {
        let row = self
            .db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let json = serde_json::to_string(&config)
            .map_err(|e| AppError::Core(format!("llm config serialize: {e}")))?;
        self.db
            .set_bot_config(owner_id, bot_id, Some(&json))
            .await?;
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

    /// 读取某个 bot 的 LLM 配置；未配置或 JSON 解析失败返回 None。
    pub async fn get_bot_llm(
        &self,
        owner_id: u32,
        bot_id: i64,
    ) -> AppResult<Option<LlmConfigInput>> {
        self.db
            .get_bot(owner_id, bot_id)
            .await?
            .ok_or_else(|| AppError::Core("bot not found".into()))?;
        let raw = self.db.get_bot_config(owner_id, bot_id).await?;
        match raw.as_deref() {
            None | Some("") => Ok(None),
            Some(json) => match serde_json::from_str::<LlmConfigInput>(json) {
                Ok(cfg) => Ok(Some(cfg)),
                // 设置回读场景下解析失败更安全地返回 None，而非报错
                Err(_) => Ok(None),
            },
        }
    }

    /// 启动 LLM 自动回复后台运行时(内部 spawn，不阻塞当前调用方)。
    pub fn spawn_runtime(&self) {
        tauri::async_runtime::spawn(bot_llm::spawn(
            self.accounts.clone(),
            self.db.clone(),
            self.bot_ids.clone(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_env(
        tmp: &tempfile::TempDir,
    ) -> (Arc<Mutex<Accounts>>, Arc<Db>, BotService) {
        let accounts = Arc::new(Mutex::new(
            Accounts::new(tmp.path().join("accounts"), true)
                .await
                .unwrap(),
        ));
        let db = Arc::new(Db::new(tmp.path().join("test.db")).await.unwrap());
        db.migrate().await.unwrap();
        let svc = BotService::new(accounts.clone(), db.clone());
        (accounts, db, svc)
    }

    /// set_io 在真实添加的账号上切换 start/stop，并同步更新 db status。
    #[tokio::test(flavor = "multi_thread")]
    async fn test_set_io_toggles_status() {
        let tmp = tempfile::tempdir().unwrap();
        let (accounts, db, svc) = test_env(&tmp).await;

        let owner_id = 1u32;
        let bot_account_id = {
            let mut accounts = accounts.lock().await;
            accounts.add_account().await.unwrap()
        };
        let bot_id = db
            .insert_bot(owner_id, bot_account_id, "TestBot", chrono::Utc::now().timestamp())
            .await
            .unwrap();

        let dto = svc.set_io(owner_id, bot_id, false).await.unwrap();
        assert!(!dto.io_running);
        assert_eq!(dto.bot_account_id, bot_account_id);
        assert_eq!(dto.display_name, "TestBot");
        let row = db.get_bot(owner_id, bot_id).await.unwrap().unwrap();
        assert_eq!(row.status, "stopped");

        let dto = svc.set_io(owner_id, bot_id, true).await.unwrap();
        assert!(dto.io_running);
        let row = db.get_bot(owner_id, bot_id).await.unwrap().unwrap();
        assert_eq!(row.status, "running");
    }

    /// 删除不归属当前用户的 bot 应返回错误（Core "bot not found"）。
    #[tokio::test(flavor = "multi_thread")]
    async fn test_delete_non_owned_bot_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, _, svc) = test_env(&tmp).await;

        let err = svc.delete(1, 999).await.unwrap_err();
        assert!(matches!(err, AppError::Core(_)));
    }

    /// update_bot_llm 写入的 LLM 配置能被 get_bot_llm 读回（往返一致）。
    #[tokio::test(flavor = "multi_thread")]
    async fn test_update_bot_llm_round_trip() {
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

        let config = LlmConfigInput {
            system_prompt: Some("你是助手".to_string()),
            base_url: Some("https://api.example.com/v1".to_string()),
            api_key: Some("sk-test".to_string()),
            model: Some("gpt-4o-mini".to_string()),
            provider: Some("openai".to_string()),
        };
        let dto = svc.update_bot_llm(owner_id, bot_id, config.clone()).await.unwrap();
        assert_eq!(dto.bot_account_id, bot_account_id);
        // 归属校验：非 owner 更新应报错
        let err = svc.update_bot_llm(2, bot_id, config.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::Core(_)));

        let read = svc.get_bot_llm(owner_id, bot_id).await.unwrap().unwrap();
        assert_eq!(read.system_prompt, config.system_prompt);
        assert_eq!(read.base_url, config.base_url);
        assert_eq!(read.api_key, config.api_key);
        assert_eq!(read.model, config.model);
        assert_eq!(read.provider, config.provider);
    }
}
