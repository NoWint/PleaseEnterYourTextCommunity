use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex;

use deltachat::accounts::Accounts;
use deltachat::context::Context;

use crate::bots::BotService;
use crate::db::Db;
use crate::error::AppResult;
use crate::plugins::PluginManager;
use crate::terminal::TerminalSessions;

pub struct AppState {
    pub accounts: Arc<Mutex<Accounts>>,
    pub current_id: StdMutex<Option<u32>>,
    pub db: Arc<Db>,
    pub bots: BotService,
    pub plugins: PluginManager,
    pub terminals: TerminalSessions,
    /// 应用数据目录(Tauri app_data_dir),供导出路径/备份默认目录
    pub data_dir: PathBuf,
}

impl AppState {
    pub async fn new(app_data_dir: PathBuf) -> AppResult<Self> {
        let dir = app_data_dir.join("accounts");
        tokio::fs::create_dir_all(&dir).await?;
        let accounts = Accounts::new(dir.clone(), true).await?;
        let current_id = accounts.get_selected_account_id();
        if let Some(id) = current_id {
            if let Some(ctx) = accounts.get_account(id) {
                ctx.start_io().await;
            }
        }
        let db = Db::new(app_data_dir.join("peytchat.db")).await?;
        db.migrate().await?;
        let accounts = Arc::new(Mutex::new(accounts));
        let db = Arc::new(db);
        let bots = BotService::new(accounts.clone(), db.clone());
        Ok(Self {
            accounts,
            current_id: StdMutex::new(current_id),
            db,
            bots,
            plugins: PluginManager::new(app_data_dir.clone()),
            terminals: TerminalSessions::default(),
            data_dir: app_data_dir,
        })
    }

    pub async fn current(&self) -> Option<Context> {
        let id = *self.current_id.lock().unwrap();
        let accounts = self.accounts.lock().await;
        accounts.get_account(id?)
    }

    pub fn set_current(&self, id: u32) {
        *self.current_id.lock().unwrap() = Some(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn test_state_init_and_add_account() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().join("accounts")).await.unwrap();
        assert!(state.current().await.is_none());

        let id = {
            let mut accounts = state.accounts.lock().await;
            accounts.add_account().await.unwrap()
        };
        state.set_current(id);
        assert_eq!(*state.current_id.lock().unwrap(), Some(id));
        assert!(state.current().await.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_state_restart_restores_selected_account() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("accounts");

        // First boot: create state, add an account, and persist selection
        // (mirrors the login command, which calls select_account to persist).
        let id = {
            let state = AppState::new(dir.clone()).await.unwrap();
            assert!(state.current().await.is_none());

            let mut accounts = state.accounts.lock().await;
            let id = accounts.add_account().await.unwrap();
            accounts.select_account(id).await.unwrap();
            id
        };

        // Second boot: reopen the same directory; current_id should be restored.
        let state = AppState::new(dir.clone()).await.unwrap();
        assert_eq!(*state.current_id.lock().unwrap(), Some(id));
        assert!(state.current().await.is_some());
    }
}
