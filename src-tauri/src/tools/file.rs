//! 沙箱文件工具:read_file / write_file / list_files。
//!
//! 每个 Bot 有独立私有目录 `data_dir/bot_files/{bot_id}/`,所有路径经
//! [`resolve_safe`] 校验,禁止越界(绝对路径 / `..` / `~` / 符号链接逃逸)。

use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::tools::{Tool, ToolContext};

const MAX_READ: usize = 64 * 1024;
const MAX_WRITE: usize = 256 * 1024;

/// 解析相对路径到沙箱内绝对路径;越界返回 Err。
///
/// 规则:
/// - `rel` 必须非空;拒绝绝对路径、盘符,以及任意 `..` / `~` 组件;
/// - 根目录 = `data_dir/bot_files/{bot_id}`;
/// - 已存在路径 `canonicalize` 后校验前缀在根内(防符号链接逃逸);
/// - 不存在路径(写场景)校验最深存在的祖先仍在根内。
pub fn resolve_safe(data_dir: &Path, bot_id: i64, rel: &str) -> AppResult<PathBuf> {
    if rel.is_empty() {
        return Err(AppError::Core("路径为空".into()));
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(AppError::Core("路径越界".into()));
    }
    let b = rel.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return Err(AppError::Core("路径越界".into()));
    }
    let root = data_dir.join("bot_files").join(bot_id.to_string());
    let mut parts: Vec<&str> = Vec::new();
    for p in rel.split(['/', '\\']) {
        match p {
            "" | "." => {}
            ".." | "~" => return Err(AppError::Core("路径越界".into())),
            _ => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(AppError::Core("路径为空".into()));
    }
    let mut candidate = root.clone();
    for p in parts {
        candidate.push(p);
    }
    if candidate.exists() {
        let canon = candidate
            .canonicalize()
            .map_err(|_| AppError::Core("路径越界".into()))?;
        let canon_root = root
            .canonicalize()
            .map_err(|_| AppError::Core("路径越界".into()))?;
        if !canon.starts_with(&canon_root) {
            return Err(AppError::Core("路径越界".into()));
        }
        return Ok(canon);
    }
    // 不存在:从最深存在的祖先校验(防父目录符号链接逃逸)。
    let mut anc = candidate.as_path();
    let mut existing: Option<PathBuf> = None;
    while !anc.exists() {
        match anc.parent() {
            Some(p) => anc = p,
            None => break,
        }
    }
    if anc.exists() {
        existing = Some(anc.to_path_buf());
    }
    if let Some(ex) = existing {
        if let (Ok(canon_ex), Ok(canon_root)) = (ex.canonicalize(), root.canonicalize()) {
            if !canon_ex.starts_with(&canon_root) {
                return Err(AppError::Core("路径越界".into()));
            }
        }
    }
    Ok(candidate)
}

/// 读取沙箱文件(≤64KB)。
pub struct ReadFileTool;

/// 写入沙箱文件(≤256KB,自动建父目录)。
pub struct WriteFileTool;

/// 列出沙箱目录内容。
pub struct ListFilesTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn description(&self) -> &'static str {
        "读取 Bot 沙箱目录中的文件(≤64KB)"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" }
            },
            "required": ["path"]
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let path = resolve_safe(ctx.data_dir, ctx.bot_id, rel)?;
        let bytes = std::fs::read(&path)?;
        if bytes.len() > MAX_READ {
            return Err(AppError::Core(format!("文件过大(>{}KB)", MAX_READ / 1024)));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &'static str {
        "write_file"
    }

    fn description(&self) -> &'static str {
        "写入文件到 Bot 沙箱目录(≤256KB)"
    }

    fn is_safe(&self) -> bool {
        false
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "content": { "type": "string" }
            },
            "required": ["path", "content"]
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let path = resolve_safe(ctx.data_dir, ctx.bot_id, rel)?;
        if content.len() > MAX_WRITE {
            return Err(AppError::Core(format!("内容过大(>{}KB)", MAX_WRITE / 1024)));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
        Ok(format!("已写入 {} ({} 字节)", rel, content.len()))
    }
}

#[async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &'static str {
        "list_files"
    }

    fn description(&self) -> &'static str {
        "列出 Bot 沙箱目录内容"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "子目录,默认根" }
            }
        })
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext<'_>) -> AppResult<String> {
        let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let dir = if rel.is_empty() {
            ctx.data_dir.join("bot_files").join(ctx.bot_id.to_string())
        } else {
            resolve_safe(ctx.data_dir, ctx.bot_id, rel)?
        };
        let mut lines: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let line = if entry.path().is_dir() {
                format!("[目录]/{}", name)
            } else {
                format!("{}", name)
            };
            lines.push(line);
        }
        lines.sort();
        lines.truncate(100);
        if lines.is_empty() {
            return Ok("(空目录)".to_string());
        }
        Ok(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;
    use crate::tools::ToolContext;

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

    fn root_of(data_dir: &std::path::Path, bot_id: i64) -> std::path::PathBuf {
        data_dir.join("bot_files").join(bot_id.to_string())
    }

    #[test]
    fn test_resolve_safe_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let out = resolve_safe(data_dir, 1, "a/b.txt").unwrap();
        assert!(out.starts_with(root_of(data_dir, 1)));
        assert!(out.ends_with("b.txt"));
    }

    #[test]
    fn test_resolve_safe_rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        for bad in ["../x", "/etc/passwd", "", "~/x", "..", "C:\\x", "a/../b"] {
            assert!(
                resolve_safe(data_dir, 1, bad).is_err(),
                "应拒绝路径: {:?}",
                bad
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_write_read_round_trip() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let out = WriteFileTool
            .execute(
                serde_json::json!({"path": "notes/a.txt", "content": "你好,沙箱"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(out.contains("已写入"));
        let read = ReadFileTool
            .execute(serde_json::json!({"path": "notes/a.txt"}), &ctx)
            .await
            .unwrap();
        assert_eq!(read, "你好,沙箱");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_write_rejects_escape() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = WriteFileTool
            .execute(serde_json::json!({"path": "../evil", "content": "x"}), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("越界"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_files_shows_written() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        WriteFileTool
            .execute(
                serde_json::json!({"path": "dir/b.txt", "content": "hi"}),
                &ctx,
            )
            .await
            .unwrap();
        let list = ListFilesTool
            .execute(serde_json::json!({}), &ctx)
            .await
            .unwrap();
        assert!(list.contains("dir"), "列表应含子目录 dir: {}", list);
        let inner = ListFilesTool
            .execute(serde_json::json!({"path": "dir"}), &ctx)
            .await
            .unwrap();
        assert!(inner.contains("b.txt"), "列表应含 b.txt: {}", inner);
    }
}
