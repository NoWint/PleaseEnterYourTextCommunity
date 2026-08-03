# 跨切面机制 + 开发约定 + 常见任务 + 坑

## 1. 特殊消息前缀（`shell/shell.ts` `handleIncomingMsg`）

识别两类带前缀的消息，**不当作普通消息渲染**：

- **`[CARD]`**：截取前缀后的 JSON → `call('upsert_card_from_msg', { msgId, cardJson })`。若当前在 work 页 kanban 视图且是同频道，刷新看板。return 不渲染。
- **`[PEYT_INVITE]`**：JSON 含 `general_qr` / `work_qr` 两个 SecureJoin QR。对每个调用 `join_peyt_channel`（work 频道 `spaceType: 'card'`），然后 `refreshChannels` + `renderNavPanel`。return 不渲染。

PEYT Studio 流程：founder 的 `ensure_peyt_studio` 建 master 群 + 闲聊/工作群，在 master 群发 `[PEYT_INVITE]`；新成员 `join_peyt_studio` 进 master 后收到该消息自动进子频道。

**`[PEYT]` 信封协议**（发送端）：`src-tauri/src/envelope.rs` 的 `build_envelope(type, payload)` 把结构化数据封装成 `[PEYT]{version,type,id,timestamp,from,payload}` JSON 消息，用于卡片 create/update/delete、项目邀请等跨设备同步。**接收端目前不解析**（`handleIncomingMsg` 不拦截 `[PEYT]`，信封消息原样渲染为普通消息，方便调试）——见 `docs/superpowers/specs/2026-08-02-peyt-envelope-protocol-design.md`。

## 2. 插件系统端到端

```
GitHub Pages 市场 → Rust PluginManager（安装/卸载/启停，文件系统）→ 前端 manager.ts（new Function 执行 JS）→ createPluginApi 注入 peytchat
```

- **安装**：`install_plugin`（拉 manifest + entry JS 存 `plugins/<name>/`，建 `enabled` 标记）或 `install_plugin_from_zip`（本地 zip，剥离顶层目录）。
- **加载**（`manager.ts loadPlugins`，boot 时）：`list_plugins` → 过滤 enabled → `get_plugin_js` → **`new Function('peytchat', js)(api)` 直执行，无沙箱**。
- **`peytchat` 全局 API**（`api.ts createPluginApi`），各方法有权限门控：

| API | 权限 | 作用 |
|---|---|---|
| `sendText(chatId, text)` | `messages:send` | 发消息 |
| `onMessage(cb)` | `messages:read` | 订阅 IncomingMsg |
| `addCSS(css)` | `ui:css` | 注入 `<style>` |
| `registerTheme(config)` | `ui:theme` | 注册 data-theme CSS + 主题选择器条目 |
| `onCommand(name, cb)` | `commands` | 注册 `/` 斜杠命令 |
| `registerLLM(name, config)` | `llm` | 注册 LLM 提供商 |
| `registerSetting(config)` | 无 | 注册设置字段 |
| `http.get/post` | `network` | fetch 封装 |
| `store.get/set/delete` | 无 | localStorage `plugin:<name>:<key>` |
| `log.*` | 无 | 带前缀 console |

- **权限**（permissions.ts）：存 `peyt.plugin.perms`，**默认全部 7 项权限授予**。settings.ts 有 UI 开关。
- **全局扩展点**：`window.__peytchat_themes` / `__peytchat_commands` / `__peytchat_llms` / `__peytchat_settings`。
- manifest 类型：`{ name, version, title, description, author, type: "theme"|"chatbot"|"llm"|"general", entry }`。

## 3. 图标系统（`src/components/icon.ts`）——三处同步

新增图标**必须三处同步**（历史上有重复 import/类型块导致构建失败的冲突）：
1. **lucide import**（文件顶部，如 `Compass` from 'lucide'）
2. **`IconName` 类型联合**（`| 'compass'`；联合里允许重复条目）
3. **`iconMap` 记录**（`'compass': Compass`）

`iconSvg(name, opts)` 把 lucide IconNode 手写序列化成内联 SVG 字符串；`iconElement` 包一层 span。

