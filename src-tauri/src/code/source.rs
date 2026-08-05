//! 代码数据源抽象:本地沙箱 + GitHub 回退。
//! 从 [`crate::dto::ProjectContext`] 解析:repo_local_path(存在目录)→ Local,否则 repo_path → Github,皆无 → None。
//! Github 分支复用 [`crate::github`]:contents API(list_tree/read_file)+ git trees API(find_files)。

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;

use crate::dto::ProjectContext;
use crate::error::{AppError, AppResult};
use crate::github::api::{url_get_content, url_git_trees, url_repo};
use crate::github::client::{GithubAuth, GithubClient};
use crate::github::types::{
    parse_content, parse_content_list, parse_repo, parse_tree, parse_tree_truncated, ContentDto,
    TreeEntryDto,
};

use super::index::IndexCache;
use super::local::{self, LocalEntry, SandboxMode};

/// 统一代码条目(与语言无关的目录/文件描述)。
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // Task 3/4 接入后移除
pub struct CodeEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
}

#[allow(dead_code)]
impl From<LocalEntry> for CodeEntry {
    fn from(e: LocalEntry) -> Self {
        CodeEntry {
            path: e.path,
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
        }
    }
}

/// 代码数据源:本地仓库目录优先;GitHub 为回退。
#[derive(Debug, Clone)]
#[allow(dead_code)] // Task 3/4 接入后移除
pub enum CodeSource {
    Local {
        root: PathBuf,
        sandbox_mode: SandboxMode,
        /// 本地文件索引缓存(find_files 用;mtime 变化自动重扫)。
        index: IndexCache,
    },
    Github {
        owner: String,
        repo: String,
    },
}

#[allow(dead_code)] // Task 3/4 接入后移除
impl CodeSource {
    /// repo_local_path 非空且为目录 → Local;否则 repo_path("owner/repo")→ Github;皆无 → None。
    pub fn from_project_context(pc: &ProjectContext) -> Option<CodeSource> {
        if let Some(local) = pc.repo_local_path.as_deref() {
            let p = Path::new(local);
            if p.is_dir() {
                return Some(CodeSource::Local {
                    root: p.to_path_buf(),
                    sandbox_mode: SandboxMode::parse(pc.sandbox_mode.as_deref()),
                    index: IndexCache::new(),
                });
            }
        }
        if let Some(repo_path) = pc.repo_path.as_deref() {
            if let Some((owner, repo)) = repo_path.split_once('/') {
                if !owner.is_empty() && !repo.is_empty() {
                    return Some(CodeSource::Github {
                        owner: owner.to_string(),
                        repo: repo.to_string(),
                    });
                }
            }
        }
        None
    }

    /// 读文件(本地沙箱 / GitHub contents API);≤64KB 超限截断同 local。
    pub async fn read_file(
        &self,
        client: &GithubClient,
        auth: &GithubAuth,
        rel: &str,
    ) -> AppResult<String> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
                ..
            } => local::read_file(root, rel, *sandbox_mode).await,
            CodeSource::Github { owner, repo } => {
                let raw = client.get_json(auth, &url_get_content(owner, repo, rel)).await?;
                parse_file_content(&raw, rel)
            }
        }
    }

    /// 列出目录项(单层;prefix 为相对路径,空 = 根)。
    pub async fn list_tree(
        &self,
        client: &GithubClient,
        auth: &GithubAuth,
        prefix: &str,
    ) -> AppResult<Vec<CodeEntry>> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
                ..
            } => Ok(local::list_tree(root, prefix, *sandbox_mode)
                .await?
                .into_iter()
                .map(CodeEntry::from)
                .collect()),
            CodeSource::Github { owner, repo } => {
                let raw = client.get_json(auth, &url_get_content(owner, repo, prefix)).await?;
                parse_content_to_entries(&raw, prefix)
            }
        }
    }

    /// 按文件名查找(忽略大小写;限 20)。
    /// Local 优先走索引缓存(mtime 变化重扫),失败则直接遍历兜底;
    /// Github 用 git trees API 一次拉全树过滤。
    pub async fn find_files(
        &self,
        client: &GithubClient,
        auth: &GithubAuth,
        name: &str,
    ) -> AppResult<Vec<CodeEntry>> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
                index,
            } => {
                if let Some(entry) = index.get_or_scan(root).await.unwrap_or(None) {
                    let needle = name.to_lowercase();
                    let mut out = Vec::new();
                    for f in &entry.files {
                        let fname = f.path.rsplit('/').next().unwrap_or(&f.path);
                        if fname.to_lowercase().contains(&needle) {
                            out.push(CodeEntry {
                                path: f.path.clone(),
                                name: fname.to_string(),
                                is_dir: false,
                                size: f.size,
                            });
                            if out.len() >= local::MAX_FIND_RESULTS {
                                break;
                            }
                        }
                    }
                    return Ok(out);
                }
                Ok(local::find_files(root, name, *sandbox_mode)
                    .await?
                    .into_iter()
                    .map(CodeEntry::from)
                    .collect())
            }
            CodeSource::Github { owner, repo } => {
                let branch = github_default_branch(client, auth, owner, repo).await?;
                let raw = client.get_json(auth, &url_git_trees(owner, repo, &branch)).await?;
                tree_entries_or_truncated(&raw, name)
            }
        }
    }
}

