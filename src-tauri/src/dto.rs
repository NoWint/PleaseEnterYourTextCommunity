use serde::{Deserialize, Serialize};

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
pub struct ChatInfoDto {
    pub chat_id: u32,
    pub name: String,
    pub is_group: bool,
    pub is_contact_request: bool,
    pub is_self_talk: bool,
    pub chat_type: String,
    pub is_encrypted: bool,
    pub members: Vec<MemberDto>,
}

#[derive(Debug, Serialize)]
pub struct MsgDto {
    pub msg_id: u32,
    pub from_id: u32,
    pub from_name: String,
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

/// 活动类型常量(见 bot_activities.kind)。
pub mod bot_activity_kind {
    pub const REPLY_SENT: &str = "reply_sent";
    pub const REPLY_SKIPPED: &str = "reply_skipped";
    pub const REPLY_RATE_LIMITED: &str = "reply_rate_limited";
    pub const LLM_ERROR: &str = "llm_error";
    pub const NO_CONFIG: &str = "no_config";
    pub const DRIVER_DISABLED: &str = "driver_disabled";
    pub const THINKING: &str = "thinking";
    pub const TOOL_CALLED: &str = "tool_called";
    pub const SCHEDULE_SENT: &str = "schedule_sent";
    pub const RULE_REPLY: &str = "rule_reply";
}

/// Bot 活动日志 DTO(时间线页/统计用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotActivityDto {
    pub id: i64,
    pub bot_id: i64,
    pub kind: String,
    pub chat_id: Option<u32>,
    pub msg_id: Option<u32>,
    pub summary: String,
    pub detail_json: Option<String>,
    pub created_at: i64,
}

fn default_temperature() -> f64 {
    0.7
}
fn default_timeout_secs() -> u64 {
    120
}
fn default_max_retries() -> u32 {
    2
}
fn default_max_concurrent() -> u32 {
    2
}
fn default_reply_interval() -> u64 {
    3
}
fn default_interaction_max_rounds() -> u32 {
    3
}

/// 结构化 LLM 驱动配置(旧 LlmConfigInput 的超集)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LlmConfig {
    pub system_prompt: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

impl LlmConfig {
    /// base_url + api_key + model 三者非空即视为可自动回复。
    pub fn is_complete(&self) -> bool {
        let non_empty = |s: &Option<String>| s.as_deref().map_or(false, |s| !s.trim().is_empty());
        non_empty(&self.base_url) && non_empty(&self.api_key) && non_empty(&self.model)
    }
}

impl From<LlmConfigInput> for LlmConfig {
    fn from(i: LlmConfigInput) -> Self {
        Self {
            system_prompt: i.system_prompt,
            base_url: i.base_url,
            api_key: i.api_key,
            model: i.model,
            provider: i.provider,
            temperature: default_temperature(),
            max_tokens: None,
            top_p: None,
            timeout_secs: default_timeout_secs(),
            max_retries: default_max_retries(),
        }
    }
}

/// 规则驱动:单条规则定义。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RuleDef {
    pub id: i64,
    pub pattern: String, // 关键词子串 或 正则
    pub is_regex: bool,
    pub replies: Vec<String>, // 随机取一条
    pub enabled: bool,
}

/// 规则驱动:完整规则配置。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RuleConfig {
    pub rules: Vec<RuleDef>,
    pub welcome: Option<String>,
    pub fallback: Option<String>,
}

/// 定时驱动:一条定时任务。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleDto {
    pub id: i64,
    pub bot_id: i64,
    pub chat_id: u32,
    pub minute: i32,
    pub hour: i32,
    pub day_of_week: i32,
    pub message: String,
    pub enabled: bool,
    pub next_run_at: i64,
}

/// Bot 运行时限额。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BotLimits {
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
    #[serde(default = "default_reply_interval")]
    pub reply_min_interval_secs: u64,
    /// 是否允许 Bot 与 Bot 对话;默认 false
    #[serde(default)]
    pub allow_bot_interaction: bool,
    /// 互动最大轮数;默认 3
    #[serde(default = "default_interaction_max_rounds")]
    pub interaction_max_rounds: u32,
}

