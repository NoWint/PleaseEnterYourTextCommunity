use deltachat::chat::{self, Chat, ChatItem, ChatVisibility};
use deltachat::context::Context;
use deltachat::chatlist::Chatlist;
use deltachat::config::Config;
use deltachat::constants::Chattype;
use deltachat::contact::{Contact, ContactId};
use deltachat::download::DownloadState;
use deltachat::login_param::{EnteredCertificateChecks, EnteredLoginParam};
use deltachat::message::{self, Message, MessageState, MsgId, Viewtype};
use deltachat::provider::Socket;
use deltachat::reaction;
use deltachat::securejoin;
use tauri::State;

use crate::dto::{
    ActivityDto, AdvancedLogin, BotDto, CardDto, ChannelDto, ChatDto, ChatInfoDto, ContactDto,
    ContactRoleDto, InboxEventDto, MemberDto, MsgDto, PeytStudioDto, PinDto, ProfileDto,
    RawMsgDto, ReactionDto, RoleDto, SearchResultDto, WorkspaceDto,
};
use crate::error::{AppError, AppResult};
use crate::plugins::{PluginStatus, RegistryPlugin};
use crate::state::AppState;

/// SP5 Task 11: 区分"字段缺失"(None, 不更新) / "字段为 null"(Some(None), 清空) /
/// "字段有值"(Some(Some(v)), 更新)。
///
/// 问题: Tauri 的 CommandItem 反序列化器在 deserialize_option 中, 对 key 缺失和
/// JSON null 都调用 visit_none(), 导致 Option<Option<T>> 无法区分"清空"和"不更新"。
/// 且 Tauri v2.11 的 #[command] 宏不支持 #[serde(...)] 函数参数属性。
///
/// 方案: 定义 Clearable<T> 包装类型, 手动实现 Deserialize。利用 deserialize_any
/// 在 key 缺失时返回 Err 的特性来区分三种情况:
///   - key 缺失 → Value::deserialize 返回 Err → Clearable(None) (不更新)
///   - key 存在 + null → Value::Null → Clearable(Some(None)) (清空)
///   - key 存在 + value → from_value → Clearable(Some(Some(v))) (更新)
pub struct Clearable<T>(Option<Option<T>>);

impl<'de, T: serde::de::DeserializeOwned> serde::Deserialize<'de> for Clearable<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match serde_json::Value::deserialize(deserializer) {
            Ok(serde_json::Value::Null) => Ok(Clearable(Some(None))),
            Ok(v) => {
                let t: T = serde_json::from_value(v).map_err(serde::de::Error::custom)?;
                Ok(Clearable(Some(Some(t))))
            }
            Err(_) => Ok(Clearable(None)),
        }
    }
}

/// Debug log to project dir (stderr is swallowed by macOS GUI).
fn dbg(msg: impl AsRef<str>) {
    use std::io::Write;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{}", msg.as_ref());
        let _ = f.flush();
    }
}

fn parse_socket(s: &Option<String>) -> Socket {
    match s.as_deref() {
        Some("ssl") => Socket::Ssl,
        Some("tls") => Socket::Starttls,
        Some("plain") => Socket::Plain,
        _ => Socket::Automatic,
    }
}

#[tauri::command]
pub async fn is_configured(state: State<'_, AppState>) -> AppResult<bool> {
    Ok(state.current_id.lock().unwrap().is_some())
}

#[tauri::command]
pub async fn login(
    state: State<'_, AppState>,
    email: String,
    password: String,
    advanced: Option<AdvancedLogin>,
) -> AppResult<u32> {
    let id = {
        let mut accounts = state.accounts.lock().await;
        accounts.add_account().await?
    };
    let ctx = {
        let accounts = state.accounts.lock().await;
        accounts
            .get_account(id)
            .ok_or_else(|| AppError::Core("account gone".into()))?
    };

    let mut param = EnteredLoginParam::default();
    param.addr = email.clone();
    param.imap.password = password.clone();
    if let Some(a) = &advanced {
        param.imap.server = a.imap_host.clone().unwrap_or_default();
        param.imap.port = a.imap_port.unwrap_or(0);
        param.imap.security = parse_socket(&a.imap_security);
        param.imap.user = a.imap_user.clone().unwrap_or_default();
        param.smtp.server = a.smtp_host.clone().unwrap_or_default();
        param.smtp.port = a.smtp_port.unwrap_or(0);
        param.smtp.security = parse_socket(&a.smtp_security);
        param.smtp.user = a.smtp_user.clone().unwrap_or_default();
        param.smtp.password = a.smtp_password.clone().unwrap_or_default();
        param.certificate_checks = EnteredCertificateChecks::Automatic;
    }

    if let Err(e) = ctx.add_or_update_transport(&mut param).await {
        let msg = e.to_string().to_lowercase();
        let mapped = if msg.contains("auth") || msg.contains("login") || msg.contains("password") {
            AppError::AuthFailed
        } else if msg.contains("network") || msg.contains("connection") || msg.contains("timeout") {
            AppError::Network(msg)
        } else if msg.contains("autoconfig") || msg.contains("provider") {
            AppError::AutoconfigNotFound
        } else {
            AppError::Core(e.to_string())
        };
        return Err(mapped);
    }
    // 根治「Provider requires E2EE」死锁:chatmail core 默认 force_encryption=1,
    // 新会话无对方公钥时首条明文被禁 → Autocrypt 密钥交换无法启动。
    // 桌面客户端恢复 Delta 标准流程(首条明文带公钥 → 自动升级加密)。
    ctx.set_config(Config::ForceEncryption, Some("0")).await?;
    ctx.start_io().await;

    {
        let mut accounts = state.accounts.lock().await;
        accounts.select_account(id).await?;
    }

    // `set_current` 是同步 `&self`（Task 2 实现），无需 await、无需 mut。
    state.set_current(id);
    Ok(id)
}

#[tauri::command]
pub async fn create_chatmail_account(
    state: State<'_, AppState>,
    display_name: String,
) -> AppResult<u32> {
    dbg(format!("[chatmail] start, display_name={display_name}"));
    let id = {
        let mut accounts = state.accounts.lock().await;
        accounts.add_account().await?
    };
    dbg(format!("[chatmail] add_account ok, id={id}"));
    let ctx = {
        let accounts = state.accounts.lock().await;
        accounts
            .get_account(id)
            .ok_or_else(|| AppError::Core("account gone".into()))?
    };
    dbg("[chatmail] got context, calling add_transport_from_qr...");

    ctx.add_transport_from_qr("dcaccount:https://yzjtiantian.cn/new")
        .await
        .map_err(|e| {
            dbg(format!("[chatmail] add_transport_from_qr FAILED: {e}"));
            let msg = e.to_string().to_lowercase();
            if msg.contains("network") || msg.contains("connection") || msg.contains("timeout") {
                AppError::Network(msg)
            } else {
                AppError::Core(e.to_string())
            }
        })?;
    dbg("[chatmail] add_transport_from_qr ok, setting display name...");

    ctx.set_config(Config::Displayname, Some(&display_name))
        .await?;
    // 同上 login:关闭 force_encryption,避免新会话无对方公钥时首条明文被禁的 Autocrypt 死锁
    ctx.set_config(Config::ForceEncryption, Some("0")).await?;
    dbg("[chatmail] display name set, selecting account...");

    {
        let mut accounts = state.accounts.lock().await;
        accounts.select_account(id).await?;
    }
    // 启动 IO（与 login 命令对齐，否则 chatmail 账号无法收发消息）
    ctx.start_io().await;
    state.set_current(id);
    dbg(format!("[chatmail] done, id={id}"));
    Ok(id)
}

#[tauri::command]
pub async fn get_self_profile(state: State<'_, AppState>) -> AppResult<ProfileDto> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let id = ctx.get_id();
    let name = ctx.get_config(Config::Displayname).await?;
    let addr = ctx.get_config(Config::ConfiguredAddr).await?;
    let self_contact = Contact::get_by_id(&ctx, ContactId::SELF).await?;
    let avatar = self_contact
        .get_profile_image(&ctx)
        .await?
        .map(|p| p.to_string_lossy().to_string());
    let color = Some(self_contact.get_color());
    Ok(ProfileDto {
        id,
        name,
        addr,
        avatar,
        color,
    })
}

fn state_str(s: MessageState) -> &'static str {
    match s {
        MessageState::OutPending => "pending",
        MessageState::OutFailed => "failed",
        MessageState::OutDelivered => "delivered",
        MessageState::OutMdnRcvd => "read",
        _ => "other",
    }
}

fn viewtype_str(v: Viewtype) -> &'static str {
    use Viewtype::*;
    match v {
        Text => "Text",
        Image => "Image",
        Gif => "Gif",
        Sticker => "Sticker",
        Audio => "Audio",
        Voice => "Voice",
        Video => "Video",
        File => "File",
        Vcard => "Vcard",
        Webxdc => "Webxdc",
        Unknown => "Unknown",
        _ => "Unknown",
    }
}

fn chat_type_str(chat: &Chat, _is_self_talk: bool) -> String {
    use Chattype::*;
    let t = chat.get_type();
    match t {
        Single => "single".to_string(),
        Group => "group".to_string(),
        Mailinglist => "mailinglist".to_string(),
        OutBroadcast | InBroadcast => "broadcast".to_string(),
        //_ => {
        //    if is_self_talk {
        //        "self_talk".to_string()
        //    } else {
        //       format!("{:?}", t).to_lowercase()
        //    }
        //}
    }
}

fn download_state_str(s: DownloadState) -> &'static str {
    use DownloadState::*;
    match s {
        Done => "Done",
        Available => "Available",
        Failure => "Failure",
        Undecipherable => "Undecipherable",
        InProgress => "InProgress",
        // _ => "Unknown",
    }
}

