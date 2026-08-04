//! GitHub 工具层:16 个 Bot 工具(§3),薄封装 `GithubClient`。
//!
//! - token 解析:bot 自身 `project_context.github_token` 优先,回退全局 `github_settings.token`;
//!   无 token 仍可执行公开只读(限速低);`search_code` 无 token 直接报错。
//! - 写入工具(`create_issue` / `add_issue_comment` / `add_issue_labels` / `create_pr_review_comment`)
//!   仅限已绑定仓库(`github_repos` 表),执行前经 [`require_repo_bound`] 校验。
//! - `list_issues` 在工具层过滤 GitHub `/issues` 混入的 PR(带 `pull_request` 键的条目)。
//! - 列表输出最多 10 项;文件/README 内容截断到前 2000 字符。

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};

use crate::dto::BotConfig;
use crate::error::{AppError, AppResult};
use crate::github::api::{
    add_issue_comment_body, add_issue_labels_body, create_issue_body, pr_review_comment_body,
    url_add_issue_labels, url_create_issue, url_create_issue_comment, url_get_commit,
    url_get_content, url_get_issue, url_get_pull, url_get_readme, url_list_commits,
    url_list_events, url_list_issues, url_list_pulls, url_pr_review_comment, url_repo,
    url_search_code, url_search_repo,
};
use crate::github::client::{GithubAuth, GithubClient};
use crate::github::types::{
    parse_commit, parse_commit_list, parse_content_list, parse_event_list, parse_issue,
    parse_issue_list, parse_pull, parse_pull_list, parse_repo, parse_search_code,
    parse_search_repo,
};
use crate::tools::{Tool, ToolContext};

/// 文件/README 内容最大返回字符数。
const MAX_CONTENT_CHARS: usize = 2000;
/// 列表工具最多返回条数。
const MAX_LIST_ITEMS: usize = 10;

// ---- 参数解析 ----

fn req_str(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::Core(format!("缺少参数: {key}")))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn req_i64(args: &Value, key: &str) -> AppResult<i64> {
    args.get(key)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::Core(format!("缺少参数: {key}")))
}

fn req_str_array(args: &Value, key: &str) -> AppResult<Vec<String>> {
    let items = args
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<String>| !v.is_empty())
        .ok_or_else(|| AppError::Core(format!("缺少参数: {key}")))?;
    Ok(items)
}

// ---- token 解析 ----

/// 解析 GitHub token:优先 bot 自身 `project_context.github_token`,回退全局 settings token。
async fn resolve_token(ctx: &ToolContext<'_>) -> AppResult<Option<String>> {
    if let Some(raw) = ctx.db.get_bot_config_by_id(ctx.bot_id).await? {
        if let Some(cfg) = BotConfig::parse(Some(&raw)) {
            let bot_token = cfg
                .project_context
                .and_then(|pc| pc.github_token)
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            if bot_token.is_some() {
                return Ok(bot_token);
            }
        }
    }
    let settings = ctx.db.get_github_settings().await?;
    Ok(settings
        .token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty()))
}

// ---- 写入工具限绑定仓库 ----

async fn require_repo_bound(ctx: &ToolContext<'_>, owner: &str, repo: &str) -> AppResult<()> {
    if !ctx.db.is_repo_bound(owner, repo).await? {
        return Err(AppError::Core("该仓库未绑定,写入操作仅限已绑定仓库".into()));
    }
    Ok(())
}

// ---- 格式化输出 ----

/// 截断到 `max` 字符,超出加「…(截断)」。
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("…(截断)");
    out
}

/// 过滤掉含 `pull_request` 键的条目(GitHub `/issues` 会混入 PR)。
pub fn filter_out_pull_requests(v: &Value) -> Value {
    match v.as_array() {
        Some(arr) => Value::Array(
            arr.iter()
                .filter(|x| x.is_object() && x.get("pull_request").is_none())
                .cloned()
                .collect(),
        ),
        None => Value::Array(Vec::new()),
    }
}

fn format_repo_detail(raw: &Value) -> String {
    let r = parse_repo(raw);
    format!(
        "仓库: {}\n描述: {}\n语言: {}\n星标: {} | Fork: {} | Open Issues: {}\n默认分支: {}\nURL: {}",
        r.full_name,
        r.description.as_deref().unwrap_or("(无)"),
        r.language.as_deref().unwrap_or("(未知)"),
        r.stargazers_count,
        r.forks_count,
        r.open_issues_count,
        r.default_branch,
        r.html_url
    )
}

