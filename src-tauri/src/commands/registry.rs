//! 统一命令注册表:Bot 路径(rule.rs)与用户/系统路径(syscmd.rs)共用的全局命令注册。
//!
//! 设计说明:
//! - handler 类型:任务建议的 `Arc<dyn Fn(...) -> BoxFuture<'static, ...>>` 需要
//!   `futures` crate,但本项目 Cargo.toml 未直接依赖 futures(且文件边界禁止改
//!   Cargo.toml)。因此采用任务给出的备选方案:`#[async_trait] pub trait
//!   CommandHandler`,与 drivers/mod.rs 的 BotDriver 用法一致;`CommandSpec.handler`
//!   存 `Arc<dyn CommandHandler>`。`BoxFuture` 别名(std 手写,不依赖 futures)保留
//!   供 syscmd.rs 的回调类型使用。
//! - 扩展点:summarize/ask 的 handler 为骨架,内部调用 `hooks::summarize` /
//!   `hooks::ask` 占位实现;集成者接入真实实现时替换 hooks 模块即可(接口固定)。
//! - whoami/roll 的真实逻辑已从 rule.rs 迁移:roll 的 N 解析在 `roll_n`,
//!   whoami 的回复拼装在 `whoami_reply`(rule.rs 经 `pub use` 复用)。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, RwLock};

use async_trait::async_trait;
use rand::Rng;

use crate::dto::ProjectContext;
use crate::error::AppResult;

/// 手写 BoxFuture 别名(futures crate 非直接依赖,见模块头注释)。
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 命令可用的执行路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandScope {
    /// 仅 Bot 驱动路径可执行。
    Bot,
    /// 仅用户/系统路径可执行。
    User,
    /// 两侧均可执行。
    Both,
}

/// 命令发起上下文种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    /// 由 Bot 驱动收到消息触发。
    Bot,
    /// 由用户/系统侧(syscmd)触发。
    System,
}

/// 解析出的命令调用(name 不含前导 '/' )。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInvocation {
    pub name: String,
    pub args: Vec<String>,
}

/// 命令执行上下文。`name` 为 parse 得到的命令名(不含 '/' ),供 handle 查表;
/// 在任务给定字段(kind/chat_id/msg_id/args/raw)基础上补充。
pub struct CommandCtx<'a> {
    pub name: String,
    pub kind: CommandKind,
    pub chat_id: u32,
    pub msg_id: u32,
    pub args: Vec<String>,
    pub raw: &'a str,
}

/// 命令处理器:async 方法经 #[async_trait] 对象化(参考 BotDriver 用法)。
#[async_trait]
pub trait CommandHandler: Send + Sync {
    async fn run(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>>;
}

/// 一条已注册命令的完整描述。
#[derive(Clone)]
pub struct CommandSpec {
    pub name: &'static str,
    pub scope: CommandScope,
    pub description: &'static str,
    pub handler: Arc<dyn CommandHandler>,
}

/// 进程级命令注册表(构造后存 Arc;模块内提供 `global()` 单例,装配者也可自建)。
pub struct CommandRegistry {
    inner: RwLock<HashMap<String, CommandSpec>>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// 注册命令;同名命令覆盖旧注册(供集成者替换实现)。
    pub fn register(&self, spec: CommandSpec) {
        self.inner
            .write()
            .unwrap()
            .insert(spec.name.to_string(), spec);
    }

    /// 解析命令文本:trim → 以 '/' 开头 → 命令名(首个空白前)+ 参数按空白分割
    /// (支持双引号包裹含空白的参数)。非命令文本返回 None。
    pub fn parse(text: &str) -> Option<CommandInvocation> {
        let t = text.trim();
        let t = t.strip_prefix('/')?;
        let mut parts = t.splitn(2, char::is_whitespace);
        let name = parts.next()?.trim();
        if name.is_empty() {
            return None;
        }
        let rest = parts.next().unwrap_or("");
        Some(CommandInvocation {
            name: name.to_string(),
            args: split_args(rest),
        })
    }

    /// 按名称查命令(返回克隆;未注册返回 None)。
    pub fn lookup(&self, name: &str) -> Option<CommandSpec> {
        self.inner.read().unwrap().get(name).cloned()
    }

