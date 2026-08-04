# D1:GitHub 集成设计文档

> **定位**: Bot 系统骨架(B3/B4/B5)之后的第一块开发者能力。连接 GitHub,让 AI 理解开发者项目环境,并提供独立的人类可浏览界面。为 D2(项目理解/代码分析)提供仓库数据地基。
>
> **前置决策**(brainstorming 确认):
> - 凭据:每 Bot 配置 token(存后端 SQLite);GitHubPage 用全局共享 token
> - repo_path 语义:GitHub 仓库标识 `owner/repo`(纯 API,无本地克隆)
> - 功能:GitHub API 工具集 + 仓库动态(按需查询工具)+ 写入操作(默认关闭+显式启用)+ 管理中心配置 UI + 独立 GitHubPage(人类界面)
> - 仓库绑定:手动添加 + 共享绑定列表
> - 访问层:方案 A 独立 github/ 模块(GithubClient + 纯函数 API + DTO),工具薄封装,界面命令复用

## 1. 总览与模块布局

```
src-tauri/src/
├── github/                    # 新:GitHub 访问层
│   ├── mod.rs                 # 装配 + 导出
│   ├── client.rs              # GithubClient(reqwest, auth/限速/错误映射)
│   ├── api.rs                 # 纯函数端点:请求构造 + 响应解析
│   └── types.rs               # GitHub 响应 DTO
├── tools/github.rs            # 新:Bot 工具薄封装
├── tools/mod.rs               # 改:注册 GitHub 工具
├── dto.rs                     # 改:GithubSettingsDto/GithubRepoDto + ProjectContext 扩展
├── db.rs                      # 改:github_settings + github_repos 表
├── commands.rs                # 改:GitHub 界面命令 + 设置命令
├── error.rs                   # 改:AppError 新增 GitHub 变体
├── state.rs / lib.rs          # 改:设置状态 + 命令注册
└── src/pages/githubPage.ts    # 新:独立 GitHub 界面
    ├── src/shell/navPanel.ts  # 改:rail 入口
    └── src/settingsPage.ts    # 改:全局 token 设置
```

## 2. GitHub 访问层(github/)

### 2.1 GithubClient(client.rs)

```rust
pub struct GithubClient { http: reqwest::Client }
pub struct GithubAuth { pub token: Option<String> }  // None = 公开只读

pub async fn get_json(&self, auth: &GithubAuth, url: &str) -> AppResult<serde_json::Value>;
pub async fn get_bytes(&self, auth: &GithubAuth, url: &str) -> AppResult<Vec<u8>>; // raw 内容
pub async fn post_json(&self, auth: &GithubAuth, url: &str, body: &Value) -> AppResult<Value>;
pub async fn patch_json(&self, auth: &GithubAuth, url: &str, body: &Value) -> AppResult<Value>;
pub async fn delete(&self, auth: &GithubAuth, url: &str) -> AppResult<()>;
```

- 无 token → 公开 API(限速 60/h);有 token → `Authorization: Bearer`
- 错误映射:`429/403` → `GitHubRateLimit`(附 reset 提示)、`401` → `GitHubAuth`、`404` → `GitHubNotFound`、5xx → `GitHubServer`
- `ApiError` 内部枚举(解析 body 的 message 字段),映射到 `AppError`

### 2.2 API 端点(api.rs,纯函数可单测)

| 函数 | 端点 | 用途 |
|---|---|---|
| `repo(owner, repo)` | `GET /repos/{o}/{r}` | 仓库详情 |
| `list_issues(owner, repo, state?)` | `GET /repos/{o}/{r}/issues?state=` | Issue 列表 |
| `get_issue(owner, repo, n)` | `GET /repos/{o}/{r}/issues/{n}` | Issue 详情 |
| `list_pulls(owner, repo, state?)` | `GET /repos/{o}/{r}/pulls?state=` | PR 列表 |
| `get_pull(owner, repo, n)` | `GET /repos/{o}/{r}/pulls/{n}` | PR 详情 |
| `list_commits(owner, repo, path?)` | `GET /repos/{o}/{r}/commits` | Commit 列表 |
| `get_commit(owner, repo, sha)` | `GET /repos/{o}/{r}/commits/{sha}` | Commit 详情 |
| `search_repo(query)` | `GET /search/repositories?q=` | 仓库搜索 |
| `search_code(query)` | `GET /search/code?q=` | 代码搜索(需 token) |
| `get_content(owner, repo, path)` | `GET /repos/{o}/{r}/contents/{path}` | 文件/目录 |
| `get_readme(owner, repo)` | `GET /repos/{o}/{r}/readme` | README |
| `list_events(owner, repo)` | `GET /repos/{o}/{r}/events` | 仓库动态 |
| 写入:`create_issue` / `create_issue_comment` / `add_issue_labels` / `create_pr_review_comment` | `POST/PATCH` | 写入操作 |

- 函数签名:纯函数构造 URL + 返回 `(url, body)` 或解析 `serde_json::Value` → DTO
- URL 用 `urlencoding`(已有依赖)编码 owner/repo/path

### 2.3 DTO(types.rs)