## 4. 主题系统

- 机制：`<html data-theme>` 属性切 CSS 变量。nowint = 无属性。
- CSS 结构：`:root` 全部 token（颜色/字体缩放 `--font-scale-*`/间距 `--space-*`/圆角 `--radius-*`/阴影）；`[data-theme="violet"]`、`[data-theme="goldenhour"]` 全覆盖。
- 渐变主题：`body { background: var(--theme-gradient, var(--bg)) }`，`.theme-mask`（fixed, z-index:0）叠在 `#app`（z-index:1）后面，`--theme-gradient`/`--theme-mask` 控制。

## 5. 动效（`.closing` 模式）

- 入场：CSS `animation`（挂在元素上，`.dropdown-menu`/`.search-dialog` 等有 `pop-in`/`fade-in`）。
- 出场：JS 加 `.closing` → CSS `pop-out`/`fade-out`（forwards）→ 延时 `remove()`。
- reduced-motion：`@media (prefers-reduced-motion: reduce)` 全部 `animation: none !important`。
- **别给整屏大区块加透明度动画**（页面容器/消息列表），WKWebView 下会闪。

## 6. styles.css 结构与「重复选择器陷阱」

styles.css ~2433 行。**很多选择器定义了两次：前面的旧规则是死代码，后面 Task 17 的规则是活的**（CSS 后者覆盖前者）。改样式时**永远改后面的**（约 1334 行往后是 Task 17 区）：

| 选择器 | 旧（死）行 | 新（活）行 |
|---|---|---|
| `.nav-header` | ~197 | ~1350 |
| `.detail-expand` | ~365 | ~1635 |
| `.chat-header-actions` | ~462 | ~1629 |
| `.dropdown-menu` | ~715 | ~1388 |
| `.rail`（旧 `.ws-rail` 已死） | ~136 | ~1339 |
| `.channel-tree`/`.nav-tree` | ~182-238 | `.nav-panel` ~1349+ |

**另一个坑**：`shell.ts` 骨架里 `#channel-tree` 的 class 是 `nav-panel`，但 renderNavPanel 会 `panel.className = 'nav-panel'` 覆盖；rail 同理 renderRail 覆盖 `ws-rail`。别给旧 class 加样式。

## 7. 开发约定

- **import 一律 `.js` 扩展名**（Vite 解析 .ts）。新增/移动文件别写成 `.ts`。
- **`npx tsc --noEmit` 是唯一静态校验**（strict 模式）。没有测试套件，没有 linter。
- **代码注释中文**，新增注释保持一致。
- **新增 Tauri 命令必须在 `lib.rs` 的 `invoke_handler` 登记**。
- **页面路由无路由库**：靠 `state.currentPage` + `renderMain()` 分发。
- **改功能前先读对应 spec/plan**（`docs/superpowers/specs/` + `plans/` 成对）。清单见下表。
- **git 提交规范**：conventional commits + scope（`feat(chat): ...`、`fix(icon): ...`、`style(ui): ...`）。PR-based 工作流（merge commit）。

### Spec/Plan 清单

| Spec | 主题 |
|---|---|
| `2026-07-29-peytchat-mvp-design.md` | MVP：邮箱登录 + 私聊/群聊 |
| `2026-07-30-sp1-shell-workspace-design.md` | Shell + workspace/channel 模型 |
| `2026-07-30-sp2-management-chat-design.md` | 管理闭环 + 聊天体验 |
| `2026-07-30-sp3-social-global-design.md` | 社交入口 + 全局体验 |
| `2026-07-30-sp4-huly-layout-foundation-design.md` | Huly 布局 + 基础修复 |
| `2026-07-30-sp5-card-task-design.md` | 卡片任务系统（kanban/CRUD/双存储） |
| `2026-07-30-theme-system-design.md` | 三主题 + CSS 变量 |
| `2026-07-31-full-ux-redesign-design.md` | 全面 UX 重构（零弹窗/lucide/TS 迁移） |
| `2026-07-31-sidebar-redesign-design.md` | 侧栏重构 |
| `2026-07-31-terminal-page-design.md` | 终端页 |
| `2026-08-02-peyt-envelope-protocol-design.md` | 信封协议（不进 git） |
| `2026-08-03-delta-alignment-roadmap.md` | Delta 功能对齐路线图（批次 1 已完成） |
| `2026-08-03-delta-batch1-archive-saved-draft.md` | 批次 1 实施计划 |

