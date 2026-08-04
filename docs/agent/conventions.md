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

## 3. 图标系统（`src/components/icon.ts`）——TDesign 两处同步

**已从 lucide 换成 TDesign**（`tdesignIcons.ts` vendored paths，stroke 模式 24 viewBox）。`iconMap = TDESIGN_PATHS as Record<IconName, TDesignPath[]>`。

新增图标**必须两处同步**（历史上有重复 import/类型块导致构建失败的冲突）：
1. **`tdesignIcons.ts` 的 `TDESIGN_PATHS`** 加路径（TDesign 缺的图标如 play/pause/mic 在此补充标准路径）
2. **`icon.ts` 的 `IconName` 类型联合**（`| 'play'`；联合里允许重复条目）

`iconMap` 是 TDESIGN_PATHS 的 cast，不用手动改。`iconSvg(name, opts)` 手写序列化成内联 SVG 字符串；`iconElement` 包一层 span。

## 4. 主题系统

- 机制：`<html data-theme>` 属性切 CSS 变量。nowint = 无属性。
- **11 套内置主题**（`BUILTIN_THEMES`：nowint/violet/goldenhour/forest/midnight/ember/graphite/paper/frost/sage/blush），CSS 在各 `[data-theme="..."]` 块。
- **全局字体缩放**：`FontScale`（sm/md/lg/xl，`theme.ts`），`<html data-font-scale>` 覆盖 `--font-scale-*`（styles.css 的 `html[data-font-scale="..."]` 块，md 不设属性）。设置页「外观」用 `ui.segmented` 调，localStorage `peyt.fontScale`。
- CSS 结构：`:root` 全部 token（颜色/字体缩放 `--font-scale-*`/间距 `--space-*`/圆角 `--radius-*`/阴影/动效 `--ease-*`）。
- 渐变主题：`body { background: var(--theme-gradient, var(--bg)) }`，`.theme-mask`（fixed, z-index:0）叠在 `#app`（z-index:1）后面，`--theme-gradient`/`--theme-mask` 控制。

## 5. 动效（`.closing` 模式）

- 入场：CSS `animation`（挂在元素上，`.dropdown-menu`/`.search-dialog` 等有 `pop-in`/`fade-in`）。
- 出场：JS 加 `.closing` → CSS `pop-out`/`fade-out`（forwards）→ 延时 `remove()`。**改出场动画时长时必须同步 JS 的 `setTimeout` 移除延时**（dropdown/search/commandPalette/plugin-confirm/message 等），否则动画被截断。
- **动效 token**（styles.css `:root`）：`--ease-out` / `--ease-in-out` / `--ease-drawer`。入场统一 `var(--ease-out)`，时长 200-300ms；出场保持 120-210ms 快速收束。
- reduced-motion：`@media (prefers-reduced-motion: reduce)` 全部 `animation: none !important`。
- **别给整屏大区块加透明度动画**（页面容器/消息列表），WKWebView 下会闪。

## 6. 设计标准（视觉规范）

整体取向：**macOS 原生质感**，不做 Material/Google 味。这是硬性标准，改样式时必须遵守。

### 圆角
- **弹窗 / 卡片用 macOS 弧度**：`var(--radius-md)`（12px）。**禁用 18px+ 的大圆角**（曾在 `.ui-dialog` 用过 18px，观感怪异，已回退 12px）。
- 按钮：**`var(--radius-sm)`（8px）圆角矩形**（macOS 按钮弧度）。

### 按钮（macOS 式）
- **动作按钮一律圆角矩形**：`border-radius: var(--radius-sm)`（8px），**禁用 999px 胶囊**。覆盖：`.ui-button`、`.ui-dialog-close`、`.cp-add`、`.rd-add-friend`、`.view-btn`、`.dbg-more` 等。
- **关闭按钮圆角矩形**，不用圆形。
- **按钮必须有质感（可见填充 + 发丝描边），不透明**：`.ui-button` = `background: var(--control-bg)` + `border: 1px solid color-mix(in srgb, var(--text) 14%, transparent)`；`.ui-button-primary` 纯强调填充无描边；`.ui-button-ghost` / `.ui-dialog-close` / `.chat-header-btn` / `.nav-add-btn` 带 `var(--capsule)` 底。**不要 `background: transparent` / `background: none`**。
- 例外（工具栏惯例，可透明-悬停显示）：rail 图标（`.rail-icon`）、分段控件内部段（`.ui-segment`）、文本链接式小按钮（`.nav-meta-link`）。

