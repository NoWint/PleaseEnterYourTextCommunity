//! GitHub API 端点纯函数:URL 构造 + 写入 body 构造。不发起任何请求。

use serde_json::{json, Map, Value};

/// GitHub REST API 基地址。
pub const GITHUB_API_BASE: &str = "https://api.github.com";

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// 仓库详情。
pub fn url_repo(owner: &str, repo: &str) -> String {
    format!("{GITHUB_API_BASE}/repos/{}/{}", enc(owner), enc(repo))
}

fn with_query(base: String, name: &str, value: Option<&str>) -> String {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => format!("{base}?{name}={}", enc(v)),
        None => base,
    }
}

/// Issue 列表(state: "open"|"closed"|"all",None 不拼 query)。
pub fn url_list_issues(owner: &str, repo: &str, state: Option<&str>) -> String {
    with_query(format!("{}/issues", url_repo(owner, repo)), "state", state)
}

/// Issue 详情。
pub fn url_get_issue(owner: &str, repo: &str, n: i64) -> String {
    format!("{}/issues/{n}", url_repo(owner, repo))
}

/// Pull Request 列表(state: "open"|"closed"|"all",None 不拼 query)。
pub fn url_list_pulls(owner: &str, repo: &str, state: Option<&str>) -> String {
    with_query(format!("{}/pulls", url_repo(owner, repo)), "state", state)
}

/// Pull Request 详情(含 diff 统计)。
pub fn url_get_pull(owner: &str, repo: &str, n: i64) -> String {
    format!("{}/pulls/{n}", url_repo(owner, repo))
}

/// Commit 列表(path: 限定路径,None 不拼 query)。
pub fn url_list_commits(owner: &str, repo: &str, path: Option<&str>) -> String {
    with_query(format!("{}/commits", url_repo(owner, repo)), "path", path)
}

/// Commit 详情。
pub fn url_get_commit(owner: &str, repo: &str, sha: &str) -> String {
    format!("{}/commits/{}", url_repo(owner, repo), enc(sha))
}

/// 仓库搜索。
pub fn url_search_repo(query: &str) -> String {
    format!("{GITHUB_API_BASE}/search/repositories?q={}", enc(query))
}

/// 代码搜索(需 token)。
pub fn url_search_code(query: &str) -> String {
    format!("{GITHUB_API_BASE}/search/code?q={}", enc(query))
}

/// 仓库内容(目录或单文件)。path 可含 '/' 或为空/根目录。
pub fn url_get_content(owner: &str, repo: &str, path: &str) -> String {
    let base = format!("{}/contents", url_repo(owner, repo));
    let path = path.trim();
    if path.is_empty() || path == "/" {
        base
    } else {
        format!("{base}/{}", enc(path))
    }
}

/// 仓库 git 树(`?recursive=1` 一次拉全树)。branch 可为分支名或 commit SHA。
/// 当前仅 code::source 的 Github 回退使用;Task 3/4 接入前豁免 dead_code。
#[allow(dead_code)]
pub fn url_git_trees(owner: &str, repo: &str, branch: &str) -> String {
    format!("{}/git/trees/{}?recursive=1", url_repo(owner, repo), enc(branch))
}

/// README。
pub fn url_get_readme(owner: &str, repo: &str) -> String {
    format!("{}/readme", url_repo(owner, repo))
}

/// 仓库动态事件列表。
pub fn url_list_events(owner: &str, repo: &str) -> String {
    format!("{}/events", url_repo(owner, repo))
}

// ---- 写入端点 ----

/// 创建 Issue(POST)。
pub fn url_create_issue(owner: &str, repo: &str) -> String {
    format!("{}/issues", url_repo(owner, repo))
}

/// 创建 Issue 评论(POST)。
pub fn url_create_issue_comment(owner: &str, repo: &str, n: i64) -> String {
    format!("{}/issues/{n}/comments", url_repo(owner, repo))
}

/// 添加 Issue 标签(POST)。
pub fn url_add_issue_labels(owner: &str, repo: &str, n: i64) -> String {
    format!("{}/issues/{n}/labels", url_repo(owner, repo))
}

/// 创建 PR 评论(POST)。
pub fn url_pr_review_comment(owner: &str, repo: &str, n: i64) -> String {
    format!("{}/pulls/{n}/comments", url_repo(owner, repo))
}

// ---- 写入 body 构造 ----

/// 创建 Issue 的 body:`{title, body?}`。
pub fn create_issue_body(title: &str, body: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("title".to_string(), json!(title));
    if let Some(b) = body {
        m.insert("body".to_string(), json!(b));
    }
    Value::Object(m)
}

/// 添加 Issue 标签的 body:`{labels: [...]}`。
pub fn add_issue_labels_body(labels: &[String]) -> Value {
    json!({ "labels": labels })
}

/// 创建 Issue/PR 评论的 body:`{body}`。
pub fn add_issue_comment_body(body: &str) -> Value {
    json!({ "body": body })
}

