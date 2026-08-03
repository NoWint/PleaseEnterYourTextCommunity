use std::sync::Arc;

use async_trait::async_trait;
use deltachat::chat::ChatItem;
use deltachat::chat::{self, ChatId};
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, MsgId, Viewtype};

use super::{BotDriver, BotRuntime, DriverKind, DriverRegistry, IncomingMsg};
use crate::dto::bot_activity_kind as act;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};
use crate::tools::{ToolContext, ToolRegistry};

/// 工具调用循环最大轮数。
const MAX_TOOL_ROUNDS: usize = 5;

/// 单条回复的最大字符数(超长按句边界拆分)。
const MAX_REPLY_LEN: usize = 400;

/// LLM 自动回复驱动:读取 BotConfig.llm,用聊天历史 + 系统提示词调用 LLM 返回回复。
/// 支持最多 5 轮工具调用往返;长回复按句边界拆分为多条消息。
pub struct LlmDriver {
    client: LlmClient,
    registry: Arc<ToolRegistry>,
}

impl LlmDriver {
    pub fn new(client: LlmClient, registry: Arc<ToolRegistry>) -> Self {
        Self { client, registry }
    }
}

#[async_trait]
impl BotDriver for LlmDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Llm
    }

    async fn on_message(
        &self,
        bot: &BotRuntime<'_>,
        msg: &IncomingMsg<'_>,
    ) -> AppResult<Vec<String>> {
        let Some(llm) = bot.config.llm.as_ref() else {
            return Ok(vec![]);
        };
        if !llm.is_complete() {
            bot.activity
                .record(
                    bot.bot_id,
                    act::REPLY_SKIPPED,
                    Some(msg.chat_id.to_u32()),
                    Some(msg.msg_id.to_u32()),
                    "LLM 配置不完整,跳过回复",
                    None,
                )
                .await;
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
                ..Default::default()
            });
        }
        messages.extend(history);

        let enabled = bot.config.tools.as_deref();
        let defs = self.registry.defs_for(enabled);

        let mut final_text: Option<String> = None;
        for _ in 0..MAX_TOOL_ROUNDS {
            let round = self.client.call(llm, messages.clone(), &defs).await?;
            if let Some(t) = round.text {
                final_text = Some(t);
                break;
            }
            if round.tool_calls.is_empty() {
                break;
            }
            messages.push(ChatMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: round.tool_calls.clone(),
                tool_call_id: None,
            });
            for tc in round.tool_calls {
                let ctx = ToolContext {
                    dc: bot.dc,
                    db: bot.db,
                    bot_id: bot.bot_id,
                    chat_id: msg.chat_id,
                    data_dir: bot.data_dir,
                };
                let result = match self.registry.execute(&tc.name, &tc.arguments, &ctx).await {
                    Ok(r) => r,
                    Err(e) => format!("工具错误: {e}"),
                };
                messages.push(ChatMessage {
                    role: "tool".into(),
                    content: result,
                    tool_calls: vec![],
                    tool_call_id: Some(tc.id),
                });
                bot.activity
                    .record(
                        bot.bot_id,
                        act::TOOL_CALLED,
                        Some(msg.chat_id.to_u32()),
                        Some(msg.msg_id.to_u32()),
                        format!("调用工具 {}", tc.name),
                        None,
                    )
                    .await;
            }
        }

        let Some(final_text) = final_text else {
            return Err(AppError::Core("工具循环未产出最终回复".into()));
        };
        Ok(split_reply(&final_text))
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

/// 按句边界拆分,每段 ≤ max_len(默认 400);单句超长硬切。
pub fn split_reply(text: &str) -> Vec<String> {
    split_reply_with_limit(text, MAX_REPLY_LEN)
}

fn split_reply_with_limit(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        if text.trim().is_empty() {
            return Vec::new();
        }
        return vec![text.to_string()];
    }
    let sentences = split_sentences(text);
    let mut items: Vec<String> = Vec::new();
    let mut cur = String::new();
    for s in sentences {
        let s_len = s.chars().count();
        if s_len > max_len {
            push_trimmed(&mut items, &std::mem::take(&mut cur));
            let chars: Vec<char> = s.chars().collect();
            for chunk in chars.chunks(max_len) {
                push_trimmed(&mut items, &chunk.iter().collect::<String>());
            }
        } else if cur.chars().count() + s_len > max_len {
            push_trimmed(&mut items, &std::mem::take(&mut cur));
            cur.push_str(&s);
        } else {
            cur.push_str(&s);
        }
    }
    push_trimmed(&mut items, &cur);
    items
}

/// 按句边界(。！？!? 及换行)切分,边界字符归属前一句。
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '\n') {
            sentences.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        sentences.push(cur);
    }
    sentences
}

/// 去掉首尾空白后非空才入列(丢弃空段)。
fn push_trimmed(items: &mut Vec<String>, s: &str) {
    let t = s.trim();
    if !t.is_empty() {
        items.push(t.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deltachat::message::Viewtype::*;
    use std::sync::Arc;

    use crate::tools::bridge::ToolBridge;
    use crate::tools::ToolRegistry;

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
        registry.register(Arc::new(LlmDriver::new(
            LlmClient::new(),
            Arc::new(ToolRegistry::new(Arc::new(ToolBridge::new()))),
        )));
        assert_eq!(registry.drivers().len(), 1);
        assert_eq!(registry.drivers()[0].kind(), DriverKind::Llm);
    }

    #[test]
    fn test_driver_kind_debug_eq() {
        assert_eq!(DriverKind::Llm, DriverKind::Llm);
        assert_ne!(DriverKind::Llm, DriverKind::Rule);
        assert_ne!(DriverKind::Rule, DriverKind::Schedule);
    }

    #[test]
    fn test_split_reply_short_text() {
        let text = "你好，世界！";
        let parts = split_reply(text);
        assert_eq!(parts, vec![text.to_string()]);
    }

    #[test]
    fn test_split_reply_long_multi_sentence() {
        let text = format!("{}。{}!", "A".repeat(300), "B".repeat(300));
        let parts = split_reply(&text);
        assert!(parts.len() >= 2);
        for p in &parts {
            assert!(
                p.chars().count() <= 400,
                "segment too long: {} chars",
                p.chars().count()
            );
        }
        assert!(parts[0].ends_with('。'));
        assert!(parts[0].contains("AAAA"));
        assert!(parts[1].contains("BBBB"));
    }

    #[test]
    fn test_split_reply_hard_cut_single_sentence() {
        let text = "字".repeat(500);
        let parts = split_reply(&text);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].chars().count(), 400);
        assert_eq!(parts[1].chars().count(), 100);
    }

    #[test]
    fn test_split_reply_empty() {
        assert_eq!(split_reply(""), Vec::<String>::new());
        assert_eq!(split_reply("   "), Vec::<String>::new());
    }
}