    /// 执行命令:查表执行;未知命令返回「未知命令,发送 /help 查看可用命令」。
    /// scope 校验由调用方(rule.rs / syscmd.rs)通过 `scope_reject` 完成。
    pub async fn handle(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
        let Some(spec) = self.lookup(&ctx.name) else {
            return Ok(vec!["未知命令,发送 /help 查看可用命令".into()]);
        };
        spec.handler.run(ctx).await
    }

    /// scope 与执行上下文匹配检查:不可用返回拒绝提示文本,可用返回 None。
    pub fn scope_reject(spec: &CommandSpec, kind: CommandKind) -> Option<&'static str> {
        match (spec.scope, kind) {
            (CommandScope::Bot, CommandKind::System) => Some("该命令仅 Bot 可用"),
            (CommandScope::User, CommandKind::Bot) => Some("该命令仅用户侧可用"),
            _ => None,
        }
    }

    /// 进程级单例:注册 4 个内置命令。
    pub fn global() -> Arc<CommandRegistry> {
        GLOBAL.clone()
    }
}

/// 进程级单例(惰性构造,注册内置命令)。
static GLOBAL: LazyLock<Arc<CommandRegistry>> = LazyLock::new(default_registry);

/// 内置命令注册表。
pub fn default_registry() -> Arc<CommandRegistry> {
    let reg = Arc::new(CommandRegistry::new());
    reg.register(CommandSpec {
        name: "whoami",
        scope: CommandScope::Bot,
        description: "查看 Bot 身份与所属工作区",
        handler: Arc::new(WhoamiHandler),
    });
    reg.register(CommandSpec {
        name: "roll",
        scope: CommandScope::Bot,
        description: "随机 1-N(参数 N,默认 100)",
        handler: Arc::new(RollHandler),
    });
    reg.register(CommandSpec {
        name: "summarize",
        scope: CommandScope::Both,
        description: "总结最近消息(待接入 knowledge 管线)",
        handler: Arc::new(SummarizeHandler),
    });
    reg.register(CommandSpec {
        name: "ask",
        scope: CommandScope::Both,
        description: "向知识库提问(待接入 knowledge 管线)",
        handler: Arc::new(AskHandler),
    });
    reg
}

// ── 内置 handler ────────────────────────────────────────────────────────────
//
// handler 以「pub async fn + 结构体适配」双形式暴露:结构体用于注册,
// pub fn 供集成者复用/替换(真实实现可改走 hooks 或直接替换 handler 字段)。

/// 扩展点:summarize/ask 的占位实现,集成者替换本模块内函数即可接入真实实现。
/// 注意:rule.rs 的 /summarize 分支因依赖 BotRuntime(LLM 客户端),仍保留原实现;
/// 此处 hooks 面向无 runtime 的上下文(系统路径)。
pub mod hooks {
    use super::*;

    /// 总结占位:集成者替换为 knowledge pipeline 的 store_summary 调用。
    pub async fn summarize(
        _chat_id: u32,
        _msg_id: u32,
        _args: &[String],
    ) -> AppResult<Vec<String>> {
        Ok(vec!["总结功能待接入".into()])
    }

    /// 问答占位:集成者替换为 knowledge ask 的调用。
    pub async fn ask(_chat_id: u32, _msg_id: u32, _args: &[String]) -> AppResult<Vec<String>> {
        Ok(vec!["问答功能待接入".into()])
    }

    /// whoami 占位:全局注册表无 BotRuntime 可查 db/配置,返回通用身份。
    /// Bot 路径的富身份回复仍由 rule.rs 原分支完成(经 whoami_reply 复用)。
    pub async fn whoami(_chat_id: u32, _msg_id: u32, _args: &[String]) -> AppResult<Vec<String>> {
        Ok(vec!["我是 PEYT Bot".into()])
    }
}

/// whoami handler:占位(见 hooks::whoami 注释)。
pub async fn whoami_handler(ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
    hooks::whoami(ctx.chat_id, ctx.msg_id, &ctx.args).await
}

/// /roll 的 N 解析:首个参数为 ≥1 的整数则用之,否则默认 100(从 rule.rs 迁移)。
pub fn roll_n(args: &[String]) -> i64 {
    args.first()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(100)
}