fn format_issue_list(raw: &Value) -> AppResult<String> {
    let filtered = filter_out_pull_requests(raw);
    let issues = parse_issue_list(&filtered);
    if issues.is_empty() {
        return Ok("(无 Issue)".to_string());
    }
    let mut lines = Vec::new();
    for i in issues.iter().take(MAX_LIST_ITEMS) {
        lines.push(format!("#{} [{}] {} ({})", i.number, i.state, i.title, i.user));
    }
    Ok(lines.join("\n"))
}

fn format_issue_detail(raw: &Value) -> String {
    let i = parse_issue(raw);
    let labels = if i.labels.is_empty() {
        "(无)".to_string()
    } else {
        i.labels.join(", ")
    };
    format!(
        "#{} {}\n状态: {} | 作者: {}\n创建: {} | 更新: {}\n标签: {}\nURL: {}\n正文:\n{}",
        i.number,
        i.title,
        i.state,
        i.user,
        i.created_at,
        i.updated_at,
        labels,
        i.html_url,
        truncate(i.body.as_deref().unwrap_or("(无正文)"), MAX_CONTENT_CHARS)
    )
}

fn format_pull_list(raw: &Value) -> AppResult<String> {
    let pulls = parse_pull_list(raw);
    if pulls.is_empty() {
        return Ok("(无 Pull Request)".to_string());
    }
    let mut lines = Vec::new();
    for p in pulls.iter().take(MAX_LIST_ITEMS) {
        lines.push(format!("PR #{} [{}] {} ({})", p.number, p.state, p.title, p.user));
    }
    Ok(lines.join("\n"))
}

fn format_pull_detail(raw: &Value) -> String {
    let p = parse_pull(raw);
    let merged = p.merged_at.as_deref().unwrap_or("(未合并)");
    format!(
        "PR #{} {}\n状态: {} | 作者: {}\n创建: {} | 更新: {}\n合并: {} | 变更 +{}/-{}\nURL: {}\n",
        p.number,
        p.title,
        p.state,
        p.user,
        p.created_at,
        p.updated_at,
        merged,
        p.additions,
        p.deletions,
        p.html_url
    )
}

fn format_commit_list(raw: &Value) -> AppResult<String> {
    let commits = parse_commit_list(raw);
    if commits.is_empty() {
        return Ok("(无提交)".to_string());
    }
    let mut lines = Vec::new();
    for c in commits.iter().take(MAX_LIST_ITEMS) {
        let short: String = c.sha.chars().take(7).collect();
        let author = c.author.as_deref().unwrap_or("(未知)");
        let date = c.date.as_deref().unwrap_or("");
        lines.push(format!("{short} {} ({author}, {date})", c.message));
    }
    Ok(lines.join("\n"))
}