```rust
pub struct RepoDto { full_name, description, language, stargazers_count, forks_count, open_issues_count, default_branch, html_url }
pub struct IssueDto { number, title, state, user, created_at, updated_at, labels: Vec<String>, body, html_url }
pub struct PullDto { number, title, state, user, created_at, updated_at, merged_at, additions, deletions, html_url }
pub struct CommitDto { sha, message, author, date }
pub struct EventDto { typ, actor, created_at, summary }
pub struct ContentDto { name, path, typ: String("file"|"dir"), size, content }
pub struct SearchRepoDto { full_name, description, stargazers_count, language, html_url }
pub struct SearchCodeDto { name, path, repo_full_name, html_url }
```

- 解析为纯函数 `parse_repo(&Value) -> RepoDto` 等,缺失字段取默认,可单测
- 需 `serde::Deserialize` 派生或手写 Value 读取——**推荐手写 Value 读取**(对 GitHub 大 JSON 更稳健,字段缺失不炸),但若字段名明确可直接 derive。实施时二选一,保持一致。

## 3. Bot 工具(tools/github.rs)

实现 `Tool` trait,经 `ToolContext` 取 token:

| 工具 | 参数 | safe | 说明 |
|---|---|---|---|
| `get_repo` | `owner: string, repo: string` | true | 仓库详情 |
| `list_issues` | `owner, repo, state?` | true | Issue 列表(默认 open,最多 10) |
| `get_issue` | `owner, repo, number` | true | Issue 详情 |
| `list_pulls` | `owner, repo, state?` | true | PR 列表 |
| `get_pull` | `owner, repo, number` | true | PR 详情 |
| `list_commits` | `owner, repo, path?` | true | Commit 列表 |
| `get_commit` | `owner, repo, sha` | true | Commit 详情 |
| `search_repo` | `query` | true | 仓库搜索 |
| `search_code` | `query` | false | 代码搜索(需 token) |
| `get_file` | `owner, repo, path` | true | 文件内容(前 2000 字符) |
| `get_readme` | `owner, repo` | true | README(前 2000 字符) |
| `get_repo_events` | `owner, repo` | true | 最近动态(10 条) |
| `create_issue` | `owner, repo, title, body?` | false | 创建 Issue |
| `add_issue_comment` | `owner, repo, number, body` | false | 评论 |
| `add_issue_labels` | `owner, repo, number, labels: string[]` | false | 打标签 |
| `create_pr_review_comment` | `owner, repo, number, body, commitId?, path?, line?` | false | PR 评论 |

- token 来源:`ToolContext` 传入 bot 的 `project_context.github_token` → 回退全局 settings token
- 写入工具默认 `safe=false`,需显式启用
- **写入工具仅限已绑定仓库**(`github_repos` 表),防止 Bot 对任意仓库写入;只读工具允许任意公开仓库
- 返回人类可读 + LLM 友好的格式化文本

## 4. 数据层(db.rs + dto.rs)

### 4.1 表
```sql
CREATE TABLE IF NOT EXISTS github_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS github_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,  -- "owner/repo"
  added_at INTEGER NOT NULL
);
```

### 4.2 Db 方法
- `get_github_settings()` / `set_github_token(Option<&str>)`
- `list_github_repos()` / `add_github_repo(owner, repo)`(冲突返回错误或忽略)/ `remove_github_repo(id)`

### 4.3 ProjectContext 扩展(dto.rs)
```rust
pub struct ProjectContext {
    pub workspace_id: Option<i64>,
    pub chat_ids: Vec<u32>,
    pub description: Option<String>,
    pub repo_path: Option<String>,       // 语义改为 "owner/repo" GitHub 标识
    pub github_token: Option<String>,    // 新:每 Bot 的 GitHub token(优先,回退全局)
}
```

### 4.4 dto 新增
```rust
pub struct GithubSettingsDto { pub token: Option<String> }
pub struct GithubRepoDto { pub id: i64, pub owner: String, pub repo: String, pub full_name: String }
```

## 5. 命令层(commands.rs,全部非 bot 特定、无需 owner 校验的界面命令 + 设置命令)

| 命令 | 入参 | 返回 |
|---|---|---|
| `get_github_settings` | — | `GithubSettingsDto` |
| `set_github_token` | `token: Option<String>`(None=清除) | `()` |
| `list_github_repos` | — | `Vec<GithubRepoDto>` |
| `add_github_repo` | `owner: String, repo: String` | `GithubRepoDto`(校验 owner/repo 格式) |
| `remove_github_repo` | `id: i64` | `()` |
| `github_repo` | `owner, repo` | `RepoDto` |
| `github_list_issues` | `owner, repo, state?` | `Vec<IssueDto>` |
| `github_get_issue` | `owner, repo, number` | `IssueDto` |
| `github_list_pulls` | `owner, repo, state?` | `Vec<PullDto>` |
| `github_list_commits` | `owner, repo, path?` | `Vec<CommitDto>` |
| `github_search_repo` | `query` | `Vec<SearchRepoDto>` |
| `github_search_code` | `query` | `Vec<SearchCodeDto>`(需 token) |
| `github_list_events` | `owner, repo` | `Vec<EventDto>` |
| `github_get_content` | `owner, repo, path` | `Vec<ContentDto>`(目录) / 单文件 |

