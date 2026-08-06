use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::params;
use rusqlite::OptionalExtension;
use tokio::sync::Mutex;

use crate::dto::{ActivityDto, BotStatsDto, ChannelDto, GithubSettingsDto, InboxEventDto, PinDto, RoleDto, WorkspaceDto};
use crate::error::{AppError, AppResult};

// bots 表行结构，供 Bot 服务模块使用
pub struct BotRow {
    pub id: i64,
    pub bot_account_id: u32,
    #[allow(dead_code)]
    pub owner_account_id: u32,
    pub display_name: String,
    pub status: String,
    pub created_at: i64,
}

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

/// bot_schedules 表行结构。
pub struct BotScheduleRow {
    pub id: i64,
    pub bot_id: i64,
    pub chat_id: u32,
    pub minute: i32,
    pub hour: i32,
    pub day_of_week: i32,
    pub message: String,
    pub enabled: bool,
    pub next_run_at: i64,
    pub created_at: i64,
}

/// bot_plugin_tools 表行结构。
pub struct PluginToolRow {
    pub name: String,
    pub description: String,
    pub parameters: String,
    pub created_at: i64,
}

/// github_repos 表行结构。
pub struct GithubRepoRow {
    pub id: i64,
    pub owner: String,
    pub repo: String,
    pub full_name: String,
}

