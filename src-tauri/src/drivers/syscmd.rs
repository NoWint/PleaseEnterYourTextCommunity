//! 系统/用户侧命令处理器:不依赖 BotRuntime 的发送能力,通过注入的 send 回调
//! 自发送回复;on_message 恒返回空 Vec,避免驱动调度器二次发送。
//!
//! send 方案选择(回调注入,而非直接调 commands::send_text_impl):
//! - `send_text_impl` 是 commands.rs 的私有 async fn,且需要 `&Context`(来自
//!   State/AppState);系统路径可能没有真实 BotRuntime,无法稳定取得 Context。
//! - 因此采用任务允许的回调注入方案:`send: Arc<dyn Fn(u32, &str) -> BoxFuture<'static, AppResult<u32>>>`,
//!   由装配者(集成者)注入基于 send_text_impl 的闭包。`futures` crate 非直接依赖,
//!   BoxFuture 用 registry.rs 提供的 std 手写别名。
//! - `has_running_bot` 同理注入(db.chat_has_running_bot 尚不存在,避免直接依赖
//!   db.rs;集成者接 db 查询)。

use std::sync::Arc;

use async_trait::async_trait;

use super::{BotDriver, BotRuntime, DriverKind, IncomingMsg};
use crate::commands::registry::{BoxFuture, CommandCtx, CommandKind, CommandRegistry, CommandScope};
use crate::error::AppResult;

/// 发送回复的回调:chat_id + 文本 → 消息 id(由装配者注入 send_text_impl 逻辑)。
pub type SendReplyFn =
    Arc<dyn Fn(u32, &str) -> BoxFuture<'static, AppResult<u32>> + Send + Sync>;
/// 查询某会话是否已有 Bot 在运行(防双回复;集成者接 db.chat_has_running_bot)。
pub type HasRunningBotFn = Arc<dyn Fn(u32) -> BoxFuture<'static, AppResult<bool>> + Send + Sync>;

/// 系统路径命令处理器:解析 → scope 校验 → 防双回复 → 执行 → send 回调发送。
pub struct SystemCommandProcessor {
    registry: Arc<CommandRegistry>,
    send: SendReplyFn,
    has_running_bot: HasRunningBotFn,
}

impl SystemCommandProcessor {
    pub fn new(
        registry: Arc<CommandRegistry>,
        send: SendReplyFn,
        has_running_bot: HasRunningBotFn,
    ) -> Self {
        Self {
            registry,
            send,
            has_running_bot,
        }
    }

    /// 核心处理逻辑(与 on_message 解耦,便于单元测试;返回后发送已完成)。
    pub async fn process(&self, chat_id: u32, msg_id: u32, text: &str) -> AppResult<()> {
        // 1. 非命令放行(返回,让调度器交给其它驱动)。
        let Some(inv) = CommandRegistry::parse(text) else {
            return Ok(());
        };
        let Some(spec) = self.registry.lookup(&inv.name) else {
            (self.send)(chat_id, "未知命令,发送 /help 查看可用命令").await?;
            return Ok(());
        };
        // 2. scope 校验:Bot-only 命令在系统路径拒绝。
        if let Some(reject) = CommandRegistry::scope_reject(&spec, CommandKind::System) {
            (self.send)(chat_id, reject).await?;
            return Ok(());
        }
        // 3. 防双回复:scope 含 Bot(Both)且该会话已有 Bot 驱动在跑 → 跳过,
        //    避免 Bot 与系统路径各回一条。db 查询失败按「无 Bot 在跑」处理。
        if spec.scope == CommandScope::Both
            && (self.has_running_bot)(chat_id).await.unwrap_or(false)
        {
            return Ok(());
        }
        // 4. 执行 handler,经 send 回调逐条发送;系统路径自己发,返回空 Vec。
        let ctx = CommandCtx {
            name: inv.name,
            kind: CommandKind::System,
            chat_id,
            msg_id,
            args: inv.args,
            raw: text,
        };
        match self.registry.handle(&ctx).await {
            Ok(replies) => {
                for r in replies {
                    (self.send)(chat_id, &r).await?;
                }
            }
            Err(e) => {
                (self.send)(chat_id, &format!("命令执行失败: {e}")).await?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl BotDriver for SystemCommandProcessor {
    fn kind(&self) -> DriverKind {
        DriverKind::System
    }

    async fn on_message(
        &self,
        _bot: &BotRuntime<'_>,
        msg: &IncomingMsg<'_>,
    ) -> AppResult<Vec<String>> {
        // 取 chat_id/msg_id:IncomingMsg.chat_id/msg_id 为 deltachat 的
        // ChatId/MsgId,经 to_u32() 转换。
        let Some(text) = msg.text else {
            return Ok(vec![]);
        };
        self.process(msg.chat_id.to_u32(), msg.msg_id.to_u32(), text)
            .await?;
        // 系统路径自己经 send 回调发送,返回空 Vec 防止驱动调度器再次发送。
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn stub(sent: Arc<Mutex<Vec<String>>>, bot_running: bool) -> SystemCommandProcessor {
        let s = sent.clone();
        let send: SendReplyFn = Arc::new(move |_chat_id, text| {
            let s = s.clone();
            let text = text.to_string();
            Box::pin(async move {
                s.lock().unwrap().push(text);
                Ok(42u32)
            })
        });
        let has_running_bot: HasRunningBotFn =
            Arc::new(move |_chat_id| Box::pin(async move { Ok(bot_running) }));
        SystemCommandProcessor::new(
            crate::commands::registry::CommandRegistry::global(),
            send,
            has_running_bot,
        )
    }

    #[tokio::test]
    async fn non_command_passes_through_without_sending() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        stub(sent.clone(), false)
            .process(1, 1, "普通消息")
            .await
            .unwrap();
        assert!(sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bot_only_command_rejected_in_system_path() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        stub(sent.clone(), false)
            .process(1, 1, "/whoami")
            .await
            .unwrap();
        assert_eq!(
            sent.lock().unwrap().as_slice(),
            &["该命令仅 Bot 可用".to_string()]
        );
    }

    #[tokio::test]
    async fn both_command_executed_and_sent() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        stub(sent.clone(), false)
            .process(1, 1, "/summarize")
            .await
            .unwrap();
        assert_eq!(
            sent.lock().unwrap().as_slice(),
            &["总结功能待接入".to_string()]
        );
    }

    #[tokio::test]
    async fn skips_when_bot_running_to_avoid_double_reply() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        stub(sent.clone(), true)
            .process(1, 1, "/summarize")
            .await
            .unwrap();
        assert!(sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_command_sends_hint() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        stub(sent.clone(), false)
            .process(1, 1, "/nope")
            .await
            .unwrap();
        assert_eq!(
            sent.lock().unwrap().as_slice(),
            &["未知命令,发送 /help 查看可用命令".to_string()]
        );
    }
}
