//! Bot 代码工具:4 个只读工具(is_safe=true),薄封装 [`crate::code::CodeSource`]。
//!
//! CodeSource 每个 execute 从 bot 配置 `project_context` 构建:
//! `repo_local_path`(存在目录)→ Local;否则 `repo_path`("owner/repo")→ Github 回退
//! (token 复用 [`crate::tools::github::resolve_token`],bot token → 全局 token)。
//! 未配置项目仓库 → 统一错误「未配置项目仓库」。

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::code::{CodeEntry, CodeSource};
use crate::dto::BotConfig;
use crate::error::{AppError, AppResult};
use crate::github::client::{GithubAuth, GithubClient};
use crate::tools::github::{opt_str, req_str, resolve_token};
use crate::tools::{Tool, ToolContext};

/// 从 bot 配置构建 CodeSource;无 project_context 或不可解析 → 错误。
async fn code_source(ctx: &ToolContext<'_>) -> AppResult<CodeSource> {
    let raw = ctx.db.get_bot_config_by_id(ctx.bot_id).await?;
    let source = BotConfig::parse(raw.as_deref())
        .and_then(|cfg| cfg.project_context)
        .and_then(|pc| CodeSource::from_project_context(&pc));
    source.ok_or_else(|| {
        AppError::Core("未配置项目仓库,请配置 repo_local_path 或 repo_path".into())
    })
}

/// 目录项格式化:目录 `{name}/`,文件 `{name} ({size}B)`,按 name 排序(与 code/list_tree 确定性一致);
/// 空 → `(空目录)`。
fn format_entries(entries: &[CodeEntry]) -> String {
    if entries.is_empty() {
        return "(空目录)".to_string();
    }
    let mut sorted: Vec<&CodeEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    sorted
        .iter()
        .map(|e| {
            if e.is_dir {
                format!("{}/", e.name)
            } else {
                format!("{} ({}B)", e.name, e.size)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- 工具定义(宏生成 struct + Tool impl)----

macro_rules! code_tool {
    ($struct:ident, $name:literal, $desc:literal, $params:expr, $handler:ident) => {
        pub struct $struct {
            client: Arc<GithubClient>,
        }

        impl $struct {
            pub fn new(client: Arc<GithubClient>) -> Self {
                Self { client }
            }
        }

        #[async_trait]
        impl Tool for $struct {
            fn name(&self) -> &'static str {
                $name
            }

            fn description(&self) -> &'static str {
                $desc
            }

            fn parameters(&self) -> serde_json::Value {
                $params
            }

            async fn execute(
                &self,
                args: Value,
                ctx: &ToolContext<'_>,
            ) -> AppResult<String> {
                $handler(self, args, ctx).await
            }
        }
    };
}

code_tool!(
    ListProjectFilesTool,
    "list_project_files",
    "列出项目仓库目录结构(单层;prefix 指定子目录相对路径)",
    json!({
        "type": "object",
        "properties": {
            "prefix": { "type": "string", "description": "子目录相对路径,缺省为根目录" }
        }
    }),
    handle_list_project_files
);

code_tool!(
    ReadProjectFileTool,
    "read_project_file",
    "读取项目仓库文件内容(≤64KB,超限截断)",
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "仓库内文件相对路径" }
        },
        "required": ["path"]
    }),
    handle_read_project_file
);

code_tool!(
    FindProjectFilesTool,
    "find_project_files",
    "按文件名在项目仓库中查找文件(忽略大小写,最多 20 个)",
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "文件名包含匹配关键字" }
        },
        "required": ["name"]
    }),
    handle_find_project_files
);

code_tool!(
    ListProjectRootTool,
    "list_project_root",
    "列出项目仓库根目录项(名称/类型/大小)",
    json!({ "type": "object", "properties": {} }),
    handle_list_project_root
);

// ---- handler ----

async fn handle_list_project_files(
    tool: &ListProjectFilesTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let prefix = opt_str(&args, "prefix").unwrap_or_default();
    let source = code_source(ctx).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let entries = source.list_tree(&tool.client, &auth, &prefix).await?;
    Ok(format_entries(&entries))
}

async fn handle_list_project_root(
    tool: &ListProjectRootTool,
    _args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let source = code_source(ctx).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let entries = source.list_tree(&tool.client, &auth, "").await?;
    Ok(format_entries(&entries))
}

