use std::path::PathBuf;
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
    pub data_dir: &'a PathBuf, // 工具执行所需的本地数据目录
}

/// 驱动接口:一种「大脑」。返回要发送的回复文本列表;发送/限流/日志由调度器处理。
#[async_trait]
pub trait BotDriver: Send + Sync {
    fn kind(&self) -> DriverKind;
    async fn on_message(
        &self,
        bot: &BotRuntime<'_>,
        msg: &IncomingMsg<'_>,
    ) -> AppResult<Vec<String>>;
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
