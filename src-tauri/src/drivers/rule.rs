use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use deltachat::config::Config;
use rand::Rng;
use regex::Regex;

use super::{BotDriver, BotRuntime, DriverKind, IncomingMsg};
use crate::dto::bot_activity_kind as act;
use crate::dto::LlmConfig;
use crate::dto::ProjectContext;
use crate::dto::RuleConfig;
use crate::error::AppResult;
use crate::llm::{ChatMessage, LlmClient};

/// 8ball 预设回答。
const EIGHT_BALL_ANSWERS: [&str; 10] = [
    "🎱 是的",
    "🎱 不太可能",
    "🎱 再问一次",
    "🎱 肯定可以",
    "🎱 别指望了",
    "🎱 天机不可泄露",
    "🎱 问心无愧即可",
    "🎱 也许吧",
    "🎱 必定的",
    "🎱 让我想想",
];

/// /summarize 默认总结条数。
const SUMMARIZE_DEFAULT: usize = 30;
/// /summarize 条数上限。
const SUMMARIZE_MAX: usize = 200;

/// 规则驱动:处理指令彩蛋(/summarize 除外)、进群欢迎语、关键词/正则规则与兜底文案。
/// `seen` 记录 (bot_id, chat_id),保证每个会话的欢迎语只发一次;
/// `llm` 供 /summarize 使用,纯规则模式(无 LLM)时保持 None。
pub struct RuleDriver {
    seen: StdMutex<HashSet<(i64, u32)>>,
    llm: Option<Arc<LlmClient>>,
}

impl RuleDriver {
    /// 纯规则模式:无 LLM,/summarize 返回「LLM 未配置」。
    pub fn new() -> Self {
        Self {
            seen: StdMutex::new(HashSet::new()),
            llm: None,
        }
    }

    /// 注入 LLM 客户端,启用 /summarize。
    pub fn with_llm(llm: Arc<LlmClient>) -> Self {
        Self {
            seen: StdMutex::new(HashSet::new()),
            llm: Some(llm),
        }
    }

    /// 记录 (bot_id, chat_id) 已见过;仅首次调用且 welcome 有值时返回欢迎语。
    pub fn welcome_for(&self, bot_id: i64, chat_id: u32, welcome: Option<&str>) -> Option<String> {
        let first = self.seen.lock().unwrap().insert((bot_id, chat_id));
        if first {
            welcome.map(str::to_string)
        } else {
            None
        }
    }
}

#[async_trait]
impl BotDriver for RuleDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Rule
    }

    async fn on_message(
        &self,
        bot: &BotRuntime<'_>,
        msg: &IncomingMsg<'_>,
    ) -> AppResult<Vec<String>> {
        // 1. 指令彩蛋(不依赖 rule 配置)。/summarize 需要 LLM 与历史,单独走异步路径。
        if let Some(text) = msg.text {
            let text = text.trim();
            if text.starts_with('/') {
                if let Some(count) = parse_summarize(text) {
                    return self.handle_summarize(bot, msg, count).await;
                }
                let bot_name = bot
                    .dc
                    .get_config(Config::Displayname)
                    .await
                    .ok()
                    .flatten()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "Bot".to_string());
                let bot_addr = bot
                    .dc
                    .get_config(Config::ConfiguredAddr)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if is_whoami(text) {
                    let workspace_name = workspace_name_for(bot).await;
                    let reply = whoami_reply(
                        &bot_name,
                        &bot_addr,
                        bot.config.project_context.as_ref(),
                        workspace_name.as_deref(),
                    );
                    bot.activity
                        .record(
                            bot.bot_id,
                            act::RULE_REPLY,
                            Some(msg.chat_id.to_u32()),
                            Some(msg.msg_id.to_u32()),
                            "指令: /whoami",
                            None,
                        )
                        .await;
                    return Ok(vec![reply]);
                }
                if let Some(reply) = handle_command(text) {
                    return Ok(vec![reply]);
                }
            }
        }

        let Some(rule) = &bot.config.rule else {
            return Ok(vec![]);
        };

        // 2. 欢迎语:该会话首次消息且配置了 welcome。
        if let Some(w) = self.welcome_for(bot.bot_id, msg.chat_id.to_u32(), rule.welcome.as_deref())
        {
            bot.activity
                .record(
                    bot.bot_id,
                    act::RULE_REPLY,
                    Some(msg.chat_id.to_u32()),
                    Some(msg.msg_id.to_u32()),
                    "欢迎语",
                    None,
                )
                .await;
            return Ok(vec![w]);
        }

        // 3. 关键词/正则规则。
        if let Some(text) = msg.text {
            if let Some((pattern, reply)) = pick_reply(text, rule) {
                bot.activity
                    .record(
                        bot.bot_id,
                        act::RULE_REPLY,
                        Some(msg.chat_id.to_u32()),
                        Some(msg.msg_id.to_u32()),
                        format!("规则命中: {pattern}"),
                        None,
                    )
                    .await;
                return Ok(vec![reply]);
            }
        }

        // 4. 兜底。
        if let Some(fb) = &rule.fallback {
            bot.activity
                .record(
                    bot.bot_id,
                    act::RULE_REPLY,
                    Some(msg.chat_id.to_u32()),
                    Some(msg.msg_id.to_u32()),
                    "兜底回复",
                    None,
                )
                .await;
            return Ok(vec![fb.clone()]);
        }

        Ok(vec![])
    }
}

