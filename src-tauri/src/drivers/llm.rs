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

/// 项目上下文注入上限(控制 system 消息大小,避免爆 LLM 上下文窗口):
/// - 每频道最多取最近 PC_MAX_MSGS_PER_CHAT 条消息;
/// - 每条消息文本截断到 PC_MAX_MSG_CHARS 字符;
/// - 最多注入 PC_MAX_CHATS 个关联频道(跳过当前会话,避免与主 history 重复);
/// - 累计字符数达 PC_MAX_TOTAL_CHARS 后停止注入后续频道。
const PC_MAX_CHATS: usize = 5;
const PC_MAX_MSGS_PER_CHAT: usize = 10;
const PC_MAX_MSG_CHARS: usize = 200;
const PC_MAX_TOTAL_CHARS: usize = 4000;

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
        // 项目上下文注入:system prompt 之后、history 之前
        append_project_context(&mut messages, bot, msg.chat_id).await;
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

// ── 项目上下文注入 ──────────────────────────────────────────────────

/// 项目上下文注入:Bot 配置了 project_context 时,把项目描述与关联频道最近消息
/// 拼成 system 消息,插在 system prompt 之后、对话 history 之前。
/// 单频道失败跳过,不影响其他频道注入。
///
/// 注入大小受控(见 PC_* 常量):跳过当前会话(已作为主 history 注入),
/// 每频道最近消息截断到上限、频道数与累计字符数均有上限。
async fn append_project_context(
    messages: &mut Vec<ChatMessage>,
    bot: &BotRuntime<'_>,
    current_chat_id: ChatId,
) {
    let Some(pc) = bot.config.project_context.as_ref() else {
        return;
    };
    if let Some(desc) = pc
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.push(ChatMessage {
            role: "system".into(),
            content: format!("项目背景:{desc}"),
            ..Default::default()
        });
    }
    if pc.chat_ids.is_empty() {
        return;
    }
    let mut lines: Vec<String> = Vec::new();
    let mut budget: usize = PC_MAX_TOTAL_CHARS;
    for cid in select_context_chat_ids(&pc.chat_ids, current_chat_id) {
        let chat_id = ChatId::new(cid);
        let chat_name = match chat::Chat::load_from_db(bot.dc, chat_id).await {
            Ok(c) => c.get_name().to_string(),
            Err(_) => continue,
        };
        let history = match build_history_n(bot.dc, chat_id, PC_MAX_MSGS_PER_CHAT).await {
            Ok(h) if !h.is_empty() => h,
            _ => continue,
        };
        let (line, used) = render_chat_context_line(&chat_name, &history, budget);
        let Some(line) = line else {
            break; // 剩余预算不足,停止注入后续频道
        };
        budget -= used;
        lines.push(line);
    }
    if !lines.is_empty() {
        messages.push(ChatMessage {
            role: "system".into(),
            content: build_chat_context_block(lines),
            ..Default::default()
        });
    }
}

/// 决定要注入的关联频道 id 顺序:跳过当前会话(避免与主 history 重复),
/// 保持配置顺序,最多取 PC_MAX_CHATS 个。
fn select_context_chat_ids(chat_ids: &[u32], current_chat_id: ChatId) -> Vec<u32> {
    chat_ids
        .iter()
        .copied()
        .filter(|&cid| ChatId::new(cid) != current_chat_id)
        .take(PC_MAX_CHATS)
        .collect()
}

/// 截断单条消息文本到 PC_MAX_MSG_CHARS 字符(UTF-8 安全;未超限原样返回)。
fn truncate_pc_msg(text: &str) -> String {
    if text.chars().count() <= PC_MAX_MSG_CHARS {
        text.to_string()
    } else {
        text.chars().take(PC_MAX_MSG_CHARS).collect()
    }
}

/// 单条关联频道上下文行:「{chat_name}: {text}」。
fn format_chat_context_line(chat_name: &str, text: &str) -> String {
    format!("{chat_name}: {text}")
}

/// 从某频道最近消息渲染单行上下文(名称前缀 + 逐条截断文本)。
/// `budget_left` 为剩余字符预算;行文本(含名称)超过预算时返回 (None, 0) 表示停止注入。
/// 返回 (行文本, 行字符数)。
fn render_chat_context_line(
    chat_name: &str,
    messages: &[ChatMessage],
    budget_left: usize,
) -> (Option<String>, usize) {
    if messages.is_empty() {
        return (None, 0);
    }
    let body = messages
        .iter()
        .map(|m| truncate_pc_msg(&m.content))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let line = format_chat_context_line(chat_name, &body);
    let used = line.chars().count();
    if used > budget_left {
        (None, 0)
    } else {
        (Some(line), used)
    }
}

/// 拼装「其他频道上下文」system 消息内容。
fn build_chat_context_block(lines: Vec<String>) -> String {
    format!("其他频道上下文:\n{}", lines.join("\n"))
}

// ── 历史构建(自 bot_llm.rs 移植) ────────────────────────────────────────

/// 构建最近 20 条聊天历史,每条渲染为「name: text」的 user 消息。
pub async fn build_history(ctx: &Context, chat_id: ChatId) -> AppResult<Vec<ChatMessage>> {
    build_history_n(ctx, chat_id, 20).await
}

