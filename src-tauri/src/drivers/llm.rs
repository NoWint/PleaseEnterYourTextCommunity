use async_trait::async_trait;
use deltachat::chat::{self, ChatId};
use deltachat::chat::ChatItem;
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, MsgId, Viewtype};

use super::{BotDriver, BotRuntime, DriverKind, DriverRegistry, IncomingMsg};
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};

/// LLM 自动回复驱动:读取 BotConfig.llm,用聊天历史 + 系统提示词调用 LLM 返回回复。
pub struct LlmDriver {
    client: LlmClient,
}

impl LlmDriver {
    pub fn new(client: LlmClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl BotDriver for LlmDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Llm
    }

    async fn on_message(&self, bot: &BotRuntime<'_>, msg: &IncomingMsg<'_>) -> AppResult<Vec<String>> {
        let Some(llm) = bot.config.llm.as_ref() else {
            return Ok(vec![]);
        };
        if !llm.is_complete() {
            return Ok(vec![]);
        }

        let history = build_history(bot.dc, msg.chat_id).await?;

        let mut messages = Vec::new();
        if let Some(p) = llm
            .system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            messages.push(ChatMessage {
                role: "system".into(),
                content: p.to_string(),
            });
        }
        messages.extend(history);

        let reply = self.client.complete(llm, messages).await?.trim().to_string();
        if reply.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![reply])
    }
}

// ── 历史构建(自 bot_llm.rs 移植) ────────────────────────────────────────

/// 构建最近 20 条聊天历史,每条渲染为「name: text」的 user 消息。
pub async fn build_history(ctx: &Context, chat_id: ChatId) -> AppResult<Vec<ChatMessage>> {
    let items = chat::get_chat_msgs(ctx, chat_id)
        .await
        .map_err(|e| AppError::Core(format!("get_chat_msgs: {e}")))?;
    let mut last: Vec<MsgId> = items
        .into_iter()
        .filter_map(|it| match it {
            ChatItem::Message { msg_id } => Some(msg_id),
            _ => None,
        })
        .rev()
        .take(20)
        .collect();
    last.reverse();

    let mut history = Vec::with_capacity(last.len());
    for mid in last {
        let m = match Message::load_from_db(ctx, mid).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = sender_name(ctx, &m).await;
        let text = m.get_text();
        let line = if text.trim().is_empty() {
            format!("{name}: {}", render_viewtype_label(&m.get_viewtype()))
        } else {
            format_message_line(&name, &text)
        };
        history.push(ChatMessage {
            role: "user".into(),
            content: line,
        });
    }
    Ok(history)
}

/// 取消息发送者展示名,为空时退回邮箱地址。
pub async fn sender_name(ctx: &Context, m: &Message) -> String {
    match Contact::get_by_id(ctx, m.get_from_id()).await {
        Ok(c) => {
            let name = c.get_display_name().trim();
            if name.is_empty() {
                c.get_addr().to_string()
            } else {
                name.to_string()
            }
        }
        Err(_) => "未知".to_string(),
    }
}

/// 无文本消息的 viewtype 中文标签。
pub fn render_viewtype_label(v: &Viewtype) -> &'static str {
    match v {
        Viewtype::Image => "[图片]",
        Viewtype::File => "[文件]",
        Viewtype::Voice => "[语音]",
        Viewtype::Webxdc => "[App]",
        _ => "[其他]",
    }
}

/// 渲染单条历史消息行:「name: text」。
pub fn format_message_line(name: &str, text: &str) -> String {
    format!("「{name}: {text}」")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use deltachat::message::Viewtype::*;

    #[test]
    fn test_render_viewtype_label() {
        assert_eq!(render_viewtype_label(&Image), "[图片]");
        assert_eq!(render_viewtype_label(&File), "[文件]");
        assert_eq!(render_viewtype_label(&Voice), "[语音]");
        assert_eq!(render_viewtype_label(&Webxdc), "[App]");
        assert_eq!(render_viewtype_label(&Text), "[其他]");
        assert_eq!(render_viewtype_label(&Video), "[其他]");
    }

    #[test]
    fn test_format_message_line() {
        let line = format_message_line("小明", "你好呀");
        assert_eq!(line, "「小明: 你好呀」");
        assert!(line.contains("小明"));
        assert!(line.contains("你好呀"));
    }

    #[test]
    fn test_driver_registry_register_and_list() {
        let mut registry = DriverRegistry::new();
        registry.register(Arc::new(LlmDriver::new(LlmClient::new())));
        assert_eq!(registry.drivers().len(), 1);
        assert_eq!(registry.drivers()[0].kind(), DriverKind::Llm);
    }

    #[test]
    fn test_driver_kind_debug_eq() {
        assert_eq!(DriverKind::Llm, DriverKind::Llm);
        assert_ne!(DriverKind::Llm, DriverKind::Rule);
        assert_ne!(DriverKind::Rule, DriverKind::Schedule);
    }
}