// ---- GitHub 纯函数(可单测,不触网)----

/// contents API 数组 → CodeEntry;单对象(请求到文件路径)视为非目录报错。
#[allow(dead_code)] // Task 3/4 接入后移除
fn parse_content_to_entries(raw: &Value, prefix: &str) -> AppResult<Vec<CodeEntry>> {
    if raw.is_object() {
        return Err(AppError::Core(format!("不是目录: {prefix}")));
    }
    Ok(parse_content_list(raw).iter().map(content_to_entry).collect())
}

/// contents API 响应 → 文件文本:目录路径返回数组 JSON(或对象无 content),
/// 此时非文件 → Err("不是文件: {rel}"),对齐 Local 分支语义。
#[allow(dead_code)]
fn parse_file_content(raw: &Value, rel: &str) -> AppResult<String> {
    if raw.is_array() {
        return Err(AppError::Core(format!("不是文件: {rel}")));
    }
    let dto = parse_content(raw);
    if dto.typ == "dir" || dto.content.is_none() {
        return Err(AppError::Core(format!("不是文件: {rel}")));
    }
    Ok(format_bytes(&decode_content_base64(&dto)?))
}

/// ContentDto → CodeEntry(type == "dir" 视为目录)。
#[allow(dead_code)]
fn content_to_entry(c: &ContentDto) -> CodeEntry {
    CodeEntry {
        path: c.path.clone(),
        name: c.name.clone(),
        is_dir: c.typ == "dir",
        size: c.size,
    }
}

/// 文件 base64 解码(contents API `content` 字段)。
#[allow(dead_code)]
fn decode_content_base64(dto: &ContentDto) -> AppResult<Vec<u8>> {
    let content = dto.content.as_deref().unwrap_or("");
    base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| AppError::Core("文件内容不是有效 base64".into()))
}

/// git 树条目 → 文件名含 needle(忽略大小写)的文件 CodeEntry,限 20。
#[allow(dead_code)]
fn tree_to_file_entries(tree: &[TreeEntryDto], needle: &str) -> Vec<CodeEntry> {
    let needle = needle.to_lowercase();
    let mut out = Vec::new();
    for it in tree {
        if it.typ != "blob" {
            continue;
        }
        let fname = it.path.rsplit('/').next().unwrap_or(&it.path);
        if fname.to_lowercase().contains(&needle) {
            out.push(CodeEntry {
                path: it.path.clone(),
                name: fname.to_string(),
                is_dir: false,
                size: it.size,
            });
            if out.len() >= local::MAX_FIND_RESULTS {
                break;
            }
        }
    }
    out
}