fn format_commit_detail(raw: &Value) -> String {
    let c = parse_commit(raw);
    let full = raw
        .get("commit")
        .and_then(|x| x.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    format!(
        "提交 {}\n作者: {} | 日期: {}\n消息:\n{}",
        c.sha,
        c.author.as_deref().unwrap_or("(未知)"),
        c.date.as_deref().unwrap_or("(未知)"),
        truncate(full, MAX_CONTENT_CHARS)
    )
}

fn format_event_list(raw: &Value) -> AppResult<String> {
    let events = parse_event_list(raw);
    if events.is_empty() {
        return Ok("(暂无动态)".to_string());
    }
    let mut lines = Vec::new();
    for e in events.iter().take(MAX_LIST_ITEMS) {
        let actor = e.actor.as_deref().unwrap_or("(未知)");
        let summary = if e.summary.is_empty() {
            "(无摘要)".to_string()
        } else {
            e.summary.clone()
        };
        lines.push(format!("[{}] {} · {} · {}", e.typ, actor, summary, e.created_at));
    }
    Ok(lines.join("\n"))
}

fn format_search_repo(raw: &Value) -> AppResult<String> {
    let items = parse_search_repo(raw);
    if items.is_empty() {
        return Ok("(未找到匹配仓库)".to_string());
    }
    let mut lines = Vec::new();
    for it in items.iter().take(MAX_LIST_ITEMS) {
        let lang = it.language.as_deref().unwrap_or("(未知)");
        let desc = it.description.as_deref().unwrap_or("(无描述)");
        lines.push(format!(
            "{} ⭐{} {} — {}",
            it.full_name, it.stargazers_count, lang, desc
        ));
    }
    Ok(lines.join("\n"))
}

fn format_search_code(raw: &Value) -> AppResult<String> {
    let items = parse_search_code(raw);
    if items.is_empty() {
        return Ok("(未找到匹配代码)".to_string());
    }
    let mut lines = Vec::new();
    for it in items.iter().take(MAX_LIST_ITEMS) {
        lines.push(format!("{} — {} ({})", it.repo_full_name, it.path, it.name));
    }
    Ok(lines.join("\n"))
}

/// 文件内容(base64 解码后截断)或目录列表。
fn format_content(raw: &Value) -> AppResult<String> {
    if raw.is_array() {
        let items = parse_content_list(raw);
        if items.is_empty() {
            return Ok("(空目录)".to_string());
        }
        let mut lines = Vec::new();
        for it in items.iter().take(100) {
            lines.push(format!("{:>8}  {}  {}", it.size, it.typ, it.name));
        }
        return Ok(lines.join("\n"));
    }
    let content = raw.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| AppError::Core("文件内容不是有效 base64".into()))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(truncate(&text, MAX_CONTENT_CHARS))
}

// ---- 工具定义(宏生成 struct + Tool impl)----

macro_rules! github_tool {
    ($struct:ident, $name:literal, $desc:literal, $params:expr, $safe:expr, $handler:ident) => {
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

            fn is_safe(&self) -> bool {
                $safe
            }

            async fn execute(
                &self,
                args: serde_json::Value,
                ctx: &ToolContext<'_>,
            ) -> AppResult<String> {
                $handler(self, args, ctx).await
            }
        }
    };
}

github_tool!(
    GithubGetRepoTool,
    "get_repo",
    "获取 GitHub 仓库详情",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string", "description": "仓库所有者" },
            "repo": { "type": "string", "description": "仓库名" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_get_repo
);

github_tool!(
    GithubListIssuesTool,
    "list_issues",
    "列出仓库 Issue(不含 Pull Request,默认 open,最多 10 条)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "过滤状态,默认 open" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_list_issues
);

github_tool!(
    GithubGetIssueTool,
    "get_issue",
    "获取单个 Issue 详情",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "number": { "type": "integer" }
        },
        "required": ["owner", "repo", "number"]
    }),
    true,
    handle_get_issue
);

github_tool!(
    GithubListPullsTool,
    "list_pulls",
    "列出仓库 Pull Request(默认 open,最多 10 条)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "过滤状态,默认 open" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_list_pulls
);

github_tool!(
    GithubGetPullTool,
    "get_pull",
    "获取单个 Pull Request 详情",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "number": { "type": "integer" }
        },
        "required": ["owner", "repo", "number"]
    }),
    true,
    handle_get_pull
);

github_tool!(
    GithubListCommitsTool,
    "list_commits",
    "列出仓库提交(最多 10 条)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "path": { "type": "string", "description": "限定文件路径" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_list_commits
);

github_tool!(
    GithubGetCommitTool,
    "get_commit",
    "获取单个提交详情",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "sha": { "type": "string" }
        },
        "required": ["owner", "repo", "sha"]
    }),
    true,
    handle_get_commit
);

github_tool!(
    GithubSearchRepoTool,
    "search_repo",
    "搜索 GitHub 仓库",
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" }
        },
        "required": ["query"]
    }),
    true,
    handle_search_repo
);

github_tool!(
    GithubSearchCodeTool,
    "search_code",
    "搜索 GitHub 代码(需要 GitHub token)",
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" }
        },
        "required": ["query"]
    }),
    false,
    handle_search_code
);

github_tool!(
    GithubGetFileTool,
    "get_file",
    "读取仓库文件内容(前 2000 字符)或目录列表",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "path": { "type": "string" }
        },
        "required": ["owner", "repo", "path"]
    }),
    true,
    handle_get_file
);

