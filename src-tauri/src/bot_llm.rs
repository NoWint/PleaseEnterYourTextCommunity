use std::collections::HashSet;
use std::sync::Arc;

use deltachat::accounts::Accounts;
use deltachat::chat::{self, ChatId, ChatItem};
use deltachat::config::Config;
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, MsgId, Viewtype};
use deltachat::EventType;
use tokio::sync::Mutex;

use crate::db::{BotRow, Db};
use crate::dto::LlmConfigInput;
use crate::error::AppResult;
use crate::llm::{self, ChatMessage};

/// LLM 自动回复运行时。
///
/// 监听全部账号的 IncomingMsg 事件，仅处理 `bot_ids` 集合内的 bot 账号：
/// 读取 bots 表的 LLM 配置 → 构建聊天历史 → 调用 LLM 生成回复 → 以 bot 身份发出。
/// 这是长驻后台任务，由 bot 服务在启动时通过 `tokio::spawn` 挂载。
///
/// 注意：不要在循环里长期持有 accounts 锁，只在需要 Context 时短暂获取。
pub async fn spawn(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    bot_ids: Arc<Mutex<HashSet<u32>>>,
) {
    let emitter = {
        let accounts = accounts.lock().await;
        accounts.get_event_emitter()
    };
    while let Some(event) = emitter.recv().await {
        let EventType::IncomingMsg { chat_id, msg_id } = event.typ else {
            continue;
        };
        // 仅处理 bot 账号的消息
        let is_bot = { bot_ids.lock().await.contains(&event.id) };
        if !is_bot {
            continue;
        }
        // 查 bots 表（含 config_json）；不在表中视为非 bot
        let (row, config_json) = match find_bot_by_account_id(&db, event.id).await {
            Ok(Some(v)) => v,
            Ok(None) => continue,
            Err(e) => {
                log::warn!("bot account {}: query bot row failed: {e}", event.id);
                continue;
            }
        };
        // 非 running 状态不自动回复
        if row.status != "running" {
            continue;
        }
        // LLM 配置不完整时不自动回复
        let Some(cfg) = parse_llm_config(&config_json) else {
            continue;
        };
        if !has_complete_llm_config(&cfg) {
            continue;
        }
        handle_incoming(&accounts, &bot_ids, event.id, chat_id, msg_id, &row, cfg).await;
    }
}

