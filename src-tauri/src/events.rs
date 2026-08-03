use std::sync::Arc;

use deltachat::accounts::Accounts;
use deltachat::chat::ChatId;
use deltachat::message::{Message, MsgId};
use deltachat::EventType;
use tauri::{async_runtime, AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::dto::EventPayload;

/// 启动事件转发 task: 把 deltachat core 的事件转成 `EventPayload`,
/// 通过 `app.emit("dc-event", payload)` 推到前端。
///
/// 对齐 Plzdelta 的事件覆盖:补齐 MsgsNoticed/MsgDelivered/MsgFailed/MsgRead/
/// ReactionsChanged/IncomingReaction/IncomingMsgBunch/MsgDeleted/
/// ChatEphemeralTimerModified/ChatDeleted/Webxdc* 等关键事件,
/// 之前 `_ => continue` 会丢弃这些事件导致前端无法更新已读/失败/反应状态。
///
/// `bot_ids` 是要过滤的 Bot 账号集合:Bot 账号产生的事件不转发给前端
/// (主界面只关心当前主账号,Bot 收信由 bot_llm 运行时处理)。
pub fn spawn_event_forwarder(
    app: AppHandle,
    accounts: Arc<Mutex<Accounts>>,
    bot_ids: Arc<Mutex<std::collections::HashSet<u32>>>,
) {
    async_runtime::spawn(async move {
        let emitter = {
            let accounts = accounts.lock().await;
            accounts.get_event_emitter()
        };
        while let Some(event) = emitter.recv().await {
            // Bot 账号的事件不转发前端(主界面只关心当前主账号;Bot 收信由 bot_llm 运行时处理)
            let is_bot_event = { let ids = bot_ids.lock().await; ids.contains(&event.id) };
            if is_bot_event {
                continue;
            }
            let payload = match event.typ {
                EventType::IncomingMsg { chat_id, msg_id } => {
                    // 拉取消息摘要给前端做通知(避免前端再发一次 get_chat_msgs)
                    let text = fetch_msg_text(&accounts, chat_id, msg_id).await;
                    EventPayload {
                        typ: "IncomingMsg".into(),
                        chat_id: Some(chat_id.to_u32()),
                        msg_id: Some(msg_id.to_u32()),
                        contact_id: None,
                        progress: None,
                        comment: None,
                        text,
                    }
                }
                EventType::MsgsChanged { chat_id, msg_id } => EventPayload {
                    typ: "MsgsChanged".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::MsgsNoticed(chat_id) => EventPayload {
                    typ: "MsgsNoticed".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::MsgDelivered { chat_id, msg_id } => EventPayload {
                    typ: "MsgDelivered".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::MsgFailed { chat_id, msg_id } => EventPayload {
                    typ: "MsgFailed".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::MsgRead { chat_id, msg_id } => EventPayload {
                    typ: "MsgRead".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::MsgDeleted { chat_id, msg_id } => EventPayload {
                    typ: "MsgDeleted".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ReactionsChanged { chat_id, msg_id, contact_id } => EventPayload {
                    typ: "ReactionsChanged".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: Some(contact_id.to_u32()),
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::IncomingReaction { chat_id, contact_id, msg_id, .. } => EventPayload {
                    typ: "IncomingReaction".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: Some(contact_id.to_u32()),
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::IncomingMsgBunch => EventPayload {
                    typ: "IncomingMsgBunch".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ContactsChanged(c) => EventPayload {
                    typ: "ContactsChanged".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: c.map(|x| x.to_u32()),
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::SelfavatarChanged => EventPayload {
                    typ: "SelfavatarChanged".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ConfigureProgress { progress, comment } => EventPayload {
                    typ: "ConfigureProgress".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: None,
                    progress: Some(progress),
                    comment,
                    text: None,
                },
                EventType::ChatlistItemChanged { chat_id } => EventPayload {
                    typ: "ChatlistItemChanged".into(),
                    chat_id: chat_id.map(|x| x.to_u32()),
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ChatModified(chat_id) => EventPayload {
                    typ: "ChatModified".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ChatEphemeralTimerModified { chat_id, .. } => EventPayload {
                    typ: "ChatEphemeralTimerModified".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::ChatDeleted { chat_id } => EventPayload {
                    typ: "ChatDeleted".into(),
                    chat_id: Some(chat_id.to_u32()),
                    msg_id: None,
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::SecurejoinJoinerProgress { contact_id, progress } => EventPayload {
                    typ: "SecurejoinJoinerProgress".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: Some(contact_id.to_u32()),
                    progress: Some(progress),
                    comment: None,
                    text: None,
                },
                EventType::SecurejoinInviterProgress { contact_id, progress, .. } => EventPayload {
                    typ: "SecurejoinInviterProgress".into(),
                    chat_id: None,
                    msg_id: None,
                    contact_id: Some(contact_id.to_u32()),
                    progress: Some(progress),
                    comment: None,
                    text: None,
                },
                EventType::WebxdcStatusUpdate { msg_id, .. } => EventPayload {
                    typ: "WebxdcStatusUpdate".into(),
                    chat_id: None,
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::WebxdcRealtimeData { msg_id, .. } => EventPayload {
                    typ: "WebxdcRealtimeData".into(),
                    chat_id: None,
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                EventType::WebxdcInstanceDeleted { msg_id, .. } => EventPayload {
                    typ: "WebxdcInstanceDeleted".into(),
                    chat_id: None,
                    msg_id: Some(msg_id.to_u32()),
                    contact_id: None,
                    progress: None,
                    comment: None,
                    text: None,
                },
                // 信息/警告/错误等日志类事件不转发(前端不需要)
                _ => continue,
            };
            let result = app.emit("dc-event", &payload);
            // 诊断:确认事件循环活着 + emit 是否成功(排查事件流断)
            log::debug!("[events] forwarded {}, emit result ok={}", payload.typ, result.is_ok());
        }
    });
}

/// 加载消息文本(用于 IncomingMsg 通知预览)。
/// 失败时返回 None,前端会 fallback 到 "新消息"。
async fn fetch_msg_text(
    accounts: &Arc<Mutex<Accounts>>,
    _chat_id: ChatId,
    msg_id: MsgId,
) -> Option<String> {
    let ctx = {
        let accounts = accounts.lock().await;
        let id = accounts.get_selected_account_id()?;
        accounts.get_account(id)?
    };
    let m = Message::load_from_db(&ctx, msg_id).await.ok()?;
    let text = m.get_text();
    if text.is_empty() {
        // 无文本时返回 viewtype 描述(如 "图片"/"文件")
        Some(format!("[{}]", viewtype_str(m.get_viewtype())))
    } else {
        Some(text.chars().take(80).collect())
    }
}

fn viewtype_str(v: deltachat::message::Viewtype) -> &'static str {
    use deltachat::message::Viewtype::*;
    match v {
        Text => "文本",
        Image => "图片",
        Gif => "GIF",
        Sticker => "贴纸",
        Audio => "音频",
        Voice => "语音",
        Video => "视频",
        File => "文件",
        Vcard => "名片",
        Webxdc => "App",
        Unknown => "消息",
        _ => "消息",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_payload_serialization() {
        let p = EventPayload {
            typ: "IncomingMsg".into(),
            chat_id: Some(42),
            msg_id: Some(7),
            contact_id: None,
            progress: None,
            comment: None,
            text: Some("hi".into()),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"typ\":\"IncomingMsg\""));
        assert!(json.contains("\"chat_id\":42"));
        assert!(json.contains("\"msg_id\":7"));
        assert!(json.contains("\"text\":\"hi\""));
    }

    #[test]
    fn test_configure_progress_payload() {
        let p = EventPayload {
            typ: "ConfigureProgress".into(),
            chat_id: None,
            msg_id: None,
            contact_id: None,
            progress: Some(500),
            comment: Some("connecting imap".into()),
            text: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"typ\":\"ConfigureProgress\""));
        assert!(json.contains("\"progress\":500"));
        assert!(json.contains("\"comment\":\"connecting imap\""));
    }

    #[test]
    fn test_reactions_changed_payload() {
        let p = EventPayload {
            typ: "ReactionsChanged".into(),
            chat_id: Some(10),
            msg_id: Some(99),
            contact_id: Some(5),
            progress: None,
            comment: None,
            text: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"typ\":\"ReactionsChanged\""));
        assert!(json.contains("\"contact_id\":5"));
    }
}