github_tool!(
    GithubGetReadmeTool,
    "get_readme",
    "读取仓库 README(前 2000 字符)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_get_readme
);

github_tool!(
    GithubGetRepoEventsTool,
    "get_repo_events",
    "获取仓库最近动态(最多 10 条)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" }
        },
        "required": ["owner", "repo"]
    }),
    true,
    handle_get_repo_events
);

github_tool!(
    GithubCreateIssueTool,
    "create_issue",
    "创建 Issue(仅限已绑定仓库)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "title": { "type": "string" },
            "body": { "type": "string" }
        },
        "required": ["owner", "repo", "title"]
    }),
    false,
    handle_create_issue
);

github_tool!(
    GithubAddIssueCommentTool,
    "add_issue_comment",
    "给 Issue 添加评论(仅限已绑定仓库)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "number": { "type": "integer" },
            "body": { "type": "string" }
        },
        "required": ["owner", "repo", "number", "body"]
    }),
    false,
    handle_add_issue_comment
);

github_tool!(
    GithubAddIssueLabelsTool,
    "add_issue_labels",
    "给 Issue 添加标签(仅限已绑定仓库)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "number": { "type": "integer" },
            "labels": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["owner", "repo", "number", "labels"]
    }),
    false,
    handle_add_issue_labels
);

github_tool!(
    GithubCreatePrReviewCommentTool,
    "create_pr_review_comment",
    "给 Pull Request 添加评论(仅限已绑定仓库)",
    json!({
        "type": "object",
        "properties": {
            "owner": { "type": "string" },
            "repo": { "type": "string" },
            "number": { "type": "integer" },
            "body": { "type": "string" },
            "commitId": { "type": "string" },
            "path": { "type": "string" },
            "line": { "type": "integer" }
        },
        "required": ["owner", "repo", "number", "body"]
    }),
    false,
    handle_create_pr_review_comment
);

// ---- 只读工具 handler ----

async fn handle_get_repo(
    tool: &GithubGetRepoTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool.client.get_json(&auth, &url_repo(&owner, &repo)).await?;
    Ok(format_repo_detail(&raw))
}

async fn handle_list_issues(
    tool: &GithubListIssuesTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let state = opt_str(&args, "state");
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_list_issues(&owner, &repo, state.as_deref()))
        .await?;
    format_issue_list(&raw)
}

async fn handle_get_issue(
    tool: &GithubGetIssueTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let number = req_i64(&args, "number")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_get_issue(&owner, &repo, number))
        .await?;
    Ok(format_issue_detail(&raw))
}

async fn handle_list_pulls(
    tool: &GithubListPullsTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let state = opt_str(&args, "state");
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_list_pulls(&owner, &repo, state.as_deref()))
        .await?;
    format_pull_list(&raw)
}

async fn handle_get_pull(
    tool: &GithubGetPullTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let number = req_i64(&args, "number")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_get_pull(&owner, &repo, number))
        .await?;
    Ok(format_pull_detail(&raw))
}

async fn handle_list_commits(
    tool: &GithubListCommitsTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let path = opt_str(&args, "path");
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_list_commits(&owner, &repo, path.as_deref()))
        .await?;
    format_commit_list(&raw)
}

async fn handle_get_commit(
    tool: &GithubGetCommitTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let sha = req_str(&args, "sha")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_get_commit(&owner, &repo, &sha))
        .await?;
    Ok(format_commit_detail(&raw))
}

async fn handle_search_repo(
    tool: &GithubSearchRepoTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let query = req_str(&args, "query")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool.client.get_json(&auth, &url_search_repo(&query)).await?;
    format_search_repo(&raw)
}

async fn handle_search_code(
    tool: &GithubSearchCodeTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let query = req_str(&args, "query")?;
    let token = resolve_token(ctx)
        .await?
        .ok_or_else(|| AppError::Core("需要 GitHub token".into()))?;
    let auth = GithubAuth { token: Some(token) };
    let raw = tool.client.get_json(&auth, &url_search_code(&query)).await?;
    format_search_code(&raw)
}

async fn handle_get_file(
    tool: &GithubGetFileTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let path = req_str(&args, "path")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_get_content(&owner, &repo, &path))
        .await?;
    format_content(&raw)
}

