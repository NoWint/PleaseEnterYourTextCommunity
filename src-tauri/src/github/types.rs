//! GitHub API 响应 DTO 与解析纯函数。
//!
//! 解析采用手写 `serde_json::Value` 读取:对 GitHub 大 JSON 稳健,字段缺失取默认。
//! DTO 仅派生 `Serialize`,供命令层直接返回给前端(不反序列化 JSON)。

use serde::Serialize;

/// 仓库详情。
#[derive(Debug, Clone, Serialize)]
pub struct RepoDto {
    pub full_name: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub stargazers_count: i64,
    pub forks_count: i64,
    pub open_issues_count: i64,
    pub default_branch: String,
    pub html_url: String,
}

/// Issue 详情/列表项。
#[derive(Debug, Clone, Serialize)]
pub struct IssueDto {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub user: String,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<String>,
    pub body: Option<String>,
    pub html_url: String,
}

/// Pull Request 详情/列表项。
#[derive(Debug, Clone, Serialize)]
pub struct PullDto {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub user: String,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub html_url: String,
}

/// Commit 列表项。
#[derive(Debug, Clone, Serialize)]
pub struct CommitDto {
    pub sha: String,
    pub message: String,
    pub author: Option<String>,
    pub date: Option<String>,
}

/// 仓库动态事件。
#[derive(Debug, Clone, Serialize)]
pub struct EventDto {
    pub typ: String,
    pub actor: Option<String>,
    pub created_at: String,
    pub summary: String,
}

/// 仓库内容(文件或目录条目)。
#[derive(Debug, Clone, Serialize)]
pub struct ContentDto {
    pub name: String,
    pub path: String,
    pub typ: String,
    pub size: i64,
    pub content: Option<String>,
}

/// Git 树条目(Git Trees API `/git/trees/{branch}?recursive=1`)。
/// 当前仅 code::source 的 Github 回退使用;Task 3/4 接入前豁免 dead_code。
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TreeEntryDto {
    pub path: String,
    pub typ: String,
    pub size: i64,
}

/// 仓库搜索结果项。
#[derive(Debug, Clone, Serialize)]
pub struct SearchRepoDto {
    pub full_name: String,
    pub description: Option<String>,
    pub stargazers_count: i64,
    pub language: Option<String>,
    pub html_url: String,
}