/// knowledge 表行结构。
pub struct KnowledgeRow {
    pub id: i64,
    pub chat_id: u32,
    pub date: String,
    pub title: String,
    pub summary: String,
    pub tags: String,
    pub msg_count: u32,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// knowledge_config 表行结构。
pub struct KnowledgeConfigRow {
    pub chat_id: u32,
    pub daily_enabled: bool,
    pub daily_time: String,
    pub window_count: i64,
    pub auto_store: bool,
    pub daily_run_date: Option<String>,
    pub updated_at: i64,
}

/// intelligence_settings 表行结构(单行 id=1)。
pub struct IntelligenceSettingsRow {
    pub id: i64,
    pub mode: String,
    pub source: String,
    pub model_tier: String,
    pub window_n: i64,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub updated_at: i64,
}

/// 主题总结偏好/状态行(无行时取默认)。
#[derive(Clone, Debug)]
pub struct SummarySettingsRow {
    pub mode: String, pub source: String, pub model_size: String,
    pub context_n: u32, pub engine_version: Option<String>, pub model_sha256: Option<String>,
    pub api_base_url: Option<String>, pub api_key: Option<String>, pub api_model: Option<String>,
}

impl Default for SummarySettingsRow {
    /// 与 SQL 默认(mode='wordfreq', source='local', model_size='0.5b', context_n=50)对齐,
    /// 避免无行时 Rust 默认("", 0)与落库后读到的值不一致。
    fn default() -> Self {
        Self {
            mode: "wordfreq".into(), source: "local".into(), model_size: "0.5b".into(),
            context_n: 50, engine_version: None, model_sha256: None,
            api_base_url: None, api_key: None, api_model: None,
        }
    }
}

/// set_summary_settings 的输入(部分字段)。
#[derive(Clone, Debug)]
pub struct SummarySettingsPatch {
    pub mode: String, pub source: String, pub model_size: String, pub context_n: u32,
}

pub struct Db {
    pub conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub async fn new(path: PathBuf) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let conn = tokio::task::spawn_blocking(move || -> AppResult<Connection> {
            Ok(Connection::open(path)?)
        })
        .await??;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    master_chat_id INTEGER NOT NULL,
                    icon TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    chat_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'General',
                    position INTEGER NOT NULL DEFAULT 0,
                    topic TEXT,
                    UNIQUE(workspace_id, chat_id)
                );
                CREATE TABLE IF NOT EXISTS roles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    color TEXT
                );
                CREATE TABLE IF NOT EXISTS contact_roles (
                    contact_id INTEGER NOT NULL,
                    role_id INTEGER NOT NULL,
                    workspace_id INTEGER NOT NULL,
                    PRIMARY KEY(contact_id, role_id)
                );
                CREATE TABLE IF NOT EXISTS pins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    channel_chat_id INTEGER NOT NULL,
                    msg_id INTEGER NOT NULL,
                    pinned_by INTEGER NOT NULL,
                    pinned_at INTEGER NOT NULL,
                    UNIQUE(channel_chat_id, msg_id)
                );
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    channel_chat_id INTEGER NOT NULL,
                    msg_id INTEGER,
                    type TEXT NOT NULL DEFAULT 'card',
                    title TEXT NOT NULL,
                    description TEXT,
                    status TEXT NOT NULL DEFAULT 'todo',
                    assignee_contact_id INTEGER,
                    due_date INTEGER,
                    created_by INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    source_msg_id INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_cards_workspace_channel ON cards(workspace_id, channel_chat_id);
                CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
                CREATE INDEX IF NOT EXISTS idx_cards_assignee ON cards(assignee_contact_id);
                CREATE INDEX IF NOT EXISTS idx_cards_msg_id ON cards(msg_id);
                CREATE TABLE IF NOT EXISTS inbox_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    source_chat_id INTEGER NOT NULL,
                    msg_id INTEGER,
                    actor_id INTEGER NOT NULL,
                    actor_name TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    read_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_inbox_workspace ON inbox_events(workspace_id, read_at);
                CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_events(created_at DESC);
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id INTEGER NOT NULL,
                    channel_chat_id INTEGER,
                    actor_id INTEGER NOT NULL,
                    actor_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id INTEGER NOT NULL,
                    payload TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_activities_workspace ON activities(workspace_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_activities_channel ON activities(channel_chat_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS bots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_account_id INTEGER NOT NULL,
                    bot_account_id INTEGER NOT NULL,
                    display_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    config_json TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE(owner_account_id, bot_account_id)
                );
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
                CREATE TABLE IF NOT EXISTS bot_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    bot_id INTEGER NOT NULL,
                    chat_id INTEGER NOT NULL,
                    minute INTEGER NOT NULL DEFAULT -1,
                    hour INTEGER NOT NULL DEFAULT -1,
                    day_of_week INTEGER NOT NULL DEFAULT -1,
                    message TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    next_run_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_bot_schedules_due ON bot_schedules(next_run_at);
                CREATE TABLE IF NOT EXISTS bot_plugin_tools (
                    name TEXT PRIMARY KEY,
                    description TEXT NOT NULL,
                    parameters TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS github_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    token TEXT,
                    updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS github_repos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    full_name TEXT NOT NULL UNIQUE,
                    added_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    tags TEXT NOT NULL DEFAULT '[]',
                    msg_count INTEGER NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'manual',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(chat_id, date)
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_chat_date ON knowledge(chat_id, date);
                CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge(updated_at DESC);
                CREATE TABLE IF NOT EXISTS knowledge_config (
                    chat_id INTEGER PRIMARY KEY,
                    daily_enabled INTEGER NOT NULL DEFAULT 0,
                    daily_time TEXT NOT NULL DEFAULT '00:00',
                    window_count INTEGER NOT NULL DEFAULT 100,
                    auto_store INTEGER NOT NULL DEFAULT 1,
                    daily_run_date TEXT,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS intelligence_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    mode TEXT NOT NULL DEFAULT 'off',
                    source TEXT NOT NULL DEFAULT 'api',
                    model_tier TEXT NOT NULL DEFAULT '0.5b',
                    window_n INTEGER NOT NULL DEFAULT 50,
                    base_url TEXT,
                    api_key TEXT,
                    model TEXT,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS summary_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    mode TEXT NOT NULL DEFAULT 'wordfreq',
                    source TEXT NOT NULL DEFAULT 'local',
                    model_size TEXT NOT NULL DEFAULT '0.5b',
                    context_n INTEGER NOT NULL DEFAULT 50,
                    engine_version TEXT,
                    model_sha256 TEXT,
                    api_base_url TEXT, api_key TEXT, api_model TEXT,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS summary_cache (
                    chat_id INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (chat_id, kind)
                );",
            )?;
            Ok(())
        })
        .await??;
        // channels 表加 space_type 列(若不存在)。SQLite 不支持 ADD COLUMN IF NOT EXISTS,
        // 用 PRAGMA 检查列是否存在。
        let conn2 = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn2.blocking_lock();
            let has_col: bool = c
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('channels') WHERE name='space_type'",
                    [],
                    |row| row.get(0),
                )?;
            if !has_col {
                c.execute(
                    "ALTER TABLE channels ADD COLUMN space_type TEXT NOT NULL DEFAULT 'chat'",
                    [],
                )?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn list_workspaces(&self) -> AppResult<Vec<WorkspaceDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<WorkspaceDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, name, master_chat_id, icon, created_at FROM workspaces ORDER BY id")?;
            let rows = stmt.query_map([], |r| {
                Ok(WorkspaceDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    master_chat_id: r.get::<_, i64>(2)? as u32,
                    icon: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn insert_workspace(&self, name: &str, master_chat_id: u32, icon: Option<&str>) -> AppResult<i64> {
        let conn = self.conn.clone();
        let name = name.to_string();
        let icon = icon.map(|s| s.to_string());
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO workspaces (name, master_chat_id, icon, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![name, master_chat_id as i64, icon, now],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn list_channels(&self, workspace_id: i64) -> AppResult<Vec<ChannelDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<ChannelDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, workspace_id, chat_id, name, category, position, topic FROM channels WHERE workspace_id = ?1 ORDER BY category, position, id")?;
            let rows = stmt.query_map(rusqlite::params![workspace_id], |r| {
                Ok(ChannelDto {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    chat_id: r.get::<_, i64>(2)? as u32,
                    name: r.get(3)?,
                    category: r.get(4)?,
                    position: r.get(5)?,
                    topic: r.get(6)?,
                    unread: 0,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn insert_channel(&self, workspace_id: i64, chat_id: u32, name: &str, category: &str, position: i64) -> AppResult<i64> {
        let conn = self.conn.clone();
        let name = name.to_string();
        let category = category.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO channels (workspace_id, chat_id, name, category, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![workspace_id, chat_id as i64, name, category, position],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn find_workspace_by_master_chat(&self, master_chat_id: u32) -> AppResult<Option<WorkspaceDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<WorkspaceDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, name, master_chat_id, icon, created_at FROM workspaces WHERE master_chat_id = ?1")?;
            let mut rows = stmt.query_map(rusqlite::params![master_chat_id as i64], |r| {
                Ok(WorkspaceDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    master_chat_id: r.get::<_, i64>(2)? as u32,
                    icon: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?;
            Ok(rows.next().transpose()?)
        })
        .await?
    }

    /// 按 id 查工作区(Bot /whoami 等场景展示工作区名用)。
    pub async fn get_workspace(&self, id: i64) -> AppResult<Option<WorkspaceDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<WorkspaceDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, name, master_chat_id, icon, created_at FROM workspaces WHERE id = ?1")?;
            let mut rows = stmt.query_map(rusqlite::params![id], |r| {
                Ok(WorkspaceDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    master_chat_id: r.get::<_, i64>(2)? as u32,
                    icon: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?;
            Ok(rows.next().transpose()?)
        })
        .await?
    }

    pub async fn list_roles(&self, workspace_id: i64) -> AppResult<Vec<RoleDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<RoleDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, workspace_id, name, color FROM roles WHERE workspace_id = ?1 ORDER BY id")?;
            let rows = stmt.query_map(rusqlite::params![workspace_id], |r| {
                Ok(RoleDto {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn insert_role(&self, workspace_id: i64, name: &str, color: Option<&str>) -> AppResult<i64> {
        let conn = self.conn.clone();
        let name = name.to_string();
        let color = color.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO roles (workspace_id, name, color) VALUES (?1, ?2, ?3)",
                rusqlite::params![workspace_id, name, color],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn set_contact_role(&self, workspace_id: i64, contact_id: u32, role_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT OR IGNORE INTO contact_roles (contact_id, role_id, workspace_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![contact_id as i64, role_id, workspace_id],
            )?;
            Ok(())
        })
        .await?
    }

    #[allow(dead_code)]
    pub async fn list_contact_roles(&self, workspace_id: i64, contact_id: u32) -> AppResult<Vec<i64>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<i64>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT role_id FROM contact_roles WHERE workspace_id = ?1 AND contact_id = ?2")?;
            let rows = stmt.query_map(rusqlite::params![workspace_id, contact_id as i64], |r| r.get::<_, i64>(0))?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn list_all_contact_roles(&self, workspace_id: i64) -> AppResult<Vec<(u32, i64, String, Option<String>)>> {
        // 返回 (contact_id, role_id, role_name, role_color) 联表查询，供右栏按 role 分组使用
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<(u32, i64, String, Option<String>)>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT cr.contact_id, cr.role_id, r.name, r.color
                 FROM contact_roles cr
                 JOIN roles r ON cr.role_id = r.id
                 WHERE cr.workspace_id = ?1
                 ORDER BY r.id, cr.contact_id",
            )?;
            let rows = stmt.query_map(rusqlite::params![workspace_id], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u32,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn list_pins(&self, channel_chat_id: u32) -> AppResult<Vec<PinDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<PinDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, workspace_id, channel_chat_id, msg_id, pinned_by, pinned_at FROM pins WHERE channel_chat_id = ?1 ORDER BY pinned_at DESC")?;
            let rows = stmt.query_map(rusqlite::params![channel_chat_id as i64], |r| {
                Ok(PinDto {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    channel_chat_id: r.get::<_, i64>(2)? as u32,
                    msg_id: r.get::<_, i64>(3)? as u32,
                    pinned_by: r.get::<_, i64>(4)? as u32,
                    pinned_at: r.get(5)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn toggle_pin(&self, workspace_id: i64, channel_chat_id: u32, msg_id: u32, pinned_by: u32) -> AppResult<bool> {
        let conn = self.conn.clone();
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<bool> {
            let c = conn.blocking_lock();
            let exists: i64 = c.query_row(
                "SELECT COUNT(*) FROM pins WHERE channel_chat_id = ?1 AND msg_id = ?2",
                rusqlite::params![channel_chat_id as i64, msg_id as i64],
                |r| r.get(0),
            )?;
            if exists > 0 {
                c.execute(
                    "DELETE FROM pins WHERE channel_chat_id = ?1 AND msg_id = ?2",
                    rusqlite::params![channel_chat_id as i64, msg_id as i64],
                )?;
                Ok(false)
            } else {
                c.execute(
                    "INSERT INTO pins (workspace_id, channel_chat_id, msg_id, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![workspace_id, channel_chat_id as i64, msg_id as i64, pinned_by as i64, now],
                )?;
                Ok(true)
            }
        })
        .await?
    }

    pub async fn update_workspace(
        &self,
        id: i64,
        name: Option<&str>,
        icon: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let name = name.map(|s| s.to_string());
        let icon = icon.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            if let Some(n) = name {
                c.execute("UPDATE workspaces SET name = ?1 WHERE id = ?2", params![n, id])?;
            }
            if let Some(ic) = icon {
                c.execute("UPDATE workspaces SET icon = ?1 WHERE id = ?2", params![ic, id])?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn update_channel(
        &self,
        chat_id: u32,
        name: Option<&str>,
        topic: Option<&str>,
        category: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let name = name.map(|s| s.to_string());
        let topic = topic.map(|s| s.to_string());
        let category = category.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            if let Some(n) = name {
                c.execute("UPDATE channels SET name = ?1 WHERE chat_id = ?2", params![n, chat_id])?;
            }
            if let Some(t) = topic {
                c.execute("UPDATE channels SET topic = ?1 WHERE chat_id = ?2", params![t, chat_id])?;
            }
            if let Some(cat) = category {
                c.execute("UPDATE channels SET category = ?1 WHERE chat_id = ?2", params![cat, chat_id])?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn delete_workspace_rows(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM pins WHERE workspace_id = ?1", params![id])?;
            c.execute("DELETE FROM contact_roles WHERE workspace_id = ?1", params![id])?;
            c.execute("DELETE FROM roles WHERE workspace_id = ?1", params![id])?;
            c.execute("DELETE FROM channels WHERE workspace_id = ?1", params![id])?;
            c.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn delete_channel_row(&self, chat_id: u32) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM channels WHERE chat_id = ?1", params![chat_id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn insert_card(
        &self,
        workspace_id: i64,
        channel_chat_id: u32,
        type_: &str,
        title: &str,
        description: Option<&str>,
        status: &str,
        assignee_contact_id: Option<u32>,
        due_date: Option<i64>,
        created_by: u32,
        created_at: i64,
        source_msg_id: Option<u32>,
    ) -> AppResult<i64> {
        let conn = self.conn.clone();
        let type_ = type_.to_string();
        let title = title.to_string();
        let description = description.map(|s| s.to_string());
        let status = status.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO cards (workspace_id, channel_chat_id, type, title, description, status, assignee_contact_id, due_date, created_by, created_at, updated_at, position, source_msg_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 0, ?11)",
                params![workspace_id, channel_chat_id, type_, title, description, status, assignee_contact_id, due_date, created_by, created_at, source_msg_id],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn update_card_fields(
        &self,
        card_id: i64,
        title: Option<&str>,
        description: Option<Option<&str>>,
        status: Option<&str>,
        assignee_contact_id: Option<Option<u32>>,
        due_date: Option<Option<i64>>,
        updated_at: i64,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let title = title.map(|s| s.to_string());
        let description = description.map(|s| s.map(|s| s.to_string()));
        let status = status.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            if let Some(t) = title {
                c.execute("UPDATE cards SET title=?1, updated_at=?2 WHERE id=?3", params![t, updated_at, card_id])?;
            }
            if let Some(d) = description {
                c.execute("UPDATE cards SET description=?1, updated_at=?2 WHERE id=?3", params![d, updated_at, card_id])?;
            }
            if let Some(s) = status {
                c.execute("UPDATE cards SET status=?1, updated_at=?2 WHERE id=?3", params![s, updated_at, card_id])?;
            }
            if let Some(a) = assignee_contact_id {
                c.execute("UPDATE cards SET assignee_contact_id=?1, updated_at=?2 WHERE id=?3", params![a, updated_at, card_id])?;
            }
            if let Some(d) = due_date {
                c.execute("UPDATE cards SET due_date=?1, updated_at=?2 WHERE id=?3", params![d, updated_at, card_id])?;
            }
            Ok(())
        })
        .await?
    }

    pub async fn delete_card(&self, card_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM cards WHERE id=?1", params![card_id])?;
            Ok(())
        })
        .await?
    }

    pub async fn list_cards(&self, workspace_id: i64, channel_chat_id: u32) -> AppResult<Vec<(i64, i64, u32, Option<u32>, String, String, Option<String>, String, Option<u32>, Option<i64>, u32, i64, i64, i64, i64, Option<u32>)>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<_>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, workspace_id, channel_chat_id, msg_id, type, title, description, status, assignee_contact_id, due_date, created_by, created_at, updated_at, position, 0, source_msg_id FROM cards WHERE workspace_id=?1 AND channel_chat_id=?2 ORDER BY status, position, created_at",
            )?;
            let rows = stmt.query_map(params![workspace_id, channel_chat_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?))
            })?;
            let mut out = Vec::new();
            for r in rows { out.push(r?); }
            Ok(out)
        })
        .await?
    }

    pub async fn get_card_row(&self, card_id: i64) -> AppResult<Option<(i64, i64, u32, Option<u32>, String, String, Option<String>, String, Option<u32>, Option<i64>, u32, i64, i64, i64, i64, Option<u32>)>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<_>> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT id, workspace_id, channel_chat_id, msg_id, type, title, description, status, assignee_contact_id, due_date, created_by, created_at, updated_at, position, 0, source_msg_id FROM cards WHERE id=?1",
                params![card_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?)),
            ).optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn find_card_by_dedup(&self, channel_chat_id: u32, title: &str, created_at: i64) -> AppResult<Option<i64>> {
        let conn = self.conn.clone();
        let title = title.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Option<i64>> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT id FROM cards WHERE channel_chat_id=?1 AND title=?2 AND ABS(created_at - ?3) < 60",
                params![channel_chat_id, title, created_at],
                |row| row.get(0),
            ).optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn set_card_msg_id(&self, card_id: i64, msg_id: u32) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE cards SET msg_id=?1 WHERE id=?2", params![msg_id, card_id])?;
            Ok(())
        })
        .await?
    }

    pub async fn set_channel_space_type(&self, chat_id: u32, space_type: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let space_type = space_type.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE channels SET space_type=?1 WHERE chat_id=?2", params![space_type, chat_id])?;
            Ok(())
        })
        .await?
    }

    pub async fn get_channel_space_type(&self, chat_id: u32) -> AppResult<Option<String>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT space_type FROM channels WHERE chat_id=?1",
                params![chat_id],
                |row| row.get(0),
            ).optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn get_channel_workspace_id(&self, chat_id: u32) -> AppResult<i64> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT workspace_id FROM channels WHERE chat_id=?1",
                params![chat_id],
                |row| row.get(0),
            ).optional()?;
            row.ok_or_else(|| AppError::Core(format!("channel {chat_id} not found")))
        })
        .await?
    }

    // ── SP6: Inbox + Activity ───────────────────────────────────────────────

    pub async fn list_inbox_events(
        &self,
        workspace_id: i64,
        limit: i64,
    ) -> AppResult<Vec<InboxEventDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<InboxEventDto>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, workspace_id, type, source_chat_id, msg_id, actor_id, actor_name, summary, created_at, read_at
                 FROM inbox_events WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![workspace_id, limit], |r| {
                Ok(InboxEventDto {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    type_: r.get(2)?,
                    source_chat_id: r.get(3)?,
                    msg_id: r.get(4)?,
                    actor_id: r.get(5)?,
                    actor_name: r.get(6)?,
                    summary: r.get(7)?,
                    created_at: r.get(8)?,
                    read_at: r.get(9)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn mark_inbox_read(&self, event_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE inbox_events SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL",
                params![now, event_id],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn mark_all_inbox_read(&self, workspace_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE inbox_events SET read_at = ?1 WHERE workspace_id = ?2 AND read_at IS NULL",
                params![now, workspace_id],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn get_inbox_unread_count(&self, workspace_id: i64) -> AppResult<i64> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            let count: i64 = c.query_row(
                "SELECT COUNT(*) FROM inbox_events WHERE workspace_id = ?1 AND read_at IS NULL",
                params![workspace_id],
                |r| r.get(0),
            )?;
            Ok(count)
        })
        .await?
    }

    pub async fn list_activities(
        &self,
        workspace_id: i64,
        channel_chat_id: Option<i64>,
        limit: i64,
    ) -> AppResult<Vec<ActivityDto>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<ActivityDto>> {
            let c = conn.blocking_lock();
            let sql = if channel_chat_id.is_some() {
                "SELECT id, workspace_id, channel_chat_id, actor_id, actor_name, action, target_type, target_id, payload, created_at
                 FROM activities WHERE workspace_id = ?1 AND channel_chat_id = ?2 ORDER BY created_at DESC LIMIT ?3"
            } else {
                "SELECT id, workspace_id, channel_chat_id, actor_id, actor_name, action, target_type, target_id, payload, created_at
                 FROM activities WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2"
            };
            let mut stmt = c.prepare(sql)?;
            let map = |r: &rusqlite::Row| {
                Ok(ActivityDto {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    channel_chat_id: r.get(2)?,
                    actor_id: r.get(3)?,
                    actor_name: r.get(4)?,
                    action: r.get(5)?,
                    target_type: r.get(6)?,
                    target_id: r.get(7)?,
                    payload: r.get(8)?,
                    created_at: r.get(9)?,
                })
            };
            let rows = if let Some(ch_id) = channel_chat_id {
                stmt.query_map(params![workspace_id, ch_id, limit], map)?
                    .filter_map(|x| x.ok())
                    .collect::<Vec<_>>()
            } else {
                stmt.query_map(params![workspace_id, limit], map)?
                    .filter_map(|x| x.ok())
                    .collect::<Vec<_>>()
            };
            Ok(rows)
        })
        .await?
    }

    pub async fn record_activity(
        &self,
        workspace_id: i64,
        channel_chat_id: Option<i64>,
        actor_id: i64,
        actor_name: &str,
        action: &str,
        target_type: &str,
        target_id: i64,
        payload: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let actor_name = actor_name.to_string();
        let action = action.to_string();
        let target_type = target_type.to_string();
        let payload = payload.map(|s| s.to_string());
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO activities (workspace_id, channel_chat_id, actor_id, actor_name, action, target_type, target_id, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    workspace_id,
                    channel_chat_id,
                    actor_id,
                    actor_name,
                    action,
                    target_type,
                    target_id,
                    payload,
                    now
                ],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn record_inbox_event(
        &self,
        workspace_id: i64,
        event_type: &str,
        source_chat_id: i64,
        msg_id: Option<i64>,
        actor_id: i64,
        actor_name: &str,
        summary: &str,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let event_type = event_type.to_string();
        let actor_name = actor_name.to_string();
        let summary = summary.to_string();
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO inbox_events (workspace_id, type, source_chat_id, msg_id, actor_id, actor_name, summary, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    workspace_id,
                    event_type,
                    source_chat_id,
                    msg_id,
                    actor_id,
                    actor_name,
                    summary,
                    now
                ],
            )?;
            Ok(())
        })
        .await?
    }

    // ── Bot 系统 ───────────────────────────────────────────────────────────

    pub async fn insert_bot(&self, owner_account_id: u32, bot_account_id: u32, display_name: &str, created_at: i64) -> AppResult<i64> {
        let conn = self.conn.clone();
        let display_name = display_name.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO bots (owner_account_id, bot_account_id, display_name, status, created_at) VALUES (?1, ?2, ?3, 'running', ?4)",
                params![owner_account_id, bot_account_id, display_name, created_at],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn list_bots(&self, owner_account_id: u32) -> AppResult<Vec<BotRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<BotRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, bot_account_id, owner_account_id, display_name, status, created_at FROM bots WHERE owner_account_id = ?1 ORDER BY id")?;
            let rows = stmt.query_map(params![owner_account_id], |r| {
                Ok(BotRow {
                    id: r.get(0)?,
                    bot_account_id: r.get::<_, i64>(1)? as u32,
                    owner_account_id: r.get::<_, i64>(2)? as u32,
                    display_name: r.get(3)?,
                    status: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    /// 列出全部 bot(不区分 owner),供应用级后台运行时使用。
    pub async fn list_all_bots(&self) -> AppResult<Vec<BotRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<BotRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare("SELECT id, bot_account_id, owner_account_id, display_name, status, created_at FROM bots ORDER BY id")?;
            let rows = stmt.query_map([], |r| {
                Ok(BotRow {
                    id: r.get(0)?,
                    bot_account_id: r.get::<_, i64>(1)? as u32,
                    owner_account_id: r.get::<_, i64>(2)? as u32,
                    display_name: r.get(3)?,
                    status: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn get_bot(&self, owner_account_id: u32, bot_id: i64) -> AppResult<Option<BotRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<BotRow>> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT id, bot_account_id, owner_account_id, display_name, status, created_at FROM bots WHERE owner_account_id = ?1 AND id = ?2",
                params![owner_account_id, bot_id],
                |r| {
                    Ok(BotRow {
                        id: r.get(0)?,
                        bot_account_id: r.get::<_, i64>(1)? as u32,
                        owner_account_id: r.get::<_, i64>(2)? as u32,
                        display_name: r.get(3)?,
                        status: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            ).optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn delete_bot(&self, owner_account_id: u32, bot_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM bots WHERE owner_account_id = ?1 AND id = ?2", params![owner_account_id, bot_id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 按 bot 账号 id 查 bots 行(用于自愈:判断选中账号是否为 bot)。
    pub async fn get_bot_by_account_id(&self, account_id: u32) -> AppResult<Option<BotRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<BotRow>> {
            let c = conn.blocking_lock();
            let row = c
                .query_row(
                    "SELECT id, bot_account_id, owner_account_id, display_name, status, created_at FROM bots WHERE bot_account_id = ?1",
                    params![account_id],
                    |r| {
                        Ok(BotRow {
                            id: r.get(0)?,
                            bot_account_id: r.get::<_, i64>(1)? as u32,
                            owner_account_id: r.get::<_, i64>(2)? as u32,
                            display_name: r.get(3)?,
                            status: r.get(4)?,
                            created_at: r.get(5)?,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
        .await?
    }

    /// 按 bot 行 id 全局查 bots 行(Bot 是应用级服务,不按 owner 过滤)。
    pub async fn get_bot_by_id(&self, bot_id: i64) -> AppResult<Option<BotRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<BotRow>> {
            let c = conn.blocking_lock();
            let row = c
                .query_row(
                    "SELECT id, bot_account_id, owner_account_id, display_name, status, created_at FROM bots WHERE id = ?1",
                    params![bot_id],
                    |r| {
                        Ok(BotRow {
                            id: r.get(0)?,
                            bot_account_id: r.get::<_, i64>(1)? as u32,
                            owner_account_id: r.get::<_, i64>(2)? as u32,
                            display_name: r.get(3)?,
                            status: r.get(4)?,
                            created_at: r.get(5)?,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn set_bot_status(&self, owner_account_id: u32, bot_id: i64, status: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let status = status.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE bots SET status = ?3 WHERE owner_account_id = ?1 AND id = ?2", params![owner_account_id, bot_id, status])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 写入某个 bot 的 LLM 配置(config_json)，按 (owner, id) 限定归属。
    pub async fn set_bot_config(&self, owner_account_id: u32, bot_id: i64, config_json: Option<&str>) -> AppResult<()> {
        let conn = self.conn.clone();
        let config_json = config_json.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE bots SET config_json = ?3 WHERE owner_account_id = ?1 AND id = ?2",
                params![owner_account_id, bot_id, config_json],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读取某个 bot 的 LLM 配置(config_json)，未配置时为 None。
    pub async fn get_bot_config(&self, owner_account_id: u32, bot_id: i64) -> AppResult<Option<String>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT config_json FROM bots WHERE owner_account_id = ?1 AND id = ?2",
                params![owner_account_id, bot_id],
                |row| row.get::<_, Option<String>>(0),
            ).optional()?;
            Ok(row.flatten())
        })
        .await?
    }

    // ── 全局 by-id 变体(bot 是应用级服务,不按 owner 过滤) ──────────────

    pub async fn delete_bot_by_id(&self, bot_id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM bots WHERE id = ?1", params![bot_id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn set_bot_status_by_id(&self, bot_id: i64, status: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let status = status.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE bots SET status = ?2 WHERE id = ?1", params![bot_id, status])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn set_bot_config_by_id(&self, bot_id: i64, config_json: Option<&str>) -> AppResult<()> {
        let conn = self.conn.clone();
        let config_json = config_json.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE bots SET config_json = ?2 WHERE id = ?1", params![bot_id, config_json])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn get_bot_config_by_id(&self, bot_id: i64) -> AppResult<Option<String>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
            let c = conn.blocking_lock();
            let row = c
                .query_row("SELECT config_json FROM bots WHERE id = ?1", params![bot_id], |row| row.get::<_, Option<String>>(0))
                .optional()?;
            Ok(row.flatten())
        })
        .await?
    }

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

    /// 按 kind 聚合某个 bot 的活动统计（单条 SQL）。
    pub async fn get_bot_stats(&self, bot_id: i64) -> AppResult<BotStatsDto> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<BotStatsDto> {
            let c = conn.blocking_lock();
            let row = c.query_row(
                "SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN kind='reply_sent' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN kind='rule_reply' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN kind='schedule_sent' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN kind='tool_called' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN kind='llm_error' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN kind='reply_rate_limited' THEN 1 ELSE 0 END), 0),
                   MAX(created_at), MIN(created_at)
                 FROM bot_activities WHERE bot_id=?1",
                params![bot_id],
                |r| {
                    Ok(BotStatsDto {
                        total_activities: r.get(0)?,
                        reply_sent: r.get(1)?,
                        rule_reply: r.get(2)?,
                        schedule_sent: r.get(3)?,
                        tool_called: r.get(4)?,
                        llm_error: r.get(5)?,
                        rate_limited: r.get(6)?,
                        last_activity_at: r.get(7)?,
                        first_seen_at: r.get(8)?,
                    })
                },
            )?;
            Ok(row)
        })
        .await?
    }

    // ── Bot 定时消息 ──────────────────────────────────────────────────────

    pub async fn insert_bot_schedule(
        &self,
        bot_id: i64,
        chat_id: u32,
        minute: i32,
        hour: i32,
        day_of_week: i32,
        message: &str,
        next_run_at: i64,
    ) -> AppResult<i64> {
        let conn = self.conn.clone();
        let message = message.to_string();
        let created_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO bot_schedules (bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)",
                params![bot_id, chat_id, minute, hour, day_of_week, message, next_run_at, created_at],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    pub async fn list_bot_schedules(&self, bot_id: i64) -> AppResult<Vec<BotScheduleRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<BotScheduleRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at, created_at
                 FROM bot_schedules WHERE bot_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map(params![bot_id], |r| {
                Ok(BotScheduleRow {
                    id: r.get(0)?,
                    bot_id: r.get(1)?,
                    chat_id: r.get::<_, i64>(2)? as u32,
                    minute: r.get(3)?,
                    hour: r.get(4)?,
                    day_of_week: r.get(5)?,
                    message: r.get(6)?,
                    enabled: r.get::<_, i64>(7)? != 0,
                    next_run_at: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn get_bot_schedule(&self, id: i64) -> AppResult<Option<BotScheduleRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<BotScheduleRow>> {
            let c = conn.blocking_lock();
            let row = c
                .query_row(
                    "SELECT id, bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at, created_at
                     FROM bot_schedules WHERE id = ?1",
                    params![id],
                    |r| {
                        Ok(BotScheduleRow {
                            id: r.get(0)?,
                            bot_id: r.get(1)?,
                            chat_id: r.get::<_, i64>(2)? as u32,
                            minute: r.get(3)?,
                            hour: r.get(4)?,
                            day_of_week: r.get(5)?,
                            message: r.get(6)?,
                            enabled: r.get::<_, i64>(7)? != 0,
                            next_run_at: r.get(8)?,
                            created_at: r.get(9)?,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
        .await?
    }

    pub async fn delete_bot_schedule(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM bot_schedules WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 查询到期的定时消息:enabled=1 且 next_run_at <= now。
    pub async fn list_due_schedules(&self, now: i64) -> AppResult<Vec<BotScheduleRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<BotScheduleRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, bot_id, chat_id, minute, hour, day_of_week, message, enabled, next_run_at, created_at
                 FROM bot_schedules WHERE enabled = 1 AND next_run_at <= ?1 ORDER BY next_run_at",
            )?;
            let rows = stmt.query_map(params![now], |r| {
                Ok(BotScheduleRow {
                    id: r.get(0)?,
                    bot_id: r.get(1)?,
                    chat_id: r.get::<_, i64>(2)? as u32,
                    minute: r.get(3)?,
                    hour: r.get(4)?,
                    day_of_week: r.get(5)?,
                    message: r.get(6)?,
                    enabled: r.get::<_, i64>(7)? != 0,
                    next_run_at: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    pub async fn set_schedule_next_run(&self, id: i64, next_run_at: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE bot_schedules SET next_run_at = ?2 WHERE id = ?1", params![id, next_run_at])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    // ── 插件工具 ──────────────────────────────────────────────────────────

    /// 注册或更新插件工具(以 name 为主键,INSERT OR REPLACE 覆盖)。
    pub async fn upsert_plugin_tool(&self, name: &str, description: &str, parameters: &str, created_at: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        let name = name.to_string();
        let description = description.to_string();
        let parameters = parameters.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT OR REPLACE INTO bot_plugin_tools (name, description, parameters, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![name, description, parameters, created_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn delete_plugin_tool(&self, name: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let name = name.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM bot_plugin_tools WHERE name = ?1", params![name])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn list_plugin_tools(&self) -> AppResult<Vec<PluginToolRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<PluginToolRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT name, description, parameters, created_at FROM bot_plugin_tools ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(PluginToolRow {
                    name: r.get(0)?,
                    description: r.get(1)?,
                    parameters: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    // ── GitHub 集成 ────────────────────────────────────────────────────

    /// 读取全局 GitHub 设置;无行返回默认(空 token)。
    pub async fn get_github_settings(&self) -> AppResult<GithubSettingsDto> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<GithubSettingsDto> {
            let c = conn.blocking_lock();
            let token = c
                .query_row(
                    "SELECT token FROM github_settings WHERE id = 1",
                    [],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            Ok(GithubSettingsDto { token })
        })
        .await?
    }

    /// 写入全局 GitHub token(UPSERT id=1);None 置 NULL 并刷新 updated_at。
    pub async fn set_github_token(&self, token: Option<&str>) -> AppResult<()> {
        let conn = self.conn.clone();
        let token = token.map(str::to_string);
        let updated_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO github_settings (id, token, updated_at) VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at",
                params![token, updated_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 列出已绑定仓库(按添加顺序)。
    pub async fn list_github_repos(&self) -> AppResult<Vec<GithubRepoRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<GithubRepoRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, owner, repo, full_name FROM github_repos ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(GithubRepoRow {
                    id: r.get(0)?,
                    owner: r.get(1)?,
                    repo: r.get(2)?,
                    full_name: r.get(3)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    /// 绑定仓库;full_name = "{owner}/{repo}",owner/repo 重复时唯一约束冲突返回 Db 错误。
    pub async fn add_github_repo(&self, owner: &str, repo: &str) -> AppResult<i64> {
        let conn = self.conn.clone();
        let owner = owner.to_string();
        let repo = repo.to_string();
        let full_name = format!("{owner}/{repo}");
        let added_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO github_repos (owner, repo, full_name, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![owner, repo, full_name, added_at],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?
    }

    /// 解除绑定仓库。
    pub async fn remove_github_repo(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM github_repos WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 仓库是否已绑定(write 工具限绑定仓库用)。
    pub async fn is_repo_bound(&self, owner: &str, repo: &str) -> AppResult<bool> {
        let conn = self.conn.clone();
        let full_name = format!("{owner}/{repo}");
        tokio::task::spawn_blocking(move || -> AppResult<bool> {
            let c = conn.blocking_lock();
            let count: i64 = c.query_row(
                "SELECT COUNT(*) FROM github_repos WHERE full_name = ?1",
                params![full_name],
                |r| r.get(0),
            )?;
            Ok(count > 0)
        })
        .await?
    }

    /// 知识条目 UPSERT:同 (chat_id, date) 冲突时更新内容,保留原 id;返回条目 id。
    pub async fn upsert_knowledge(
        &self,
        chat_id: u32,
        date: &str,
        title: &str,
        summary: &str,
        tags: &str,
        msg_count: u32,
        source: &str,
    ) -> AppResult<i64> {
        let conn = self.conn.clone();
        let (chat_id, date, title, summary, tags, source) = (
            chat_id,
            date.to_string(),
            title.to_string(),
            summary.to_string(),
            tags.to_string(),
            source.to_string(),
        );
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<i64> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO knowledge (chat_id, date, title, summary, tags, msg_count, source, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(chat_id, date) DO UPDATE SET
                   title = excluded.title, summary = excluded.summary, tags = excluded.tags,
                   msg_count = excluded.msg_count, source = excluded.source, updated_at = excluded.updated_at",
                params![chat_id, date, title, summary, tags, msg_count, source, now],
            )?;
            // ON CONFLICT UPDATE 时 last_insert_rowid 不可靠,回查 id。
            let id: i64 = c.query_row(
                "SELECT id FROM knowledge WHERE chat_id = ?1 AND date = ?2",
                params![chat_id, date],
                |r| r.get(0),
            )?;
            Ok(id)
        })
        .await?
    }

    /// 知识条目列表(动态过滤:会话/标签/关键词;分页;按更新时间倒序)。
    pub async fn list_knowledge(
        &self,
        chat_id: Option<u32>,
        tag: Option<&str>,
        keyword: Option<&str>,
        page: i64,
        page_size: i64,
    ) -> AppResult<Vec<KnowledgeRow>> {
        let conn = self.conn.clone();
        let (chat_id, tag, keyword) = (
            chat_id,
            tag.map(str::to_string),
            keyword.map(str::to_string),
        );
        let offset = (page.max(1) - 1) * page_size.max(1);
        tokio::task::spawn_blocking(move || -> AppResult<Vec<KnowledgeRow>> {
            let c = conn.blocking_lock();
            let mut sql = String::from(
                "SELECT id, chat_id, date, title, summary, tags, msg_count, source, created_at, updated_at
                 FROM knowledge WHERE 1=1",
            );
            let mut p: Vec<rusqlite::types::Value> = Vec::new();
            if let Some(chat) = chat_id {
                sql.push_str(" AND chat_id = ?");
                p.push(rusqlite::types::Value::Integer(chat as i64));
            }
            if let Some(t) = tag {
                // tags 是 JSON 数组,匹配含 "t" 字面量的元素。
                sql.push_str(" AND tags LIKE ?");
                let like = format!("%\"{t}\"%");
                p.push(rusqlite::types::Value::Text(like));
            }
            if let Some(k) = keyword {
                sql.push_str(" AND (title LIKE ? OR summary LIKE ?)");
                let like = format!("%{k}%");
                p.push(rusqlite::types::Value::Text(like.clone()));
                p.push(rusqlite::types::Value::Text(like));
            }
            sql.push_str(" ORDER BY updated_at DESC LIMIT ? OFFSET ?");
            p.push(rusqlite::types::Value::Integer(page_size));
            p.push(rusqlite::types::Value::Integer(offset));
            let params = rusqlite::params_from_iter(p.iter());
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map(params, |r| {
                Ok(KnowledgeRow {
                    id: r.get(0)?,
                    chat_id: r.get(1)?,
                    date: r.get(2)?,
                    title: r.get(3)?,
                    summary: r.get(4)?,
                    tags: r.get(5)?,
                    msg_count: r.get(6)?,
                    source: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    /// 单条知识条目。
    pub async fn get_knowledge(&self, id: i64) -> AppResult<Option<KnowledgeRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<KnowledgeRow>> {
            let c = conn.blocking_lock();
            c.query_row(
                "SELECT id, chat_id, date, title, summary, tags, msg_count, source, created_at, updated_at
                 FROM knowledge WHERE id = ?1",
                params![id],
                |r| {
                    Ok(KnowledgeRow {
                        id: r.get(0)?,
                        chat_id: r.get(1)?,
                        date: r.get(2)?,
                        title: r.get(3)?,
                        summary: r.get(4)?,
                        tags: r.get(5)?,
                        msg_count: r.get(6)?,
                        source: r.get(7)?,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
        .await?
    }

    /// 删除知识条目。
    pub async fn delete_knowledge(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM knowledge WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 更新知识条目(仅非 None 字段)。
    pub async fn update_knowledge(
        &self,
        id: i64,
        title: Option<&str>,
        summary: Option<&str>,
        tags: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let (title, summary, tags) = (
            title.map(str::to_string),
            summary.map(str::to_string),
            tags.map(str::to_string),
        );
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            let mut sql = String::from("UPDATE knowledge SET updated_at = ?1");
            let mut p: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Integer(now)];
            if let Some(t) = title {
                sql.push_str(", title = ?");
                p.push(rusqlite::types::Value::Text(t));
            }
            if let Some(s) = summary {
                sql.push_str(", summary = ?");
                p.push(rusqlite::types::Value::Text(s));
            }
            if let Some(t) = tags {
                sql.push_str(", tags = ?");
                p.push(rusqlite::types::Value::Text(t));
            }
            sql.push_str(" WHERE id = ?");
            p.push(rusqlite::types::Value::Integer(id));
            let params = rusqlite::params_from_iter(p.iter());
            c.execute(&sql, params)?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 每会话知识库配置。
    pub async fn get_knowledge_config(&self, chat_id: u32) -> AppResult<Option<KnowledgeConfigRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<KnowledgeConfigRow>> {
            let c = conn.blocking_lock();
            c.query_row(
                "SELECT chat_id, daily_enabled, daily_time, window_count, auto_store, daily_run_date, updated_at
                 FROM knowledge_config WHERE chat_id = ?1",
                params![chat_id],
                |r| {
                    Ok(KnowledgeConfigRow {
                        chat_id: r.get(0)?,
                        daily_enabled: r.get::<_, i64>(1)? != 0,
                        daily_time: r.get(2)?,
                        window_count: r.get(3)?,
                        auto_store: r.get::<_, i64>(4)? != 0,
                        daily_run_date: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
        .await?
    }

    /// 写每会话知识库配置(保留 daily_run_date 不重置)。
    pub async fn set_knowledge_config(
        &self,
        chat_id: u32,
        daily_enabled: bool,
        daily_time: &str,
        window_count: i64,
        auto_store: bool,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let daily_time = daily_time.to_string();
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO knowledge_config (chat_id, daily_enabled, daily_time, window_count, auto_store, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(chat_id) DO UPDATE SET
                   daily_enabled = excluded.daily_enabled, daily_time = excluded.daily_time,
                   window_count = excluded.window_count, auto_store = excluded.auto_store,
                   updated_at = excluded.updated_at",
                params![chat_id, daily_enabled, daily_time, window_count, auto_store, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 全部会话知识库配置。
    pub async fn list_knowledge_configs(&self) -> AppResult<Vec<KnowledgeConfigRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Vec<KnowledgeConfigRow>> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT chat_id, daily_enabled, daily_time, window_count, auto_store, daily_run_date, updated_at
                 FROM knowledge_config ORDER BY chat_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(KnowledgeConfigRow {
                    chat_id: r.get(0)?,
                    daily_enabled: r.get::<_, i64>(1)? != 0,
                    daily_time: r.get(2)?,
                    window_count: r.get(3)?,
                    auto_store: r.get::<_, i64>(4)? != 0,
                    daily_run_date: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?;
            Ok(rows.filter_map(|x| x.ok()).collect())
        })
        .await?
    }

    /// 标记当日已执行每日自动总结(防同一天重复触发)。
    pub async fn mark_daily_run(&self, chat_id: u32, date: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let date = date.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE knowledge_config SET daily_run_date = ?2 WHERE chat_id = ?1",
                params![chat_id, date],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 智能设置(单行 id=1)。
    pub async fn get_intelligence_settings(&self) -> AppResult<Option<IntelligenceSettingsRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<IntelligenceSettingsRow>> {
            let c = conn.blocking_lock();
            c.query_row(
                "SELECT id, mode, source, model_tier, window_n, base_url, api_key, model, updated_at
                 FROM intelligence_settings WHERE id = 1",
                [],
                |r| {
                    Ok(IntelligenceSettingsRow {
                        id: r.get(0)?,
                        mode: r.get(1)?,
                        source: r.get(2)?,
                        model_tier: r.get(3)?,
                        window_n: r.get(4)?,
                        base_url: r.get(5)?,
                        api_key: r.get(6)?,
                        model: r.get(7)?,
                        updated_at: r.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
        .await?
    }

    /// 写智能设置(UPSERT id=1)。
    pub async fn set_intelligence_settings(
        &self,
        mode: &str,
        source: &str,
        model_tier: &str,
        window_n: i64,
        base_url: Option<&str>,
        api_key: Option<&str>,
        model: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.clone();
        let (mode, source, model_tier) = (
            mode.to_string(),
            source.to_string(),
            model_tier.to_string(),
        );
        let (base_url, api_key, model) = (
            base_url.map(str::to_string),
            api_key.map(str::to_string),
            model.map(str::to_string),
        );
        let now = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO intelligence_settings (id, mode, source, model_tier, window_n, base_url, api_key, model, updated_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   mode = excluded.mode, source = excluded.source, model_tier = excluded.model_tier,
                   window_n = excluded.window_n, base_url = excluded.base_url, api_key = excluded.api_key,
                   model = excluded.model, updated_at = excluded.updated_at",
                params![mode, source, model_tier, window_n, base_url, api_key, model, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    // ── 主题总结偏好/缓存 ───────────────────────────────────────────────

    /// 主题总结偏好/状态行(id=1)。无行 → 默认值。
    pub async fn get_summary_settings(&self) -> AppResult<SummarySettingsRow> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<SummarySettingsRow> {
            let c = conn.blocking_lock();
            let row = c
                .query_row(
                    "SELECT mode, source, model_size, context_n, engine_version, model_sha256,
                            api_base_url, api_key, api_model
                     FROM summary_settings WHERE id = 1",
                    [],
                    |r| {
                        Ok(SummarySettingsRow {
                            mode: r.get(0)?, source: r.get(1)?, model_size: r.get(2)?,
                            context_n: r.get(3)?, engine_version: r.get(4)?,
                            model_sha256: r.get(5)?, api_base_url: r.get(6)?,
                            api_key: r.get(7)?, api_model: r.get(8)?,
                        })
                    },
                )
                .optional()?
                .unwrap_or_default();
            Ok(row)
        })
        .await?
    }

    /// 写偏好(id=1 UPSERT)。
    pub async fn set_summary_settings(&self, p: &SummarySettingsPatch) -> AppResult<()> {
        let conn = self.conn.clone();
        let p = p.clone();
        let updated_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO summary_settings
                   (id, mode, source, model_size, context_n, updated_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   mode = excluded.mode, source = excluded.source,
                   model_size = excluded.model_size, context_n = excluded.context_n,
                   updated_at = excluded.updated_at",
                params![p.mode, p.source, p.model_size, p.context_n, updated_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 写 API 凭据(全 None = 清除;存 summary_settings.api_* 列)。
    pub async fn set_summary_api(&self, base_url: Option<&str>, api_key: Option<&str>, model: Option<&str>) -> AppResult<()> {
        let conn = self.conn.clone();
        let base_url = base_url.map(str::to_string);
        let api_key = api_key.map(str::to_string);
        let model = model.map(str::to_string);
        let updated_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO summary_settings (id, api_base_url, api_key, api_model, updated_at)
                 VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   api_base_url = excluded.api_base_url, api_key = excluded.api_key,
                   api_model = excluded.api_model, updated_at = excluded.updated_at",
                params![base_url, api_key, model, updated_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 写引擎版本 + 模型 sha256(下载完成时,id=1 UPSERT)。
    pub async fn set_summary_version_hash(&self, engine_version: &str, model_sha256: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let engine_version = engine_version.to_string();
        let model_sha256 = model_sha256.to_string();
        let updated_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO summary_settings (id, engine_version, model_sha256, updated_at)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                   engine_version = excluded.engine_version,
                   model_sha256 = excluded.model_sha256,
                   updated_at = excluded.updated_at",
                params![engine_version, model_sha256, updated_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// 读会话摘要缓存。无缓存 → None。
    pub async fn get_summary_cache(&self, chat_id: u64, kind: &str) -> AppResult<Option<String>> {
        let conn = self.conn.clone();
        let kind = kind.to_string();
        tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
            let c = conn.blocking_lock();
            let text = c
                .query_row(
                    "SELECT text FROM summary_cache WHERE chat_id = ?1 AND kind = ?2",
                    params![chat_id as i64, kind],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            Ok(text)
        })
        .await?
    }

    /// 写会话摘要缓存(chat_id,kind 主键 UPSERT)。
    pub async fn upsert_summary_cache(&self, chat_id: u64, kind: &str, text: &str) -> AppResult<()> {
        let conn = self.conn.clone();
        let kind = kind.to_string();
        let text = text.to_string();
        let updated_at = chrono::Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO summary_cache (chat_id, kind, text, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(chat_id, kind) DO UPDATE SET
                   text = excluded.text, updated_at = excluded.updated_at",
                params![chat_id as i64, kind, text, updated_at],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn test_db_new_and_migrate_creates_all_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let conn = db.conn.lock().await;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('workspaces','channels','roles','contact_roles','pins')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 5);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_workspace_insert_and_list() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let id = db.insert_workspace("前端组", 100, Some("FE")).await.unwrap();
        assert!(id > 0);
        let ws = db.list_workspaces().await.unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].name, "前端组");
        assert_eq!(ws[0].master_chat_id, 100);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_channel_insert_and_list() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let ws_id = db.insert_workspace("FE", 100, None).await.unwrap();
        let ch_id = db.insert_channel(ws_id, 200, "general", "General", 0).await.unwrap();
        assert!(ch_id > 0);
        let chans = db.list_channels(ws_id).await.unwrap();
        assert_eq!(chans.len(), 1);
        assert_eq!(chans[0].name, "general");
        assert_eq!(chans[0].category, "General");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_role_insert_list_and_assign() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let ws_id = db.insert_workspace("FE", 100, None).await.unwrap();
        let role_id = db.insert_role(ws_id, "core", None).await.unwrap();
        db.set_contact_role(ws_id, 42, role_id).await.unwrap();
        let roles = db.list_roles(ws_id).await.unwrap();
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].name, "core");
        let my_roles = db.list_contact_roles(ws_id, 42).await.unwrap();
        assert_eq!(my_roles.len(), 1);
        assert_eq!(my_roles[0], role_id);
        // 验证联表查询 list_all_contact_roles
        let all = db.list_all_contact_roles(ws_id).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, 42); // contact_id
        assert_eq!(all[0].1, role_id); // role_id
        assert_eq!(all[0].2, "core"); // role_name
        assert_eq!(all[0].3, None); // role_color
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_pin_toggle() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let ws_id = db.insert_workspace("FE", 100, None).await.unwrap();
        // pin
        let pinned = db.toggle_pin(ws_id, 200, 999, 1).await.unwrap();
        assert!(pinned);
        let pins = db.list_pins(200).await.unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].msg_id, 999);
        // unpin
        let pinned2 = db.toggle_pin(ws_id, 200, 999, 1).await.unwrap();
        assert!(!pinned2);
        let pins2 = db.list_pins(200).await.unwrap();
        assert_eq!(pins2.len(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_update_workspace_and_channel() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let ws_id = db.insert_workspace("Old", 100, Some("O")).await.unwrap();
        let ch_id = db.insert_channel(ws_id, 200, "old-name", "General", 0).await.unwrap();
        // update workspace
        db.update_workspace(ws_id, Some("New"), Some("N")).await.unwrap();
        let ws = db.list_workspaces().await.unwrap().into_iter().find(|w| w.id == ws_id).unwrap();
        assert_eq!(ws.name, "New");
        assert_eq!(ws.icon.as_deref(), Some("N"));
        // update channel (by chat_id)
        db.update_channel(200, Some("new-name"), Some("topic-x"), Some("Events")).await.unwrap();
        let ch = db.list_channels(ws_id).await.unwrap().into_iter().find(|c| c.chat_id == 200).unwrap();
        assert_eq!(ch.name, "new-name");
        assert_eq!(ch.topic.as_deref(), Some("topic-x"));
        assert_eq!(ch.category, "Events");
        // delete channel row
        db.delete_channel_row(200).await.unwrap();
        assert!(db.list_channels(ws_id).await.unwrap().is_empty());
        // delete workspace rows (cascades channels)
        db.insert_channel(ws_id, 300, "c2", "General", 1).await.unwrap();
        db.delete_workspace_rows(ws_id).await.unwrap();
        assert!(db.list_workspaces().await.unwrap().is_empty());
        assert!(db.list_channels(ws_id).await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_cards_schema() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        // channels.space_type 列存在
        let st = db.get_channel_space_type(999).await.unwrap();
        assert_eq!(st, None); // 不存在的频道返回 None
        // 插入一个 channel 再测
        let conn = db.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("INSERT INTO channels (workspace_id, chat_id, name, category, position) VALUES (1, 100, 'test', 'General', 0)", [])?;
            Ok(())
        }).await.unwrap();
        let st = db.get_channel_space_type(100).await.unwrap();
        assert_eq!(st, Some("chat".to_string())); // 默认 chat
        // 改为 card
        db.set_channel_space_type(100, "card").await.unwrap();
        let st = db.get_channel_space_type(100).await.unwrap();
        assert_eq!(st, Some("card".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_card_crud() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let now = 1234567890;
        let id = db.insert_card(1, 100, "task", "测试任务", Some("描述"), "todo", Some(5), Some(now + 86400), 1, now, None).await.unwrap();
        assert!(id > 0);
        // 查找
        let found = db.find_card_by_dedup(100, "测试任务", now).await.unwrap();
        assert_eq!(found, Some(id));
        // 更新状态
        db.update_card_fields(id, None, None, Some("in_progress"), None, None, now + 1).await.unwrap();
        let row = db.get_card_row(id).await.unwrap().unwrap();
        assert_eq!(row.7, "in_progress"); // status 字段(index 7)
        // 列表
        let list = db.list_cards(1, 100).await.unwrap();
        assert_eq!(list.len(), 1);
        // 删除
        db.delete_card(id).await.unwrap();
        let row = db.get_card_row(id).await.unwrap();
        assert!(row.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_insert_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let bot_id = db.insert_bot(1, 9001, "助理机器人", 1234567890).await.unwrap();
        assert!(bot_id > 0);
        let row = db.get_bot(1, bot_id).await.unwrap().unwrap();
        assert_eq!(row.id, bot_id);
        assert_eq!(row.bot_account_id, 9001);
        assert_eq!(row.owner_account_id, 1);
        assert_eq!(row.display_name, "助理机器人");
        assert_eq!(row.status, "running");
        assert_eq!(row.created_at, 1234567890);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_list_filters_by_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        db.insert_bot(1, 9001, "bot-a", 1000).await.unwrap();
        db.insert_bot(2, 9002, "bot-b", 2000).await.unwrap();
        db.insert_bot(1, 9003, "bot-c", 3000).await.unwrap();
        let bots = db.list_bots(1).await.unwrap();
        assert_eq!(bots.len(), 2);
        assert!(bots.iter().all(|b| b.owner_account_id == 1));
        assert_eq!(bots[0].bot_account_id, 9001);
        assert_eq!(bots[1].bot_account_id, 9003);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_delete_removes_row() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let bot_id = db.insert_bot(1, 9001, "bot", 1000).await.unwrap();
        db.delete_bot(1, bot_id).await.unwrap();
        assert!(db.get_bot(1, bot_id).await.unwrap().is_none());
        // 不匹配 owner 时不应删除
        let bot_id2 = db.insert_bot(2, 9002, "bot2", 2000).await.unwrap();
        db.delete_bot(1, bot_id2).await.unwrap();
        assert!(db.get_bot(2, bot_id2).await.unwrap().is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_unique_constraint() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        db.insert_bot(1, 9001, "bot", 1000).await.unwrap();
        let err = db.insert_bot(1, 9001, "bot-dup", 2000).await.unwrap_err();
        assert!(matches!(err, AppError::Db(_)));
        // 不同 owner 可复用同一 bot_account_id
        let ok = db.insert_bot(2, 9001, "bot-other", 3000).await.unwrap();
        assert!(ok > 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_set_status() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let bot_id = db.insert_bot(1, 9001, "bot", 1000).await.unwrap();
        assert_eq!(db.get_bot(1, bot_id).await.unwrap().unwrap().status, "running");
        db.set_bot_status(1, bot_id, "stopped").await.unwrap();
        let row = db.get_bot(1, bot_id).await.unwrap().unwrap();
        assert_eq!(row.status, "stopped");
    }

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

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_stats() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        // 空 bot → 全 0,时间戳为 None
        let empty = db.get_bot_stats(1).await.unwrap();
        assert_eq!(empty.total_activities, 0);
        assert_eq!(empty.reply_sent, 0);
        assert_eq!(empty.rule_reply, 0);
        assert_eq!(empty.schedule_sent, 0);
        assert_eq!(empty.tool_called, 0);
        assert_eq!(empty.llm_error, 0);
        assert_eq!(empty.rate_limited, 0);
        assert_eq!(empty.last_activity_at, None);
        assert_eq!(empty.first_seen_at, None);

        // 插入不同 kind 的活动,统计正确
        let now = chrono::Utc::now().timestamp();
        let bot_id = 9;
        let t1 = now - 100;
        let t2 = now;
        let conn = db.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO bot_activities (bot_id, kind, chat_id, msg_id, summary, detail_json, created_at) VALUES (?1, ?2, NULL, NULL, 's', NULL, ?3)",
                params![bot_id, "reply_sent", t1],
            )?;
            Ok(())
        }).await.unwrap();
        db.insert_bot_activity(bot_id, "reply_sent", None, None, "回复", None).await.unwrap();
        db.insert_bot_activity(bot_id, "rule_reply", None, None, "规则回复", None).await.unwrap();
        db.insert_bot_activity(bot_id, "rule_reply", None, None, "规则回复2", None).await.unwrap();
        db.insert_bot_activity(bot_id, "schedule_sent", None, None, "定时", None).await.unwrap();
        db.insert_bot_activity(bot_id, "tool_called", None, None, "工具", None).await.unwrap();
        db.insert_bot_activity(bot_id, "llm_error", None, None, "失败", None).await.unwrap();
        db.insert_bot_activity(bot_id, "reply_rate_limited", None, None, "限流", None).await.unwrap();
        // 不属于统计的 kind 只算进 total
        db.insert_bot_activity(bot_id, "no_config", None, None, "无配置", None).await.unwrap();
        // 别的 bot 不影响本 bot 统计
        db.insert_bot_activity(99, "reply_sent", None, None, "other", None).await.unwrap();

        let s = db.get_bot_stats(bot_id).await.unwrap();
        assert_eq!(s.total_activities, 9);
        assert_eq!(s.reply_sent, 2);
        assert_eq!(s.rule_reply, 2);
        assert_eq!(s.schedule_sent, 1);
        assert_eq!(s.tool_called, 1);
        assert_eq!(s.llm_error, 1);
        assert_eq!(s.rate_limited, 1);
        // created_at 为 Utc::now().timestamp(),必大于 t1
        assert!(s.last_activity_at.is_some());
        assert!(s.first_seen_at.is_some());
        assert_eq!(s.first_seen_at, Some(t1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_schedule_crud_and_due() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        let id1 = db.insert_bot_schedule(9, 3, 30, 9, -1, "每天 9:30 打卡", 100).await.unwrap();
        let id2 = db.insert_bot_schedule(9, 3, -1, -1, -1, "一次性提醒", 200).await.unwrap();
        assert!(id1 > 0 && id2 > 0);

        // list 按 bot_id 过滤
        let list = db.list_bot_schedules(9).await.unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|s| s.bot_id == 9));
        assert_eq!(list[0].message, "每天 9:30 打卡");
        assert!(list[0].enabled);
        assert_eq!(list[1].day_of_week, -1);

        // 非本 bot 查不到
        assert!(db.list_bot_schedules(99).await.unwrap().is_empty());

        // get
        let row = db.get_bot_schedule(id1).await.unwrap().unwrap();
        assert_eq!(row.id, id1);
        assert_eq!(row.minute, 30);
        assert_eq!(row.hour, 9);
        assert!(db.get_bot_schedule(9999).await.unwrap().is_none());

        // due 查询:now=100 → id1 到期,id2(200)未到期
        let due = db.list_due_schedules(100).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, id1);

        // set_next_run 后不再 due
        db.set_schedule_next_run(id1, 99999).await.unwrap();
        assert!(db.list_due_schedules(100).await.unwrap().is_empty());

        // delete → empty
        db.delete_bot_schedule(id1).await.unwrap();
        db.delete_bot_schedule(id2).await.unwrap();
        assert!(db.list_bot_schedules(9).await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bot_schedule_due_ignores_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        let id = db.insert_bot_schedule(9, 3, -1, -1, -1, "提醒", 10).await.unwrap();
        let conn = db.conn.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let c = conn.blocking_lock();
            c.execute("UPDATE bot_schedules SET enabled = 0 WHERE id = ?1", params![id])?;
            Ok(())
        }).await.unwrap();
        assert!(db.list_due_schedules(10).await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_plugin_tool_upsert_list_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        // upsert 两次,同名覆盖更新
        db.upsert_plugin_tool("webhook", "触发 webhook", "{\"type\":\"object\"}", 1000).await.unwrap();
        db.upsert_plugin_tool("webhook", "触发 webhook v2", "{\"type\":\"object\",\"v\":2}", 2000).await.unwrap();
        db.upsert_plugin_tool("calc", "计算", "{\"type\":\"object\"}", 1500).await.unwrap();

        let list = db.list_plugin_tools().await.unwrap();
        assert_eq!(list.len(), 2);
        let webhook = list.iter().find(|t| t.name == "webhook").unwrap();
        assert_eq!(webhook.description, "触发 webhook v2");
        assert_eq!(webhook.parameters, "{\"type\":\"object\",\"v\":2}");
        assert_eq!(webhook.created_at, 2000);

        // delete → empty
        db.delete_plugin_tool("webhook").await.unwrap();
        db.delete_plugin_tool("calc").await.unwrap();
        assert!(db.list_plugin_tools().await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_github_settings_upsert_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        // 无行 → 默认
        let s = db.get_github_settings().await.unwrap();
        assert_eq!(s, GithubSettingsDto::default());

        // 写入 token
        db.set_github_token(Some("ghp_test_123")).await.unwrap();
        let s = db.get_github_settings().await.unwrap();
        assert_eq!(s.token.as_deref(), Some("ghp_test_123"));

        // UPSERT 覆盖
        db.set_github_token(Some("ghp_test_456")).await.unwrap();
        let s = db.get_github_settings().await.unwrap();
        assert_eq!(s.token.as_deref(), Some("ghp_test_456"));

        // None 清除 → NULL
        db.set_github_token(None).await.unwrap();
        let s = db.get_github_settings().await.unwrap();
        assert_eq!(s.token, None);

        // 单行约束:仍只有一行
        let conn = db.conn.lock().await;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM github_settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_github_repos_crud_and_unique() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        // 初始为空
        assert!(db.list_github_repos().await.unwrap().is_empty());
        assert!(!db.is_repo_bound("owner", "repo").await.unwrap());

        // 添加
        let id1 = db.add_github_repo("owner", "repo").await.unwrap();
        let id2 = db.add_github_repo("alice", "peytchat").await.unwrap();
        assert!(id1 > 0 && id2 > 0 && id1 != id2);

        let list = db.list_github_repos().await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].full_name, "owner/repo");
        assert_eq!(list[1].full_name, "alice/peytchat");

        // is_repo_bound 按 owner/repo 匹配 full_name
        assert!(db.is_repo_bound("owner", "repo").await.unwrap());
        assert!(db.is_repo_bound("alice", "peytchat").await.unwrap());
        assert!(!db.is_repo_bound("owner", "other").await.unwrap());
        assert!(!db.is_repo_bound("other", "repo").await.unwrap());

        // 唯一约束:重复 owner/repo 冲突 → Db 错误
        let dup = db.add_github_repo("owner", "repo").await;
        assert!(dup.is_err(), "重复绑定应返回 Db 错误");
        assert_eq!(db.list_github_repos().await.unwrap().len(), 2);

        // remove
        db.remove_github_repo(id1).await.unwrap();
        let list = db.list_github_repos().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id2);
        assert!(!db.is_repo_bound("owner", "repo").await.unwrap());

        // 移除后可以重新绑定
        db.add_github_repo("owner", "repo").await.unwrap();
        assert!(db.is_repo_bound("owner", "repo").await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_github_tables_created_in_migrate() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let conn = db.conn.lock().await;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('github_settings','github_repos')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_knowledge_tables_created_in_migrate() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();
        let conn = db.conn.lock().await;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('knowledge','knowledge_config','intelligence_settings')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_knowledge_upsert_dedup_by_chat_and_date() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        let id1 = db
            .upsert_knowledge(7, "2026-08-05", "会议", "要点A", r#"["会议"]"#, 30, "manual")
            .await
            .unwrap();
        let id2 = db
            .upsert_knowledge(7, "2026-08-05", "会议2", "要点B", r#"["会议","待办"]"#, 40, "daily")
            .await
            .unwrap();
        // 同 (chat_id, date) → 更新保留原 id
        assert_eq!(id1, id2);
        let row = db.get_knowledge(id1).await.unwrap().unwrap();
        assert_eq!(row.title, "会议2");
        assert_eq!(row.msg_count, 40);
        assert_eq!(row.source, "daily");

        // 不同日期 → 新条目
        let id3 = db
            .upsert_knowledge(7, "2026-08-06", "标题", "内容", "[]", 5, "manual")
            .await
            .unwrap();
        assert_ne!(id2, id3);
        let all = db.list_knowledge(None, None, None, 1, 20).await.unwrap();
        assert_eq!(all.len(), 2);
        // 更新时间倒序(id3 后插入,应在前;同秒时以 id 倒序兜底)
        let all_ids: Vec<i64> = all.iter().map(|r| r.id).collect();
        assert!(all_ids == vec![id3, id1] || all_ids == vec![id1, id3], "got {all_ids:?}");

        // 会话过滤 + 标签过滤 + 关键词过滤
        assert_eq!(db.list_knowledge(Some(7), None, None, 1, 20).await.unwrap().len(), 2);
        assert_eq!(db.list_knowledge(None, Some("待办"), None, 1, 20).await.unwrap().len(), 1);
        assert_eq!(db.list_knowledge(None, None, Some("要点B"), 1, 20).await.unwrap().len(), 1);
        assert_eq!(db.list_knowledge(None, None, Some("不存在"), 1, 20).await.unwrap().len(), 0);

        // 更新字段
        db.update_knowledge(id1, Some("新标题"), None, Some(r#"["a","b"]"#)).await.unwrap();
        let row = db.get_knowledge(id1).await.unwrap().unwrap();
        assert_eq!(row.title, "新标题");
        assert_eq!(row.tags, r#"["a","b"]"#);

        // 删除
        db.delete_knowledge(id3).await.unwrap();
        assert!(db.get_knowledge(id3).await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_knowledge_config_roundtrip_preserves_daily_run_date() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        db.set_knowledge_config(9, true, "08:30", 120, true).await.unwrap();
        let cfg = db.get_knowledge_config(9).await.unwrap().unwrap();
        assert!(cfg.daily_enabled);
        assert_eq!(cfg.daily_time, "08:30");
        assert_eq!(cfg.window_count, 120);

        db.mark_daily_run(9, "2026-08-05").await.unwrap();
        assert_eq!(db.get_knowledge_config(9).await.unwrap().unwrap().daily_run_date.as_deref(), Some("2026-08-05"));

        // 改配置不重置 daily_run_date
        db.set_knowledge_config(9, false, "09:00", 50, false).await.unwrap();
        let cfg = db.get_knowledge_config(9).await.unwrap().unwrap();
        assert!(!cfg.daily_enabled);
        assert_eq!(cfg.daily_run_date.as_deref(), Some("2026-08-05"));

        assert_eq!(db.list_knowledge_configs().await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_intelligence_settings_upsert_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::new(tmp.path().join("test.db")).await.unwrap();
        db.migrate().await.unwrap();

        assert!(db.get_intelligence_settings().await.unwrap().is_none());

        db.set_intelligence_settings("llm", "api", "1.5b", 80, Some("http://x"), Some("key"), Some("model"))
            .await
            .unwrap();
        let s = db.get_intelligence_settings().await.unwrap().unwrap();
        assert_eq!(s.mode, "llm");
        assert_eq!(s.source, "api");
        assert_eq!(s.model_tier, "1.5b");
        assert_eq!(s.window_n, 80);
        assert_eq!(s.base_url.as_deref(), Some("http://x"));

        // 再次写入覆盖
        db.set_intelligence_settings("wordfreq", "local", "0.5b", 50, None, None, None).await.unwrap();
        let s = db.get_intelligence_settings().await.unwrap().unwrap();
        assert_eq!(s.mode, "wordfreq");
        assert_eq!(s.source, "local");
        assert_eq!(s.base_url, None);
        assert_eq!(s.api_key, None);
    }
}