async fn handle_get_readme(
    tool: &GithubGetReadmeTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool.client.get_json(&auth, &url_get_readme(&owner, &repo)).await?;
    format_content(&raw)
}

async fn handle_get_repo_events(
    tool: &GithubGetRepoEventsTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let raw = tool
        .client
        .get_json(&auth, &url_list_events(&owner, &repo))
        .await?;
    format_event_list(&raw)
}

// ---- 写入工具 handler ----

async fn handle_create_issue(
    tool: &GithubCreateIssueTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let title = req_str(&args, "title")?;
    let body = opt_str(&args, "body");
    require_repo_bound(ctx, &owner, &repo).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let payload = create_issue_body(&title, body.as_deref());
    let resp = tool
        .client
        .post_json(&auth, &url_create_issue(&owner, &repo), &payload)
        .await?;
    let n = resp.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(format!("已创建 Issue #{n}: {title}"))
}

async fn handle_add_issue_comment(
    tool: &GithubAddIssueCommentTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let number = req_i64(&args, "number")?;
    let body = req_str(&args, "body")?;
    require_repo_bound(ctx, &owner, &repo).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let payload = add_issue_comment_body(&body);
    let resp = tool
        .client
        .post_json(
            &auth,
            &url_create_issue_comment(&owner, &repo, number),
            &payload,
        )
        .await?;
    let id = resp.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(format!("已评论 Issue #{number}(评论 #{id})"))
}

async fn handle_add_issue_labels(
    tool: &GithubAddIssueLabelsTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let number = req_i64(&args, "number")?;
    let labels = req_str_array(&args, "labels")?;
    require_repo_bound(ctx, &owner, &repo).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let payload = add_issue_labels_body(&labels);
    let resp = tool
        .client
        .post_json(
            &auth,
            &url_add_issue_labels(&owner, &repo, number),
            &payload,
        )
        .await?;
    let names: Vec<&str> = resp
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    Ok(format!(
        "已为 Issue #{number} 添加标签: {}",
        names.join(", ")
    ))
}