/// 代码搜索结果项。
#[derive(Debug, Clone, Serialize)]
pub struct SearchCodeDto {
    pub name: String,
    pub path: String,
    pub repo_full_name: String,
    pub html_url: String,
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn opt_str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn int_field(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn user_login(v: &serde_json::Value) -> String {
    v.get("user").and_then(|u| u.get("login")).and_then(|l| l.as_str()).unwrap_or_default().to_string()
}

fn label_names(v: &serde_json::Value) -> Vec<String> {
    v.get("labels")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn array_items(v: &serde_json::Value) -> Vec<serde_json::Value> {
    v.as_array()
        .map(|a| a.iter().filter(|x| x.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// Commit 消息:取首行并截断到 80 字符。
fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().chars().take(80).collect()
}

/// 从 payload 提取 action(GitHub 事件通用字段)。
fn payload_action(v: &serde_json::Value) -> String {
    v.get("payload").and_then(|p| p.get("action")).and_then(|a| a.as_str()).unwrap_or_default().to_string()
}

fn title_summary(action: &str, title: &str) -> String {
    let action = action.trim();
    let title = title.trim();
    match (action.is_empty(), title.is_empty()) {
        (false, false) => format!("{action}: {title}"),
        (false, true) => action.to_string(),
        (true, false) => title.to_string(),
        (true, true) => String::new(),
    }
}

fn event_summary(typ: &str, v: &serde_json::Value) -> String {
    match typ {
        "PushEvent" => {
            let n = v
                .get("payload")
                .and_then(|p| p.get("commits"))
                .and_then(|c| c.as_array())
                .map_or(0, |a| a.len());
            format!("{n} 次提交")
        }
        "IssuesEvent" => {
            let action = payload_action(v);
            let title = v
                .get("payload")
                .and_then(|p| p.get("issue"))
                .and_then(|i| i.get("title"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            title_summary(&action, title)
        }
        "PullRequestEvent" => {
            let action = payload_action(v);
            let title = v
                .get("payload")
                .and_then(|p| p.get("pull_request"))
                .and_then(|p| p.get("title"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            title_summary(&action, title)
        }
        _ => payload_action(v),
    }
}

pub fn parse_repo(v: &serde_json::Value) -> RepoDto {
    RepoDto {
        full_name: str_field(v, "full_name"),
        description: opt_str_field(v, "description"),
        language: opt_str_field(v, "language"),
        stargazers_count: int_field(v, "stargazers_count"),
        forks_count: int_field(v, "forks_count"),
        open_issues_count: int_field(v, "open_issues_count"),
        default_branch: str_field(v, "default_branch"),
        html_url: str_field(v, "html_url"),
    }
}

pub fn parse_issue(v: &serde_json::Value) -> IssueDto {
    IssueDto {
        number: int_field(v, "number"),
        title: str_field(v, "title"),
        state: str_field(v, "state"),
        user: user_login(v),
        created_at: str_field(v, "created_at"),
        updated_at: str_field(v, "updated_at"),
        labels: label_names(v),
        body: opt_str_field(v, "body"),
        html_url: str_field(v, "html_url"),
    }
}

pub fn parse_issue_list(v: &serde_json::Value) -> Vec<IssueDto> {
    array_items(v).iter().map(parse_issue).collect()
}

pub fn parse_pull(v: &serde_json::Value) -> PullDto {
    PullDto {
        number: int_field(v, "number"),
        title: str_field(v, "title"),
        state: str_field(v, "state"),
        user: user_login(v),
        created_at: str_field(v, "created_at"),
        updated_at: str_field(v, "updated_at"),
        merged_at: opt_str_field(v, "merged_at"),
        additions: int_field(v, "additions"),
        deletions: int_field(v, "deletions"),
        html_url: str_field(v, "html_url"),
    }
}

pub fn parse_pull_list(v: &serde_json::Value) -> Vec<PullDto> {
    array_items(v).iter().map(parse_pull).collect()
}

pub fn parse_commit(v: &serde_json::Value) -> CommitDto {
    let commit = v.get("commit");
    CommitDto {
        sha: str_field(v, "sha"),
        message: commit
            .and_then(|c| c.get("message"))
            .and_then(|m| m.as_str())
            .map(first_line)
            .unwrap_or_default(),
        author: commit
            .and_then(|c| c.get("author"))
            .and_then(|a| a.get("name"))
            .and_then(|n| n.as_str())
            .map(str::to_string),
        date: commit
            .and_then(|c| c.get("author"))
            .and_then(|a| a.get("date"))
            .and_then(|d| d.as_str())
            .map(str::to_string),
    }
}

pub fn parse_commit_list(v: &serde_json::Value) -> Vec<CommitDto> {
    array_items(v).iter().map(parse_commit).collect()
}

pub fn parse_event(v: &serde_json::Value) -> EventDto {
    let typ = str_field(v, "type");
    let actor = v
        .get("actor")
        .and_then(|a| a.get("login"))
        .and_then(|l| l.as_str())
        .map(str::to_string);
    EventDto {
        summary: event_summary(&typ, v),
        typ,
        actor,
        created_at: str_field(v, "created_at"),
    }
}

pub fn parse_event_list(v: &serde_json::Value) -> Vec<EventDto> {
    array_items(v).iter().map(parse_event).collect()
}

pub fn parse_content(v: &serde_json::Value) -> ContentDto {
    ContentDto {
        name: str_field(v, "name"),
        path: str_field(v, "path"),
        typ: str_field(v, "type"),
        size: int_field(v, "size"),
        content: opt_str_field(v, "content"),
    }
}

pub fn parse_content_list(v: &serde_json::Value) -> Vec<ContentDto> {
    array_items(v).iter().map(parse_content).collect()
}

/// 解析 git 树响应的 `tree` 数组(条目含 path/type/size)。
#[allow(dead_code)] // Task 3/4 接入后移除
pub fn parse_tree(v: &serde_json::Value) -> Vec<TreeEntryDto> {
    v.get("tree")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|x| x.is_object())
                .map(|item| TreeEntryDto {
                    path: str_field(item, "path"),
                    typ: str_field(item, "type"),
                    size: int_field(item, "size"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_search_repo_item(v: &serde_json::Value) -> SearchRepoDto {
    SearchRepoDto {
        full_name: str_field(v, "full_name"),
        description: opt_str_field(v, "description"),
        stargazers_count: int_field(v, "stargazers_count"),
        language: opt_str_field(v, "language"),
        html_url: str_field(v, "html_url"),
    }
}

pub fn parse_search_repo(v: &serde_json::Value) -> Vec<SearchRepoDto> {
    v.get("items")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().map(parse_search_repo_item).collect())
        .unwrap_or_default()
}

fn parse_search_code_item(v: &serde_json::Value) -> SearchCodeDto {
    SearchCodeDto {
        name: str_field(v, "name"),
        path: str_field(v, "path"),
        repo_full_name: v
            .get("repository")
            .and_then(|r| r.get("full_name"))
            .and_then(|f| f.as_str())
            .unwrap_or_default()
            .to_string(),
        html_url: str_field(v, "html_url"),
    }
}

pub fn parse_search_code(v: &serde_json::Value) -> Vec<SearchCodeDto> {
    v.get("items")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().map(parse_search_code_item).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_repo_full() {
        let v = json!({
            "full_name": "octocat/Hello-World",
            "description": "My first repository",
            "language": null,
            "stargazers_count": 100,
            "forks_count": 50,
            "open_issues_count": 10,
            "default_branch": "main",
            "html_url": "https://github.com/octocat/Hello-World"
        });
        let repo = parse_repo(&v);
        assert_eq!(repo.full_name, "octocat/Hello-World");
        assert_eq!(repo.description.as_deref(), Some("My first repository"));
        assert_eq!(repo.language, None);
        assert_eq!(repo.stargazers_count, 100);
        assert_eq!(repo.forks_count, 50);
        assert_eq!(repo.open_issues_count, 10);
        assert_eq!(repo.default_branch, "main");
    }

    #[test]
    fn test_parse_repo_missing_fields_default() {
        let repo = parse_repo(&json!({ "full_name": "a/b" }));
        assert_eq!(repo.full_name, "a/b");
        assert_eq!(repo.description, None);
        assert_eq!(repo.language, None);
        assert_eq!(repo.stargazers_count, 0);
        assert_eq!(repo.forks_count, 0);
        assert_eq!(repo.open_issues_count, 0);
        assert_eq!(repo.default_branch, "");
        assert_eq!(repo.html_url, "");
    }

    #[test]
    fn test_parse_issue_full() {
        let v = json!({
            "number": 1347,
            "title": "Found a bug",
            "state": "open",
            "user": { "login": "octocat" },
            "created_at": "2011-04-22T13:33:48Z",
            "updated_at": "2011-04-22T13:33:48Z",
            "labels": [ { "name": "bug" }, { "name": "help wanted" } ],
            "body": "I'm having a problem",
            "html_url": "https://github.com/octocat/Hello-World/issues/1347"
        });
        let issue = parse_issue(&v);
        assert_eq!(issue.number, 1347);
        assert_eq!(issue.title, "Found a bug");
        assert_eq!(issue.state, "open");
        assert_eq!(issue.user, "octocat");
        assert_eq!(issue.labels, vec!["bug", "help wanted"]);
        assert_eq!(issue.body.as_deref(), Some("I'm having a problem"));
    }

    #[test]
    fn test_parse_issue_missing_fields_default() {
        let issue = parse_issue(&json!({ "number": 1 }));
        assert_eq!(issue.title, "");
        assert_eq!(issue.user, "");
        assert_eq!(issue.labels, Vec::<String>::new());
        assert_eq!(issue.body, None);
        assert_eq!(issue.created_at, "");
    }

    #[test]
    fn test_parse_issue_list_skips_non_object_items() {
        let v = json!([
            { "number": 1, "title": "a" },
            null,
            { "number": 2, "title": "b" }
        ]);
        let list = parse_issue_list(&v);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].number, 1);
        assert_eq!(list[1].number, 2);
    }

    #[test]
    fn test_parse_pull_list_without_diff_stats() {
        let v = json!([{
            "number": 1,
            "title": "Update README",
            "state": "open",
            "user": { "login": "octocat" },
            "created_at": "2011-04-22T13:33:48Z",
            "updated_at": "2011-04-22T13:33:48Z",
            "merged_at": null,
            "html_url": "https://github.com/octocat/Hello-World/pull/1"
        }]);
        let pulls = parse_pull_list(&v);
        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].additions, 0);
        assert_eq!(pulls[0].deletions, 0);
        assert_eq!(pulls[0].merged_at, None);
        assert_eq!(pulls[0].user, "octocat");
    }

    #[test]
    fn test_parse_pull_detail_with_diff_stats() {
        let v = json!({
            "number": 2,
            "title": "Add feature",
            "state": "closed",
            "user": { "login": "octocat" },
            "created_at": "x",
            "updated_at": "y",
            "merged_at": "2011-04-23T10:00:00Z",
            "additions": 10,
            "deletions": 3,
            "html_url": "u"
        });
        let pull = parse_pull(&v);
        assert_eq!(pull.additions, 10);
        assert_eq!(pull.deletions, 3);
        assert_eq!(pull.merged_at.as_deref(), Some("2011-04-23T10:00:00Z"));
    }

    #[test]
    fn test_parse_commit_first_line_and_truncation() {
        let long = "fix: 修复一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题的第二行";
        let v = json!({
            "sha": "7fd1a60b01f91b314aab2fb82699b",
            "commit": {
                "message": format!("{long}\nbody 部分"),
                "author": { "name": "Monalisa Octocat", "date": "2011-04-14T16:00:49Z" }
            }
        });
        let c = parse_commit(&v);
        assert_eq!(c.sha, "7fd1a60b01f91b314aab2fb82699b");
        assert_eq!(c.author.as_deref(), Some("Monalisa Octocat"));
        assert_eq!(c.date.as_deref(), Some("2011-04-14T16:00:49Z"));
        assert!(!c.message.contains('\n'));
        assert!(c.message.chars().count() <= 80);
    }

    #[test]
    fn test_parse_commit_short_message() {
        let v = json!({
            "sha": "abc",
            "commit": {
                "message": "fix bug",
                "author": { "name": "M", "date": "d" }
            }
        });
        let c = parse_commit(&v);
        assert_eq!(c.message, "fix bug");
    }

    #[test]
    fn test_parse_commit_missing_author() {
        let v = json!({ "sha": "abc", "commit": { "message": "hi" } });
        let c = parse_commit(&v);
        assert_eq!(c.message, "hi");
        assert_eq!(c.author, None);
        assert_eq!(c.date, None);
    }

    #[test]
    fn test_parse_event_push() {
        let v = json!({
            "type": "PushEvent",
            "actor": { "login": "octocat" },
            "created_at": "2011-04-22T13:33:48Z",
            "payload": { "commits": [1, 2, 3] }
        });
        let e = parse_event(&v);
        assert_eq!(e.typ, "PushEvent");
        assert_eq!(e.actor.as_deref(), Some("octocat"));
        assert_eq!(e.summary, "3 次提交");
    }

    #[test]
    fn test_parse_event_issue() {
        let v = json!({
            "type": "IssuesEvent",
            "actor": { "login": "octocat" },
            "created_at": "x",
            "payload": { "action": "opened", "issue": { "title": "Bug in UI" } }
        });
        let e = parse_event(&v);
        assert_eq!(e.summary, "opened: Bug in UI");
    }

    #[test]
    fn test_parse_event_pull_request() {
        let v = json!({
            "type": "PullRequestEvent",
            "actor": null,
            "created_at": "x",
            "payload": { "action": "closed", "pull_request": { "title": "Fix #1" } }
        });
        let e = parse_event(&v);
        assert_eq!(e.summary, "closed: Fix #1");
        assert_eq!(e.actor, None);
    }

    #[test]
    fn test_parse_event_other_action_or_empty() {
        let with_action = json!({
            "type": "WatchEvent",
            "created_at": "x",
            "payload": { "action": "started" }
        });
        assert_eq!(parse_event(&with_action).summary, "started");

        let without_action = json!({ "type": "CreateEvent", "created_at": "x", "payload": {} });
        assert_eq!(parse_event(&without_action).summary, "");
    }

    #[test]
    fn test_parse_content_file_and_dir() {
        let file = json!({
            "name": "main.rs",
            "path": "src/main.rs",
            "type": "file",
            "size": 1234,
            "content": "Zm9vYmFy"
        });
        let c = parse_content(&file);
        assert_eq!(c.typ, "file");
        assert_eq!(c.content.as_deref(), Some("Zm9vYmFy"));
        assert_eq!(c.size, 1234);

        let dir = json!({
            "name": "src",
            "path": "src",
            "type": "dir",
            "size": 0
        });
        let d = parse_content(&dir);
        assert_eq!(d.typ, "dir");
        assert_eq!(d.content, None);
    }

    #[test]
    fn test_parse_tree_maps_blobs_and_trees() {
        let v = json!({
            "sha": "abc",
            "truncated": false,
            "tree": [
                { "path": "src", "mode": "040000", "type": "tree", "sha": "t1", "url": "u" },
                { "path": "src/main.rs", "mode": "100644", "type": "blob", "sha": "b1", "size": 12, "url": "u" },
                null,
                { "path": "README.md", "type": "blob", "size": 5 }
            ]
        });
        let tree = parse_tree(&v);
        assert_eq!(tree.len(), 3);
        assert_eq!(tree[0].path, "src");
        assert_eq!(tree[0].typ, "tree");
        assert_eq!(tree[0].size, 0);
        assert_eq!(tree[1].path, "src/main.rs");
        assert_eq!(tree[1].typ, "blob");
        assert_eq!(tree[1].size, 12);
        assert_eq!(tree[2].path, "README.md");
        assert_eq!(tree[2].size, 5);
    }

    #[test]
    fn test_parse_tree_missing_or_no_items() {
        assert_eq!(parse_tree(&json!({})).len(), 0);
        assert_eq!(parse_tree(&json!({ "tree": [] })).len(), 0);
        assert_eq!(parse_tree(&json!({ "tree": [null, 1] })).len(), 0);
    }

    #[test]
    fn test_parse_search_repo() {        let v = json!({
            "total_count": 1,
            "items": [
                { "full_name": "octocat/Hello-World", "description": "x", "stargazers_count": 100, "language": "Rust", "html_url": "u" }
            ]
        });
        let list = parse_search_repo(&v);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].full_name, "octocat/Hello-World");
        assert_eq!(list[0].language.as_deref(), Some("Rust"));
        assert_eq!(list[0].stargazers_count, 100);
    }

    #[test]
    fn test_parse_search_repo_no_items() {
        assert_eq!(parse_search_repo(&json!({ "total_count": 0 })).len(), 0);
    }

    #[test]
    fn test_parse_search_code() {
        let v = json!({
            "items": [
                { "name": "config.js", "path": "src/config.js", "repository": { "full_name": "octocat/Hello-World" }, "html_url": "u" }
            ]
        });
        let list = parse_search_code(&v);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "config.js");
        assert_eq!(list[0].path, "src/config.js");
        assert_eq!(list[0].repo_full_name, "octocat/Hello-World");
    }

    #[test]
    fn test_parse_search_code_missing_repository() {
        let v = json!({ "items": [ { "name": "x", "path": "p", "html_url": "u" } ] });
        let list = parse_search_code(&v);
        assert_eq!(list[0].repo_full_name, "");
    }
}
