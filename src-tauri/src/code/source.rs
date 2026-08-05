//! 代码数据源抽象:本地沙箱 + GitHub(Task 2 补全 GitHub 分支)。
//! 从 [`crate::dto::ProjectContext`] 解析:repo_local_path(存在目录)→ Local,否则 repo_path → Github,皆无 → None。

use std::path::{Path, PathBuf};

use crate::dto::ProjectContext;
use crate::error::{AppError, AppResult};
use crate::github::client::GithubClient;

use super::local::{self, LocalEntry, SandboxMode};

/// 统一代码条目(与语言无关的目录/文件描述)。
#[derive(Debug, Clone, PartialEq)]
pub struct CodeEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
}

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
pub enum CodeSource {
    Local {
        root: PathBuf,
        sandbox_mode: SandboxMode,
    },
    /// Task 2 实现 GitHub 分支。
    Github {
        owner: String,
        repo: String,
    },
}

impl CodeSource {
    /// repo_local_path 非空且为目录 → Local;否则 repo_path("owner/repo")→ Github;皆无 → None。
    pub fn from_project_context(pc: &ProjectContext) -> Option<CodeSource> {
        if let Some(local) = pc.repo_local_path.as_deref() {
            let p = Path::new(local);
            if p.is_dir() {
                return Some(CodeSource::Local {
                    root: p.to_path_buf(),
                    sandbox_mode: SandboxMode::parse(pc.sandbox_mode.as_deref()),
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

    /// 读文件;GitHub 分支待 Task 2 实现(返回错误,不 panic)。
    pub async fn read_file(&self, _client: &GithubClient, rel: &str) -> AppResult<String> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
            } => local::read_file(root, rel, *sandbox_mode).await,
            CodeSource::Github { .. } => Err(AppError::Core("GitHub 数据源待实现(Task 2)".into())),
        }
    }

    /// 列出目录项;GitHub 分支待 Task 2 实现。
    pub async fn list_tree(&self, _client: &GithubClient, prefix: &str) -> AppResult<Vec<CodeEntry>> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
            } => Ok(local::list_tree(root, prefix, *sandbox_mode)
                .await?
                .into_iter()
                .map(CodeEntry::from)
                .collect()),
            CodeSource::Github { .. } => Err(AppError::Core("GitHub 数据源待实现(Task 2)".into())),
        }
    }

    /// 按文件名查找;GitHub 分支待 Task 2 实现。
    pub async fn find_files(&self, _client: &GithubClient, name: &str) -> AppResult<Vec<CodeEntry>> {
        match self {
            CodeSource::Local {
                root,
                sandbox_mode,
            } => Ok(local::find_files(root, name, *sandbox_mode)
                .await?
                .into_iter()
                .map(CodeEntry::from)
                .collect()),
            CodeSource::Github { .. } => Err(AppError::Core("GitHub 数据源待实现(Task 2)".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Some(CodeSource::Local { root: r, sandbox_mode }) => {
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
    async fn test_local_read_and_github_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "content").unwrap();

        let client = GithubClient::new();
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
        let text = local.read_file(&client, "a.txt").await.unwrap();
        assert_eq!(text, "content");

        // GitHub 分支返回错误(非 panic)
        let github = CodeSource::Github {
            owner: "o".into(),
            repo: "r".into(),
        };
        let err = github.read_file(&client, "a.txt").await.unwrap_err();
        assert!(err.to_string().contains("GitHub 数据源待实现"));
    }
}