// ── /summarize 开发者指令 ────────────────────────────────────────────────

impl RuleDriver {
    /// 处理 /summarize:拉取最近 count 条历史,走 LLM 生成结构化总结,按句边界拆分返回。
    /// LLM 未注入或 bot 配置不完整时返回「LLM 未配置,无法总结」;调用失败返回「总结失败: {e}」。
    async fn handle_summarize(
        &self,
        bot: &BotRuntime<'_>,
        msg: &IncomingMsg<'_>,
        count: usize,
    ) -> AppResult<Vec<String>> {
        let Some(cfg) = summarize_cfg(self.llm.as_ref(), bot.config.llm.as_ref()) else {
            return Ok(vec!["LLM 未配置,无法总结".into()]);
        };
        let history = crate::drivers::llm::build_history_n(bot.dc, msg.chat_id, count).await?;
        if history.is_empty() {
            return Ok(vec!["暂无可总结的消息".into()]);
        }
        let mut messages = Vec::with_capacity(history.len() + 1);
        messages.push(ChatMessage {
            role: "system".into(),
            content: "你是一个技术讨论总结助手,请用简洁的结构化要点总结以下对话:".into(),
            ..Default::default()
        });
        messages.extend(history);
        let summary = match self.llm.as_ref().unwrap().complete(cfg, messages).await {
            Ok(s) => s,
            Err(e) => return Ok(vec![format!("总结失败: {e}")]),
        };
        bot.activity
            .record(
                bot.bot_id,
                act::RULE_REPLY,
                Some(msg.chat_id.to_u32()),
                Some(msg.msg_id.to_u32()),
                "指令: /summarize",
                None,
            )
            .await;
        Ok(crate::drivers::llm::split_reply(&summary))
    }
}

/// /summarize 可用的 LLM 配置:需驱动已注入 LlmClient 且 bot 配置完整;否则 None。
fn summarize_cfg<'a>(
    self_llm: Option<&Arc<LlmClient>>,
    cfg: Option<&'a LlmConfig>,
) -> Option<&'a LlmConfig> {
    self_llm?;
    let c = cfg?;
    if c.is_complete() {
        Some(c)
    } else {
        None
    }
}

/// 解析 /summarize 指令:命中返回总结条数(默认 30,非法参数取默认,上限 200),否则 None。
pub fn parse_summarize(text: &str) -> Option<usize> {
    let t = text.trim();
    let mut parts = t.splitn(2, char::is_whitespace);
    if parts.next()? != "/summarize" {
        return None;
    }
    let n = parts
        .next()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .map(|n| n.min(SUMMARIZE_MAX))
        .unwrap_or(SUMMARIZE_DEFAULT);
    Some(n)
}