- 界面命令统一用全局 token(无则公开只读);命令构造 URL 解析用 api.rs 纯函数
- 全局 `GithubClient` 经 `AppState` 共享

## 6. 错误模型(error.rs)

```rust
GitHubRateLimit(String)  // 429/403,附 reset 提示
GitHubAuth(String)       // 401,提示检查 token
GitHubServer(String)     // 5xx
GitHubNotFound(String)   // 404
```
- 错误消息透传前端(现有 showError/toast)
- `error.rs` 现有 `AppError` 枚举 + `Display` + `From<...>` 需扩展

## 7. 前端

### 7.1 rail 入口 + 页面
- navPanel.ts 加 GitHub 入口(图标,与 inbox/work 平级)
- `src/pages/githubPage.ts` 新建

### 7.2 GitHubPage 结构
```
GitHubPage
├─ 设置区:token 输入(密码框,存全局)+ 已绑定仓库管理(添加 owner/repo、删除)
├─ 仓库视图(选一个已绑定仓库):
│  ├─ Tab:Issues | Pulls | Commits | 文件 | 动态 | 详情
│  ├─ Issues:列表(编号/标题/state/标签)→ 点击展开详情
│  ├─ Pulls:列表(编号/标题/state/增删行数)→ 详情
│  ├─ Commits:sha 前7/消息/作者/日期
│  ├─ 文件:目录树 → 文件内容(只读,前 2000 字符)
│  ├─ 动态:事件时间线(type/actor/时间/摘要)
│  └─ 详情:描述/语言/星标/fork/open_issues/默认分支/README
└─ 搜索区:仓库搜索 / 代码搜索(需 token)
```
- 全部走界面命令(全局 token);无 token 只读公开
- 复用 ui.ts 组件;不新增全局 CSS

### 7.3 管理中心 LLM Tab 项目上下文区扩展
- repo_path placeholder 改 `owner/repo`
- 新增 github_token 输入(每 Bot)
- 已绑定仓库下拉(从 list_github_repos)帮助选择 repo_path

### 7.4 设置页
- 「GitHub」区:全局 token(密码框 + 保存/清除)

## 8. api-spec 收口
- §2 新增 GitHub 命令组(§5 全部命令)
- §3 错误模型补 GitHub 变体
- §5/§7 DTO 章节补 GithubSettingsDto/GithubRepoDto/RepoDto/IssueDto/PullDto/CommitDto/EventDto/ContentDto/SearchRepoDto/SearchCodeDto;ProjectContext 补 github_token + repo_path 语义
- 前端 `api.ts` 或直接 call 使用;统一 snake_case 响应字段

## 9. 测试与验收

### 单元测试(cargo test --lib,不触发真实网络)
- `github/types.rs`:`parse_*` 对样例 JSON 解析正确(缺失字段取默认)
- `github/api.rs`:URL 构造(owner/repo/state/path 拼接、编码)
- `github/client.rs`:错误映射(401→GitHubAuth、429/403→RateLimit、404→NotFound、5xx→Server)——注入错误码分支或 mock
- `tools/github.rs`:参数校验(缺 owner/repo 报错)、格式化输出、写入工具 is_safe=false、写入工具限绑定仓库
- `db.rs`:github_settings upsert/read、github_repos CRUD + 唯一约束
- `dto.rs`:ProjectContext round-trip(含 github_token)
- 既有 150 测试不回归

### 编译/手动
- [ ] `cargo build` / `cargo test --lib` 通过;`npx tsc --noEmit` 干净
- [ ] 设置页配 token → GitHubPage 加载公开/私有仓库数据
- [ ] GitHubPage 各 tab(Issues/Pulls/Commits/文件/动态/详情)正常
- [ ] 绑定/删除仓库 → 列表持久化
- [ ] Bot 配 repo_path → 问「这个仓库的 README 是什么」→ 工具返回内容
- [ ] 写入工具:未启用时 LLM 调 create_issue 报「未启用」;启用后创建成功
- [ ] 无 token:公开仓库只读正常;私有仓库提示需 token
- [ ] 错误路径:假 token → GitHubAuth 提示;不存在仓库 → NotFound
- [ ] 既有功能(规则/定时/管理中心)不回归

## 10. 改动文件清单

- 新增:`src-tauri/src/github/{mod,client,api,types}.rs`、`src-tauri/src/tools/github.rs`、`src/pages/githubPage.ts`
- 修改:`error.rs`、`dto.rs`、`db.rs`、`commands.rs`、`tools/mod.rs`、`state.rs`、`lib.rs`、`src/shell/navPanel.ts`、`src/settingsPage.ts`、`src/pages/botsPage.ts`、`docs/api-spec.md`
- 文档:本设计文档

## 11. 变更记录

- 2026-08-04 初稿。基于 brainstorming 确认的决策;范围含独立 GitHubPage(用户要求)与每 Bot token + 全局 token 双轨。
