pub mod bridge;
pub mod builtins;
pub mod net;
pub mod file;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use deltachat::chat::ChatId;
use deltachat::context::Context;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::tools::bridge::ToolBridge;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn parameters(&self) -> serde_json::Value; // JSON Schema
    /// 该工具是否默认开放给 LLM(危险工具如写文件/建卡片设为 false)
    fn is_safe(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String>;
}

pub struct ToolContext<'a> {
    pub dc: &'a Context,
    pub db: &'a Db,
    pub bot_id: i64,
    pub chat_id: ChatId,
    pub data_dir: &'a PathBuf,
}

pub struct ToolRegistry {
    tools: Vec<Arc<dyn Tool>>,
    pub bridge: Arc<ToolBridge>,
}

impl ToolRegistry {
    pub fn new(bridge: Arc<ToolBridge>) -> Self {
        Self {
            tools: Vec::new(),
            bridge,
        }
    }

    pub fn register(&mut self, t: Arc<dyn Tool>) {
        self.tools.push(t);
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.tools.iter().map(|t| t.name()).collect()
    }

    /// enabled = None → 仅 is_safe() 的默认工具集;Some(names) → 恰好这些出现在注册表中的工具
    pub fn defs_for(&self, enabled: Option<&[String]>) -> Vec<serde_json::Value> {
        self.tools
            .iter()
            .filter(|t| match enabled {
                None => t.is_safe(),
                Some(names) => names.iter().any(|n| n == t.name()),
            })
            .map(|t| {
                serde_json::json!({
                    "name": t.name(),
                    "description": t.description(),
                    "parameters": t.parameters(),
                })
            })
            .collect()
    }

    pub async fn execute(
        &self,
        name: &str,
        arguments: &str,
        ctx: &ToolContext<'_>,
    ) -> AppResult<String> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.name() == name)
            .ok_or_else(|| AppError::Core(format!("未知工具: {name}")))?;
        let args: serde_json::Value = serde_json::from_str(arguments)
            .map_err(|_| AppError::Core("工具参数非法 JSON".into()))?;
        tool.execute(args, ctx).await
    }

    pub fn has(&self, name: &str) -> bool {
        self.tools.iter().any(|t| t.name() == name)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;
    use crate::error::AppResult;
    use crate::tools::bridge::ToolBridge;

    struct FakeTool {
        name: &'static str,
        safe: bool,
    }

    impl FakeTool {
        fn new(name: &'static str, safe: bool) -> Self {
            Self { name, safe }
        }
    }

    #[async_trait]
    impl Tool for FakeTool {
        fn name(&self) -> &'static str {
            self.name
        }

        fn description(&self) -> &'static str {
            "fake tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object", "properties": {} })
        }

        fn is_safe(&self) -> bool {
            self.safe
        }

        async fn execute(
            &self,
            args: serde_json::Value,
            _ctx: &ToolContext<'_>,
        ) -> AppResult<String> {
            Ok(args["x"]
                .as_i64()
                .map(|v| v.to_string())
                .unwrap_or_default())
        }
    }

    /// 持有构造 ToolContext 所需的所有权对象(短生命周期,仅测试用)。
    struct TestCtx {
        _tmp: tempfile::TempDir,
        dc: Context,
        db: Db,
        data_dir: std::path::PathBuf,
    }

    impl TestCtx {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut accounts = deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
                .await
                .unwrap();
            let id = accounts.add_account().await.unwrap();
            let dc = accounts.get_account(id).unwrap();
            let db = Db::new(tmp.path().join("app.db")).await.unwrap();
            let data_dir = tmp.path().to_path_buf();
            Self {
                _tmp: tmp,
                dc,
                db,
                data_dir,
            }
        }

        fn tool_ctx(&self) -> ToolContext<'_> {
            ToolContext {
                dc: &self.dc,
                db: &self.db,
                bot_id: 1,
                chat_id: ChatId::new(123),
                data_dir: &self.data_dir,
            }
        }
    }

    fn registry_with_fakes() -> ToolRegistry {
        let mut reg = ToolRegistry::new(Arc::new(ToolBridge::new()));
        reg.register(Arc::new(FakeTool::new("t1", true)));
        reg.register(Arc::new(FakeTool::new("t2", false)));
        reg
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_registry_names_and_has() {
        let reg = registry_with_fakes();
        let mut names = reg.names();
        names.sort();
        assert_eq!(names, vec!["t1", "t2"]);
        assert!(reg.has("t1"));
        assert!(reg.has("t2"));
        assert!(!reg.has("nope"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_execute_unknown_tool() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let reg = ToolRegistry::new(Arc::new(ToolBridge::new()));
        let err = reg.execute("ghost", "{}", &ctx).await.unwrap_err();
        assert!(err.to_string().contains("未知工具"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_execute_passes_parsed_args() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let mut reg = ToolRegistry::new(Arc::new(ToolBridge::new()));
        reg.register(Arc::new(FakeTool::new("t1", true)));
        let out = reg.execute("t1", r#"{"x": 42}"#, &ctx).await.unwrap();
        assert_eq!(out, "42");
        let err = reg.execute("t1", "not json", &ctx).await.unwrap_err();
        assert!(err.to_string().contains("非法"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_defs_for_filters() {
        let reg = registry_with_fakes();

        let defs_none = reg.defs_for(None);
        assert_eq!(defs_none.len(), 1);
        assert_eq!(defs_none[0]["name"], "t1");

        let defs_some = reg.defs_for(Some(&["t2".to_string()]));
        assert_eq!(defs_some.len(), 1);
        assert_eq!(defs_some[0]["name"], "t2");

        for def in &defs_none {
            assert!(def["name"].is_string());
            assert!(def["description"].is_string());
            assert!(def["parameters"].is_object());
        }
    }

    #[test]
    fn test_bridge_resolve_unknown_id() {
        let bridge = ToolBridge::new();
        assert!(!bridge.resolve("no-such-id", "x".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_bridge_round_trip() {
        let captured: Arc<StdMutex<Vec<serde_json::Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let bridge = Arc::new(ToolBridge::new().with_emitter({
            let captured = captured.clone();
            move |v: serde_json::Value| {
                captured.lock().unwrap().push(v);
            }
        }));
        let bridge2 = bridge.clone();
        let captured2 = captured.clone();
        let resolver = tokio::spawn(async move {
            let id = loop {
                let first = captured2.lock().unwrap().first().cloned();
                if let Some(v) = first {
                    break v["id"].as_str().unwrap().to_string();
                }
                tokio::task::yield_now().await;
            };
            bridge2.resolve(&id, "桥接结果".to_string());
        });
        let out = bridge
            .request("plugin_tool", serde_json::json!({ "q": 1 }))
            .await
            .unwrap();
        assert_eq!(out, "桥接结果");
        resolver.await.unwrap();

        let emitted = captured.lock().unwrap().first().unwrap().clone();
        assert_eq!(emitted["kind"], "tool_request");
        assert_eq!(emitted["name"], "plugin_tool");
        assert_eq!(emitted["args"]["q"], 1);
    }
}
