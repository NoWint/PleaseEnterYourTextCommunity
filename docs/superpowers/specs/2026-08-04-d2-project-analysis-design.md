# D2:项目理解与代码分析 设计文档

> **定位**: 在 D1 GitHub 集成基础上,新增**本地代码访问层**与统一抽象,让 Bot(及人类界面)理解项目结构、读取代码、辅助 Debug。数据源本地优先 + GitHub 回退。
>
> **前置决策**(brainstorming 确认):
> - 数据源:本地仓库路径优先,无则回退 GitHub API(D1)
> - 范围:项目结构/文件读取工具 + 代码分析辅助(LLM+上下文)+ 本地索引/缓存 + 项目浏览界面
> - 沙箱:每 Bot 配 `sandbox_mode`('repo' 限本地仓库目录 / 'any' 任意路径),默认 'repo'
> - 索引:轻量自建(mtime 检测,不引入开源索引库)
> - 访问层:方案 A 独立 code/ 模块(CodeSource 统一抽象),工具薄封装,界面复用
> - 前端:后端 + 前端都做(项目上下文区加配置,文件浏览加数据源 badge)

## 1. 总览与模块布局

```
src-tauri/src/
├── code/                       # 新:代码访问层
│   ├── mod.rs                  # CodeSource 枚举 + 装配 + 导出
│   ├── source.rs               # CodeSource(Local|Github)统一 read_file/list_tree/find_files
│   ├── local.rs                # 本地实现:沙箱校验 + mtime 索引 + 目录遍历
│   └── index.rs                # 轻量索引(文件清单缓存 + 目录 mtime 检测)
├── tools/code.rs               # 新:Bot 代码工具(薄封装 CodeSource)
├── tools/mod.rs                # 改:注册代码工具
├── dto.rs                      # 改:ProjectContext 加 repo_local_path + sandbox_mode
├── commands.rs                 # 改:项目浏览命令(project_list_tree/project_read_file)
├── lib.rs                      # 改:注册代码工具
└── src/pages/botsPage.ts       # 改:项目上下文区加本地路径/沙箱配置
    └── src/pages/githubPage.ts # 改:文件 tab 数据源 badge(本地/GitHub)
```

## 2. 配置扩展(dto.rs)

```rust
pub struct ProjectContext {
    pub workspace_id: Option<i64>,
    pub chat_ids: Vec<u32>,
    pub description: Option<String>,
    pub repo_path: Option<String>,        // GitHub "owner/repo"(D1)
    pub github_token: Option<String>,     // D1
    pub repo_local_path: Option<String>,  // 新:本地仓库路径(优先,无则 GitHub 回退)
    pub sandbox_mode: Option<String>,     // 新:"repo"(默认,限本地仓库目录)| "any"(任意相对路径)
}
```
- `sandbox_mode` 缺省解析为 "repo"(向后兼容);serde default
- round-trip 测试补新字段

## 3. 代码访问层(code/)

### 3.1 CodeSource(source.rs)
```rust
pub enum CodeSource {
    Local { root: PathBuf, sandbox_mode: SandboxMode },
    Github { owner: String, repo: String },
}
pub enum SandboxMode { Repo, Any }

pub struct CodeEntry { pub path: String, pub name: String, pub is_dir: bool, pub size: i64 }

impl CodeSource {
    /// 从 ProjectContext 解析:本地路径存在则 Local,否则有 repo_path 则 Github,皆无则 None
    pub fn from_project_context(pc: &ProjectContext) -> Option<CodeSource>;
    pub async fn read_file(&self, client: &GithubClient, rel: &str) -> AppResult<String>;
    pub async fn list_tree(&self, client: &GithubClient, prefix: &str) -> AppResult<Vec<CodeEntry>>;
    pub async fn find_files(&self, client: &GithubClient, name: &str) -> AppResult<Vec<CodeEntry>>;
}
```
- 数据源选择:有 `repo_local_path` 且目录存在 → Local;否则有 `repo_path` → Github;皆无 → None(调用方提示「未配置项目仓库」)
- 界面/工具对本地/GitHub 切换透明

### 3.2 本地实现(local.rs)
- **沙箱校验**:`resolve_safe(root, rel, mode)` — 相对路径拼接,规范化校验前缀在 root 内(Repo 模式);Any 模式也拒绝绝对路径/`..`/`~`(仅允许相对路径语义)。越界 → `AppError::Core("路径越界")`
- **目录遍历**:`list_tree(root, prefix)` 读目录项(名称/类型/大小),递归限深度(默认 3)、限条目数(默认 200)
- **文件读取**:`read_file(root, rel)` ≤ 64KB(超限截断 + 提示),二进制检测(NUL 字节 → 「二进制文件」)
- **find_files**:递归按文件名包含匹配(忽略大小写),忽略 .git/node_modules/target,限 20 结果