async fn handle_read_project_file(
    tool: &ReadProjectFileTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let path = req_str(&args, "path")?;
    let source = code_source(ctx).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let content = source.read_file(&tool.client, &auth, &path).await?;
    Ok(format!("path: {path}\n{content}"))
}

async fn handle_find_project_files(
    tool: &FindProjectFilesTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let name = req_str(&args, "name")?;
    let source = code_source(ctx).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let entries = source.find_files(&tool.client, &auth, &name).await?;
    if entries.is_empty() {
        return Ok("(未找到匹配文件)".to_string());
    }
    Ok(entries
        .iter()
        .map(|e| e.path.clone())
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use deltachat::chat::ChatId;
    use deltachat::context::Context;
    use serde_json::json;

    use super::*;
    use crate::db::Db;

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
            let mut accounts =
                deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
                    .await
                    .unwrap();
            let id = accounts.add_account().await.unwrap();
            let dc = accounts.get_account(id).unwrap();
            let db = Db::new(tmp.path().join("app.db")).await.unwrap();
            db.migrate().await.unwrap();
            let data_dir = tmp.path().to_path_buf();
            Self {
                _tmp: tmp,
                dc,
                db,
                data_dir,
            }
        }

        fn tool_ctx(&self, bot_id: i64) -> ToolContext<'_> {
            ToolContext {
                dc: &self.dc,
                db: &self.db,
                bot_id,
                chat_id: ChatId::new(123),
                data_dir: &self.data_dir,
            }
        }

        /// 在测试临时目录下建仓库并配到 bot 的 project_context(repo_local_path)。
        async fn install_repo(&self, bot_id: i64) -> std::path::PathBuf {
            let root = self._tmp.path().join("repo");
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::write(root.join("README.md"), "hello").unwrap();
            std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
            std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
            let cfg = json!({
                "llm": null,
                "project_context": {
                    "repo_local_path": root.to_string_lossy(),
                    "sandbox_mode": "repo"
                }
            });
            self.db
                .set_bot_config_by_id(bot_id, Some(&cfg.to_string()))
                .await
                .unwrap();
            root
        }
    }

    fn client() -> Arc<GithubClient> {
        Arc::new(GithubClient::new())
    }

    /// 4 个工具全量(共享一个 client)。
    fn all_tools() -> Vec<Box<dyn Tool>> {
        let c = client();
        vec![
            Box::new(ListProjectFilesTool::new(c.clone())),
            Box::new(ReadProjectFileTool::new(c.clone())),
            Box::new(FindProjectFilesTool::new(c.clone())),
            Box::new(ListProjectRootTool::new(c)),
        ]
    }

    #[test]
    fn test_meta_unique_and_all_safe() {
        let tools = all_tools();
        assert_eq!(tools.len(), 4);
        let mut names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
        names.sort();
        let mut dedup = names.clone();
        dedup.dedup();
        assert_eq!(names, dedup, "工具名应唯一");
        for t in tools {
            assert!(!t.description().is_empty());
            assert_eq!(t.parameters()["type"], "object");
            assert!(t.is_safe(), "代码工具应全部 is_safe=true: {}", t.name());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_read_project_file_missing_path() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = ReadProjectFileTool::new(client());
        let err = tool.execute(json!({}), &ctx).await.unwrap_err();
        assert!(err.to_string().contains("缺少参数: path"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_project_files_missing_name() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = FindProjectFilesTool::new(client());
        let err = tool.execute(json!({}), &ctx).await.unwrap_err();
        assert!(err.to_string().contains("缺少参数: name"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_unconfigured_repo_error() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        let ctx = owned.tool_ctx(bot_id);
        let tools = all_tools();
        for t in tools {
            let args = match t.name() {
                "read_project_file" => json!({ "path": "a.rs" }),
                "find_project_files" => json!({ "name": "main" }),
                _ => json!({}),
            };
            let err = t.execute(args, &ctx).await.unwrap_err();
            assert!(
                err.to_string().contains("未配置项目仓库"),
                "{} 未配置仓库应报错,实际: {}",
                t.name(),
                err
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_unconfigured_no_project_context_error() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        // 配置存在但无 project_context → 同样报未配置仓库
        owned
            .db
            .set_bot_config_by_id(bot_id, Some(r#"{ "llm": null }"#))
            .await
            .unwrap();
        let ctx = owned.tool_ctx(bot_id);
        let tool = ListProjectRootTool::new(client());
        let err = tool.execute(json!({}), &ctx).await.unwrap_err();
        assert!(err.to_string().contains("未配置项目仓库"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_project_root_formats_dir_and_file() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        owned.install_repo(bot_id).await;
        let ctx = owned.tool_ctx(bot_id);
        let tool = ListProjectRootTool::new(client());
        let out = tool.execute(json!({}), &ctx).await.unwrap();
        assert!(out.contains("src/"), "目录行应为 {{name}}/: {out}");
        assert!(out.contains("README.md (5B)"), "文件行应为 {{name}} ({{size}}B): {out}");
        assert!(out.contains("Cargo.toml (9B)"));
        // 与 code/list_tree 一致的确定性:按 name 排序
        let lines: Vec<&str> = out.lines().collect();
        let mut sorted = lines.to_vec();
        sorted.sort();
        assert_eq!(lines, sorted, "输出应按名称排序");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_project_files_with_prefix() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        owned.install_repo(bot_id).await;
        let ctx = owned.tool_ctx(bot_id);
        let tool = ListProjectFilesTool::new(client());
        let out = tool
            .execute(json!({ "prefix": "src" }), &ctx)
            .await
            .unwrap();
        assert_eq!(out, "main.rs (13B)");
        // 根目录(无 prefix)
        let root = tool.execute(json!({}), &ctx).await.unwrap();
        assert!(root.contains("src/"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_project_root_empty_dir() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        let root = owned._tmp.path().join("empty_repo");
        std::fs::create_dir_all(&root).unwrap();
        let cfg = json!({
            "llm": null,
            "project_context": { "repo_local_path": root.to_string_lossy() }
        });
        owned
            .db
            .set_bot_config_by_id(bot_id, Some(&cfg.to_string()))
            .await
            .unwrap();
        let ctx = owned.tool_ctx(bot_id);
        let tool = ListProjectRootTool::new(client());
        let out = tool.execute(json!({}), &ctx).await.unwrap();
        assert_eq!(out, "(空目录)");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_read_project_file_prefix_and_content() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        owned.install_repo(bot_id).await;
        let ctx = owned.tool_ctx(bot_id);
        let tool = ReadProjectFileTool::new(client());
        let out = tool
            .execute(json!({ "path": "README.md" }), &ctx)
            .await
            .unwrap();
        assert!(out.starts_with("path: README.md\n"), "应带 path: 前缀: {out}");
        assert!(out.ends_with("hello"));
        // 读目录 → 不是文件
        let err = tool
            .execute(json!({ "path": "src" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("不是文件"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_project_files_local() {
        let owned = TestCtx::new().await;
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        owned.install_repo(bot_id).await;
        let ctx = owned.tool_ctx(bot_id);
        let tool = FindProjectFilesTool::new(client());
        // 忽略大小写包含匹配
        let out = tool
            .execute(json!({ "name": "MAIN" }), &ctx)
            .await
            .unwrap();
        assert_eq!(out, "src/main.rs");
        // 无匹配 → 提示
        let none = tool
            .execute(json!({ "name": "zzz_absent" }), &ctx)
            .await
            .unwrap();
        assert_eq!(none, "(未找到匹配文件)");
    }

    #[test]
    fn test_format_entries_sort_and_empty() {
        let entries = vec![
            CodeEntry {
                path: "src".into(),
                name: "src".into(),
                is_dir: true,
                size: 0,
            },
            CodeEntry {
                path: "a.txt".into(),
                name: "a.txt".into(),
                is_dir: false,
                size: 3,
            },
        ];
        assert_eq!(format_entries(&entries), "a.txt (3B)\nsrc/");
        assert_eq!(format_entries(&[]), "(空目录)");
    }

    #[test]
    fn test_global_index_cache_singleton() {
        let a = crate::code::global_index_cache();
        let b = crate::code::global_index_cache();
        assert!(Arc::ptr_eq(&a, &b), "全局索引缓存应为同一 Arc 单例");
    }
}