/// 按 bot_account_id 查 bots 表（含 config_json）。
/// db.rs 只提供按 (owner, bot_id) 查询的 get_bot，这里直接走 conn。
async fn find_bot_by_account_id(
    db: &Db,
    account_id: u32,
) -> AppResult<Option<(BotRow, Option<String>)>> {
    use rusqlite::OptionalExtension;

    let conn = db.conn.clone();
    tokio::task::spawn_blocking(move || -> AppResult<Option<(BotRow, Option<String>)>> {
        let c = conn.blocking_lock();
        let row = c
            .query_row(
                "SELECT id, bot_account_id, owner_account_id, display_name, status, created_at, config_json
                 FROM bots WHERE bot_account_id = ?1",
                rusqlite::params![account_id],
                |r| {
                    Ok((
                        BotRow {
                            id: r.get(0)?,
                            bot_account_id: r.get::<_, i64>(1)? as u32,
                            owner_account_id: r.get::<_, i64>(2)? as u32,
                            display_name: r.get(3)?,
                            status: r.get(4)?,
                            created_at: r.get(5)?,
                        },
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?;
        Ok(row)
    })
    .await?
}

/// 解析 bots 表 config_json 为 LLM 配置；缺失或 JSON 非法返回 None。
fn parse_llm_config(config_json: &Option<String>) -> Option<LlmConfigInput> {
    serde_json::from_str::<LlmConfigInput>(config_json.as_deref()?).ok()
}

/// LLM 自动回复需要完整配置：base_url / api_key / model 三者都非空。
fn has_complete_llm_config(cfg: &LlmConfigInput) -> bool {
    let non_empty = |s: &Option<String>| s.as_deref().map_or(false, |s| !s.trim().is_empty());
    non_empty(&cfg.base_url) && non_empty(&cfg.api_key) && non_empty(&cfg.model)
}

/// 处理单条 IncomingMsg：加载消息 → 防 bot 互聊 → 构建历史 → 调 LLM → 发送回复。
/// 任何一步失败只记日志，绝不把错误作为回复发给用户。
async fn handle_incoming(
    accounts: &Arc<Mutex<Accounts>>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
    account_id: u32,
    chat_id: ChatId,
    msg_id: MsgId,
    row: &BotRow,
    cfg: LlmConfigInput,
) {
    // 短暂持有 accounts 锁拿到 bot 的 Context
    let ctx = {
        let accounts = accounts.lock().await;
        match accounts.get_account(account_id) {
            Some(ctx) => ctx,
            None => {
                log::warn!(
                    "bot {} (account {account_id}) context unavailable, skip",
                    row.id
                );
                return;
            }
        }
    };

    // 加载触发消息并取发送者地址
    let msg = match Message::load_from_db(&ctx, msg_id).await {
        Ok(m) => m,
        Err(e) => {
            log::warn!("bot {}: load msg {msg_id} failed: {e}", row.id);
            return;
        }
    };
    let sender_addr = match Contact::get_by_id(&ctx, msg.get_from_id()).await {
        Ok(c) => c.get_addr().to_string(),
        Err(e) => {
            log::warn!("bot {}: sender contact load failed: {e}", row.id);
            return;
        }
    };

    // 防循环：bot 之间不互相回复
    let bot_addrs = collect_bot_addrs(accounts, bot_ids).await;
    if is_bot_addr(&sender_addr, &bot_addrs) {
        log::debug!("bot {}: skip reply to bot {sender_addr}", row.id);
        return;
    }

    // 构建最近 20 条聊天历史
    let history = match build_history(&ctx, chat_id).await {
        Some(h) => h,
        None => {
            log::warn!("bot {}: build history failed", row.id);
            return;
        }
    };

    // system prompt + 历史拼成完整上下文
    let mut messages = Vec::new();
    if let Some(p) = cfg
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

    // 调 LLM；失败只记日志，不把错误发给用户
    let reply = match llm::complete(&cfg, messages).await {
        Ok(r) => r.trim().to_string(),
        Err(e) => {
            log::warn!("bot {}: llm complete failed: {e}", row.id);
            return;
        }
    };
    if reply.is_empty() {
        log::warn!("bot {}: empty llm reply, skip", row.id);
        return;
    }

    // 以 bot 身份发送文本回复
    let mut out = Message::new(Viewtype::Text);
    out.set_text(reply);
    if let Err(e) = chat::send_msg(&ctx, chat_id, &mut out).await {
        log::warn!("bot {}: send reply failed: {e}", row.id);
    }
}

/// 收集所有 bot 账号的已配置邮箱地址，用于防 bot 互聊。
async fn collect_bot_addrs(
    accounts: &Arc<Mutex<Accounts>>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
) -> HashSet<String> {
    let ids: Vec<u32> = bot_ids.lock().await.iter().copied().collect();
    let mut addrs = HashSet::new();
    for id in ids {
        let ctx = { accounts.lock().await.get_account(id) };
        if let Some(ctx) = ctx {
            if let Ok(Some(addr)) = ctx.get_config(Config::ConfiguredAddr).await {
                addrs.insert(addr);
            }
        }
    }
    addrs
}

/// 构建聊天历史（最近 20 条），每条渲染为「发送者: 内容」的 user 消息。
async fn build_history(ctx: &Context, chat_id: ChatId) -> Option<Vec<ChatMessage>> {
    let items = chat::get_chat_msgs(ctx, chat_id).await.ok()?;
    // core 返回按时间升序，取最后 20 条消息（先反转取前 20 再反回去保持时间顺序）
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
    Some(history)
}

/// 取消息发送者展示名，为空时退回邮箱地址。
async fn sender_name(ctx: &Context, m: &Message) -> String {
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

/// 判断地址是否属于某个 bot 账号（用于阻止 bot 之间互聊）。
fn is_bot_addr(addr: &str, bot_addrs: &HashSet<String>) -> bool {
    bot_addrs.contains(addr)
}

/// 无文本消息的 viewtype 中文标签。
fn render_viewtype_label(v: &Viewtype) -> &'static str {
    match v {
        Viewtype::Image => "[图片]",
        Viewtype::File => "[文件]",
        Viewtype::Voice => "[语音]",
        Viewtype::Webxdc => "[App]",
        _ => "[其他]",
    }
}

/// 渲染单条历史消息行：「name: text」
fn format_message_line(name: &str, text: &str) -> String {
    format!("「{name}: {text}」")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_bot_addr() {
        let mut addrs = HashSet::new();
        addrs.insert("bot1@example.com".to_string());
        addrs.insert("bot2@example.com".to_string());
        assert!(is_bot_addr("bot1@example.com", &addrs));
        assert!(is_bot_addr("bot2@example.com", &addrs));
        assert!(!is_bot_addr("alice@example.com", &addrs));
        assert!(!is_bot_addr("", &addrs));
    }

    #[test]
    fn test_format_message_line() {
        let line = format_message_line("小明", "你好呀");
        assert_eq!(line, "「小明: 你好呀」");
        // 名称与文本都应出现在行内
        assert!(line.contains("小明"));
        assert!(line.contains("你好呀"));
    }

    #[test]
    fn test_render_viewtype_label() {
        use deltachat::message::Viewtype::*;
        assert_eq!(render_viewtype_label(&Image), "[图片]");
        assert_eq!(render_viewtype_label(&File), "[文件]");
        assert_eq!(render_viewtype_label(&Voice), "[语音]");
        assert_eq!(render_viewtype_label(&Webxdc), "[App]");
        // 文本消息不会走到标签分支，其余类型一律兜底 [其他]
        assert_eq!(render_viewtype_label(&Unknown), "[其他]");
        assert_eq!(render_viewtype_label(&Text), "[其他]");
        assert_eq!(render_viewtype_label(&Gif), "[其他]");
        assert_eq!(render_viewtype_label(&Video), "[其他]");
    }

    #[test]
    fn test_has_complete_llm_config() {
        let cfg = LlmConfigInput {
            system_prompt: None,
            base_url: Some("https://api.example.com/v1".to_string()),
            api_key: Some("key".to_string()),
            model: Some("gpt-4o-mini".to_string()),
            provider: None,
        };
        assert!(has_complete_llm_config(&cfg));
        let mut no_model = cfg.clone();
        no_model.model = None;
        assert!(!has_complete_llm_config(&no_model));
        let mut no_key = cfg.clone();
        no_key.api_key = Some("   ".to_string());
        assert!(!has_complete_llm_config(&no_key));
    }

    #[test]
    fn test_parse_llm_config() {
        let cfg = parse_llm_config(&Some(
            r#"{"base_url":"https://x","api_key":"k","model":"m"}"#.to_string(),
        ));
        assert!(cfg.is_some());
        assert_eq!(cfg.unwrap().model.as_deref(), Some("m"));
        // 缺失或非法 JSON 均返回 None
        assert!(parse_llm_config(&None).is_none());
        assert!(parse_llm_config(&Some("not json".to_string())).is_none());
    }
}