### 3.3 索引(index.rs)
- `IndexCache: Arc<RwLock<HashMap<PathBuf, IndexEntry>>>`
- `IndexEntry { mtime_secs, files: Vec<IndexFile> }`;`IndexFile { path, size, mtime }`
- **惰性 + mtime 检测**:首次访问扫描建索引(忽略 .git/node_modules/target 等);后续先查 root 目录 mtime(递归浅层),变化才重扫
- 目录遍历用索引加速;线程安全,进程级单例(经 AppState 或模块级)

### 3.4 GitHub 回退
- 复用 D1 `GithubClient` + `github::api`:`list_tree` 逐层调 `get_content`(contents API 一次一目录);`read_file` → 单文件 base64 解码
- GitHub contents API 不递归,目录树逐层拉取(深度受限)

## 4. Bot 代码工具(tools/code.rs)

所有工具从 `ToolContext` 的 bot config(project_context)构造 CodeSource,`is_safe=true`(只读):

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_project_files` | `prefix?: string` | 项目结构树(单层目录列表) |
| `read_project_file` | `path: string` | 文件内容(≤64KB,本地/GitHub 回退) |
| `find_project_files` | `name: string` | 按文件名/扩展名搜索(递归) |
| `list_project_root` | — | 仓库根目录项(名称/类型/大小) |

- 输出格式化:目录树行缩进、文件内容含 `path: ` 前缀
- **代码分析辅助** = 这些工具的 LLM 工具循环组合:Bot 问「这个 bug 在哪」→ LLM 依次调 list/read/find 收集上下文 → 综合分析。无需单独「分析」工具
- token:GitHub 回退时复用 D1 的 resolve_token(bot token → 全局)

## 5. 项目浏览界面(前端)

### 5.1 botsPage.ts 项目上下文区扩展
- 加 `repo_local_path` 输入(本地仓库路径)
- 加 `sandbox_mode` 下拉('repo' 限目录 / 'any' 任意路径)
- 保存走 update_bot_config

### 5.2 githubPage.ts 文件 tab 数据源 badge
- 文件 tab 显示数据源 badge:有本地路径且目录存在 → 「本地」;否则 → 「GitHub」
- 仅指示,不改变当前浏览行为(GitHub 数据源为主;本地优先仅用于 Bot 工具)

## 6. 命令层(commands.rs)

| 命令 | 入参 | 返回 |
|---|---|---|
| `project_list_tree` | `localPath?: String, owner?: String, repo?: String` | `Vec<CodeEntry>` |
| `project_read_file` | `localPath?, owner?, repo?, path: String` | 文件内容 |

- 界面命令接受显式 localPath 或 owner/repo,构造 CodeSource,不依赖 Bot
- 复用 `code::CodeSource` + 现有 GithubClient(AppState.github)

## 7. 测试与验收

### 单元测试(cargo test --lib,不触发网络)
- `code/local.rs`:沙箱 resolve_safe(合法相对路径通过、`../` 拒绝、绝对路径拒绝、Repo 越界拒绝、Any 允许)、list_tree(临时目录结构)、read_file(超限截断、二进制检测)、find_files(递归/忽略 .git)
- `code/index.rs`:mtime 检测(目录不变不重扫、变则重扫)、忽略清单
- `code/source.rs`:从 ProjectContext 构造(本地存在→Local、无本地有 repo_path→Github、皆无→None)
- `dto.rs`:ProjectContext 新字段 round-trip
- `tools/code.rs`:参数校验、格式化输出、is_safe
- 既有 228 测试不回归

### 编译/手动
- [ ] `cargo build` / `cargo test --lib` 通过;`npx tsc --noEmit` 干净
- [ ] Bot 配 repo_local_path → 「项目里有哪些文件」→ list_project_files;「读 src/main.ts」→ read_project_file;「找 xx 文件」→ find_project_files
- [ ] 未配本地但有 repo_path → 自动 GitHub 回退
- [ ] 沙箱:Bot 读本地仓库外路径 → Repo 模式拒绝;Any 模式放行
- [ ] 大仓库:首次慢,二次快(mtime 缓存)
- [ ] 项目浏览界面:文件 tab 数据源 badge;project_list_tree/read 命令可用
- [ ] 错误:未配仓库 → 提示;不存在文件 → NotFound
- [ ] 既有功能(D1/B3/B4/B5)不回归

## 8. 改动文件清单

- 新增:`src-tauri/src/code/{mod,source,local,index}.rs`、`src-tauri/src/tools/code.rs`
- 修改:`dto.rs`(ProjectContext 扩展)、`commands.rs`(项目浏览命令)、`tools/mod.rs`(注册)、`lib.rs`(注册)、`src/pages/botsPage.ts`(项目上下文区)、`src/pages/githubPage.ts`(数据源 badge)、`docs/api-spec.md`
- 文档:本设计文档

## 9. 变更记录

- 2026-08-04 初稿。基于 brainstorming 确认的决策(本地优先+GitHub回退、每Bot沙箱、轻量索引、code 模块方案 A、前后端都做)。