/// roll handler:随机 1..=N 并返回结果文本(从 rule.rs 的 handle_command 迁移)。
pub async fn roll_handler(ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
    let n = roll_n(&ctx.args);
    let roll = rand::thread_rng().gen_range(1..=n);
    Ok(vec![format!("🎲 你掷出了 {roll} (1-{n})")])
}

/// summarize handler:骨架,经 hooks::summarize 占位(见模块头注释)。
pub async fn summarize_handler(ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
    hooks::summarize(ctx.chat_id, ctx.msg_id, &ctx.args).await
}

/// ask handler:骨架,经 hooks::ask 占位(见模块头注释)。
pub async fn ask_handler(ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
    hooks::ask(ctx.chat_id, ctx.msg_id, &ctx.args).await
}

/// whoami 回复拼装(从 rule.rs 迁移;rule.rs 经 `pub use` 复用)。
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

/// 参数按空白分割,支持双引号包裹含空白的参数(引号本身不保留)。
fn split_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in s.chars() {
        match c {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        args.push(cur);
    }
    args
}

// ── 注册用适配结构体 ────────────────────────────────────────────────────────

struct WhoamiHandler;

#[async_trait]
impl CommandHandler for WhoamiHandler {
    async fn run(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
        whoami_handler(ctx).await
    }
}

struct RollHandler;

#[async_trait]
impl CommandHandler for RollHandler {
    async fn run(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
        roll_handler(ctx).await
    }
}

struct SummarizeHandler;

#[async_trait]
impl CommandHandler for SummarizeHandler {
    async fn run(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
        summarize_handler(ctx).await
    }
}

struct AskHandler;