### 保留胶囊/圆形的元素（非动作按钮）
- chip / badge / 未读角标 / 状态点 / 语音播放圆键 / 标签——语义上是「标记/标签」，保持胶囊/圆形是常规做法。

### 检查清单（改样式时）
- 新按钮：`border-radius: var(--radius-sm)`（8px）圆角矩形，有可见背景填充（+ 发丝描边），不写 `999px`，不写 `background: transparent`。
- **弹窗（苹果式）**：`.ui-overlay` 用轻量毛玻璃遮罩（`rgba(0,0,0,0.20)` + `blur(10px)`，**不要厚重黑幕**）；`.ui-dialog` 表面 `var(--surface)` 94% 实心 + `blur(24px)`、顶部边缘高光（`border-top-color` 提亮）+ `inset 0 1px 0` 顶部内高光、圆角 `var(--radius-md)`（12px）、标题 15px semibold、内距 18px/20px、gap 12px。**布局无标题栏 ✕**（`ui.dialog` 的 `closeable` 默认关闭，opt-in；靠动作按钮 / 点外部关闭）——苹果弹窗不是「窗口 + ✕」。
- 主题颜色优先保留，只调结构性 token（圆角/阴影/动效/间距/背景填充）。

### 无边框窗口 / 顶栏（平台约定）
- **平台类**：`html.window-overlay`(macOS,原生红绿灯)、`html.window-frame`(Windows/Linux,自绘标题栏)。由 `main.ts` boot 按 UA 加。改标题栏样式时按这两个类区分。
- **顶栏 34px**:`#app` padding-top、`#window-drag-region` 高度、`#titlebar-tools` 高度三者一致。
- **居中搜索条**：`#titlebar-search`(440px,VSCode 式),容器 `pointer-events:none` 不拦拖拽,仅搜索按钮 `pointer-events:auto`。点击 → `openSearch()`(Cmd+K)。
- **窗口控制**：macOS 用原生红绿灯(不动);Windows/Linux 用 `#wb-min/max/close`(`windowControls.ts` 绑定),`-webkit-app-region: no-drag` 防误拖。
- **深链**：`utils/deepLink.ts` 监听 `DeepLink` 事件(capabilities 需 `deep-link:default`);改登录/邀请流程时同步 `routeDeepLink`。
- **原生通知**：`notifications.rs` 命令;前端通知中心收 `IncomingMsg` 等事件触发。

## 7. styles.css 结构与「重复选择器陷阱」

styles.css ~3757 行。**很多选择器定义了两次：前面的旧规则是死代码，后面 Task 17 的规则是活的**（CSS 后者覆盖前者）。改样式时**永远改后面的**（约 2650 行往后是 Task 17 区；**行号会随改动漂移，以 `grep` 最后一次出现为准**）：

| 选择器 | 旧（死）行 | 新（活）行 |
|---|---|---|
| `.nav-header` | ~197 | ~2150+ |
| `.detail-expand` | ~365 | ~2525 |
| `.chat-header-actions` | ~462 | ~2519 |
| `.dropdown-menu` | ~715 | ~2261 |
| `.rail`（旧 `.ws-rail` 已死） | ~136 | ~2153 |
| `.channel-tree`/`.nav-tree` | ~182-238 | `.nav-panel` ~2164+ |

**另一个坑**：`shell.ts` 骨架里 `#channel-tree` 的 class 是 `nav-panel`，但 renderNavPanel 会 `panel.className = 'nav-panel'` 覆盖；rail 同理 renderRail 覆盖 `ws-rail`。别给旧 class 加样式。

## 8. 开发约定

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
| `2026-08-03-delta-alignment-roadmap.md` | Delta 功能对齐路线图（批次 1-4 已完成，4.5 通话待做） |
| `2026-08-03-delta-batch1-archive-saved-draft.md` | 批次 1 实施计划（已完成） |
| `2026-08-03-delta-batch2-search-gallery-palette-mailing.md` | 批次 2 实施计划（已完成） |
| `2026-08-03-delta-batch3-voice-webxdc.md` | 批次 3 实施计划（已完成） |
| `2026-08-03-delta-batch4-notifications-encryption-backup.md` | 批次 4 实施计划（已完成） |
| `2026-08-03-eight-new-themes-design.md` | 8 套新主题（共 11 套） |
| `2026-08-03-peyt-friend-invite-design.md` | 好友邀请系统（选择联系人/邮箱/peyt:// 链接） |
| `2026-08-03-peyt-friend-invite-plan.md` | 好友邀请实施计划 |
| `2026-08-03-bot-account-management-design.md` | Bot 系统 A：账号管理（BotService/bots 表） |
| `2026-08-03-bot-llm-runtime-design.md` | Bot 系统 B：LLM 运行时（llm.rs/bot_llm.rs） |
| `2026-08-03-bot-management-ui-design.md` | Bot 系统 C：管理 UI（botsPage） |
| `2026-08-03-bot-chat-ux-design.md` | Bot 系统 D：bot 聊天 UX（bot 会话命令） |