/// 构建聊天列表 DTO（供 get_chatlist 与 bot_get_chatlist 复用）。
async fn build_chatlist(ctx: &Context, archived_only: Option<bool>) -> AppResult<Vec<ChatDto>> {
    // 归档视图请求 DC_GCL_ARCHIVED_ONLY(仅归档会话);常规视图用 0(仅未归档)。
    // core 文档:flags=0 且存在归档会话时,chatlist 会自动注入 DC_CHAT_ID_ARCHIVED_LINK
    // 虚拟会话(见下循环跳过)。DC_GCL_ARCHIVED_ONLY 时同样可能注入 ALLDONE_HINT。
    let listflags = if archived_only.unwrap_or(false) {
        deltachat::constants::DC_GCL_ARCHIVED_ONLY
    } else {
        0
    };
    let list = Chatlist::try_load(ctx, listflags, None, None).await?;
    let mut out = Vec::with_capacity(list.len());
    for i in 0..list.len() {
        let chat_id = list.get_chat_id(i)?;
        // 跳过虚拟特殊会话(归档链接 id=6 / alldone 提示 id=7):它们在 chatlist 里但
        // db 无行,load_from_db 会 QueryReturnedNoRows 使整个 get_chatlist 失败,
        // 导致前端聊天列表空。PEYT 无 UI 消费它们,直接跳过。
        if chat_id.is_archived_link() || chat_id.is_alldone_hint() {
            continue;
        }
        let chat = Chat::load_from_db(ctx, chat_id).await?;
        let is_group = chat.get_type() == Chattype::Group;
        let is_contact_request = chat.is_contact_request();
        let is_self_talk = chat.is_self_talk();
        let is_archived = chat.get_visibility() == ChatVisibility::Archived;
        let (last_msg, last_ts) = if let Some(msg_id) = list.get_msg_id(i)? {
            let m = message::Message::load_from_db(ctx, msg_id).await?;
            (Some(m.get_text()), Some(m.get_timestamp()))
        } else {
            (None, None)
        };
        let unread = chat_id.get_fresh_msg_cnt(ctx).await? as u32;
        // 单聊用联系人最新显示名/头像/颜色(比 chat.name 缓存更可靠,对齐 core
        // get_display_name:本地名→authname→邮箱);其他会话用 chat 自身头像/颜色。
        // self-talk 保持「保存的消息」名(load_from_db 已设好)。
        let mut name = chat.get_name().to_string();
        let (avatar, color) = if !is_self_talk && chat.get_type() == Chattype::Single {
            let mut av: Option<String> = None;
            let mut col: Option<u32> = None;
            if let Some(cid) = chat::get_chat_contacts(ctx, chat_id).await?.into_iter().next() {
                let c = Contact::get_by_id(ctx, cid).await?;
                name = c.get_display_name().to_string();
                av = c
                    .get_profile_image(ctx)
                    .await?
                    .map(|p| p.to_string_lossy().to_string());
                col = Some(c.get_color());
            }
            (av, col)
        } else {
            let av = chat
                .get_profile_image(ctx)
                .await?
                .map(|p| p.to_string_lossy().to_string());
            let col = Some(chat.get_color(ctx).await?);
            (av, col)
        };
        out.push(ChatDto {
            chat_id: chat_id.to_u32(),
            name,
            is_group,
            is_contact_request,
            is_self_talk,
            is_archived,
            last_msg,
            last_ts,
            unread,
            avatar,
            color,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_chatlist(
    state: State<'_, AppState>,
    archived_only: Option<bool>,
) -> AppResult<Vec<ChatDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    build_chatlist(&ctx, archived_only).await
}

#[tauri::command]
pub async fn get_chat_info(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<ChatInfoDto> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let chat = Chat::load_from_db(&ctx, chat_id).await?;
    let is_group = chat.get_type() == Chattype::Group;
    let is_contact_request = chat.is_contact_request();
    let is_self_talk = chat.is_self_talk();

    let mut members = Vec::new();
    for cid in chat::get_chat_contacts(&ctx, chat_id).await? {
        let c = Contact::get_by_id(&ctx, cid).await?;
        let avatar = c
            .get_profile_image(&ctx)
            .await?
            .map(|p| p.to_string_lossy().to_string());
        let color = Some(c.get_color());
        members.push(MemberDto {
            contact_id: cid.to_u32(),
            name: c.get_display_name().to_string(),
            addr: c.get_addr().to_string(),
            is_self: cid == ContactId::SELF,
            avatar,
            color,
        });
    }
    // For 1:1 chats, get_chat_contacts does NOT include SELF; add the other
    // side's info is already there, but if list is empty (self-talk), we still
    // want to show self.
    if members.is_empty() && is_self_talk {
        let self_id = ctx.get_id();
        let name = ctx.get_config(Config::Displayname).await?.unwrap_or_default();
        let addr = ctx.get_config(Config::ConfiguredAddr).await?.unwrap_or_default();
        let self_contact = Contact::get_by_id(&ctx, ContactId::SELF).await?;
        let avatar = self_contact
            .get_profile_image(&ctx)
            .await?
            .map(|p| p.to_string_lossy().to_string());
        let color = Some(self_contact.get_color());
        members.push(MemberDto {
            contact_id: 1, // SELF is always 1
            name,
            addr,
            is_self: true,
            avatar,
            color,
        });
        let _ = self_id; // suppress unused warning
    }

    // chat_type 字符串:single/group/mailinglist/broadcast/self_talk/device
    let chat_type = chat_type_str(&chat, is_self_talk);
    let is_encrypted = chat.is_encrypted(&ctx).await?;

    Ok(ChatInfoDto {
        chat_id: chat_id.to_u32(),
        name: chat.get_name().to_string(),
        is_group,
        is_contact_request,
        is_self_talk,
        chat_type,
        is_encrypted,
        members,
    })
}

/// 将一条消息转为 MsgDto（供 get_chat_msgs 与 bot_send_text 复用）。
async fn msg_to_dto(ctx: &Context, msg_id: MsgId) -> AppResult<MsgDto> {
    let m = message::Message::load_from_db(ctx, msg_id).await?;
    let from_id = m.get_from_id();
    let from_name = if from_id == deltachat::contact::ContactId::SELF {
        "我".to_string()
    } else {
        Contact::get_by_id(ctx, from_id)
            .await?
            .get_display_name()
            .to_string()
    };
    let (quote_from, quote_text) = match m.quoted_message(ctx).await? {
        Some(q) => {
            let q_from_id = q.get_from_id();
            let q_name = if q_from_id == deltachat::contact::ContactId::SELF {
                "我".to_string()
            } else {
                Contact::get_by_id(ctx, q_from_id)
                    .await?
                    .get_display_name()
                    .to_string()
            };
            (Some(q_name), Some(q.get_text()))
        }
        None => (None, None),
    };
    let file_path = m.get_file(ctx).map(|p| p.to_string_lossy().to_string());
    let file_name = m.get_filename();
    let file_mime = m.get_filemime();
    let file_bytes = m.get_filebytes(ctx).await.unwrap_or(None);
    let width = m.get_width();
    let height = m.get_height();
    let view_type = viewtype_str(m.get_viewtype()).to_string();
    let download_state = download_state_str(m.download_state()).to_string();
    let subject = {
        let s = m.get_subject();
        if s.is_empty() { None } else { Some(s.to_string()) }
    };
    Ok(MsgDto {
        msg_id: msg_id.to_u32(),
        from_id: from_id.to_u32(),
        from_name,
        text: m.get_text(),
        ts: m.get_timestamp(),
        is_out: m.get_state().is_outgoing(),
        state: state_str(m.get_state()).to_string(),
        quote_from,
        quote_text,
        view_type,
        file: file_path,
        file_name,
        file_mime,
        file_bytes,
        width: if width > 0 { Some(width) } else { None },
        height: if height > 0 { Some(height) } else { None },
        download_state,
        subject,
    })
}

/// 获取聊天消息分页窗口（供 get_chat_msgs 与 bot_get_chat_msgs 复用）。
async fn get_chat_msgs_impl(
    ctx: &Context,
    chat_id: u32,
    before_msg_id: Option<u32>,
) -> AppResult<Vec<MsgDto>> {
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let items = chat::get_chat_msgs(ctx, chat_id).await?;
    // core returns items oldest-first (sorted by timestamp ascending).
    // Pick the window of up to 50 items to return.
    let window: Vec<ChatItem> = match before_msg_id {
        Some(before) => {
            let pos = items.iter().position(|it| match it {
                ChatItem::Message { msg_id } => msg_id.to_u32() == before,
                _ => false,
            });
            match pos {
                Some(pos) => {
                    let start = pos.saturating_sub(50);
                    items.into_iter().skip(start).take(pos - start).collect()
                }
                None => Vec::new(),
            }
        }
        None => {
            let len = items.len();
            let start = len.saturating_sub(50);
            items.into_iter().skip(start).collect()
        }
    };
    let mut out = Vec::new();
    for item in window {
        if let ChatItem::Message { msg_id } = item {
            out.push(msg_to_dto(ctx, msg_id).await?);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_chat_msgs(
    state: State<'_, AppState>,
    chat_id: u32,
    before_msg_id: Option<u32>,
) -> AppResult<Vec<MsgDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    get_chat_msgs_impl(&ctx, chat_id, before_msg_id).await
}

/// 发送文本消息，返回新消息 id（供 send_text 与 bot_send_text 复用）。
async fn send_text_impl(ctx: &Context, chat_id: u32, text: String) -> AppResult<MsgId> {
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    Ok(chat::send_text_msg(ctx, chat_id, text).await?)
}

#[tauri::command]
pub async fn send_text(
    state: State<'_, AppState>,
    chat_id: u32,
    text: String,
) -> AppResult<u32> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    Ok(send_text_impl(&ctx, chat_id, text).await?.to_u32())
}

#[tauri::command]
pub async fn get_contacts(state: State<'_, AppState>) -> AppResult<Vec<ContactDto>> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let ids = Contact::get_all(&ctx, 0, None).await?;
    let mut out = Vec::new();
    for id in ids {
        if id == ContactId::SELF || id == ContactId::INFO || id == ContactId::DEVICE {
            continue;
        }
        let c = Contact::get_by_id(&ctx, id).await?;
        let avatar = c
            .get_profile_image(&ctx)
            .await?
            .map(|p| p.to_string_lossy().to_string());
        let color = Some(c.get_color());
        out.push(ContactDto {
            id: id.to_u32(),
            name: c.get_display_name().to_string(),
            addr: c.get_addr().to_string(),
            avatar,
            color,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_group(
    state: State<'_, AppState>,
    name: String,
    member_emails: Vec<String>,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = chat::create_group(&ctx, &name).await?;
    for email in member_emails {
        let email = email.trim();
        if email.is_empty() {
            continue;
        }
        let cid = Contact::create(&ctx, "", email).await?;
        chat::add_contact_to_chat(&ctx, chat_id, cid).await?;
    }
    Ok(chat_id.to_u32())
}

#[tauri::command]
pub async fn add_group_member(
    state: State<'_, AppState>,
    chat_id: u32,
    email: String,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let cid = Contact::create(&ctx, "", &email).await?;
    chat::add_contact_to_chat(&ctx, chat_id, cid).await?;
    Ok(cid.to_u32())
}

/// Create a 1:1 chat with the given email. If a chat already exists
/// (including a contact-request chat), returns the existing chat id.
#[tauri::command]
pub async fn create_chat_by_email(
    state: State<'_, AppState>,
    email: String,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err(AppError::Core("邮箱不能为空".into()));
    }
    let cid = Contact::create(&ctx, "", &email).await?;
    let chat_id = deltachat::chat::ChatId::create_for_contact(&ctx, cid).await?;
    Ok(chat_id.to_u32())
}

/// Accept a contact-request chat so the user can reply.
#[tauri::command]
pub async fn accept_chat(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat_id.accept(&ctx).await?;
    Ok(())
}

/// Block a contact-request chat (and its contact).
#[tauri::command]
pub async fn block_chat(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat_id.block(&ctx).await?;
    Ok(())
}

/// Delete a chat (also used to dismiss a contact request).
#[tauri::command]
pub async fn delete_chat(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat_id.delete(&ctx).await?;
    Ok(())
}

/// Leave a group chat (removes SELF from the member list).
#[tauri::command]
pub async fn leave_group(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat::remove_contact_from_chat(&ctx, chat_id, ContactId::SELF).await?;
    Ok(())
}

/// 标记聊天已读（供 mark_chat_noticed 与 bot_mark_chat_noticed 复用）。
async fn mark_chat_noticed_impl(ctx: &Context, chat_id: u32) -> AppResult<()> {
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat::marknoticed_chat(ctx, chat_id).await?;
    Ok(())
}

/// 把聊天里所有 fresh/noticed 消息标记为 seen 并触发已读回执(MDN)发送。
/// 关键:core 只在消息进入 InSeen 时(经 markseen_msgs)才会向对方发 MDN;
/// marknoticed_chat 只清未读徽标、不会发回执 —— 所以仅调 noticed 时对方永远收不到已读。
/// 传全部 msg_id 即可:markseen_msgs 内部只对 InFresh/InNoticed 的消息发 MDN,
/// 已 seen 的自动跳过,outgoing 消息状态不在 Fresh/Noticed 也不会误发。
/// (供 mark_chat_seen 与 bot_mark_chat_seen 复用。)
async fn mark_chat_seen_impl(ctx: &Context, chat_id: u32) -> AppResult<()> {
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let items = chat::get_chat_msgs(ctx, chat_id).await?;
    let msg_ids: Vec<MsgId> = items
        .into_iter()
        .filter_map(|it| match it {
            ChatItem::Message { msg_id } => Some(msg_id),
            _ => None,
        })
        .collect();
    message::markseen_msgs(ctx, msg_ids).await?;
    Ok(())
}

/// Mark all messages in a chat as noticed (clears unread badge).
#[tauri::command]
pub async fn mark_chat_noticed(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    mark_chat_noticed_impl(&ctx, chat_id).await
}

/// 标记整聊已读(seen):清未读徽标 + 向对方发送已读回执。
#[tauri::command]
pub async fn mark_chat_seen(state: State<'_, AppState>, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    mark_chat_seen_impl(&ctx, chat_id).await
}

/// Returns the user's own SecureJoin QR code (e.g. `OPENPGP4FPR:...`)
/// that another Delta Chat user can scan to add you as a verified contact.
/// Pass `chat_id = None` for the personal QR, or a group chat id for a group-invite QR.
#[tauri::command]
pub async fn get_securejoin_qr(
    state: State<'_, AppState>,
    chat_id: Option<u32>,
) -> AppResult<String> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = chat_id.map(deltachat::chat::ChatId::new);
    let qr = securejoin::get_securejoin_qr(&ctx, chat_id).await?;
    Ok(qr)
}

/// Perform a SecureJoin by scanning a `dccontact:` / `dcgroup:` / `DCACCOUNT:` URL.
/// Returns the resulting chat id (for `dccontact:` it's the 1:1 chat with the new verified contact).
#[tauri::command]
pub async fn secure_join(state: State<'_, AppState>, qr: String) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = securejoin::join_securejoin(&ctx, &qr).await?;
    Ok(chat_id.to_u32())
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceDto>> {
    Ok(state.db.list_workspaces().await?)
}

#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<WorkspaceDto> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    // 创建总群
    let master_chat_id = chat::create_group(&ctx, &name).await?;
    let master_u32 = master_chat_id.to_u32();
    // 写本地表
    let icon = name.chars().next().map(|c| c.to_uppercase().to_string());
    let id = state.db.insert_workspace(&name, master_u32, icon.as_deref()).await?;
    // 默认频道：general + announcements
    for ch_name in ["general", "announcements"] {
        let ch_id = chat::create_group(&ctx, ch_name).await?;
        state.db.insert_channel(id, ch_id.to_u32(), ch_name, "General", 0).await?;
    }
    // 默认 core role
    let _ = state.db.insert_role(id, "core", None).await?;
    // 返回完整 DTO
    let ws = state.db.find_workspace_by_master_chat(master_u32).await?
        .ok_or(AppError::Core("workspace not found after insert".into()))?;
    Ok(ws)
}

#[tauri::command]
pub async fn join_workspace(
    state: State<'_, AppState>,
    qr: String,
) -> AppResult<WorkspaceDto> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = securejoin::join_securejoin(&ctx, &qr).await?;
    let master_u32 = chat_id.to_u32();
    // 检查是否已存在
    if let Some(existing) = state.db.find_workspace_by_master_chat(master_u32).await? {
        return Ok(existing);
    }
    // 从总群 chat 获取名字
    let chat = Chat::load_from_db(&ctx, chat_id).await?;
    let name = chat.get_name().to_string();
    let icon = name.chars().next().map(|c| c.to_uppercase().to_string());
    let _id = state.db.insert_workspace(&name, master_u32, icon.as_deref()).await?;
    let ws = state.db.find_workspace_by_master_chat(master_u32).await?
        .ok_or(AppError::Core("workspace not found after insert".into()))?;
    Ok(ws)
}

#[tauri::command]
pub async fn list_channels(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> AppResult<Vec<ChannelDto>> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    let mut chans = state.db.list_channels(workspace_id).await?;
    for ch in &mut chans {
        let chat_id = deltachat::chat::ChatId::new(ch.chat_id);
        ch.unread = chat_id.get_fresh_msg_cnt(&ctx).await.unwrap_or(0) as u32;
    }
    Ok(chans)
}

#[tauri::command]
pub async fn create_channel(
    state: State<'_, AppState>,
    workspace_id: i64,
    name: String,
    category: String,
) -> AppResult<ChannelDto> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = chat::create_group(&ctx, &name).await?;
    let chat_u32 = chat_id.to_u32();
    state.db.insert_channel(workspace_id, chat_u32, &name, &category, 0).await?;
    // 记录活动 (SP6): target_id 用新频道 chat_id
    log_activity(
        &state,
        &ctx,
        workspace_id,
        Some(chat_u32),
        "channel_create",
        "channel",
        chat_u32 as i64,
        Some(name.clone()),
    )
    .await;
    // 返回该频道 DTO（按 chat_id 查找）
    let chans = state.db.list_channels(workspace_id).await?;
    chans.into_iter().find(|c| c.chat_id == chat_u32)
        .ok_or(AppError::Core("channel not found after insert".into()))
}

// ── pin/role commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_channel_pins(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<Vec<PinDto>> {
    Ok(state.db.list_pins(chat_id).await?)
}

#[tauri::command]
pub async fn toggle_pin(
    state: State<'_, AppState>,
    workspace_id: i64,
    chat_id: u32,
    msg_id: u32,
) -> AppResult<bool> {
    // SELF contact_id 在 deltachat core 中固定为 1
    let pinned_by = 1;
    let pinned = state.db.toggle_pin(workspace_id, chat_id, msg_id, pinned_by).await?;
    // 记录活动 (SP6)
    if let Some(ctx) = state.current().await {
        log_activity(
            &state,
            &ctx,
            workspace_id,
            Some(chat_id),
            "pin_toggle",
            "message",
            msg_id as i64,
            None,
        )
        .await;
    }
    Ok(pinned)
}

#[tauri::command]
pub async fn list_roles(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> AppResult<Vec<RoleDto>> {
    Ok(state.db.list_roles(workspace_id).await?)
}

#[tauri::command]
pub async fn set_contact_role(
    state: State<'_, AppState>,
    workspace_id: i64,
    contact_id: u32,
    role_id: i64,
) -> AppResult<()> {
    state.db.set_contact_role(workspace_id, contact_id, role_id).await?;
    Ok(())
}

/// 在工作区中创建一个角色, 返回角色 id。
#[tauri::command]
pub async fn create_role(
    state: State<'_, AppState>,
    workspace_id: i64,
    name: String,
    color: Option<String>,
) -> AppResult<i64> {
    state.db.insert_role(workspace_id, &name, color.as_deref()).await
}

/// Returns every (contact_id, role_id, role_name, role_color) tuple for a
/// workspace, serialized as a named DTO so the JS side gets field names
/// instead of a positional array.
#[tauri::command]
pub async fn list_all_contact_roles(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> AppResult<Vec<ContactRoleDto>> {
    let rows = state.db.list_all_contact_roles(workspace_id).await?;
    Ok(rows
        .into_iter()
        .map(|(contact_id, role_id, role_name, role_color)| ContactRoleDto {
            contact_id,
            role_id,
            role_name,
            role_color,
        })
        .collect())
}

// ── reaction commands ───────────────────────────────────────────────────────
//
// Verified against `core/src/reaction.rs`:
//   pub async fn send_reaction(context, msg_id, reaction: &str) -> Result<MsgId>
//   pub async fn get_msg_reactions(context, msg_id) -> Result<Reactions>
// `Reactions::iter()` yields `(&ContactId, &Reaction)`, and
// `Reaction::as_str()` returns the emoji string. The brief assumed the
// return was an iterable of `{ reaction, contact_id }`; that is NOT the
// real API — we adapt via `.iter()` + `.as_str()` below.

#[tauri::command]
pub async fn send_reaction(
    state: State<'_, AppState>,
    chat_id: u32,
    msg_id: u32,
    emoji: String,
) -> AppResult<()> {
    let _chat_id = chat_id; // kept for API symmetry; reaction targets msg_id only
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let msg_id = MsgId::new(msg_id);
    // send_reaction returns the reaction message's MsgId; caller doesn't need it.
    let _reaction_msg_id = reaction::send_reaction(&ctx, msg_id, &emoji).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_reactions(
    state: State<'_, AppState>,
    msg_id: u32,
) -> AppResult<Vec<ReactionDto>> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let msg_id = MsgId::new(msg_id);
    let reactions = reaction::get_msg_reactions(&ctx, msg_id).await?;
    let mut grouped: std::collections::HashMap<String, Vec<u32>> =
        std::collections::HashMap::new();
    for (contact_id, reaction) in reactions.iter() {
        grouped
            .entry(reaction.as_str().to_string())
            .or_default()
            .push(contact_id.to_u32());
    }
    Ok(grouped
        .into_iter()
        .map(|(emoji, senders)| ReactionDto {
            count: senders.len() as i64,
            senders,
            emoji,
        })
        .collect())
}

// ── reply command ───────────────────────────────────────────────────────────
//
// Verified against `core/src/message.rs` + `core/src/chat.rs`:
//   Message::new_text(text: String) -> Message            (line 483)
//   Message::load_from_db(&Context, MsgId) -> Result<Message>   (line 495)
//   Message::set_quote(&mut self, &Context, Option<&Message>) -> Result<()>  (line 1260)
//   chat::send_msg(&Context, ChatId, &mut Message) -> Result<MsgId>          (line 2616)
// All signatures match the brief.

#[tauri::command]
pub async fn send_reply(
    state: State<'_, AppState>,
    chat_id: u32,
    text: String,
    quote_msg_id: u32,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let mut msg = Message::new_text(text);
    let quote = Message::load_from_db(&ctx, MsgId::new(quote_msg_id)).await?;
    msg.set_quote(&ctx, Some(&quote)).await?;
    let sent_id = chat::send_msg(&ctx, chat_id, &mut msg).await?;
    Ok(sent_id.to_u32())
}

// ── topic commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_channel_topic(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<Option<String>> {
    // topic 存在 channels 表，需查 db。
    // channels 表按 workspace_id 查，这里遍历所有 workspace 查找该 chat_id。
    let workspaces = state.db.list_workspaces().await?;
    for ws in workspaces {
        let chans = state.db.list_channels(ws.id).await?;
        if let Some(ch) = chans.iter().find(|c| c.chat_id == chat_id) {
            return Ok(ch.topic.clone());
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn set_channel_topic(
    state: State<'_, AppState>,
    chat_id: u32,
    topic: String,
) -> AppResult<()> {
    // 直接 UPDATE channels SET topic = ? WHERE chat_id = ?
    // rusqlite 是同步 API，必须放到 spawn_blocking 里。
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let c = conn.blocking_lock();
        c.execute(
            "UPDATE channels SET topic = ?1 WHERE chat_id = ?2",
            rusqlite::params![topic, chat_id as i64],
        )?;
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn validate_channels(state: State<'_, AppState>) -> AppResult<u32> {
    // 校验 channels 表里的 chat_id 是否仍存在于 core
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let workspaces = state.db.list_workspaces().await?;
    let mut removed = 0u32;
    for ws in workspaces {
        let chans = state.db.list_channels(ws.id).await?;
        for ch in chans {
            let chat_id = deltachat::chat::ChatId::new(ch.chat_id);
            if Chat::load_from_db(&ctx, chat_id).await.is_err() {
                // 频道已不存在，从本地表删除
                let conn = state.db.conn.clone();
                let chat_id_i64 = ch.chat_id as i64;
                tokio::task::spawn_blocking(move || -> AppResult<()> {
                    let c = conn.blocking_lock();
                    c.execute("DELETE FROM channels WHERE chat_id = ?1", rusqlite::params![chat_id_i64])?;
                    Ok(())
                }).await??;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

// ── management commands (SP2 Task 2) ─────────────────────────────────────────
//
// API 签名已对照 core 源码核实:
//   chat::remove_contact_from_chat(&Context, ChatId, ContactId) -> Result<()>
//     (core 中无 leave_group 函数; 退群 = 移除 SELF, 与既有 leave_group 命令一致)
//   deltachat::securejoin::get_securejoin_qr(&Context, Option<ChatId>) -> Result<String>
//   deltachat::message::delete_msgs(&Context, &[MsgId]) -> Result<()>
//   ctx.set_config(Config::Displayname, Option<&str>) -> Result<()>
//   Accounts::select_account(&mut self, u32) — 无 unselect_account;
//     logout 通过清空 state.current_id 实现脱离当前账号 (Accounts 层选中状态
//     因 core 无公开 API 无法持久清空, 仅清内存).

#[tauri::command]
pub async fn update_workspace(
    state: State<'_, AppState>,
    id: i64,
    name: Option<String>,
    icon: Option<String>,
) -> AppResult<()> {
    state
        .db
        .update_workspace(id, name.as_deref(), icon.as_deref())
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    // leave 所有关联的 core chat (channels + master)
    let chans = state.db.list_channels(id).await?;
    for ch in chans {
        let _ = chat::remove_contact_from_chat(
            &ctx,
            deltachat::chat::ChatId::new(ch.chat_id),
            ContactId::SELF,
        )
        .await;
    }
    let wss = state.db.list_workspaces().await?;
    if let Some(ws) = wss.into_iter().find(|w| w.id == id) {
        let _ = chat::remove_contact_from_chat(
            &ctx,
            deltachat::chat::ChatId::new(ws.master_chat_id),
            ContactId::SELF,
        )
        .await;
    }
    // 删本地元数据
    state.db.delete_workspace_rows(id).await?;
    Ok(())
}

#[tauri::command]
pub async fn leave_workspace(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<()> {
    // leave 只删本地元数据, 不动 core chat (保留可重新加入)
    state.db.delete_workspace_rows(id).await?;
    Ok(())
}

#[tauri::command]
pub async fn update_channel(
    state: State<'_, AppState>,
    chat_id: u32,
    name: Option<String>,
    topic: Option<String>,
    category: Option<String>,
) -> AppResult<()> {
    state
        .db
        .update_channel(chat_id, name.as_deref(), topic.as_deref(), category.as_deref())
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_channel(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    chat::remove_contact_from_chat(
        &ctx,
        deltachat::chat::ChatId::new(chat_id),
        ContactId::SELF,
    )
    .await?;
    state.db.delete_channel_row(chat_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn leave_channel(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<()> {
    state.db.delete_channel_row(chat_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn update_profile(
    state: State<'_, AppState>,
    name: Option<String>,
    avatar_path: Option<String>, // None=不改, Some(path)=设置, Some("")=删除
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    if let Some(n) = name {
        ctx.set_config(Config::Displayname, Some(&n)).await?;
    }
    if let Some(ap) = avatar_path {
        let value = if ap.is_empty() { None } else { Some(ap.as_str()) };
        ctx.set_config(Config::Selfavatar, value).await?;
    }
    Ok(())
}

/// Task 13: 把前端 <input type="file"> 选中的字节写入临时文件,返回路径。
/// 然后前端用此路径调 update_profile({avatarPath: path}) 让 core 复制到 blobdir。
/// 不引入 tauri-plugin-dialog 依赖(避免 Cargo + capabilities 改动)。
#[tauri::command]
pub async fn save_avatar_from_bytes(bytes: Vec<u8>, ext: String) -> AppResult<String> {
    let dir = std::env::temp_dir().join("peytchat-avatars");
    tokio::fs::create_dir_all(&dir).await?;
    let safe_ext = ext.trim_start_matches('.').to_lowercase();
    let safe_ext = if safe_ext.is_empty() || !safe_ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        "png".to_string()
    } else {
        safe_ext
    };
    let filename = format!(
        "avatar-{}-{}.{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis(),
        safe_ext
    );
    let path = dir.join(filename);
    tokio::fs::write(&path, &bytes).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_my_qr(state: State<'_, AppState>) -> AppResult<String> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    // 传 None 返回个人 QR (verified: get_securejoin_qr(&Context, Option<ChatId>))
    let qr = securejoin::get_securejoin_qr(&ctx, None).await?;
    Ok(qr)
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> AppResult<()> {
    // stop_io 当前账号; clear 内存 current_id.
    // core Accounts 无 unselect_account 公开 API, select_account(0) 会因
    // "invalid account id" 失败, 故仅清内存层 (Accounts 持久选中状态保留).
    let accounts = state.accounts.lock().await;
    if let Some(id) = accounts.get_selected_account_id() {
        if let Some(ctx) = accounts.get_account(id) {
            ctx.stop_io().await;
        }
    }
    drop(accounts);
    *state.current_id.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn delete_msg(
    state: State<'_, AppState>,
    msg_id: u32,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    let ids = vec![MsgId::new(msg_id)];
    message::delete_msgs(&ctx, &ids).await?;
    Ok(())
}

/// 转发一条消息到目标会话 (保留原文、附件与引用信息)。
#[tauri::command]
pub async fn forward_msg(state: State<'_, AppState>, msg_id: u32, chat_id: u32) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    deltachat::chat::forward_msgs(
        &ctx,
        &[deltachat::message::MsgId::new(msg_id)],
        deltachat::chat::ChatId::new(chat_id),
    )
    .await?;
    Ok(())
}

// ── SP3 social entry commands ───────────────────────────────────────────────
//
// API 已对照 core 源码核实 (计划假设的 create_group_chat / create_by_contact_id
// 不存在; 实际为 chat::create_group 与 ChatId::create_for_contact):
//   chat::create_group(&Context, &str) -> Result<ChatId>          (chat.rs:3551)
//   ChatId::create_for_contact(&Context, ContactId) -> Result<ChatId>  (chat.rs:234)

/// Create a group chat (no members, no workspace association) — used by the
/// home "+" button's "创建群" entry. Returns the new chat id.
#[tauri::command]
pub async fn create_group_chat(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<u32> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    let chat_id = chat::create_group(&ctx, &name).await?;
    Ok(chat_id.to_u32())
}

/// Create a 1:1 chat with an existing contact (by contact_id). Used by the
/// member-detail "发消息" action. Returns the chat id.
#[tauri::command]
pub async fn create_chat_by_contact(
    state: State<'_, AppState>,
    contact_id: u32,
) -> AppResult<u32> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    let cid = ContactId::new(contact_id);
    let chat_id = deltachat::chat::ChatId::create_for_contact(&ctx, cid).await?;
    Ok(chat_id.to_u32())
}

// ── SP4 asset protocol ──────────────────────────────────────────────────────
//
// 将本地文件路径转为 webview 可访问的 `asset://localhost/<encoded>` URL，
// 用于加载 deltachat blobdir 中的头像/图片/文件附件。
//
// 注: brief 主方案 (`PathResolver::asset_protocol().get(path) -> Result<Url>`)
// 在已安装的 Tauri 2.11.5 中并不存在该方法 (经查 tauri-2.11.5/src/path/mod.rs
// `PathResolver` 只有 `resolve`/`parse`，无 `asset_protocol`)。按 brief 回退
// 条件改用简化方案: 直接拼 `asset://localhost/` + URL 编码的绝对路径。
// `assetProtocol.enable=true` 仍由 tauri.conf.json 配置 + Cargo.toml 的
// `protocol-asset` feature 满足 (tauri-build 校验)。

/// 将本地文件绝对路径转为 webview 可加载的 asset:// URL。
#[tauri::command]
pub async fn get_asset_url(path: String) -> AppResult<String> {
    let encoded = urlencoding::encode(&path);
    Ok(format!("asset://localhost/{}", encoded))
}

// ── SP4 cross-channel search ────────────────────────────────────────────────
//
// core 没有公开的 search_msgs API，采用 fallback：遍历 chatlist，每 chat 取最近
// 50 条消息做文本过滤，最多累计 30 条结果。与 brief Step 2 一致。

#[tauri::command]
pub async fn search_msgs(
    state: State<'_, AppState>,
    query: String,
    chat_id: Option<u32>,
) -> AppResult<Vec<SearchResultDto>> {
    let ctx = state
        .current()
        .await
        .ok_or(AppError::Core("no account".into()))?;
    let mut out: Vec<SearchResultDto> = Vec::new();
    // 会话内搜索(chat_id 传了):只查该会话最近 50 条;全局搜索:遍历 chatlist
    if let Some(tid) = chat_id.map(deltachat::chat::ChatId::new) {
        let chat = match Chat::load_from_db(&ctx, tid).await {
            Ok(c) => c,
            Err(_) => return Ok(out),
        };
        let chat_name = chat.get_name().to_string();
        let items = match chat::get_chat_msgs(&ctx, tid).await {
            Ok(v) => v,
            Err(_) => return Ok(out),
        };
        let recent: Vec<_> = items.into_iter().rev().take(50).collect();
        for item in recent {
            if let ChatItem::Message { msg_id } = item {
                let m = match Message::load_from_db(&ctx, msg_id).await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let text = m.get_text();
                if text.to_lowercase().contains(&query.to_lowercase()) {
                    let from_id = m.get_from_id();
                    let from_name = if from_id == ContactId::SELF {
                        "我".to_string()
                    } else {
                        Contact::get_by_id(&ctx, from_id)
                            .await
                            .map(|c| c.get_display_name().to_string())
                            .unwrap_or_default()
                    };
                    out.push(SearchResultDto {
                        msg_id: msg_id.to_u32(),
                        chat_id: tid.to_u32(),
                        chat_name: chat_name.clone(),
                        from_name,
                        text: text.chars().take(80).collect(),
                        ts: m.get_timestamp(),
                    });
                }
            }
        }
        return Ok(out);
    }
    let chatlist = Chatlist::try_load(&ctx, 0, None, None).await?;
    for i in 0..chatlist.len() {
        let chat_id = match chatlist.get_chat_id(i) {
            Ok(id) => id,
            Err(_) => continue,
        };
        let chat = match Chat::load_from_db(&ctx, chat_id).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        let chat_name = chat.get_name().to_string();
        let items = match chat::get_chat_msgs(&ctx, chat_id).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        // 只取最近 50 条做过滤（避免全量扫描）
        let recent: Vec<_> = items.into_iter().rev().take(50).collect();
        for item in recent {
            if let ChatItem::Message { msg_id } = item {
                let m = match Message::load_from_db(&ctx, msg_id).await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let text = m.get_text();
                if text.to_lowercase().contains(&query.to_lowercase()) {
                    let from_id = m.get_from_id();
                    let from_name = if from_id == ContactId::SELF {
                        "我".to_string()
                    } else {
                        Contact::get_by_id(&ctx, from_id)
                            .await
                            .map(|c| c.get_display_name().to_string())
                            .unwrap_or_default()
                    };
                    out.push(SearchResultDto {
                        msg_id: msg_id.to_u32(),
                        chat_id: chat_id.to_u32(),
                        chat_name: chat_name.clone(),
                        from_name,
                        text: text.chars().take(80).collect(),
                        ts: m.get_timestamp(),
                    });
                    if out.len() >= 30 {
                        break;
                    }
                }
            }
        }
        if out.len() >= 30 {
            break;
        }
    }
    Ok(out)
}

/// Debug 页: 遍历全部聊天, 收集所有消息, 按时间倒序分页返回原文。
/// 用 core 公开 API (Chatlist + get_chat_msgs), 不依赖 internals feature,
/// 避免改动 deltachat 编译特征触发 openssl 重编。
/// 先收集全部 (id, ts), 排序后再分页, 保证跨聊天全局时间序。
#[tauri::command]
pub async fn get_all_messages(
    state: State<'_, AppState>,
    cursor: Option<i64>, // 上一页最后一条的 ts; None = 第一页
    limit: Option<i64>,
) -> AppResult<Vec<RawMsgDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let limit = limit.unwrap_or(20).clamp(1, 100);

    // 1. 遍历所有聊天, 收集全部 (ts, msg_id) (load 一次拿时间戳, 供排序)
    let mut all: Vec<(i64, MsgId)> = Vec::new();
    let chatlist = Chatlist::try_load(&ctx, 0, None, None).await?;
    for i in 0..chatlist.len() {
        let chat_id = match chatlist.get_chat_id(i) {
            Ok(id) => id,
            Err(_) => continue,
        };
        let items = match chat::get_chat_msgs(&ctx, chat_id).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        for item in items {
            if let ChatItem::Message { msg_id } = item {
                if let Ok(m) = Message::load_from_db(&ctx, msg_id).await {
                    all.push((m.get_timestamp(), msg_id));
                }
            }
        }
    }

    // 2. 按 ts 倒序排序 (同 ts 按 id 倒序)
    all.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.to_u32().cmp(&a.1.to_u32())));

    // 3. 游标分页: 取 ts < cursor 的前 limit 条
    let mut out = Vec::with_capacity(limit as usize);
    for (ts, msg_id) in all {
        if let Some(c) = cursor {
            if ts >= c {
                continue;
            }
        }
        let m = match Message::load_from_db(&ctx, msg_id).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let from_id = m.get_from_id();
        let from_name = if from_id == ContactId::SELF {
            "我".to_string()
        } else {
            Contact::get_by_id(&ctx, from_id)
                .await
                .map(|c| c.get_display_name().to_string())
                .unwrap_or_default()
        };
        out.push(RawMsgDto {
            msg_id: msg_id.to_u32(),
            chat_id: m.get_chat_id().to_u32(),
            chat_name: chat_name(&ctx, m.get_chat_id()).await,
            from_name,
            is_out: matches!(
                m.get_state(),
                MessageState::OutDraft
                    | MessageState::OutPending
                    | MessageState::OutFailed
                    | MessageState::OutDelivered
                    | MessageState::OutMdnRcvd
            ),
            ts: m.get_timestamp(),
            view_type: viewtype_str(m.get_viewtype()).to_string(),
            text: m.get_text(),
        });
        if out.len() >= limit as usize {
            break;
        }
    }
    Ok(out)
}

async fn chat_name(ctx: &Context, chat_id: deltachat::chat::ChatId) -> String {
    Chat::load_from_db(ctx, chat_id)
        .await
        .map(|c| c.get_name().to_string())
        .unwrap_or_default()
}

/// 诊断: 返回 chatlist 原始内容 + 每个 chat 的 type/is_contact_request,
/// 用于排查 securejoin 会话为何不进侧栏。
#[tauri::command]
pub async fn debug_chatlist(state: State<'_, AppState>) -> AppResult<Vec<serde_json::Value>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let list = Chatlist::try_load(&ctx, 0, None, None).await?;
    let mut out = Vec::with_capacity(list.len());
    for i in 0..list.len() {
        let chat_id = list.get_chat_id(i)?;
        // 同 get_chatlist:跳过虚拟特殊会话(归档链接/ALLDONE 提示),db 无行
        if chat_id.is_archived_link() || chat_id.is_alldone_hint() {
            continue;
        }
        let chat = Chat::load_from_db(&ctx, chat_id).await?;
        out.push(serde_json::json!({
            "chat_id": chat_id.to_u32(),
            "name": chat.get_name(),
            "type": format!("{:?}", chat.get_type()),
            "is_contact_request": chat.is_contact_request(),
        }));
    }
    Ok(out)
}

// ── card commands ───────────────────────────────────────────────────────────

async fn row_to_card_dto(
    state: &State<'_, AppState>,
    row: (
        i64,
        i64,
        u32,
        Option<u32>,
        String,
        String,
        Option<String>,
        String,
        Option<u32>,
        Option<i64>,
        u32,
        i64,
        i64,
        i64,
        i64,
        Option<u32>,
    ),
) -> AppResult<CardDto> {
    let (
        id,
        workspace_id,
        channel_chat_id,
        msg_id,
        type_,
        title,
        description,
        status,
        assignee_contact_id,
        due_date,
        created_by,
        created_at,
        updated_at,
        position,
        _placeholder,
        source_msg_id,
    ) = row;
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    // 填充 assignee_name
    let assignee_name = if let Some(cid) = assignee_contact_id {
        Some(
            Contact::get_by_id(&ctx, ContactId::new(cid))
                .await?
                .get_display_name()
                .to_string(),
        )
    } else {
        None
    };
    // 填充 created_by_name
    let created_by_name = if created_by == 1 {
        // SELF
        ctx.get_config(Config::Displayname)
            .await?
            .unwrap_or_else(|| "我".to_string())
    } else {
        Contact::get_by_id(&ctx, ContactId::new(created_by))
            .await?
            .get_display_name()
            .to_string()
    };
    Ok(CardDto {
        id,
        workspace_id,
        channel_chat_id,
        msg_id,
        type_,
        title,
        description,
        status,
        assignee_contact_id,
        assignee_name,
        due_date,
        created_by,
        created_by_name,
        created_at,
        updated_at,
        position,
        source_msg_id,
    })
}

#[tauri::command]
pub async fn create_card(
    state: State<'_, AppState>,
    workspace_id: i64,
    chat_id: u32,
    type_: String,
    title: String,
    description: Option<String>,
    assignee_contact_id: Option<u32>,
    due_date: Option<i64>,
) -> AppResult<CardDto> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let now = chrono::Utc::now().timestamp();
    let created_by = ctx.get_id();

    // 1. 写本地 sqlite
    let card_id = state
        .db
        .insert_card(
            workspace_id,
            chat_id,
            &type_,
            &title,
            description.as_deref(),
            "todo",
            assignee_contact_id,
            due_date,
            created_by,
            now,
            None,
        )
        .await?;

    // 2. 构造 [PEYT] 信封 (card.create): 实体 id 暂用本地 card_id (UUID 迁移下一步)
    let assignee_addr = if let Some(cid) = assignee_contact_id {
        Contact::get_by_id(&ctx, ContactId::new(cid))
            .await?
            .get_addr()
            .to_string()
    } else {
        String::new()
    };
    let created_by_addr = Contact::get_by_id(&ctx, ContactId::SELF)
        .await?
        .get_addr()
        .to_string();
    // position 在 insert 后才有默认值, 重取一次
    let position = state
        .db
        .get_card_row(card_id)
        .await?
        .map(|r| r.13)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "id": card_id,
        "type": type_,
        "title": title,
        "status": "todo",
        "assignee_addr": assignee_addr,
        "due_date": due_date,
        "description": description,
        "created_by_addr": created_by_addr,
        "created_at": now,
        "updated_at": now,
        "position": position,
    });
    let msg_text = crate::envelope::build_envelope("card.create", payload)?;

    // 3. 发送到 deltachat
    let chat_id_dc = deltachat::chat::ChatId::new(chat_id);
    let mut msg = Message::new_text(msg_text);
    let sent_msg_id = chat::send_msg(&ctx, chat_id_dc, &mut msg).await?;

    // 4. 回填 msg_id
    state
        .db
        .set_card_msg_id(card_id, sent_msg_id.to_u32())
        .await?;

    // 5. 记录活动 (SP6)
    log_activity(
        &state,
        &ctx,
        workspace_id,
        Some(chat_id),
        "card_create",
        "card",
        card_id,
        Some(title.clone()),
    )
    .await;

    // 6. 返回 CardDto
    let row = state
        .db
        .get_card_row(card_id)
        .await?
        .ok_or_else(|| AppError::Core("card not found after insert".into()))?;
    row_to_card_dto(&state, row).await
}

#[tauri::command]
pub async fn update_card(
    state: State<'_, AppState>,
    card_id: i64,
    title: Option<String>,
    description: Clearable<String>,
    status: Option<String>,
    assignee_contact_id: Clearable<u32>,
    due_date: Clearable<i64>,
) -> AppResult<CardDto> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let now = chrono::Utc::now().timestamp();

    // Unwrap Clearable → Option<Option<T>> for db layer
    let description: Option<Option<String>> = description.0;
    let assignee_contact_id: Option<Option<u32>> = assignee_contact_id.0;
    let due_date: Option<Option<i64>> = due_date.0;

    state
        .db
        .update_card_fields(
            card_id,
            title.as_deref(),
            description.as_ref().map(|d| d.as_deref()),
            status.as_deref(),
            assignee_contact_id,
            due_date,
            now,
        )
        .await?;

    // 发送更新消息(供其他设备同步)
    let row = state
        .db
        .get_card_row(card_id)
        .await?
        .ok_or_else(|| AppError::Core("card not found".into()))?;
    let assignee_addr = if let Some(cid) = row.8 {
        Contact::get_by_id(&ctx, ContactId::new(cid))
            .await?
            .get_addr()
            .to_string()
    } else {
        String::new()
    };
    let payload = serde_json::json!({
        "id": card_id,
        "type": row.4,
        "title": row.5,
        "status": row.7,
        "assignee_addr": assignee_addr,
        "due_date": row.9,
        "description": row.6,
        "created_at": row.11,
        "updated_at": row.12,
        "position": row.13,
    });
    let msg_text = crate::envelope::build_envelope("card.update", payload)?;
    let chat_id_dc = deltachat::chat::ChatId::new(row.2);
    let mut msg = Message::new_text(msg_text);
    let _ = chat::send_msg(&ctx, chat_id_dc, &mut msg).await;

    // 记录活动 (SP6): payload 为变更字段后的快照
    let activity_payload = serde_json::json!({
        "title": row.5,
        "status": row.7,
        "description": row.6,
        "assignee_contact_id": row.8,
        "due_date": row.9,
    })
    .to_string();
    let card_workspace_id = row.1;
    let card_channel_chat_id = row.2;
    log_activity(
        &state,
        &ctx,
        card_workspace_id,
        Some(card_channel_chat_id),
        "card_update",
        "card",
        card_id,
        Some(activity_payload),
    )
    .await;

    row_to_card_dto(&state, row).await
}

#[tauri::command]
pub async fn delete_card(state: State<'_, AppState>, card_id: i64) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    // 先取 row 用于发删除消息
    let row = state.db.get_card_row(card_id).await?;
    state.db.delete_card(card_id).await?;
    if let Some(r) = row {
        let payload = serde_json::json!({
            "id": card_id,
            "title": r.5,
            "created_at": r.11,
        });
        let msg_text = crate::envelope::build_envelope("card.delete", payload)?;
        let chat_id_dc = deltachat::chat::ChatId::new(r.2);
        let mut msg = Message::new_text(msg_text);
        let _ = chat::send_msg(&ctx, chat_id_dc, &mut msg).await;

        // 记录活动 (SP6)
        log_activity(
            &state,
            &ctx,
            r.1,
            Some(r.2),
            "card_delete",
            "card",
            card_id,
            None,
        )
        .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_cards(
    state: State<'_, AppState>,
    workspace_id: i64,
    chat_id: u32,
) -> AppResult<Vec<CardDto>> {
    let rows = state.db.list_cards(workspace_id, chat_id).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(row_to_card_dto(&state, row).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_card(state: State<'_, AppState>, card_id: i64) -> AppResult<CardDto> {
    let row = state
        .db
        .get_card_row(card_id)
        .await?
        .ok_or_else(|| AppError::Core("card not found".into()))?;
    row_to_card_dto(&state, row).await
}

// ── SP5 Task 3: card sync commands ──────────────────────────────────────────
//
// upsert_card_from_msg: 由 [CARD] 同步消息驱动, 根据 action(create/update/delete)
//   + 去重查找决定 upsert / delete, 实现多设备 Card 同步。供 Task 10 调用。
// message_to_card: 把一条普通消息"转为"Card — 本地建卡 + 发送 [CARD] 同步消息。
//   供 Task 9 前端调用。
//
// API 注意: brief 中的 `Contact::lookup_by_addr` 不存在, 实际 API 为
//   `Contact::lookup_id_by_addr(&Context, &str, Origin) -> Result<Option<ContactId>>`
// 空地址会 bail!, 所以必须先 is_empty() 检查。

#[tauri::command]
pub async fn upsert_card_from_msg(
    state: State<'_, AppState>,
    msg_id: u32,
    card_json: String,
) -> AppResult<Option<CardDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let payload: serde_json::Value = serde_json::from_str(&card_json)
        .map_err(|e| AppError::Core(format!("invalid card json: {e}")))?;

    let action = payload["action"].as_str().unwrap_or("create");
    let title = payload["title"].as_str().unwrap_or("");
    let created_at = payload["created_at"].as_i64().unwrap_or(0);

    // 从 msg_id 反查 chat_id
    let msg = Message::load_from_db(&ctx, MsgId::new(msg_id)).await?;
    let channel_chat_id = msg.get_chat_id().to_u32();

    // 查 workspace_id: 通过 channel_chat_id 找 channels 表
    let workspace_id = state.db.get_channel_workspace_id(channel_chat_id).await?;

    // 去重查找
    let existing = state
        .db
        .find_card_by_dedup(channel_chat_id, title, created_at)
        .await?;

    match (action, existing) {
        ("delete", Some(id)) => {
            state.db.delete_card(id).await?;
            Ok(None)
        }
        ("delete", None) => Ok(None),
        (_, Some(id)) => {
            // 更新
            let now = chrono::Utc::now().timestamp();
            let status = payload["status"].as_str();
            let description = payload["description"].as_str();
            let due_date = payload["due_date"].as_i64();
            // assignee 映射
            let assignee_cid = if let Some(addr) = payload["assignee_addr"].as_str() {
                if addr.is_empty() {
                    None
                } else {
                    Contact::lookup_id_by_addr(
                        &ctx,
                        addr,
                        deltachat::contact::Origin::Unknown,
                    )
                    .await?
                    .map(|c| c.to_u32())
                }
            } else {
                None
            };
            state
                .db
                .update_card_fields(
                    id,
                    None,
                    description.map(|d| Some(d)),
                    status,
                    Some(assignee_cid),
                    Some(due_date),
                    now,
                )
                .await?;
            let row = state.db.get_card_row(id).await?.unwrap();
            Ok(Some(row_to_card_dto(&state, row).await?))
        }
        (_, None) => {
            // 新建
            let type_ = payload["type"].as_str().unwrap_or("card");
            let status = payload["status"].as_str().unwrap_or("todo");
            let description = payload["description"].as_str();
            let due_date = payload["due_date"].as_i64();
            let assignee_cid = if let Some(addr) = payload["assignee_addr"].as_str() {
                if addr.is_empty() {
                    None
                } else {
                    Contact::lookup_id_by_addr(
                        &ctx,
                        addr,
                        deltachat::contact::Origin::Unknown,
                    )
                    .await?
                    .map(|c| c.to_u32())
                }
            } else {
                None
            };
            let created_by = if let Some(addr) = payload["created_by_addr"].as_str() {
                if addr.is_empty() {
                    ContactId::SELF.to_u32()
                } else {
                    Contact::lookup_id_by_addr(
                        &ctx,
                        addr,
                        deltachat::contact::Origin::Unknown,
                    )
                    .await?
                    .unwrap_or(ContactId::SELF)
                    .to_u32()
                }
            } else {
                ContactId::SELF.to_u32()
            };
            let card_id = state
                .db
                .insert_card(
                    workspace_id,
                    channel_chat_id,
                    type_,
                    title,
                    description,
                    status,
                    assignee_cid,
                    due_date,
                    created_by,
                    created_at,
                    Some(msg_id),
                )
                .await?;
            state.db.set_card_msg_id(card_id, msg_id).await?;
            let row = state.db.get_card_row(card_id).await?.unwrap();
            Ok(Some(row_to_card_dto(&state, row).await?))
        }
    }
}

#[tauri::command]
pub async fn message_to_card(
    state: State<'_, AppState>,
    msg_id: u32,
    workspace_id: i64,
    chat_id: u32,
    type_: String,
    title: Option<String>,
) -> AppResult<CardDto> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    // 取消息文本作为默认 title (UTF-8 安全截断)
    let msg = Message::load_from_db(&ctx, MsgId::new(msg_id)).await?;
    let title = title.unwrap_or_else(|| {
        let text = msg.get_text();
        if text.chars().count() > 40 {
            let truncated: String = text.chars().take(40).collect();
            format!("{}...", truncated)
        } else {
            text
        }
    });
    let now = chrono::Utc::now().timestamp();
    let created_by = ctx.get_id();

    let card_id = state
        .db
        .insert_card(
            workspace_id,
            chat_id,
            &type_,
            &title,
            None,
            "todo",
            None,
            None,
            created_by,
            now,
            Some(msg_id),
        )
        .await?;

    // 发送同步消息 (card.create 信封)
    let created_by_addr = Contact::get_by_id(&ctx, ContactId::SELF)
        .await?
        .get_addr()
        .to_string();
    let position = state
        .db
        .get_card_row(card_id)
        .await?
        .map(|r| r.13)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "id": card_id,
        "type": type_,
        "title": title,
        "status": "todo",
        "assignee_addr": "",
        "due_date": null,
        "description": null,
        "created_by_addr": created_by_addr,
        "created_at": now,
        "updated_at": now,
        "position": position,
        "source_msg_id": msg_id,
    });
    let msg_text = crate::envelope::build_envelope("card.create", payload)?;
    let chat_id_dc = deltachat::chat::ChatId::new(chat_id);
    let mut sync_msg = Message::new_text(msg_text);
    let sent_msg_id = chat::send_msg(&ctx, chat_id_dc, &mut sync_msg).await?;
    state.db.set_card_msg_id(card_id, sent_msg_id.to_u32()).await?;

    // 记录活动 (SP6)
    log_activity(
        &state,
        &ctx,
        workspace_id,
        Some(chat_id),
        "message_to_card",
        "card",
        card_id,
        None,
    )
    .await;

    let row = state.db.get_card_row(card_id).await?.unwrap();
    row_to_card_dto(&state, row).await
}

#[tauri::command]
pub async fn update_channel_space_type(
    state: State<'_, AppState>,
    chat_id: u32,
    space_type: String,
) -> AppResult<()> {
    state.db.set_channel_space_type(chat_id, &space_type).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_channel_space_type(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<Option<String>> {
    state.db.get_channel_space_type(chat_id).await
}

// ── PEYT Studio 默认团队空间 ────────────────────────────────────────────────
//
// 目标: 所有团队成员登录后默认进入 "PEYT Studio" workspace,无需手动创建。
// 机制:
//   - 首人登录: ensure_peyt_studio 检测本地无 PEYT Studio → 创建 workspace
//     (master 群=公告频道) + 闲聊频道 + 工作频道 → 在 master 群发送
//     [PEYT_INVITE] JSON (含闲聊/工作群的 securejoin QR) → 返回 founder + invite_qr
//   - 后续成员: 扫描 invite_qr → join_peyt_studio → securejoin master 群 →
//     本地创建 workspace → 监听 IncomingMsg 检测 [PEYT_INVITE] → 自动 securejoin
//     其他群并 insert_channel
//   - 已存在: ensure_peyt_studio 直接返回 existing

const PEYT_STUDIO_NAME: &str = "PEYT Studio";

#[tauri::command]
pub async fn ensure_peyt_studio(state: State<'_, AppState>) -> AppResult<PeytStudioDto> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    // 根治「Provider requires E2EE」死锁(boot 必经,老账号也生效):
    // chatmail core 默认 force_encryption=1,新会话无对方公钥时首条明文被禁 → Autocrypt 死锁。
    // 桌面端恢复 Delta 标准流程(首条明文带公钥 → 自动升级加密)。
    let _ = ctx.set_config(Config::ForceEncryption, Some("0")).await;
    // 1. 检测本地是否已有 PEYT Studio workspace (按 name 匹配)
    let workspaces = state.db.list_workspaces().await?;
    if let Some(ws) = workspaces.into_iter().find(|w| w.name == PEYT_STUDIO_NAME) {
        return Ok(PeytStudioDto {
            workspace: ws,
            role: "existing".into(),
            invite_qr: None,
        });
    }
    // 2. 首人创建: master 群 (公告频道)
    let master_chat_id = chat::create_group(&ctx, PEYT_STUDIO_NAME).await?;
    let master_u32 = master_chat_id.to_u32();
    let icon = Some("P".to_string());
    let ws_id = state.db.insert_workspace(PEYT_STUDIO_NAME, master_u32, icon.as_deref()).await?;
    // 3. 创建闲聊频道 + 工作频道
    let general_chat = chat::create_group(&ctx, "闲聊").await?;
    let general_u32 = general_chat.to_u32();
    state.db.insert_channel(ws_id, general_u32, "闲聊", "General", 0).await?;
    let work_chat = chat::create_group(&ctx, "工作").await?;
    let work_u32 = work_chat.to_u32();
    state.db.insert_channel(ws_id, work_u32, "工作", "General", 1).await?;
    // 工作频道设为 card 类型 (看板)
    state.db.set_channel_space_type(work_u32, "card").await?;
    // 4. 默认 core role
    let _ = state.db.insert_role(ws_id, "core", None).await?;
    // 5. 在 master 群发送欢迎指引
    let welcome = "👋 欢迎来到 PEYT Studio\n\n这是团队的默认协作空间。\n• 公告频道: 团队通知发布\n• 闲聊频道: 日常交流\n• 工作频道: 任务看板协作\n\n点击右上角头像可切换主题,左下角 + 可创建更多 workspace。";
    let _ = chat::send_text_msg(&ctx, master_chat_id, welcome.to_string()).await?;
    // 6. 在 master 群发送 project.invite 信封,包含其他频道 QR,供新成员自动加入
    let general_qr = securejoin::get_securejoin_qr(&ctx, Some(general_chat)).await.unwrap_or_default();
    let work_qr = securejoin::get_securejoin_qr(&ctx, Some(work_chat)).await.unwrap_or_default();
    let invite_payload = crate::envelope::build_envelope(
        "project.invite",
        serde_json::json!({
            "general_qr": general_qr,
            "work_qr": work_qr,
        }),
    )?;
    let _ = chat::send_text_msg(&ctx, master_chat_id, invite_payload).await?;
    // 7. 生成 master 群的 SecureJoin QR 供首人分享
    let invite_qr = securejoin::get_securejoin_qr(&ctx, Some(master_chat_id)).await?;
    let ws = state.db.find_workspace_by_master_chat(master_u32).await?
        .ok_or(AppError::Core("workspace not found after insert".into()))?;
    Ok(PeytStudioDto {
        workspace: ws,
        role: "founder".into(),
        invite_qr: Some(invite_qr),
    })
}

#[tauri::command]
pub async fn join_peyt_studio(state: State<'_, AppState>, qr: String) -> AppResult<PeytStudioDto> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    // securejoin 加入 master 群 (公告频道)
    let chat_id = securejoin::join_securejoin(&ctx, &qr).await?;
    let master_u32 = chat_id.to_u32();
    // 幂等: 已存在则返回
    if let Some(existing) = state.db.find_workspace_by_master_chat(master_u32).await? {
        return Ok(PeytStudioDto {
            workspace: existing,
            role: "existing".into(),
            invite_qr: None,
        });
    }
    // 本地创建 workspace (master = 公告群)
    let ws_id = state.db.insert_workspace(PEYT_STUDIO_NAME, master_u32, Some("P")).await?;
    let _ = state.db.insert_role(ws_id, "core", None).await?;
    let ws = state.db.find_workspace_by_master_chat(master_u32).await?
        .ok_or(AppError::Core("workspace not found after insert".into()))?;
    // 注意: 其他频道 (闲聊/工作) 通过监听 [PEYT_INVITE] 消息自动加入,
    //       见前端 shell.js handleIncomingMsg 的 PEYT_INVITE 分支。
    Ok(PeytStudioDto {
        workspace: ws,
        role: "member".into(),
        invite_qr: None,
    })
}

/// 由前端在解析到 [PEYT_INVITE] 消息后调用: 依次 securejoin 闲聊/工作群,
/// 并 insert_channel 关联到指定 workspace。已加入的群 securejoin 会幂等返回 chat_id。
#[tauri::command]
pub async fn join_peyt_channel(
    state: State<'_, AppState>,
    workspace_id: i64,
    qr: String,
    name: String,
    category: String,
    space_type: Option<String>,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = securejoin::join_securejoin(&ctx, &qr).await?;
    let chat_u32 = chat_id.to_u32();
    // 幂等: 已关联则跳过
    let chans = state.db.list_channels(workspace_id).await?;
    if chans.iter().any(|c| c.chat_id == chat_u32) {
        return Ok(chat_u32);
    }
    state.db.insert_channel(workspace_id, chat_u32, &name, &category, 0).await?;
    if let Some(st) = space_type {
        state.db.set_channel_space_type(chat_u32, &st).await?;
    }
    Ok(chat_u32)
}

// ── Plugin Commands ──────────────────────────────────────────────────

#[tauri::command]
pub async fn fetch_registry(state: State<'_, AppState>) -> AppResult<Vec<RegistryPlugin>> {
    state.plugins.fetch_registry().await
}

#[tauri::command]
pub async fn install_plugin(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<RegistryPlugin> {
    state.plugins.install_plugin(&name).await
}

#[tauri::command]
pub async fn install_plugin_from_zip(
    state: State<'_, AppState>,
    data_base64: String,
) -> AppResult<RegistryPlugin> {
    state.plugins.install_plugin_from_zip(&data_base64)
}

#[tauri::command]
pub async fn uninstall_plugin(state: State<'_, AppState>, name: String) -> AppResult<()> {
    state.plugins.uninstall_plugin(&name)
}

#[tauri::command]
pub async fn list_plugins(state: State<'_, AppState>) -> AppResult<Vec<PluginStatus>> {
    state.plugins.list_plugins()
}

#[tauri::command]
pub async fn toggle_plugin(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> AppResult<()> {
    state.plugins.toggle_plugin(&name, enabled)
}

#[tauri::command]
pub async fn get_plugin_js(state: State<'_, AppState>, name: String) -> AppResult<String> {
    state.plugins.get_plugin_js(&name)
}

// ── SP6: Inbox + Activity ───────────────────────────────────────────────────
//
// 系统当前为单 workspace (PEYT Studio), workspace_id 通过 current_workspace_id
// 从 state.db 解析 (优先匹配 PEYT Studio, 否则取首条)。
// actor 信息: 注入式 activity 由本机账号产生 → actor_id = ctx.get_id(),
// actor_name = Displayname (无则 "self")。失败不阻断主操作 (best-effort)。

/// 解析当前 workspace_id (单 workspace 系统: 优先 PEYT Studio, 否则取首条)。
async fn current_workspace_id(state: &State<'_, AppState>) -> AppResult<i64> {
    let workspaces = state.db.list_workspaces().await?;
    workspaces
        .iter()
        .find(|w| w.name == PEYT_STUDIO_NAME)
        .or_else(|| workspaces.first())
        .map(|w| w.id)
        .ok_or_else(|| AppError::Core("no workspace".into()))
}

/// 记录一条活动 (best-effort: 失败仅吞掉, 不阻断主操作)。
async fn log_activity(
    state: &State<'_, AppState>,
    ctx: &deltachat::context::Context,
    workspace_id: i64,
    channel_chat_id: Option<u32>,
    action: &str,
    target_type: &str,
    target_id: i64,
    payload: Option<String>,
) {
    let actor_id = ctx.get_id() as i64;
    let actor_name = ctx
        .get_config(Config::Displayname)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "self".to_string());
    let _ = state
        .db
        .record_activity(
            workspace_id,
            channel_chat_id.map(|c| c as i64),
            actor_id,
            &actor_name,
            action,
            target_type,
            target_id,
            payload.as_deref(),
        )
        .await;
}

#[tauri::command]
pub async fn list_inbox_events(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<InboxEventDto>> {
    let workspace_id = current_workspace_id(&state).await?;
    let limit = limit.unwrap_or(100);
    Ok(state.db.list_inbox_events(workspace_id, limit).await?)
}

#[tauri::command]
pub async fn mark_inbox_read(state: State<'_, AppState>, event_id: i64) -> AppResult<()> {
    state.db.mark_inbox_read(event_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn mark_all_inbox_read(state: State<'_, AppState>) -> AppResult<()> {
    let workspace_id = current_workspace_id(&state).await?;
    state.db.mark_all_inbox_read(workspace_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_inbox_unread_count(state: State<'_, AppState>) -> AppResult<i64> {
    let workspace_id = current_workspace_id(&state).await?;
    Ok(state.db.get_inbox_unread_count(workspace_id).await?)
}

#[tauri::command]
pub async fn list_activities(
    state: State<'_, AppState>,
    channel_chat_id: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<ActivityDto>> {
    let workspace_id = current_workspace_id(&state).await?;
    let limit = limit.unwrap_or(100);
    Ok(state
        .db
        .list_activities(workspace_id, channel_chat_id, limit)
        .await?)
}

/// 供前端 shell.ts 在收到 @提及 / 回复 / 卡片分配消息时调用, 写入 inbox_events。
#[tauri::command]
pub async fn record_inbox_event(
    state: State<'_, AppState>,
    event_type: String,
    source_chat_id: i64,
    msg_id: Option<i64>,
    actor_id: i64,
    actor_name: String,
    summary: String,
) -> AppResult<()> {
    let workspace_id = current_workspace_id(&state).await?;
    state
        .db
        .record_inbox_event(
            workspace_id,
            &event_type,
            source_chat_id,
            msg_id,
            actor_id,
            &actor_name,
            &summary,
        )
        .await?;
    Ok(())
}

// ==== Delta 对齐批次 1 ====

/// 归档/取消归档会话。core 2.58 的 ChatId::set_visibility。
#[tauri::command]
pub async fn archive_chat(
    state: State<'_, AppState>,
    chat_id: u32,
    archive: bool,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let visibility = if archive {
        ChatVisibility::Archived
    } else {
        ChatVisibility::Normal
    };
    chat_id.set_visibility(&ctx, visibility).await?;
    Ok(())
}

/// 静音/取消静音会话。muted=true → MuteDuration::Forever;false → NotMuted。
#[tauri::command]
pub async fn set_chat_muted(
    state: State<'_, AppState>,
    chat_id: u32,
    muted: bool,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let duration = if muted {
        deltachat::chat::MuteDuration::Forever
    } else {
        deltachat::chat::MuteDuration::NotMuted
    };
    chat::set_muted(&ctx, deltachat::chat::ChatId::new(chat_id), duration).await?;
    Ok(())
}

/// 置顶/取消置顶会话。pinned=true → ChatVisibility::Pinned;false → Normal。
#[tauri::command]
pub async fn set_chat_pinned(
    state: State<'_, AppState>,
    chat_id: u32,
    pinned: bool,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let visibility = if pinned {
        ChatVisibility::Pinned
    } else {
        ChatVisibility::Normal
    };
    deltachat::chat::ChatId::new(chat_id)
        .set_visibility(&ctx, visibility)
        .await?;
    Ok(())
}

/// 保存消息到 "Saved Messages"（self-talk 会话）。
#[tauri::command]
pub async fn save_msg(state: State<'_, AppState>, msg_id: u32) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    chat::save_msgs(&ctx, &[MsgId::new(msg_id)]).await?;
    Ok(())
}

/// 取消保存消息（删除 saved 副本）。
#[tauri::command]
pub async fn unsave_msg(state: State<'_, AppState>, msg_id: u32) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    message::delete_msgs(&ctx, &[MsgId::new(msg_id)]).await?;
    Ok(())
}

/// 读取会话草稿文本。core 2.58 的 ChatId::get_draft。
#[tauri::command]
pub async fn get_draft(state: State<'_, AppState>, chat_id: u32) -> AppResult<Option<String>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let draft = chat_id.get_draft(&ctx).await?;
    Ok(draft.map(|m| m.get_text().to_string()))
}

/// 设置会话草稿。空文本 = 清除草稿。
#[tauri::command]
pub async fn set_draft(
    state: State<'_, AppState>,
    chat_id: u32,
    text: String,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    if text.trim().is_empty() {
        chat_id.set_draft(&ctx, None).await?;
    } else {
        let mut draft = Message::new_text(text);
        chat_id.set_draft(&ctx, Some(&mut draft)).await?;
    }
    Ok(())
}

// ==== Delta 对齐批次 2 ====

/// 会话内媒体列表:拉 get_chat_msgs 后按 view_type 过滤。
/// view_type 传 'Image'|'Video'|'Audio'|'File'|None=全部。
#[tauri::command]
pub async fn get_chat_media(
    state: State<'_, AppState>,
    chat_id: u32,
    view_type: Option<String>,
) -> AppResult<Vec<MsgDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let items = chat::get_chat_msgs(&ctx, chat_id).await?;
    let mut out = Vec::new();
    for item in items {
        if let ChatItem::Message { msg_id } = item {
            let m = match message::Message::load_from_db(&ctx, msg_id).await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let vt = m.get_viewtype();
            // 按过滤:view_type 未指定(全部)或匹配
            let keep = match view_type.as_deref() {
                None => true,
                Some("Image") => vt == Viewtype::Image || vt == Viewtype::Gif,
                Some("Video") => vt == Viewtype::Video,
                Some("Audio") => vt == Viewtype::Audio || vt == Viewtype::Voice,
                Some("File") => vt == Viewtype::File,
                _ => true,
            };
            if !keep { continue; }
            let from_id = m.get_from_id();
            let from_name = if from_id == deltachat::contact::ContactId::SELF {
                "我".to_string()
            } else {
                Contact::get_by_id(&ctx, from_id)
                    .await?
                    .get_display_name()
                    .to_string()
            };
            let (quote_from, quote_text) = match m.quoted_message(&ctx).await? {
                Some(q) => {
                    let q_from_id = q.get_from_id();
                    let q_name = if q_from_id == deltachat::contact::ContactId::SELF {
                        "我".to_string()
                    } else {
                        Contact::get_by_id(&ctx, q_from_id)
                            .await?
                            .get_display_name()
                            .to_string()
                    };
                    (Some(q_name), Some(q.get_text()))
                }
                None => (None, None),
            };
            let file_path = m.get_file(&ctx).map(|p| p.to_string_lossy().to_string());
            let file_name = m.get_filename();
            let file_mime = m.get_filemime();
            let file_bytes = m.get_filebytes(&ctx).await.unwrap_or(None);
            let width = m.get_width();
            let height = m.get_height();
            let view_type_str = viewtype_str(vt).to_string();
            let download_state = download_state_str(m.download_state()).to_string();
            let subject = {
                let s = m.get_subject();
                if s.is_empty() { None } else { Some(s.to_string()) }
            };
            out.push(MsgDto {
                msg_id: msg_id.to_u32(),
                from_id: from_id.to_u32(),
                from_name,
                text: m.get_text(),
                ts: m.get_timestamp(),
                is_out: m.get_state().is_outgoing(),
                state: state_str(m.get_state()).to_string(),
                quote_from,
                quote_text,
                view_type: view_type_str,
                file: file_path,
                file_name,
                file_mime,
                file_bytes,
                width: if width > 0 { Some(width) } else { None },
                height: if height > 0 { Some(height) } else { None },
                download_state,
                subject,
            });
        }
    }
    Ok(out)
}

/// 广播消息已读回执计数。
#[tauri::command]
pub async fn get_message_read_receipt_count(
    state: State<'_, AppState>,
    msg_id: u32,
) -> AppResult<u32> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let count = message::get_msg_read_receipt_count(&ctx, MsgId::new(msg_id)).await?;
    Ok(count as u32)
}

// ==== 屏蔽列表 / 取消屏蔽 (Delta UnblockContacts) ====

/// 列出被屏蔽的联系人。
#[tauri::command]
pub async fn get_blocked_contacts(state: State<'_, AppState>) -> AppResult<Vec<ContactDto>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let ids = Contact::get_all_blocked(&ctx).await?;
    let mut out = Vec::new();
    for id in ids {
        let c = Contact::get_by_id(&ctx, id).await?;
        let avatar = c
            .get_profile_image(&ctx)
            .await?
            .map(|p| p.to_string_lossy().to_string());
        let color = Some(c.get_color());
        out.push(ContactDto {
            id: id.to_u32(),
            name: c.get_display_name().to_string(),
            addr: c.get_addr().to_string(),
            avatar,
            color,
        });
    }
    Ok(out)
}

/// 取消屏蔽联系人。
#[tauri::command]
pub async fn unblock_contact(state: State<'_, AppState>, contact_id: u32) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    Contact::unblock(&ctx, ContactId::new(contact_id)).await?;
    Ok(())
}

// ==== Delta 对齐批次 3 ====

/// 发送语音消息:前端 MediaRecorder 录制的 WebM/Opus base64。
#[tauri::command]
pub async fn send_voice(
    state: State<'_, AppState>,
    chat_id: u32,
    base64: String,
) -> AppResult<u32> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| AppError::Core(format!("base64 decode: {e}")))?;
    let mut msg = Message::new(Viewtype::Voice);
    msg.set_file_from_bytes(&ctx, "voice.webm", &bytes, Some("audio/webm"))?;
    let msg_id = chat::send_msg(&ctx, chat_id, &mut msg).await?;
    Ok(msg_id.to_u32())
}

/// 获取 webxdc 应用信息(名称/文档/摘要)。
#[tauri::command]
pub async fn get_webxdc_info(
    state: State<'_, AppState>,
    msg_id: u32,
) -> AppResult<serde_json::Value> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let m = Message::load_from_db(&ctx, MsgId::new(msg_id)).await?;
    let info = m.get_webxdc_info(&ctx).await?;
    Ok(serde_json::json!({
        "name": info.name,
        "document": info.document,
        "summary": info.summary,
    }))
}

/// 获取 webxdc 状态更新(serial > last_known_serial)。
/// core 返回 JSON 字符串,这里解析为数组返回,前端直接消费。
#[tauri::command]
pub async fn get_webxdc_status_updates(
    state: State<'_, AppState>,
    msg_id: u32,
    last_known_serial: Option<i64>,
) -> AppResult<Vec<serde_json::Value>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let serial = last_known_serial.unwrap_or(0) as u32;
    let json = ctx
        .get_webxdc_status_updates(MsgId::new(msg_id), deltachat::webxdc::StatusUpdateSerial::new(serial))
        .await?;
    let updates: Vec<serde_json::Value> = serde_json::from_str(&json)
        .unwrap_or_default();
    Ok(updates)
}

/// 发送 webxdc 状态更新。
#[tauri::command]
pub async fn send_webxdc_status_update(
    state: State<'_, AppState>,
    msg_id: u32,
    payload: String,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    ctx.send_webxdc_status_update(MsgId::new(msg_id), &payload)
        .await?;
    Ok(())
}

/// 从 webxdc 消息的 zip 中读取指定文件, 写入临时文件并返回路径,
/// 供前端 `convertFileSrc` 加载 (与 save_avatar_from_bytes 同理)。
#[tauri::command]
pub async fn get_webxdc_blob(
    state: State<'_, AppState>,
    msg_id: u32,
    name: String,
) -> AppResult<String> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let m = deltachat::message::Message::load_from_db(&ctx, MsgId::new(msg_id)).await?;
    let bytes = m
        .get_webxdc_blob(&ctx, &name)
        .await
        .map_err(|e| AppError::Core(format!("webxdc blob: {e}")))?;
    let dir = std::env::temp_dir().join("peytchat-webxdc");
    tokio::fs::create_dir_all(&dir).await?;
    let sanitized: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '_' })
        .collect();
    let sanitized = if sanitized.is_empty() {
        "blob".to_string()
    } else {
        sanitized
    };
    let filename = format!(
        "w-{}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis(),
        sanitized
    );
    let path = dir.join(filename);
    tokio::fs::write(&path, &bytes).await?;
    Ok(path.to_string_lossy().to_string())
}

// ==== Delta 对齐批次 4 ====

/// 应用数据目录(供导出路径/备份默认目录)。
#[tauri::command]
pub fn get_appdata_dir(state: State<'_, AppState>) -> AppResult<String> {
    Ok(state.data_dir.to_string_lossy().to_string())
}

/// 导出本机密钥(多设备绑定:第二台设备导入)。
#[tauri::command]
pub async fn export_self_keys(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    deltachat::imex::imex(
        &ctx,
        deltachat::imex::ImexMode::ExportSelfKeys,
        std::path::Path::new(&path),
        None,
    )
    .await?;
    Ok(())
}

/// 导入密钥(第二台设备登录同一账号)。
#[tauri::command]
pub async fn import_self_keys(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    deltachat::imex::imex(
        &ctx,
        deltachat::imex::ImexMode::ImportSelfKeys,
        std::path::Path::new(&path),
        None,
    )
    .await?;
    Ok(())
}

/// 导出加密备份(带密码)。
#[tauri::command]
pub async fn export_backup(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    deltachat::imex::imex(
        &ctx,
        deltachat::imex::ImexMode::ExportBackup,
        std::path::Path::new(&path),
        Some(passphrase),
    )
    .await?;
    Ok(())
}

/// 导入备份(迁移)。
#[tauri::command]
pub async fn import_backup(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    deltachat::imex::imex(
        &ctx,
        deltachat::imex::ImexMode::ImportBackup,
        std::path::Path::new(&path),
        Some(passphrase),
    )
    .await?;
    Ok(())
}

/// 联系人加密信息(指纹/状态文本)。供保护状态对话框。
#[tauri::command]
pub async fn get_contact_encryption_info(
    state: State<'_, AppState>,
    contact_id: u32,
) -> AppResult<String> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let info = Contact::get_encrinfo(&ctx, ContactId::new(contact_id)).await?;
    Ok(info)
}

/// 会话级加密信息(对齐 core ChatId::get_encryption_info / Delta getChatEncryptionInfo)。
/// 群聊含全部非特殊成员指纹;未加密时返回 stock 提示文案。
#[tauri::command]
pub async fn get_chat_encryption_info(
    state: State<'_, AppState>,
    chat_id: u32,
) -> AppResult<String> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let info = deltachat::chat::ChatId::new(chat_id).get_encryption_info(&ctx).await?;
    Ok(info)
}

/// 自己的加密信息(SELF 是 special contact, Contact::get_encrinfo 拒绝 → 单独构造)。
/// 返回 "我 (addr)\n指纹" 或空串(尚未生成密钥)。
#[tauri::command]
pub async fn get_self_encryption_info(state: State<'_, AppState>) -> AppResult<String> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let c = Contact::get_by_id(&ctx, ContactId::SELF).await?;
    let addr = ctx
        .get_config(Config::ConfiguredAddr)
        .await?
        .unwrap_or_default();
    match c.fingerprint() {
        Some(fpr) => Ok(format!("我 ({addr})\n{}", fpr.human_readable())),
        None => Ok(String::new()),
    }
}

fn current_owner_id(state: &AppState) -> AppResult<u32> {
    state
        .current_id
        .lock()
        .unwrap()
        .ok_or_else(|| AppError::Core("no account".into()))
}

/// 创建 bot 账号（chatmail 邮箱），归属当前登录用户。
#[tauri::command]
pub async fn create_bot(state: State<'_, AppState>, display_name: String) -> AppResult<BotDto> {
    let owner_id = current_owner_id(&state)?;
    state.bots.create(owner_id, display_name).await
}

/// 列出当前用户的所有 bot。
#[tauri::command]
pub async fn list_bots(state: State<'_, AppState>) -> AppResult<Vec<BotDto>> {
    state.bots.list().await
}

/// 删除当前用户的一个 bot。
#[tauri::command]
pub async fn delete_bot(state: State<'_, AppState>, bot_id: i64) -> AppResult<()> {
    state.bots.delete(bot_id).await
}

/// 启/停当前用户某个 bot 的 IO。
#[tauri::command]
pub async fn set_bot_io(
    state: State<'_, AppState>,
    bot_id: i64,
    running: bool,
) -> AppResult<BotDto> {
    state.bots.set_io(bot_id, running).await
}

/// 更新当前用户某个 bot 的 LLM 配置。
#[tauri::command]
pub async fn update_bot_llm(
    state: State<'_, AppState>,
    bot_id: i64,
    config: crate::dto::LlmConfigInput,
) -> AppResult<BotDto> {
    state.bots.update_bot_llm(bot_id, config).await
}

/// 读取当前用户某个 bot 的 LLM 配置（未配置时为 None）。
#[tauri::command]
pub async fn get_bot_llm(
    state: State<'_, AppState>,
    bot_id: i64,
) -> AppResult<Option<crate::dto::LlmConfigInput>> {
    state.bots.get_bot_llm(bot_id).await
}

/// 获取当前用户某个 bot 账号的聊天列表。
#[tauri::command]
pub async fn bot_get_chatlist(
    state: State<'_, AppState>,
    bot_id: i64,
) -> AppResult<Vec<ChatDto>> {
    let ctx = state.bots.ctx_for_bot(bot_id).await?;
    build_chatlist(&ctx, None).await
}

/// 获取当前用户某个 bot 账号的聊天消息（最近 50 条）。
#[tauri::command]
pub async fn bot_get_chat_msgs(
    state: State<'_, AppState>,
    bot_id: i64,
    chat_id: u32,
) -> AppResult<Vec<MsgDto>> {
    let ctx = state.bots.ctx_for_bot(bot_id).await?;
    get_chat_msgs_impl(&ctx, chat_id, None).await
}

/// 以当前用户某个 bot 账号的身份发送文本消息，返回消息详情。
#[tauri::command]
pub async fn bot_send_text(
    state: State<'_, AppState>,
    bot_id: i64,
    chat_id: u32,
    text: String,
) -> AppResult<MsgDto> {
    let ctx = state.bots.ctx_for_bot(bot_id).await?;
    let msg_id = send_text_impl(&ctx, chat_id, text).await?;
    msg_to_dto(&ctx, msg_id).await
}

/// 标记当前用户某个 bot 账号的聊天为已读。
#[tauri::command]
pub async fn bot_mark_chat_noticed(
    state: State<'_, AppState>,
    bot_id: i64,
    chat_id: u32,
) -> AppResult<()> {
    let ctx = state.bots.ctx_for_bot(bot_id).await?;
    mark_chat_noticed_impl(&ctx, chat_id).await
}

/// 标记当前用户某个 bot 账号的聊天为已读(seen),并发送已读回执。
#[tauri::command]
pub async fn bot_mark_chat_seen(
    state: State<'_, AppState>,
    bot_id: i64,
    chat_id: u32,
) -> AppResult<()> {
    let ctx = state.bots.ctx_for_bot(bot_id).await?;
    mark_chat_seen_impl(&ctx, chat_id).await
}

/// 测试 LLM 配置：用固定示例消息调用一次，返回回复文本（用于配置对话框的「测试连接」）。
#[tauri::command]
pub async fn test_llm_config(config: crate::dto::LlmConfigInput) -> AppResult<String> {
    let msg = crate::llm::ChatMessage {
        role: "user".into(),
        content: "你好，请用一句话回复。".into(),
    };
    crate::llm::complete(&config, vec![msg]).await
}

/// 把 bot 拉入主账号的某个群聊/频道:主账号生成该会话的邀请 QR,bot 通过 securejoin 加入。
#[tauri::command]
pub async fn add_bot_to_chat(
    state: State<'_, AppState>,
    bot_id: i64,
    chat_id: u32,
) -> AppResult<()> {
    let main_ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let bot_ctx = state.bots.ctx_for_bot(bot_id).await?;
    // 仅群组/广播可生成邀请 QR;1:1 会话 get_securejoin_qr 会报错
    let qr = securejoin::get_securejoin_qr(&main_ctx, Some(deltachat::chat::ChatId::new(chat_id)))
        .await
        .map_err(|e| {
            let msg = e.to_string();
            AppError::Core(format!("无法生成该会话的邀请: {msg}"))
        })?;
    securejoin::join_securejoin(&bot_ctx, &qr)
        .await
        .map_err(|e| AppError::Core(format!("bot 加入失败: {e}")))?;
    Ok(())
}

/// 列出所有账号(含名称/地址),供前端「切换账号」。
#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> AppResult<Vec<crate::dto::AccountInfoDto>> {
    let accounts = state.accounts.lock().await;
    let mut out = Vec::new();
    for id in accounts.get_all() {
        let Some(ctx) = accounts.get_account(id) else { continue };
        let name = ctx.get_config(Config::Displayname).await.unwrap_or(None).unwrap_or_default();
        let addr = ctx.get_config(Config::ConfiguredAddr).await.unwrap_or(None).unwrap_or_default();
        let is_current = Some(id) == *state.current_id.lock().unwrap();
        out.push(crate::dto::AccountInfoDto {
            id,
            name,
            addr,
            is_current,
        });
    }
    Ok(out)
}

/// 切换到指定账号(选中 + 设 current + 启动 IO)。前端切换后 reload 重建 UI。
#[tauri::command]
pub async fn switch_account(state: State<'_, AppState>, id: u32) -> AppResult<crate::dto::AccountInfoDto> {
    let ctx = {
        let mut accounts = state.accounts.lock().await;
        if accounts.get_account(id).is_none() {
            return Err(AppError::Core("账号不存在".into()));
        }
        accounts.select_account(id).await?;
        accounts.get_account(id)
    };
    if let Some(ctx) = ctx {
        ctx.start_io().await;
        state.set_current(id);
        let name = ctx.get_config(Config::Displayname).await.unwrap_or(None).unwrap_or_default();
        let addr = ctx.get_config(Config::ConfiguredAddr).await.unwrap_or(None).unwrap_or_default();
        return Ok(crate::dto::AccountInfoDto { id, name, addr, is_current: true });
    }
    Err(AppError::Core("账号不可用".into()))
}