/// 与 local::read_file 一致的字节渲染:二进制 → "二进制文件";>64KB 截断;否则 UTF-8。
#[allow(dead_code)]
fn format_bytes(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        return "二进制文件".into();
    }
    if bytes.len() > local::MAX_READ {
        let head = String::from_utf8_lossy(&bytes[..local::MAX_READ]);
        format!(
            "{head}\n\n(文件超 {}KB,已截断;完整 {} 字节)",
            local::MAX_READ / 1024,
            bytes.len()
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// git trees 响应 → 过滤后的文件条目;tree 截断(`truncated: true`)时报错,避免静默返回不完整结果。
#[allow(dead_code)]
fn tree_entries_or_truncated(raw: &Value, name: &str) -> AppResult<Vec<CodeEntry>> {
    if parse_tree_truncated(raw) {
        return Err(AppError::Core(format!(
            "Git 树过大被截断(truncated),find_files 结果不完整:{name}"
        )));
    }
    Ok(tree_to_file_entries(&parse_tree(raw), name))
}

/// 确定默认分支:仓库详情 default_branch;缺失则试 main → master。
#[allow(dead_code)]
async fn github_default_branch(
    client: &GithubClient,
    auth: &GithubAuth,
    owner: &str,
    repo: &str,
) -> AppResult<String> {
    let raw = client.get_json(auth, &url_repo(owner, repo)).await?;
    let branch = parse_repo(&raw).default_branch;
    if !branch.is_empty() {
        return Ok(branch);
    }
    let mut last_err: Option<AppError> = None;
    for candidate in ["main", "master"] {
        match client.get_json(auth, &url_git_trees(owner, repo, candidate)).await {
            Ok(_) => return Ok(candidate.to_string()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Core("无法确定 GitHub 默认分支".into())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_from_project_context_local_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();

        let pc = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: Some("owner/repo".into()),
            github_token: None,
            repo_local_path: Some(root.to_string_lossy().into_owned()),
            sandbox_mode: Some("any".into()),
        };
        match CodeSource::from_project_context(&pc) {
            Some(CodeSource::Local {
                root: r,
                sandbox_mode,
                ..
            }) => {
                assert!(r.is_dir());
                assert_eq!(sandbox_mode, SandboxMode::Any);
            }
            other => panic!("expected Local, got {other:?}"),
        }
    }

    #[test]
    fn test_from_project_context_local_path_missing_dir_falls_back() {
        // 本地路径不存在目录 → 回退 repo_path → Github
        let pc = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: Some("owner/repo".into()),
            github_token: None,
            repo_local_path: Some("/nonexistent/definitely-missing".into()),
            sandbox_mode: None,
        };
        match CodeSource::from_project_context(&pc) {
            Some(CodeSource::Github { owner, repo }) => {
                assert_eq!(owner, "owner");
                assert_eq!(repo, "repo");
            }
            other => panic!("expected Github, got {other:?}"),
        }
    }

    #[test]
    fn test_from_project_context_github() {
        let pc = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: Some("owner/repo".into()),
            github_token: None,
            repo_local_path: None,
            sandbox_mode: None,
        };
        match CodeSource::from_project_context(&pc) {
            Some(CodeSource::Github { owner, repo }) => {
                assert_eq!(owner, "owner");
                assert_eq!(repo, "repo");
            }
            other => panic!("expected Github, got {other:?}"),
        }
    }

    #[test]
    fn test_from_project_context_none() {
        let pc = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: None,
            github_token: None,
            repo_local_path: None,
            sandbox_mode: None,
        };
        assert!(CodeSource::from_project_context(&pc).is_none());

        // 畸形 repo_path(无 "/")→ None
        let malformed = ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: Some("no-slash".into()),
            github_token: None,
            repo_local_path: None,
            sandbox_mode: None,
        };
        assert!(CodeSource::from_project_context(&malformed).is_none());
    }

    #[test]
    fn test_code_entry_from_local() {
        let le = LocalEntry {
            path: "src/main.rs".into(),
            name: "main.rs".into(),
            is_dir: false,
            size: 12,
        };
        let ce: CodeEntry = le.into();
        assert_eq!(ce.path, "src/main.rs");
        assert_eq!(ce.size, 12);
        assert!(!ce.is_dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_local_read_and_github_placeholder_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "content").unwrap();

        let client = GithubClient::new();
        let auth = GithubAuth { token: None };
        let local = CodeSource::from_project_context(&ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: None,
            github_token: None,
            repo_local_path: Some(root.to_string_lossy().into_owned()),
            sandbox_mode: None,
        })
        .unwrap();
        let text = local.read_file(&client, &auth, "a.txt").await.unwrap();
        assert_eq!(text, "content");
    }

    // ---- GitHub 分支:纯函数解析测试(样例 JSON,不触网) ----

    #[test]
    fn test_parse_content_to_entries_maps_dir_and_file() {
        let raw = json!([
            { "name": "src", "path": "src", "type": "dir", "size": 0 },
            { "name": "main.rs", "path": "src/main.rs", "type": "file", "size": 42, "content": "bGVsbG8=" }
        ]);
        let entries = parse_content_to_entries(&raw, "").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].path, "src");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].path, "src/main.rs");
        assert_eq!(entries[1].size, 42);
    }

    #[test]
    fn test_parse_content_to_entries_single_object_is_not_dir() {
        // 请求到单个文件时 GitHub 返回对象而非数组 → 视为非目录报错(与 local list_tree 一致)。
        let raw = json!({ "name": "main.rs", "path": "src/main.rs", "type": "file", "size": 1 });
        let err = parse_content_to_entries(&raw, "src/main.rs").unwrap_err();
        assert!(err.to_string().contains("不是目录"));
    }

    #[test]
    fn test_parse_file_content_directory_array_is_not_file() {
        // 目录路径:Github contents API 返回数组 JSON → 视为非文件报错(与 local read_file 一致)。
        let raw = json!([
            { "name": "src", "path": "src", "type": "dir", "size": 0 },
            { "name": "main.rs", "path": "src/main.rs", "type": "file", "size": 42 }
        ]);
        let err = parse_file_content(&raw, "src").unwrap_err();
        assert!(err.to_string().contains("不是文件"));
    }

    #[test]
    fn test_parse_file_content_object_dir_or_no_content_is_not_file() {
        // 单对象但 type=dir → 不是文件
        let dir = json!({ "name": "src", "path": "src", "type": "dir", "size": 0 });
        assert!(parse_file_content(&dir, "src").is_err());

        // 对象且 content 缺失 → 不是文件(与 Local 分支一致,避免静默返回空串)
        let no_content = json!({ "name": "a.rs", "path": "a.rs", "type": "file", "size": 4 });
        assert!(parse_file_content(&no_content, "a.rs").is_err());
    }

    #[test]
    fn test_parse_file_content_file_decodes() {
        let raw = json!({ "name": "hello.txt", "path": "hello.txt", "type": "file", "size": 5, "content": "aGVsbG8=" });
        assert_eq!(parse_file_content(&raw, "hello.txt").unwrap(), "hello");
    }

    #[test]
    fn test_decode_content_base64_and_format() {
        let dto = ContentDto {
            name: "a.rs".into(),
            path: "a.rs".into(),
            typ: "file".into(),
            size: 4,
            content: Some("aGVsbG8=".into()),
        };
        let bytes = decode_content_base64(&dto).unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(format_bytes(&bytes), "hello");

        // 无效 base64 → 错误
        let bad = ContentDto {
            name: "b".into(),
            path: "b".into(),
            typ: "file".into(),
            size: 0,
            content: Some("!!!not base64!!!".into()),
        };
        assert!(decode_content_base64(&bad).is_err());

        // 无 content 字段 → 空解码
        let none = ContentDto {
            name: "c".into(),
            path: "c".into(),
            typ: "file".into(),
            size: 0,
            content: None,
        };
        assert!(decode_content_base64(&none).unwrap().is_empty());
    }

    #[test]
    fn test_format_bytes_binary_and_truncate() {
        // 二进制(NUL)→ 提示
        assert_eq!(format_bytes(b"\x00\x01raw"), "二进制文件");
        // 超 64KB → 截断提示
        let big = vec![b'x'; 70 * 1024];
        let text = format_bytes(&big);
        assert!(text.contains("已截断"));
        assert!(text.contains("71680"));
    }

    #[test]
    fn test_tree_to_file_entries_filters_case_insensitive_and_limits() {
        let tree = vec![
            TreeEntryDto { path: "src/main.rs".into(), typ: "blob".into(), size: 1 },
            TreeEntryDto { path: "src/util.rs".into(), typ: "blob".into(), size: 2 },
            TreeEntryDto { path: "README.md".into(), typ: "blob".into(), size: 3 },
            TreeEntryDto { path: "src".into(), typ: "tree".into(), size: 0 },
        ];
        let entries = tree_to_file_entries(&tree, "MAIN");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/main.rs");
        assert_eq!(entries[0].name, "main.rs");
        assert!(!entries[0].is_dir);

        // 目录条目(type=tree)不参与匹配
        assert!(tree_to_file_entries(&tree, "src").is_empty());
    }

    #[test]
    fn test_tree_entries_or_truncated_errors_on_truncated_tree() {
        let raw = json!({
            "sha": "abc",
            "truncated": true,
            "tree": [
                { "path": "src/main.rs", "type": "blob", "size": 12 }
            ]
        });
        let err = tree_entries_or_truncated(&raw, "main").unwrap_err();
        assert!(err.to_string().contains("截断"));

        let ok = json!({
            "truncated": false,
            "tree": [
                { "path": "src/main.rs", "type": "blob", "size": 12 }
            ]
        });
        let entries = tree_entries_or_truncated(&ok, "main").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/main.rs");
    }

    #[test]
    fn test_find_files_local_uses_index_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "x").unwrap();
        std::fs::write(root.join("src/lib.rs"), "y").unwrap();
        std::fs::write(root.join("README.md"), "z").unwrap();

        let client = GithubClient::new();
        let auth = GithubAuth { token: None };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let source = CodeSource::from_project_context(&ProjectContext {
            workspace_id: None,
            chat_ids: vec![],
            description: None,
            repo_path: None,
            github_token: None,
            repo_local_path: Some(root.to_string_lossy().into_owned()),
            sandbox_mode: None,
        })
        .unwrap();
        let found = rt.block_on(source.find_files(&client, &auth, "main")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "src/main.rs");
    }
}