/// 彩蛋指令:命中返回回复文本,否则 None。未知指令返回 None(交由规则/兜底处理)。
/// 注:/whoami 需项目上下文(db 查询),在 on_message 中单独处理。
pub fn handle_command(text: &str) -> Option<String> {
    let t = text.trim();
    if !t.starts_with('/') {
        return None;
    }
    let mut parts = t.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("");
    let arg = parts.next();
    match cmd {
        "/roll" => {
            let n = arg
                .and_then(|s| s.trim().parse::<i64>().ok())
                .filter(|&n| n >= 1)
                .unwrap_or(100);
            let roll = rand::thread_rng().gen_range(1..=n);
            Some(format!("🎲 你掷出了 {roll} (1-{n})"))
        }
        "/dice" => {
            let d = rand::thread_rng().gen_range(1..=6);
            Some(format!("🎲 骰子: {d}"))
        }
        "/coin" => {
            if rand::thread_rng().gen_bool(0.5) {
                Some("🪙 正面".into())
            } else {
                Some("🪙 反面".into())
            }
        }
        "/8ball" => {
            let idx = rand::thread_rng().gen_range(0..EIGHT_BALL_ANSWERS.len());
            Some(EIGHT_BALL_ANSWERS[idx].to_string())
        }
        "/help" => Some("可用指令: /roll /dice /coin /8ball /whoami /summarize".into()),
        _ => None,
    }
}

/// 判断文本是否为 /whoami 指令(与 handle_command 的命令令牌解析一致)。
pub fn is_whoami(text: &str) -> bool {
    let mut parts = text.trim().splitn(2, char::is_whitespace);
    parts.next() == Some("/whoami")
}

/// /whoami 回复:身份 + 项目上下文(工作区名/ID + 项目描述)。
/// workspace_name 为 None 时回退显示工作区 id;无项目上下文时仅返回身份。
pub fn whoami_reply(
    bot_name: &str,
    bot_addr: &str,
    pc: Option<&ProjectContext>,
    workspace_name: Option<&str>,
) -> String {
    let mut out = format!("我是 {bot_name}({bot_addr})");
    if let Some(pc) = pc {
        if let Some(ws_id) = pc.workspace_id {
            let label = workspace_name
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| ws_id.to_string());
            out.push_str(&format!("\n所属工作区: {label}"));
        }
        if let Some(desc) = pc.description.as_deref().filter(|s| !s.trim().is_empty()) {
            out.push_str(&format!("\n项目: {desc}"));
        }
    }
    out
}

/// 解析 project_context 的 workspace_id 对应的工作区名(db 查询;查不到返回 None → 显示 id)。
async fn workspace_name_for(bot: &BotRuntime<'_>) -> Option<String> {
    let ws_id = bot.config.project_context.as_ref()?.workspace_id?;
    match bot.db.get_workspace(ws_id).await {
        Ok(Some(ws)) if !ws.name.trim().is_empty() => Some(ws.name),
        _ => None,
    }
}

/// 按规则匹配:命中返回 (规则 pattern, 随机一条回复),否则 None。
fn pick_reply(text: &str, cfg: &RuleConfig) -> Option<(String, String)> {
    for rule in &cfg.rules {
        if !rule.enabled || rule.replies.is_empty() {
            continue;
        }
        let hit = if rule.is_regex {
            match Regex::new(&rule.pattern) {
                Ok(re) => re.is_match(text),
                Err(_) => false,
            }
        } else {
            text.to_lowercase().contains(&rule.pattern.to_lowercase())
        };
        if hit {
            let idx = rand::thread_rng().gen_range(0..rule.replies.len());
            return Some((rule.pattern.clone(), rule.replies[idx].clone()));
        }
    }
    None
}