/// 创建 PR review 评论的 body:`{body, commit_id?, path?, line?}`。
pub fn pr_review_comment_body(
    body: &str,
    commit_id: Option<&str>,
    path: Option<&str>,
    line: Option<i64>,
) -> Value {
    let mut m = Map::new();
    m.insert("body".to_string(), json!(body));
    if let Some(c) = commit_id {
        m.insert("commit_id".to_string(), json!(c));
    }
    if let Some(p) = path {
        m.insert("path".to_string(), json!(p));
    }
    if let Some(l) = line {
        m.insert("line".to_string(), json!(l));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_repo_encodes_owner_repo() {
        assert_eq!(
            url_repo("octo cat", "my repo"),
            "https://api.github.com/repos/octo%20cat/my%20repo"
        );
        assert_eq!(
            url_repo("octocat", "Hello-World"),
            "https://api.github.com/repos/octocat/Hello-World"
        );
    }

    #[test]
    fn test_url_list_issues_state() {
        let base = "https://api.github.com/repos/o/r/issues";
        assert_eq!(url_list_issues("o", "r", Some("open")), format!("{base}?state=open"));
        assert_eq!(url_list_issues("o", "r", None), base);
        assert_eq!(url_list_issues("o", "r", Some("  ")), base);
    }

    #[test]
    fn test_url_list_pulls_state() {
        assert_eq!(
            url_list_pulls("o", "r", Some("closed")),
            "https://api.github.com/repos/o/r/pulls?state=closed"
        );
        assert_eq!(url_list_pulls("o", "r", None), "https://api.github.com/repos/o/r/pulls");
    }

    #[test]
    fn test_url_list_commits_path() {
        let base = "https://api.github.com/repos/o/r/commits";
        assert_eq!(url_list_commits("o", "r", Some("src/lib.rs")), format!("{base}?path=src%2Flib.rs"));
        assert_eq!(url_list_commits("o", "r", None), base);
    }

    #[test]
    fn test_url_get_issue_and_pull() {
        assert_eq!(
            url_get_issue("o", "r", 1347),
            "https://api.github.com/repos/o/r/issues/1347"
        );
        assert_eq!(url_get_pull("o", "r", 7), "https://api.github.com/repos/o/r/pulls/7");
    }

    #[test]
    fn test_url_get_commit_encodes_sha() {
        assert_eq!(
            url_get_commit("o", "r", "abc def"),
            "https://api.github.com/repos/o/r/commits/abc%20def"
        );
    }

    #[test]
    fn test_url_search_encodes_query() {
        assert_eq!(
            url_search_repo("rust language"),
            "https://api.github.com/search/repositories?q=rust%20language"
        );
        assert_eq!(
            url_search_code("fn main"),
            "https://api.github.com/search/code?q=fn%20main"
        );
    }

    #[test]
    fn test_url_get_content_paths() {
        let base = "https://api.github.com/repos/o/r/contents";
        assert_eq!(url_get_content("o", "r", ""), base);
        assert_eq!(url_get_content("o", "r", "/"), base);
        assert_eq!(url_get_content("o", "r", "src/main.rs"), format!("{base}/src%2Fmain.rs"));
        assert_eq!(url_get_content("o", "r", "dir with space"), format!("{base}/dir%20with%20space"));
    }

    #[test]
    fn test_url_git_trees_recursive() {
        assert_eq!(
            url_git_trees("o", "r", "main"),
            "https://api.github.com/repos/o/r/git/trees/main?recursive=1"
        );
        assert_eq!(
            url_git_trees("o", "r", "feat/x y"),
            "https://api.github.com/repos/o/r/git/trees/feat%2Fx%20y?recursive=1"
        );
    }

    #[test]
    fn test_url_get_readme_and_events() {
        assert_eq!(url_get_readme("o", "r"), "https://api.github.com/repos/o/r/readme");
        assert_eq!(url_list_events("o", "r"), "https://api.github.com/repos/o/r/events");
    }

    #[test]
    fn test_write_urls() {
        assert_eq!(url_create_issue("o", "r"), "https://api.github.com/repos/o/r/issues");
        assert_eq!(
            url_create_issue_comment("o", "r", 5),
            "https://api.github.com/repos/o/r/issues/5/comments"
        );
        assert_eq!(
            url_add_issue_labels("o", "r", 5),
            "https://api.github.com/repos/o/r/issues/5/labels"
        );
        assert_eq!(
            url_pr_review_comment("o", "r", 7),
            "https://api.github.com/repos/o/r/pulls/7/comments"
        );
    }

    #[test]
    fn test_create_issue_body() {
        let full = create_issue_body("Found a bug", Some("Details here"));
        assert_eq!(full["title"], "Found a bug");
        assert_eq!(full["body"], "Details here");

        let no_body = create_issue_body("title", None);
        assert_eq!(no_body["title"], "title");
        assert!(no_body.get("body").is_none());
    }

    #[test]
    fn test_add_issue_labels_body() {
        let b = add_issue_labels_body(&["bug".to_string(), "help wanted".to_string()]);
        assert_eq!(b["labels"], json!(["bug", "help wanted"]));
    }

    #[test]
    fn test_add_issue_comment_body() {
        assert_eq!(add_issue_comment_body("hi"), json!({ "body": "hi" }));
    }

    #[test]
    fn test_pr_review_comment_body() {
        let full = pr_review_comment_body("looks good", Some("abc123"), Some("src/main.rs"), Some(42));
        assert_eq!(full["body"], "looks good");
        assert_eq!(full["commit_id"], "abc123");
        assert_eq!(full["path"], "src/main.rs");
        assert_eq!(full["line"], 42);

        let minimal = pr_review_comment_body("lgtm", None, None, None);
        assert_eq!(minimal["body"], "lgtm");
        assert!(minimal.get("commit_id").is_none());
        assert!(minimal.get("path").is_none());
        assert!(minimal.get("line").is_none());
    }
}