## 9. 常见任务指南

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
按第 3 节两处同步：`tdesignIcons.ts` 路径 → `IconName`（iconMap 是 cast，不用改）。

### 加一张 DB 表
`db.rs::migrate()` 里 `CREATE TABLE IF NOT EXISTS`；`Db` 加方法（spawn_blocking + rusqlite）。

### 修消息相关
先读 `chat/chatView.ts`（Delta 式全量 DOM 渲染）、`chat/message.ts`（渲染/缓存）、`shell.ts`（事件订阅）。注意别破坏全量渲染：所有已加载消息都是真实 DOM 节点，浏览器原生管理滚动（`renderAllMessages` 复用已有节点、`box.innerHTML=''` 整体替换后按 scrollHeight 增量补偿 scrollTop）。**不要**引入手写 spacer 虚拟化/估算高度——那是滚动闪烁与微动的根源，已废弃。

### 动效
CSS 入场（animation）+ `.closing` 出场（JS 加类 + 延时 remove）。reduced-motion 块兜底。别给整屏大区块加透明度动画（会闪）。

## 10. 注意事项 / 坑

1. **大区块透明度动画会闪**：页面容器/消息列表整屏 `opacity` 动画在 WKWebView 表现差。动效集中在小组件。
2. **styles.css 重复选择器**：改样式永远改后面的活规则（第 6 节）。
3. **`type_` 参数名**：Rust 用 `type_`，DB 列 `type`，JSON 键 `"type"`；Tauri 参数按位置传，`[CARD]` 载荷内键是 `"type"`。
4. **`Clearable<T>`**：Tauri 无法区分「缺键」和「null」，卡片 update 用三态封装。
5. **两把锁**：`accounts` 是 tokio Mutex（await），`current_id` 是 std Mutex（同步）。
6. **card 16 元组**：list_cards/get_card_row 第 15 列是占位 0。
7. **CSP null + 无沙箱插件**：`new Function` 直执行第三方 JS，有安全风险。
8. **reactions/pins 缓存**：message.ts 模块级 Map/Set，改消息渲染时注意缓存同步（`clearReactionsCache`/`clearPinnedCache`）。
9. **`socket2` 需 `all` feature**，`chrono` 需 `clock`——删依赖会编译失败。
10. **首次编译 10–30 分钟**；`core/` submodule 必须 `--recursive` 克隆。
11. **`get_asset_url` / `transformBlobURL`**：附件/头像走 `asset://localhost/`（受 assetProtocol scope 限制）。
12. **下拉/浮层关闭**：外部点击用 `setTimeout(0)` 注册监听避免同次点击误关；`.closing` 类出场。
13. **PEYT_STUDIO_NAME = "PEYT Studio"**；`current_workspace_id()` 优先 PEYT Studio，否则第一个 workspace。
14. **登录/登出**：`logout` 不真正取消核心的选中账号（核心无公开 unselect），仅清内存 `current_id`。
15. **TDesign 图标**：lucide 已整体替换，别再用 lucide 包；缺的图标在 `tdesignIcons.ts` 补标准路径 + `IconName` 联合。
16. **Bot 是独立 deltachat 账号**：`bots` 表用 `bot_account_id` 指核心账号；bot 命令与普通命令同 `invoke_handler` 登记（lib.rs）。
17. **字体缩放 `data-font-scale`**：改 `--font-scale-*` 变量时同步看 styles.css 的 `html[data-font-scale="..."]` 覆盖块，否则某些缩放档位下字号不生效。
18. **弹窗玻璃 `--surface` 透明度**：`.ui-dialog` 填充透明度影响背景是否透出聊天内容，调太透会糊出彩色（保持 ≥80%）。