/// 按规则匹配:命中返回随机一条回复,否则 None。
pub fn match_rules(text: &str, cfg: &RuleConfig) -> Option<String> {
    pick_reply(text, cfg).map(|(_, reply)| reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roll_with_arg_in_range() {
        for _ in 0..50 {
            let r = handle_command("/roll 10").unwrap();
            assert!(r.starts_with("🎲 你掷出了 "), "unexpected: {r}");
            let n = r
                .trim_start_matches("🎲 你掷出了 ")
                .split(' ')
                .next()
                .unwrap()
                .parse::<i64>()
                .unwrap();
            assert!((1..=10).contains(&n), "roll out of range: {n}");
            assert!(r.ends_with("(1-10)"));
        }
    }

    #[test]
    fn roll_default_is_100() {
        for _ in 0..50 {
            let r = handle_command("/roll").unwrap();
            let n = r
                .trim_start_matches("🎲 你掷出了 ")
                .split(' ')
                .next()
                .unwrap()
                .parse::<i64>()
                .unwrap();
            assert!((1..=100).contains(&n), "roll out of range: {n}");
            assert!(r.ends_with("(1-100)"));
        }
    }

    #[test]
    fn dice_in_range() {
        for _ in 0..50 {
            let r = handle_command("/dice").unwrap();
            let n = r.trim_start_matches("🎲 骰子: ").parse::<i64>().unwrap();
            assert!((1..=6).contains(&n), "dice out of range: {n}");
        }
    }

    #[test]
    fn coin_is_head_or_tail() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let r = handle_command("/coin").unwrap();
            assert!(r == "🪙 正面" || r == "🪙 反面", "unexpected: {r}");
            seen.insert(r);
        }
        assert!(seen.len() == 2, "coin should flip both sides, got {seen:?}");
    }

    #[test]
    fn eight_ball_prefix() {
        for _ in 0..50 {
            let r = handle_command("/8ball").unwrap();
            assert!(r.starts_with('🎱'), "unexpected: {r}");
        }
    }

    #[test]
    fn whoami_reply_contains_bot_identity() {
        let r = whoami_reply("小明", "ming@x.io", None, None);
        assert!(r.contains("小明"));
        assert!(r.contains("ming@x.io"));
    }

    #[test]
    fn whoami_reply_includes_workspace_and_description() {
        let pc = ProjectContext {
            workspace_id: Some(7),
            chat_ids: vec![],
            description: Some("PEYT 桌面端".into()),
            repo_path: None,
        };
        let r = whoami_reply("Bot", "bot@x.io", Some(&pc), None);
        assert!(r.starts_with("我是 Bot(bot@x.io)"), "got: {r}");
        assert!(r.contains("所属工作区: 7"), "got: {r}");
        assert!(r.contains("项目: PEYT 桌面端"), "got: {r}");
    }

    #[test]
    fn whoami_reply_uses_workspace_name_when_available() {
        let pc = ProjectContext {
            workspace_id: Some(7),
            chat_ids: vec![],
            description: None,
            repo_path: None,
        };
        let r = whoami_reply("Bot", "bot@x.io", Some(&pc), Some("PEYT Studio"));
        assert!(r.contains("所属工作区: PEYT Studio"), "got: {r}");
        assert!(!r.contains("所属工作区: 7"), "got: {r}");
    }

    #[test]
    fn whoami_reply_omits_empty_project_context_parts() {
        let pc = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: Some("   ".into()),
            repo_path: None,
        };
        let r = whoami_reply("Bot", "bot@x.io", Some(&pc), None);
        assert_eq!(r, "我是 Bot(bot@x.io)");
    }

    #[test]
    fn is_whoami_matches_command_token() {
        assert!(is_whoami("/whoami"));
        assert!(is_whoami("/whoami  "));
        assert!(is_whoami("/whoami extra"));
        assert!(!is_whoami("/dice"));
        assert!(!is_whoami("whoami"));
        assert!(!is_whoami("/whoami-x"));
    }

    #[test]
    fn help_lists_commands() {
        let r = handle_command("/help").unwrap();
        assert!(r.contains("/roll"));
        assert!(r.contains("/dice"));
        assert!(r.contains("/coin"));
        assert!(r.contains("/8ball"));
        assert!(r.contains("/whoami"));
        assert!(r.contains("/summarize"));
    }

    #[test]
    fn unknown_and_plain_text_are_none() {
        assert!(handle_command("hello").is_none());
        assert!(handle_command("/unknown").is_none());
        assert!(handle_command("").is_none());
    }

    #[test]
    fn match_keyword_rule() {
        let cfg = RuleConfig {
            rules: vec![crate::dto::RuleDef {
                id: 1,
                pattern: "天气".into(),
                is_regex: false,
                replies: vec!["今天晴".into()],
                enabled: true,
            }],
            welcome: None,
            fallback: None,
        };
        assert_eq!(match_rules("今天天气如何", &cfg), Some("今天晴".into()));
    }

    #[test]
    fn match_regex_rule() {
        let cfg = RuleConfig {
            rules: vec![crate::dto::RuleDef {
                id: 1,
                pattern: r"\d+".into(),
                is_regex: true,
                replies: vec!["数字".into()],
                enabled: true,
            }],
            welcome: None,
            fallback: None,
        };
        assert_eq!(match_rules("abc123", &cfg), Some("数字".into()));
        assert_eq!(match_rules("abc", &cfg), None);
    }

    #[test]
    fn no_match_returns_none() {
        let cfg = RuleConfig {
            rules: vec![crate::dto::RuleDef {
                id: 1,
                pattern: "天气".into(),
                is_regex: false,
                replies: vec!["今天晴".into()],
                enabled: true,
            }],
            welcome: None,
            fallback: None,
        };
        assert_eq!(match_rules("完全无关的话", &cfg), None);
    }

    #[test]
    fn disabled_rule_skipped() {
        let cfg = RuleConfig {
            rules: vec![crate::dto::RuleDef {
                id: 1,
                pattern: "天气".into(),
                is_regex: false,
                replies: vec!["今天晴".into()],
                enabled: false,
            }],
            welcome: None,
            fallback: None,
        };
        assert_eq!(match_rules("今天天气如何", &cfg), None);
    }

    #[test]
    fn keyword_match_ignores_case() {
        let cfg = RuleConfig {
            rules: vec![crate::dto::RuleDef {
                id: 1,
                pattern: "HELLO".into(),
                is_regex: false,
                replies: vec!["hi".into()],
                enabled: true,
            }],
            welcome: None,
            fallback: None,
        };
        assert_eq!(match_rules("say hello world", &cfg), Some("hi".into()));
    }

    #[test]
    fn welcome_only_once_per_chat() {
        let d = RuleDriver::new();
        assert!(d.seen.lock().unwrap().is_empty());
        assert_eq!(d.welcome_for(1, 2, Some("欢迎")), Some("欢迎".into()));
        assert_eq!(d.welcome_for(1, 2, Some("欢迎")), None);
        assert_eq!(d.welcome_for(1, 3, Some("欢迎")), Some("欢迎".into()));
        assert_eq!(d.welcome_for(2, 2, Some("欢迎")), Some("欢迎".into()));
    }

    #[test]
    fn welcome_seen_recorded_even_without_text() {
        let d = RuleDriver::new();
        assert_eq!(d.welcome_for(1, 2, None), None);
        assert_eq!(d.welcome_for(1, 2, Some("欢迎")), None);
    }

    #[test]
    fn parse_summarize_default_is_30() {
        assert_eq!(parse_summarize("/summarize"), Some(30));
        assert_eq!(parse_summarize("/summarize  "), Some(30));
        assert_eq!(parse_summarize("/summarize abc"), Some(30));
        assert_eq!(parse_summarize("/summarize 0"), Some(30));
        assert_eq!(parse_summarize("/summarize -3"), Some(30));
        assert_eq!(parse_summarize("/summarize 3.5"), Some(30));
    }

    #[test]
    fn parse_summarize_explicit_count() {
        assert_eq!(parse_summarize("/summarize 50"), Some(50));
        assert_eq!(parse_summarize("/summarize 1"), Some(1));
        assert_eq!(parse_summarize("/summarize 200"), Some(200));
    }

    #[test]
    fn parse_summarize_capped_at_200() {
        assert_eq!(parse_summarize("/summarize 201"), Some(200));
        assert_eq!(parse_summarize("/summarize 9999"), Some(200));
    }

    #[test]
    fn parse_summarize_only_matches_command() {
        assert_eq!(parse_summarize("/dice"), None);
        assert_eq!(parse_summarize("/help"), None);
        assert_eq!(parse_summarize("/summarizer"), None);
        assert_eq!(parse_summarize("/summarize-extra"), None);
        assert_eq!(parse_summarize("summarize"), None);
        assert_eq!(parse_summarize(""), None);
    }

    fn llm_config(complete: bool) -> LlmConfig {
        let mut c = LlmConfig {
            system_prompt: None,
            base_url: Some("https://api.openai.com/v1".into()),
            api_key: Some("test-key".into()),
            model: Some("gpt-4o-mini".into()),
            provider: Some("openai".into()),
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            timeout_secs: 120,
            max_retries: 2,
        };
        if !complete {
            c.api_key = None;
        }
        c
    }

    #[test]
    fn summarize_cfg_requires_injected_llm_and_complete_config() {
        let llm = Arc::new(LlmClient::new());
        let complete = llm_config(true);
        let incomplete = llm_config(false);

        assert!(summarize_cfg(Some(&llm), Some(&complete)).is_some());
        assert!(summarize_cfg(None, Some(&complete)).is_none());
        assert!(summarize_cfg(Some(&llm), None).is_none());
        assert!(summarize_cfg(Some(&llm), Some(&incomplete)).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn summarize_without_llm_returns_not_configured() {
        use deltachat::accounts::Accounts;
        use deltachat::chat::ChatId;
        use deltachat::message::{MsgId, Viewtype};

        let tmp = tempfile::tempdir().unwrap();
        let mut accounts = Accounts::new(tmp.path().join("accounts"), true)
            .await
            .unwrap();
        let account_id = accounts.add_account().await.unwrap();
        let ctx = accounts.get_account(account_id).unwrap();

        let db = Arc::new(
            crate::db::Db::new(tmp.path().join("test.db"))
                .await
                .unwrap(),
        );
        db.migrate().await.unwrap();
        let activity = crate::activity::ActivityLog::new(db.clone());
        let config = crate::dto::BotConfig::default();
        let data_dir = tmp.path().to_path_buf();

        let runtime = BotRuntime {
            bot_id: 1,
            account_id,
            dc: &ctx,
            config: &config,
            db: &db,
            activity: &activity,
            data_dir: &data_dir,
        };
        let incoming = IncomingMsg {
            chat_id: ChatId::new(42),
            msg_id: MsgId::new(7),
            from_addr: "dev@x.io",
            text: Some("/summarize"),
            viewtype: Viewtype::Text,
        };

        let driver = RuleDriver::new();
        let replies = driver.on_message(&runtime, &incoming).await.unwrap();
        assert_eq!(replies, vec!["LLM 未配置,无法总结".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn whoami_command_appends_workspace_name_and_description_from_db() {
        use deltachat::accounts::Accounts;
        use deltachat::chat::ChatId;
        use deltachat::message::{MsgId, Viewtype};

        let tmp = tempfile::tempdir().unwrap();
        let mut accounts = Accounts::new(tmp.path().join("accounts"), true)
            .await
            .unwrap();
        let account_id = accounts.add_account().await.unwrap();
        let ctx = accounts.get_account(account_id).unwrap();

        let db = Arc::new(
            crate::db::Db::new(tmp.path().join("test.db"))
                .await
                .unwrap(),
        );
        db.migrate().await.unwrap();
        let ws_id = db.insert_workspace("PEYT Studio", 99, None).await.unwrap();
        let activity = crate::activity::ActivityLog::new(db.clone());
        let mut config = crate::dto::BotConfig::default();
        config.project_context = Some(crate::dto::ProjectContext {
            workspace_id: Some(ws_id),
            chat_ids: vec![],
            description: Some("桌面端协作空间".into()),
            repo_path: None,
        });
        let data_dir = tmp.path().to_path_buf();

        let runtime = BotRuntime {
            bot_id: 1,
            account_id,
            dc: &ctx,
            config: &config,
            db: &db,
            activity: &activity,
            data_dir: &data_dir,
        };
        let incoming = IncomingMsg {
            chat_id: ChatId::new(42),
            msg_id: MsgId::new(7),
            from_addr: "dev@x.io",
            text: Some("/whoami"),
            viewtype: Viewtype::Text,
        };

        let driver = RuleDriver::new();
        let replies = driver.on_message(&runtime, &incoming).await.unwrap();
        assert_eq!(replies.len(), 1);
        assert!(
            replies[0].contains("所属工作区: PEYT Studio"),
            "got: {}",
            replies[0]
        );
        assert!(
            replies[0].contains("项目: 桌面端协作空间"),
            "got: {}",
            replies[0]
        );
    }
}
