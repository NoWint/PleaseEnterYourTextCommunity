use serde::{Deserialize, Serialize};

/// 链接预览(fetch_link_preview 返回): 消息里的 URL 渲染成链接卡片用。
#[derive(Debug, Serialize)]
pub struct LinkPreviewDto {
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub favicon: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdvancedLogin {
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub imap_security: Option<String>, // "ssl" | "tls" | "plain"
    pub imap_user: Option<String>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<String>,
    pub smtp_user: Option<String>,
    pub smtp_password: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProfileDto {
    pub id: u32,
    pub name: Option<String>,
    pub addr: Option<String>,
    pub avatar: Option<String>, // blobdir 绝对路径
    pub color: Option<u32>,     // Contact::get_color() 返回的 u32
}

#[derive(Debug, Serialize)]
pub struct ChatDto {
    pub chat_id: u32,
    pub name: String,
    pub is_group: bool,
    pub is_contact_request: bool,
    pub is_self_talk: bool,
    pub is_archived: bool,
    pub last_msg: Option<String>,
    pub last_ts: Option<i64>,
    pub unread: u32,
    pub avatar: Option<String>, // blobdir 绝对路径(单聊=对方头像,群聊=群头像)
    pub color: Option<u32>,
    // 最后一条消息元信息: 前端会话预览据此显示已读状态(单聊「已读 · …」/ 群聊「N 人已读 · …」)
    pub last_msg_is_out: bool,
    pub last_msg_state: String, // "pending" | "delivered" | "failed" | "read"
    pub last_msg_read_count: u32, // 群聊已读数; 非群聊/未发出为 0
    pub last_msg_is_info: bool,   // 最后一条是系统信息行(不显示已读前缀)
}

#[derive(Debug, Serialize)]
pub struct MemberDto {
    pub contact_id: u32,
    pub name: String,
    pub addr: String,
    pub is_self: bool,
    pub avatar: Option<String>,
    pub color: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ReadReceiptDto {
    pub contact_id: u32,
    pub name: String,
    pub addr: String,
    pub avatar: Option<String>,
    pub color: Option<u32>,
    /// 读取时间(unix 秒)
    pub ts: i64,
}

#[derive(Debug, Serialize)]
pub struct ChatInfoDto {
    pub chat_id: u32,
    pub name: String,
    pub is_group: bool,
    pub is_contact_request: bool,
    pub is_self_talk: bool,
    pub chat_type: String,
    pub is_encrypted: bool,
    pub members: Vec<MemberDto>,
    pub description: String,
    pub avatar: Option<String>,
    pub color: Option<u32>,
    pub past_members: Vec<MemberDto>,
    pub can_send: bool,
    pub self_in_group: bool,
}

#[derive(Debug, Serialize)]
pub struct MsgDto {
    pub msg_id: u32,
    pub from_id: u32,
    pub from_name: String,
    pub from_avatar: Option<String>, // 发送者头像(blobdir 绝对路径),对齐 Delta authorProfileImage
    pub from_color: Option<u32>,     // 发送者头像颜色
    pub text: String,
    pub ts: i64,
    pub is_out: bool,
    pub state: String,
    pub quote_from: Option<String>,
    pub quote_text: Option<String>,
    pub view_type: String, // "Text"|"Image"|"Gif"|"Sticker"|"Audio"|"Voice"|"Video"|"File"|"Vcard"|"Webxdc"|"Unknown"
    pub file: Option<String>, // blobdir absolute path
    pub file_name: Option<String>,
    pub file_mime: Option<String>,
    pub file_bytes: Option<u64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub download_state: String, // "Done"|"Available"|"Failure"|"InProgress"|"Undecipherable"
    pub subject: Option<String>,
    pub is_info: bool, // 系统消息标记(对齐 core Message::is_info)
}

#[derive(Debug, Serialize, Clone)]
pub struct EventPayload {
    pub typ: String,
    pub chat_id: Option<u32>,
    pub msg_id: Option<u32>,
    pub contact_id: Option<u32>,
    pub progress: Option<u16>,
    pub comment: Option<String>,
    // IncomingMsg 事件携带消息摘要,供通知使用(无需再调一次 get_chat_msgs)
    pub text: Option<String>,
}

/// 深链事件载荷(仿 NotificationClickPayload):typ="DeepLink",url=唤起链接。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeepLinkPayload {
    pub typ: &'static str,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct ContactDto {
    pub id: u32,
    pub name: String,
    pub addr: String,
    pub avatar: Option<String>, // blobdir 绝对路径
    pub color: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct SearchResultDto {
    pub msg_id: u32,
    pub chat_id: u32,
    pub chat_name: String,
    pub from_name: String,
    pub text: String,
    pub ts: i64,
}

/// Debug 页原始消息 (直查 core msgs 表, 非遍历聊天)
#[derive(Debug, Serialize)]
pub struct RawMsgDto {
    pub msg_id: u32,
    pub chat_id: u32,
    pub chat_name: String,
    pub from_name: String,
    pub is_out: bool,
    pub ts: i64,
    pub view_type: String, // "Text"|"Image"|...
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceDto {
    pub id: i64,
    pub name: String,
    pub master_chat_id: u32,
    pub icon: Option<String>,
    pub created_at: i64,
}

/// PEYT Studio 默认空间信息
#[derive(Debug, Serialize)]
pub struct PeytStudioDto {
    pub workspace: WorkspaceDto,
    /// "founder" = 本机首人创建; "member" = 通过 QR 加入; "existing" = 已存在
    pub role: String,
    /// 首人创建后返回 master 群的 SecureJoin QR,供分享给其他成员
    pub invite_qr: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChannelDto {
    pub id: i64,
    pub workspace_id: i64,
    pub chat_id: u32,
    pub name: String,
    pub category: String,
    pub position: i64,
    pub topic: Option<String>,
    pub unread: u32,
}

#[derive(Debug, Serialize)]
pub struct RoleDto {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PinDto {
    pub id: i64,
    pub workspace_id: i64,
    pub channel_chat_id: u32,
    pub msg_id: u32,
    pub pinned_by: u32,
    pub pinned_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ReactionDto {
    pub emoji: String,
    pub count: i64,
    pub senders: Vec<u32>,
}

/// One row of `list_all_contact_roles`: a contact's assigned role
/// in a workspace, with role name + color for right-pane grouping.
/// Using a named DTO (instead of a raw tuple) so the JS side gets
/// `{ contact_id, role_id, role_name, role_color }` rather than a
/// positional array.
#[derive(Debug, Serialize)]
pub struct ContactRoleDto {
    pub contact_id: u32,
    pub role_id: i64,
    pub role_name: String,
    pub role_color: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CardDto {
    pub id: i64,
    pub workspace_id: i64,
    pub channel_chat_id: u32,
    pub msg_id: Option<u32>,
    #[serde(rename = "type")]
    pub type_: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub assignee_contact_id: Option<u32>,
    pub assignee_name: Option<String>,
    pub due_date: Option<i64>,
    pub created_by: u32,
    pub created_by_name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub position: i64,
    pub source_msg_id: Option<u32>,
}

/// SP6 Inbox: 通知中心事件。
/// type_: 'mention' | 'reply' | 'card_assign' | 'system'
#[derive(Debug, Clone, Serialize)]
pub struct InboxEventDto {
    pub id: i64,
    pub workspace_id: i64,
    #[serde(rename = "type")]
    pub type_: String,
    pub source_chat_id: i64,
    pub msg_id: Option<i64>,
    pub actor_id: i64,
    pub actor_name: String,
    pub summary: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
}

/// SP6 Activity: 团队活动流。
/// action: 'card_create' | 'card_update' | 'card_delete' | 'pin_toggle' |
///         'message_to_card' | 'channel_create'
/// target_type: 'card' | 'message' | 'channel'
#[derive(Debug, Clone, Serialize)]
pub struct ActivityDto {
    pub id: i64,
    pub workspace_id: i64,
    pub channel_chat_id: Option<i64>,
    pub actor_id: i64,
    pub actor_name: String,
    pub action: String,
    pub target_type: String,
    pub target_id: i64,
    pub payload: Option<String>,
    pub created_at: i64,
}

/// Bot 账号 DTO
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotDto {
    pub id: i64,
    pub bot_account_id: u32,
    pub display_name: String,
    pub addr: Option<String>,
    pub io_running: bool,
    pub created_at: i64,
}

/// Bot LLM 配置 DTO
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfigInput {
    pub system_prompt: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri v2 默认对命令参数名做 camelCase→snake_case 转换，
    /// 因此 DTO 字段使用 snake_case 命名。这里验证含 `imap_host` 等字段的
    /// JSON 能被正确反序列化为 `AdvancedLogin`。
    #[test]
    fn test_advanced_login_deserialize_snake_case() {
        let json = r#"{
            "imap_host": "imap.example.com",
            "imap_port": 993,
            "imap_security": "ssl",
            "imap_user": "alice",
            "smtp_host": "smtp.example.com",
            "smtp_port": 587,
            "smtp_security": "tls",
            "smtp_user": "alice",
            "smtp_password": "secret"
        }"#;
        let parsed: AdvancedLogin = serde_json::from_str(json).expect("deserialize AdvancedLogin");
        assert_eq!(parsed.imap_host.as_deref(), Some("imap.example.com"));
        assert_eq!(parsed.imap_port, Some(993));
        assert_eq!(parsed.imap_security.as_deref(), Some("ssl"));
        assert_eq!(parsed.imap_user.as_deref(), Some("alice"));
        assert_eq!(parsed.smtp_host.as_deref(), Some("smtp.example.com"));
        assert_eq!(parsed.smtp_port, Some(587));
        assert_eq!(parsed.smtp_security.as_deref(), Some("tls"));
        assert_eq!(parsed.smtp_user.as_deref(), Some("alice"));
        assert_eq!(parsed.smtp_password.as_deref(), Some("secret"));
    }
}

/// 账号信息(切换账号列表用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfoDto {
    pub id: u32,
    pub name: String,
    pub addr: String,
    pub is_current: bool,
}
