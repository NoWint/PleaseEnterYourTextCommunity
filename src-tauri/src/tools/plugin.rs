use std::sync::Arc;

use async_trait::async_trait;

use crate::db::PluginToolRow;
use crate::error::AppResult;
use crate::tools::bridge::ToolBridge;
use crate::tools::{Tool, ToolContext};

/// 插件工具:定义存 bot_plugin_tools 表,执行经 ToolBridge 前端往返。
pub struct PluginTool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub bridge: Arc<ToolBridge>,
}

impl PluginTool {
    pub fn from_row(row: &PluginToolRow, bridge: Arc<ToolBridge>) -> Self {
        Self {
            name: row.name.clone(),
            description: row.description.clone(),
            parameters: serde_json::from_str(&row.parameters)
                .unwrap_or_else(|_| serde_json::json!({"type":"object"})),
            bridge,
        }
    }
}

#[async_trait]
impl Tool for PluginTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> serde_json::Value {
        self.parameters.clone()
    }

    fn is_safe(&self) -> bool {
        false
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        self.bridge.request(&self.name, args).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;
    use crate::tools::bridge::ToolBridge;

    struct TestCtx {
        _tmp: tempfile::TempDir,
        dc: Context,
        db: Db,
        data_dir: std::path::PathBuf,
    }

    impl TestCtx {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut accounts =
                deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
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

    fn row(name: &str, desc: &str, parameters: &str) -> PluginToolRow {
        PluginToolRow {
            name: name.to_string(),
            description: desc.to_string(),
            parameters: parameters.to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn from_row_valid_parameters_round_trips() {
        let schema = r#"{"type":"object","properties":{"q":{"type":"integer"}}}"#;
        let tool = PluginTool::from_row(&row("pl", "desc", schema), Arc::new(ToolBridge::new()));
        assert_eq!(tool.name, "pl");
        assert_eq!(tool.description, "desc");
        assert_eq!(
            tool.parameters,
            serde_json::json!({"type":"object","properties":{"q":{"type":"integer"}}})
        );
    }

    #[test]
    fn from_row_invalid_parameters_defaults() {
        let tool =
            PluginTool::from_row(&row("pl", "desc", "not json"), Arc::new(ToolBridge::new()));
        assert_eq!(tool.parameters, serde_json::json!({"type":"object"}));
    }

    #[test]
    fn plugin_tool_is_not_safe() {
        let tool = PluginTool::from_row(&row("pl", "desc", "{}"), Arc::new(ToolBridge::new()));
        assert!(!tool.is_safe());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn execute_round_trips_through_bridge() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();

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
            tokio::time::sleep(Duration::from_millis(100)).await;
            let emitted = captured2.lock().unwrap().first().cloned().unwrap();
            let id = emitted["id"].as_str().unwrap().to_string();
            bridge2.resolve(&id, "plugin-ok".to_string());
        });

        let tool = PluginTool::from_row(&row("plugin_tool", "desc", "{}"), bridge);
        let out = tool
            .execute(serde_json::json!({"q": 1}), &ctx)
            .await
            .unwrap();
        assert_eq!(out, "plugin-ok");
        resolver.await.unwrap();

        let emitted = captured.lock().unwrap().first().unwrap().clone();
        assert_eq!(emitted["kind"], "tool_request");
        assert_eq!(emitted["name"], "plugin_tool");
        assert_eq!(emitted["args"]["q"], 1);
    }
}