## 8. 常见任务指南

### 加一个前端页面
1. `state.currentPage` 联合类型加值（types.ts）。
2. `rail.ts` 加页面图标（数据驱动数组）。
3. `navPanel.ts` 的 `renderNavPanel`/`renderMain` 加分支。
4. 建 `src/pages/<name>Page.ts`，导出 nav + main 渲染函数。
5. `persist.ts` 若需记住状态。

### 加一个 Tauri 命令
1. `commands.rs`（或新模块）写 `#[tauri::command]`。
2. `lib.rs` `invoke_handler` 登记。
3. 前端 `api.ts` 的 `call('命令名', args)` 调用。
4. DTO 放 `dto.rs`；DB 方法放 `db.rs`（经 `spawn_blocking`）。

### 加一个图标
按第 3 节三处同步：lucide import → `IconName` → `iconMap`。

### 加一张 DB 表
`db.rs::migrate()` 里 `CREATE TABLE IF NOT EXISTS`；`Db` 加方法（spawn_blocking + rusqlite）。

### 修消息相关
先读 `chat/chatView.ts`（虚拟化）、`chat/message.ts`（渲染/缓存）、`shell.ts`（事件订阅）。注意别破坏虚拟化（增量 DOM 更新：窗口内节点不动、滚出 remove、滚进 insertBefore，两个常驻 spacer 撑高度；scrollHeight 不变所以 scrollTop 由浏览器维护，**不要**引入手动恢复 scrollTop 或 `innerHTML=''` 整体替换——会回到旧位置）。

### 动效
CSS 入场（animation）+ `.closing` 出场（JS 加类 + 延时 remove）。reduced-motion 块兜底。别给整屏大区块加透明度动画（会闪）。

## 9. 注意事项 / 坑

1. **大区块透明度动画会闪**：页面容器/消息列表整屏 `opacity` 动画在 WKWebView 表现差。动效集中在小组件。
2. **styles.css 重复选择器**：改样式永远改后面的活规则（第 6 节）。
3. **`type_` 参数名**：Rust 用 `type_`，DB 列 `type`，JSON 键 `"type"`；Tauri 参数按位置传，`[CARD]` 载荷内键是 `"type"`。
4. **`Clearable<T>`**：Tauri 无法区分「缺键」和「null」，卡片 update 用三态封装。
5. **两把锁**：`accounts` 是 tokio Mutex（await），`current_id` 是 std Mutex（同步）。
6. **card 16 元组**：list_cards/get_card_row 第 15 列是占位 0。
7. **terminal 无后端白名单**：expert/whitelist 只在终端前端，PTY 是真 shell。
8. **CSP null + 无沙箱插件**：`new Function` 直执行第三方 JS，有安全风险。
9. **reactions/pins 缓存**：message.ts 模块级 Map/Set，改消息渲染时注意缓存同步（`clearReactionsCache`/`clearPinnedCache`）。
10. **`socket2` 需 `all` feature**，`chrono` 需 `clock`——删依赖会编译失败。
11. **首次编译 10–30 分钟**；`core/` submodule 必须 `--recursive` 克隆。
12. **`get_asset_url` / `transformBlobURL`**：附件/头像走 `asset://localhost/`（受 assetProtocol scope 限制）。
13. **下拉/浮层关闭**：外部点击用 `setTimeout(0)` 注册监听避免同次点击误关；`.closing` 类出场。
14. **PEYT_STUDIO_NAME = "PEYT Studio"**；`current_workspace_id()` 优先 PEYT Studio，否则第一个 workspace。
15. **登录/登出**：`logout` 不真正取消核心的选中账号（核心无公开 unselect），仅清内存 `current_id`。