/// 构建最近 count 条聊天历史(不足则全取),每条渲染为「name: text」的 user 消息。
pub async fn build_history_n(
    ctx: &Context,
    chat_id: ChatId,
    count: usize,
) -> AppResult<Vec<ChatMessage>> {
    let items = chat::get_chat_msgs(ctx, chat_id)
        .await
        .map_err(|e| AppError::Core(format!("get_chat_msgs: {e}")))?;
    let msg_ids: Vec<MsgId> = items
        .into_iter()
        .filter_map(|it| match it {
            ChatItem::Message { msg_id } => Some(msg_id),
            _ => None,
        })
        .collect();
    let last = last_n(msg_ids, count);

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
            ..Default::default()
        });
    }
    Ok(history)
}

/// 取数组末尾 count 条(保持原顺序);不足或为 0 时返回空/全取。
fn last_n<T>(items: Vec<T>, count: usize) -> Vec<T> {
    let mut last: Vec<T> = items.into_iter().rev().take(count).collect();
    last.reverse();
    last
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
    fn test_last_n_takes_count_from_end() {
        let v = vec![1, 2, 3, 4, 5];
        assert_eq!(last_n(v.clone(), 2), vec![4, 5]);
        assert_eq!(last_n(v.clone(), 0), Vec::<i32>::new());
        assert_eq!(last_n(v.clone(), 10), vec![1, 2, 3, 4, 5]);
        assert_eq!(last_n(Vec::<i32>::new(), 3), Vec::<i32>::new());
    }

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

    #[test]
    fn test_format_chat_context_line() {
        assert_eq!(format_chat_context_line("群A", "「小明: 你好」"), "群A: 「小明: 你好」");
    }

    #[test]
    fn test_build_chat_context_block() {
        let block = build_chat_context_block(vec!["群A: hi".into(), "群B: yo".into()]);
        assert!(block.starts_with("其他频道上下文:"));
        assert!(block.contains("群A: hi"));
        assert!(block.contains("群B: yo"));
        assert!(block.contains('\n'));
    }

    #[test]
    fn test_truncate_pc_msg_boundary() {
        // 恰好 PC_MAX_MSG_CHARS 字符不截断
        let exact: String = "x".repeat(PC_MAX_MSG_CHARS);
        assert_eq!(truncate_pc_msg(&exact), exact);
        // 超 1 字符截断到上限(UTF-8 安全,不产生半字符)
        let long: String = "字".repeat(PC_MAX_MSG_CHARS + 1);
        let t = truncate_pc_msg(&long);
        assert_eq!(t.chars().count(), PC_MAX_MSG_CHARS);
        assert_eq!(t, "字".repeat(PC_MAX_MSG_CHARS));
        // 空串原样返回
        assert_eq!(truncate_pc_msg(""), "");
    }

    #[test]
    fn test_render_chat_context_line_budget_boundary() {
        let msgs = vec![
            ChatMessage { role: "user".into(), content: "y".repeat(100), ..Default::default() },
            ChatMessage { role: "user".into(), content: "z".repeat(100), ..Default::default() },
        ];
        // 预算充足 → 注入,行 = 名称 + 截断后的消息体
        let (line, used) = render_chat_context_line("群A", &msgs, usize::MAX);
        let line = line.expect("budget 充足时应注入");
        assert!(line.starts_with("群A: "));
        assert_eq!(used, line.chars().count());
        // 每条消息超长被截断到 PC_MAX_MSG_CHARS
        let huge = vec![ChatMessage { role: "user".into(), content: "q".repeat(500), ..Default::default() }];
        let (line, _) = render_chat_context_line("群B", &huge, usize::MAX);
        let line = line.unwrap();
        assert!(line.ends_with(&"q".repeat(PC_MAX_MSG_CHARS)));
        assert!(!line.contains(&"q".repeat(PC_MAX_MSG_CHARS + 1)));
        // 预算不足 → (None, 0) 表示停止注入
        let (none, used0) = render_chat_context_line("群C", &msgs, 0);
        assert!(none.is_none());
        assert_eq!(used0, 0);
        // 空消息列表 → 不注入
        let (none, _) = render_chat_context_line("群D", &[], usize::MAX);
        assert!(none.is_none());
    }

    #[test]
    fn test_select_context_chat_ids_skips_current_and_caps() {
        let current = ChatId::new(42);
        let ids = vec![42, 7, 9, 11, 13, 15];
        let sel = select_context_chat_ids(&ids, current);
        // 跳过当前会话,且注入数受 PC_MAX_CHATS 限制
        assert!(!sel.contains(&42));
        assert_eq!(sel.len(), PC_MAX_CHATS);
        assert_eq!(sel, vec![7, 9, 11, 13, 15]);
        // 当前会话不在列表中:原样取前 PC_MAX_CHATS 个
        let sel2 = select_context_chat_ids(&ids, ChatId::new(999));
        assert_eq!(sel2.len(), PC_MAX_CHATS);
        assert_eq!(sel2, vec![42, 7, 9, 11, 13]);
        // 少于上限时全取(除当前会话)
        let sel3 = select_context_chat_ids(&vec![1, 2], current);
        assert_eq!(sel3, vec![1, 2]);
    }
}