async fn handle_create_pr_review_comment(
    tool: &GithubCreatePrReviewCommentTool,
    args: Value,
    ctx: &ToolContext<'_>,
) -> AppResult<String> {
    let owner = req_str(&args, "owner")?;
    let repo = req_str(&args, "repo")?;
    let number = req_i64(&args, "number")?;
    let body = req_str(&args, "body")?;
    let commit_id = opt_str(&args, "commitId");
    let path = opt_str(&args, "path");
    let line = args.get("line").and_then(|v| v.as_i64());
    require_repo_bound(ctx, &owner, &repo).await?;
    let auth = GithubAuth {
        token: resolve_token(ctx).await?,
    };
    let payload = pr_review_comment_body(&body, commit_id.as_deref(), path.as_deref(), line);
    let resp = tool
        .client
        .post_json(
            &auth,
            &url_pr_review_comment(&owner, &repo, number),
            &payload,
        )
        .await?;
    let id = resp.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(format!("已添加 PR 评论 #{id} 到 PR #{number}"))
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
    }

    fn client() -> Arc<GithubClient> {
        Arc::new(GithubClient::new())
    }

    /// 16 个工具全量(共享一个 client)。
    fn all_tools() -> Vec<Box<dyn Tool>> {
        let c = client();
        vec![
            Box::new(GithubGetRepoTool::new(c.clone())),
            Box::new(GithubListIssuesTool::new(c.clone())),
            Box::new(GithubGetIssueTool::new(c.clone())),
            Box::new(GithubListPullsTool::new(c.clone())),
            Box::new(GithubGetPullTool::new(c.clone())),
            Box::new(GithubListCommitsTool::new(c.clone())),
            Box::new(GithubGetCommitTool::new(c.clone())),
            Box::new(GithubSearchRepoTool::new(c.clone())),
            Box::new(GithubSearchCodeTool::new(c.clone())),
            Box::new(GithubGetFileTool::new(c.clone())),
            Box::new(GithubGetReadmeTool::new(c.clone())),
            Box::new(GithubGetRepoEventsTool::new(c.clone())),
            Box::new(GithubCreateIssueTool::new(c.clone())),
            Box::new(GithubAddIssueCommentTool::new(c.clone())),
            Box::new(GithubAddIssueLabelsTool::new(c.clone())),
            Box::new(GithubCreatePrReviewCommentTool::new(c.clone())),
        ]
    }

    #[test]
    fn test_all_tools_meta_unique() {
        let tools = all_tools();
        assert_eq!(tools.len(), 16);
        let mut names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
        names.sort();
        let mut dedup = names.clone();
        dedup.dedup();
        assert_eq!(names, dedup, "工具名应唯一");
        for t in tools {
            assert!(!t.description().is_empty());
            assert_eq!(t.parameters()["type"], "object");
        }
    }

    #[test]
    fn test_is_safe_flags() {
        let unsafe_names = [
            "search_code",
            "create_issue",
            "add_issue_comment",
            "add_issue_labels",
            "create_pr_review_comment",
        ];
        for t in all_tools() {
            let expected = !unsafe_names.contains(&t.name());
            assert_eq!(t.is_safe(), expected, "工具 {} 的 is_safe 错误", t.name());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_repo_requires_owner_repo() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubGetRepoTool::new(client());
        let err = tool.execute(json!({}), &ctx).await.unwrap_err();
        assert!(err.to_string().contains("缺少参数: owner"));
        let err = tool
            .execute(json!({ "owner": "o" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("缺少参数: repo"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_issue_requires_number() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubGetIssueTool::new(client());
        let err = tool
            .execute(json!({ "owner": "o", "repo": "r" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("缺少参数: number"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_create_issue_requires_title() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubCreateIssueTool::new(client());
        let err = tool
            .execute(json!({ "owner": "o", "repo": "r" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("缺少参数: title"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_add_issue_labels_requires_labels() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubAddIssueLabelsTool::new(client());
        let err = tool
            .execute(json!({ "owner": "o", "repo": "r", "number": 1 }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("缺少参数: labels"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_pr_review_comment_requires_body() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubCreatePrReviewCommentTool::new(client());
        let err = tool
            .execute(json!({ "owner": "o", "repo": "r", "number": 1 }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("缺少参数: body"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_write_tool_unbound_repo_rejected() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubCreateIssueTool::new(client());
        let err = tool
            .execute(
                json!({ "owner": "o", "repo": "r", "title": "x" }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未绑定"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_require_repo_bound_gate() {
        let owned = TestCtx::new().await;
        owned.db.add_github_repo("owner", "repo").await.unwrap();
        let ctx = owned.tool_ctx(1);
        require_repo_bound(&ctx, "owner", "repo").await.unwrap();
        let err = require_repo_bound(&ctx, "owner", "other")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未绑定"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_search_code_requires_token() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        let tool = GithubSearchCodeTool::new(client());
        let err = tool
            .execute(json!({ "query": "fn main" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("需要 GitHub token"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_token_resolution_bot_priority() {
        let owned = TestCtx::new().await;
        owned.db.set_github_token(Some("global_token")).await.unwrap();
        let bot_id = owned.db.insert_bot(1, 1, "bot", 0).await.unwrap();
        let cfg = json!({ "llm": null, "project_context": { "github_token": "bot_token" } });
        owned
            .db
            .set_bot_config_by_id(bot_id, Some(&cfg.to_string()))
            .await
            .unwrap();
        let ctx = owned.tool_ctx(bot_id);
        assert_eq!(
            resolve_token(&ctx).await.unwrap().as_deref(),
            Some("bot_token")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_token_resolution_global_fallback() {
        let owned = TestCtx::new().await;
        owned.db.set_github_token(Some("global_token")).await.unwrap();
        let ctx = owned.tool_ctx(1);
        assert_eq!(
            resolve_token(&ctx).await.unwrap().as_deref(),
            Some("global_token")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_token_resolution_none() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx(1);
        assert_eq!(resolve_token(&ctx).await.unwrap(), None);
    }

    #[test]
    fn test_list_issues_filters_pull_requests() {
        let raw = json!([
            { "number": 1, "title": "real issue", "state": "open", "user": { "login": "a" }, "created_at": "x", "updated_at": "y", "labels": [], "body": null, "html_url": "u" },
            { "number": 2, "title": "a PR", "state": "open", "user": { "login": "b" }, "pull_request": { "url": "https://api.github.com/repos/o/r/pulls/2" }, "created_at": "x", "updated_at": "y", "labels": [], "body": null, "html_url": "u" },
            { "number": 3, "title": "another issue", "state": "closed", "user": { "login": "c" }, "created_at": "x", "updated_at": "y", "labels": [], "body": null, "html_url": "u" }
        ]);
        let out = format_issue_list(&raw).unwrap();
        assert!(out.contains("#1"));
        assert!(out.contains("#3"));
        assert!(!out.contains("#2"), "PR 应被过滤:{out}");
        assert!(!out.contains("a PR"));
    }

    #[test]
    fn test_format_issue_list_line() {
        let raw = json!([{
            "number": 42, "title": "标题", "state": "open", "user": { "login": "octo" },
            "created_at": "x", "updated_at": "y", "labels": [], "body": null, "html_url": "u"
        }]);
        assert_eq!(format_issue_list(&raw).unwrap(), "#42 [open] 标题 (octo)");
    }

    #[test]
    fn test_format_issue_detail() {
        let raw = json!({
            "number": 1347, "title": "Found a bug", "state": "open", "user": { "login": "octocat" },
            "created_at": "2011-04-22T13:33:48Z", "updated_at": "2011-04-22T13:33:48Z",
            "labels": [ { "name": "bug" } ], "body": "I'm having a problem", "html_url": "u"
        });
        let out = format_issue_detail(&raw);
        assert!(out.contains("#1347 Found a bug"));
        assert!(out.contains("状态: open"));
        assert!(out.contains("作者: octocat"));
        assert!(out.contains("I'm having a problem"));
        assert!(out.contains("URL:"));
    }

    #[test]
    fn test_format_pull_detail() {
        let raw = json!({
            "number": 2, "title": "Add feature", "state": "open", "user": { "login": "octo" },
            "created_at": "a", "updated_at": "b", "merged_at": null,
            "additions": 10, "deletions": 3, "html_url": "u"
        });
        let out = format_pull_detail(&raw);
        assert!(out.contains("PR #2 Add feature"));
        assert!(out.contains("+10/-3"));
        assert!(out.contains("未合并"));
    }

    #[test]
    fn test_format_event_list() {
        let raw = json!([{
            "type": "PushEvent", "actor": { "login": "octo" }, "created_at": "t",
            "payload": { "commits": [1, 2, 3] }
        }]);
        let out = format_event_list(&raw).unwrap();
        assert!(out.contains("[PushEvent] octo · 3 次提交 · t"));
    }

    #[test]
    fn test_format_repo_detail() {
        let raw = json!({
            "full_name": "o/r", "description": "desc", "language": "Rust",
            "stargazers_count": 100, "forks_count": 2, "open_issues_count": 3,
            "default_branch": "main", "html_url": "u"
        });
        let out = format_repo_detail(&raw);
        assert!(out.contains("o/r"));
        assert!(out.contains("星标: 100"));
        assert!(out.contains("main"));
    }

    #[test]
    fn test_format_commit_list() {
        let raw = json!([{
            "sha": "abcdef1234567",
            "commit": { "message": "fix: 标题\nbody 部分", "author": { "name": "M", "date": "d" } }
        }]);
        let out = format_commit_list(&raw).unwrap();
        assert!(out.contains("abcdef1"));
        assert!(out.contains("fix: 标题"));
        assert!(out.contains("M"));
    }

    #[test]
    fn test_truncate_content() {
        let long = "x".repeat(2500);
        let out = truncate(&long, 2000);
        assert!(out.ends_with("…(截断)"));
        assert_eq!(out.chars().count(), 2000 + "…(截断)".chars().count());
        assert_eq!(truncate("short", 2000), "short");
    }

    #[test]
    fn test_format_content_file_and_dir() {
        let file = json!({
            "name": "a.txt", "path": "a.txt", "type": "file", "size": 11,
            "content": "aGVsbG8gd29ybGQ="
        });
        assert_eq!(format_content(&file).unwrap(), "hello world");

        let dir = json!([
            { "name": "src", "path": "src", "type": "dir", "size": 0 },
            { "name": "Cargo.toml", "path": "Cargo.toml", "type": "file", "size": 100 }
        ]);
        let out = format_content(&dir).unwrap();
        assert!(out.contains("src"));
        assert!(out.contains("Cargo.toml"));
    }
}
