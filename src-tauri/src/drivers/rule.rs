use std::collections::HashSet;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use deltachat::config::Config;
use rand::Rng;
use regex::Regex;

use super::{BotDriver, BotRuntime, DriverKind, IncomingMsg};
use crate::dto::bot_activity_kind as act;
use crate::dto::RuleConfig;
use crate::error::AppResult;

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

/// 规则驱动:处理指令彩蛋、进群欢迎语、关键词/正则规则与兜底文案。
/// `seen` 记录 (bot_id, chat_id),保证每个会话的欢迎语只发一次。
pub struct RuleDriver {
    seen: StdMutex<HashSet<(i64, u32)>>,
}

impl RuleDriver {
    pub fn new() -> Self {
        Self {
            seen: StdMutex::new(HashSet::new()),
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
        // 1. 指令彩蛋(不依赖 rule 配置)。
        if let Some(text) = msg.text {
            let text = text.trim();
            if text.starts_with('/') {
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
                if let Some(reply) = handle_command(text, &bot_name, &bot_addr) {
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

/// 彩蛋指令:命中返回回复文本,否则 None。未知指令返回 None(交由规则/兜底处理)。
pub fn handle_command(text: &str, bot_name: &str, bot_addr: &str) -> Option<String> {
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
        "/whoami" => Some(format!("我是 {bot_name}({bot_addr})")),
        "/help" => Some("可用指令: /roll /dice /coin /8ball /whoami".into()),
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
            let r = handle_command("/roll 10", "bot", "b@x.io").unwrap();
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
            let r = handle_command("/roll", "bot", "b@x.io").unwrap();
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
            let r = handle_command("/dice", "bot", "b@x.io").unwrap();
            let n = r.trim_start_matches("🎲 骰子: ").parse::<i64>().unwrap();
            assert!((1..=6).contains(&n), "dice out of range: {n}");
        }
    }

    #[test]
    fn coin_is_head_or_tail() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let r = handle_command("/coin", "bot", "b@x.io").unwrap();
            assert!(r == "🪙 正面" || r == "🪙 反面", "unexpected: {r}");
            seen.insert(r);
        }
        assert!(seen.len() == 2, "coin should flip both sides, got {seen:?}");
    }

    #[test]
    fn eight_ball_prefix() {
        for _ in 0..50 {
            let r = handle_command("/8ball", "bot", "b@x.io").unwrap();
            assert!(r.starts_with('🎱'), "unexpected: {r}");
        }
    }

    #[test]
    fn whoami_contains_bot_name() {
        let r = handle_command("/whoami", "小明", "ming@x.io").unwrap();
        assert!(r.contains("小明"));
        assert!(r.contains("ming@x.io"));
    }

    #[test]
    fn help_lists_commands() {
        let r = handle_command("/help", "bot", "b@x.io").unwrap();
        assert!(r.contains("/roll"));
        assert!(r.contains("/dice"));
        assert!(r.contains("/coin"));
        assert!(r.contains("/8ball"));
        assert!(r.contains("/whoami"));
    }

    #[test]
    fn unknown_and_plain_text_are_none() {
        assert!(handle_command("hello", "bot", "b@x.io").is_none());
        assert!(handle_command("/unknown", "bot", "b@x.io").is_none());
        assert!(handle_command("", "bot", "b@x.io").is_none());
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
}