#[async_trait]
impl CommandHandler for AskHandler {
    async fn run(&self, ctx: &CommandCtx<'_>) -> AppResult<Vec<String>> {
        ask_handler(ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(
        kind: CommandKind,
        name: &str,
        args: Vec<String>,
        raw: &'a str,
    ) -> CommandCtx<'a> {
        CommandCtx {
            name: name.to_string(),
            kind,
            chat_id: 1,
            msg_id: 2,
            args,
            raw,
        }
    }

    #[test]
    fn parse_bare_command() {
        assert_eq!(
            CommandRegistry::parse("/whoami"),
            Some(CommandInvocation {
                name: "whoami".into(),
                args: vec![]
            })
        );
        assert_eq!(
            CommandRegistry::parse("  /roll  "),
            Some(CommandInvocation {
                name: "roll".into(),
                args: vec![]
            })
        );
    }

    #[test]
    fn parse_with_plain_args() {
        assert_eq!(
            CommandRegistry::parse("/roll 6 9"),
            Some(CommandInvocation {
                name: "roll".into(),
                args: vec!["6".into(), "9".into()]
            })
        );
    }

    #[test]
    fn parse_quoted_args_keep_whitespace() {
        assert_eq!(
            CommandRegistry::parse("/summarize \"a b\" c"),
            Some(CommandInvocation {
                name: "summarize".into(),
                args: vec!["a b".into(), "c".into()]
            })
        );
        assert_eq!(
            CommandRegistry::parse("/ask \"  spaced  \"x"),
            Some(CommandInvocation {
                name: "ask".into(),
                args: vec!["  spaced  x".into()]
            })
        );
    }

    #[test]
    fn parse_unknown_command_still_invocation() {
        let inv = CommandRegistry::parse("/nope a").unwrap();
        assert_eq!(inv.name, "nope");
        assert_eq!(inv.args, vec!["a".to_string()]);
    }

    #[test]
    fn parse_non_command_is_none() {
        assert_eq!(CommandRegistry::parse("hello"), None);
        assert_eq!(CommandRegistry::parse(""), None);
        assert_eq!(CommandRegistry::parse("  "), None);
        assert_eq!(CommandRegistry::parse("/"), None);
        assert_eq!(CommandRegistry::parse("/ "), None);
    }

    #[test]
    fn register_lookup_roundtrip() {
        let reg = default_registry();
        let spec = reg.lookup("roll").expect("roll registered");
        assert_eq!(spec.name, "roll");
        assert_eq!(spec.scope, CommandScope::Bot);
        assert_eq!(reg.lookup("whoami").unwrap().scope, CommandScope::Bot);
        assert_eq!(reg.lookup("summarize").unwrap().scope, CommandScope::Both);
        assert_eq!(reg.lookup("ask").unwrap().scope, CommandScope::Both);
    }

    #[test]
    fn lookup_unknown_is_none() {
        let reg = default_registry();
        assert!(reg.lookup("nope").is_none());
    }

    #[test]
    fn register_overwrites_previous() {
        let reg = CommandRegistry::new();
        reg.register(CommandSpec {
            name: "foo",
            scope: CommandScope::Bot,
            description: "first",
            handler: Arc::new(WhoamiHandler),
        });
        reg.register(CommandSpec {
            name: "foo",
            scope: CommandScope::Both,
            description: "second",
            handler: Arc::new(WhoamiHandler),
        });
        let spec = reg.lookup("foo").unwrap();
        assert_eq!(spec.description, "second");
        assert_eq!(spec.scope, CommandScope::Both);
    }

    #[test]
    fn scope_reject_bot_only_in_system() {
        let spec = CommandSpec {
            name: "whoami",
            scope: CommandScope::Bot,
            description: "",
            handler: Arc::new(WhoamiHandler),
        };
        assert_eq!(
            CommandRegistry::scope_reject(&spec, CommandKind::System),
            Some("该命令仅 Bot 可用")
        );
        assert_eq!(CommandRegistry::scope_reject(&spec, CommandKind::Bot), None);
        let both = CommandSpec {
            name: "summarize",
            scope: CommandScope::Both,
            description: "",
            handler: Arc::new(WhoamiHandler),
        };
        assert_eq!(CommandRegistry::scope_reject(&both, CommandKind::System), None);
        assert_eq!(CommandRegistry::scope_reject(&both, CommandKind::Bot), None);
    }

    #[tokio::test]
    async fn handle_unknown_returns_hint() {
        let reg = default_registry();
        let c = ctx(CommandKind::System, "nope", vec![], "/nope");
        assert_eq!(
            reg.handle(&c).await.unwrap(),
            vec!["未知命令,发送 /help 查看可用命令".to_string()]
        );
    }

    #[tokio::test]
    async fn handle_dispatch_registered_command() {
        let reg = default_registry();
        let c = ctx(CommandKind::Bot, "summarize", vec![], "/summarize");
        assert_eq!(reg.handle(&c).await.unwrap(), vec!["总结功能待接入".to_string()]);
        let c = ctx(CommandKind::System, "ask", vec![], "/ask hi");
        assert_eq!(reg.handle(&c).await.unwrap(), vec!["问答功能待接入".to_string()]);
    }

    #[tokio::test]
    async fn roll_handler_default_100() {
        let reg = default_registry();
        for _ in 0..30 {
            let c = ctx(CommandKind::Bot, "roll", vec![], "/roll");
            let replies = reg.handle(&c).await.unwrap();
            assert_eq!(replies.len(), 1);
            let r = &replies[0];
            assert!(r.starts_with("🎲 你掷出了 "), "unexpected: {r}");
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

    #[tokio::test]
    async fn roll_handler_with_arg() {
        let reg = default_registry();
        for _ in 0..30 {
            let c = ctx(CommandKind::Bot, "roll", vec!["10".into()], "/roll 10");
            let r = &reg.handle(&c).await.unwrap()[0];
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
        let c = ctx(CommandKind::Bot, "roll", vec!["0".into()], "/roll 0");
        assert!(reg.handle(&c).await.unwrap()[0].ends_with("(1-100)"));
    }

    #[tokio::test]
    async fn summarize_hooks_placeholder() {
        assert_eq!(
            hooks::summarize(1, 1, &[]).await.unwrap(),
            vec!["总结功能待接入".to_string()]
        );
    }

    #[tokio::test]
    async fn ask_hooks_placeholder() {
        assert_eq!(
            hooks::ask(1, 1, &["hello".into()]).await.unwrap(),
            vec!["问答功能待接入".to_string()]
        );
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
            github_token: None,
            ..Default::default()
        };
        let r = whoami_reply("Bot", "bot@x.io", Some(&pc), None);
        assert!(r.starts_with("我是 Bot(bot@x.io)"), "got: {r}");
        assert!(r.contains("所属工作区: 7"), "got: {r}");
        assert!(r.contains("项目: PEYT 桌面端"), "got: {r}");
    }
}