impl Default for BotLimits {
    fn default() -> Self {
        Self {
            max_concurrent: default_max_concurrent(),
            reply_min_interval_secs: default_reply_interval(),
            allow_bot_interaction: false,
            interaction_max_rounds: default_interaction_max_rounds(),
        }
    }
}

/// Bot 完整配置(存于 bots.config_json)。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct BotConfig {
    #[serde(default)]
    pub llm: Option<LlmConfig>,
    #[serde(default)]
    pub limits: BotLimits,
    /// 显式启用的工具名集合;None = 使用默认安全工具集
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub rule: Option<RuleConfig>,
    #[serde(default)]
    pub persona: Option<String>,
}

impl BotConfig {
    /// 解析 config_json:优先新格式;新格式 llm 为空时回退旧格式(顶层 LLM 字段)。
    pub fn parse(raw: Option<&str>) -> Option<BotConfig> {
        let s = raw?;
        if let Ok(cfg) = serde_json::from_str::<BotConfig>(s) {
            // 含 llm 或 limits 键即视为新格式:即使 llm 为 null 也保留(limits 不丢失)
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
                if v.get("llm").is_some() || v.get("limits").is_some() {
                    return Some(cfg);
                }
            }
        }
        Self::from_legacy(s)
    }

    fn from_legacy(s: &str) -> Option<BotConfig> {
        #[derive(serde::Deserialize)]
        struct Legacy {
            system_prompt: Option<String>,
            base_url: Option<String>,
            api_key: Option<String>,
            model: Option<String>,
            provider: Option<String>,
        }
        let legacy: Legacy = serde_json::from_str(s).ok()?;
        // 需要旧格式证据(base_url/api_key/model 任一存在),避免把任意 JSON 误判为旧配置
        if legacy.base_url.is_none() && legacy.api_key.is_none() && legacy.model.is_none() {
            return None;
        }
        Some(BotConfig {
            llm: Some(LlmConfig {
                system_prompt: legacy.system_prompt,
                base_url: legacy.base_url,
                api_key: legacy.api_key,
                model: legacy.model,
                provider: legacy.provider,
                temperature: default_temperature(),
                max_tokens: None,
                top_p: None,
                timeout_secs: default_timeout_secs(),
                max_retries: default_max_retries(),
            }),
            limits: BotLimits::default(),
            tools: None,
            rule: None,
            persona: None,
        })
    }
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

    fn default_llm_config() -> LlmConfig {
        LlmConfig {
            system_prompt: Some("你是助手".into()),
            base_url: Some("https://api.openai.com/v1".into()),
            api_key: Some("sk-test".into()),
            model: Some("gpt-4o-mini".into()),
            provider: Some("openai".into()),
            temperature: 0.7,
            max_tokens: Some(256),
            top_p: Some(1.0),
            timeout_secs: 120,
            max_retries: 2,
        }
    }

    #[test]
    fn test_bot_limits_defaults() {
        let l = BotLimits::default();
        assert_eq!(l.max_concurrent, 2);
        assert_eq!(l.reply_min_interval_secs, 3);
        assert!(!l.allow_bot_interaction);
        assert_eq!(l.interaction_max_rounds, 3);
    }

    #[test]
    fn test_llm_config_is_complete() {
        assert!(default_llm_config().is_complete());
        let mut no_model = default_llm_config();
        no_model.model = None;
        assert!(!no_model.is_complete());
        let mut blank_key = default_llm_config();
        blank_key.api_key = Some("   ".into());
        assert!(!blank_key.is_complete());
    }

    #[test]
    fn test_bot_config_parse_new_format() {
        let json = r#"{"llm":{"base_url":"https://x/v1","api_key":"k","model":"m","temperature":0.3,"max_tokens":100},"limits":{"max_concurrent":5,"reply_min_interval_secs":7}}"#;
        let cfg = BotConfig::parse(Some(json)).expect("parse new format");
        let llm = cfg.llm.expect("llm present");
        assert_eq!(llm.temperature, 0.3);
        assert_eq!(llm.max_tokens, Some(100));
        assert_eq!(llm.timeout_secs, 120); // 缺省取默认
        assert_eq!(llm.max_retries, 2); // 缺省取默认
        assert_eq!(cfg.limits.max_concurrent, 5);
        assert_eq!(cfg.limits.reply_min_interval_secs, 7);
    }

    #[test]
    fn test_bot_config_parse_legacy_format() {
        // 旧格式:顶层字段,无 llm 包裹
        let json = r#"{"system_prompt":"旧提示","base_url":"https://old/v1","api_key":"old-key","model":"old-model","provider":"openai"}"#;
        let cfg = BotConfig::parse(Some(json)).expect("parse legacy");
        let llm = cfg.llm.expect("llm migrated");
        assert_eq!(llm.base_url.as_deref(), Some("https://old/v1"));
        assert_eq!(llm.model.as_deref(), Some("old-model"));
        assert_eq!(llm.temperature, 0.7); // 迁移补默认
        assert_eq!(llm.timeout_secs, 120);
        assert_eq!(cfg.limits.max_concurrent, 2); // 迁移补默认
    }

    #[test]
    fn test_bot_config_parse_none_or_invalid() {
        assert!(BotConfig::parse(None).is_none());
        assert!(BotConfig::parse(Some("not json".into())).is_none());
        // 新格式 llm 显式 null + limits(update_bot_config 序列化形态)→ 保留 limits
        let cfg = BotConfig::parse(Some(r#"{"llm":null,"limits":{"max_concurrent":4}}"#.into()))
            .expect("limits-only new format should parse");
        assert_eq!(cfg.limits.max_concurrent, 4);
        assert!(cfg.llm.is_none());
    }

    #[test]
    fn test_llm_config_from_input() {
        let input = LlmConfigInput {
            system_prompt: Some("p".into()),
            base_url: Some("https://b/v1".into()),
            api_key: Some("k".into()),
            model: Some("m".into()),
            provider: Some("openai".into()),
        };
        let cfg = LlmConfig::from(input);
        assert_eq!(cfg.base_url.as_deref(), Some("https://b/v1"));
        assert_eq!(cfg.temperature, 0.7);
        assert_eq!(cfg.max_tokens, None);
        assert!(cfg.is_complete());
    }

    #[test]
    fn test_bot_config_rule_defaults() {
        let cfg = BotConfig::default();
        assert!(cfg.rule.is_none());
        assert!(cfg.persona.is_none());
    }

    #[test]
    fn test_rule_config_round_trip() {
        let cfg = RuleConfig {
            rules: vec![RuleDef {
                id: 1,
                pattern: "hello".into(),
                is_regex: false,
                replies: vec!["hi".into(), "hey".into()],
                enabled: true,
            }],
            welcome: Some("欢迎".into()),
            fallback: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: RuleConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn test_schedule_dto_round_trip() {
        let dto = ScheduleDto {
            id: 1,
            bot_id: 9,
            chat_id: 42,
            minute: 30,
            hour: 8,
            day_of_week: 1,
            message: "早报".into(),
            enabled: true,
            next_run_at: 1700000000,
        };
        let json = serde_json::to_string(&dto).unwrap();
        let back: ScheduleDto = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, 1);
        assert_eq!(back.bot_id, 9);
        assert_eq!(back.chat_id, 42);
        assert_eq!(back.minute, 30);
        assert_eq!(back.hour, 8);
        assert_eq!(back.day_of_week, 1);
        assert_eq!(back.message, "早报");
        assert!(back.enabled);
        assert_eq!(back.next_run_at, 1700000000);
    }

    #[test]
    fn test_bot_activity_dto_round_trip() {
        let dto = BotActivityDto {
            id: 1,
            bot_id: 9,
            kind: "reply_sent".into(),
            chat_id: Some(3),
            msg_id: Some(7),
            summary: "回复 alice".into(),
            detail_json: None,
            created_at: 1,
        };
        let json = serde_json::to_string(&dto).unwrap();
        let back: BotActivityDto = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "reply_sent");
        assert_eq!(back.bot_id, 9);
        assert_eq!(back.chat_id, Some(3));
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
