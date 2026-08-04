# PEYT Chat — Agent 代码库指南(入口)

> 给 AI agent(或任何新加入的工程师)的代码库地图。本目录按主题拆成多个文件,**从这里开始**,按需跳转。
>
> 根目录 `CLAUDE.md` 是高层概览;本目录是深度参考。二者互补,`CLAUDE.md` 过时处(如「项目结构」一节)以本目录为准。

## 文件索引

| 文件 | 内容 | 何时读 |
|---|---|---|
| **[README.md](README.md)**(本文件) | 总览、技术栈、快速开始、仓库结构、架构与数据流 | 刚接触项目 / 想了解全貌 |
| **[frontend.md](frontend.md)** | 前端 70 个 TS 文件的地图:启动、状态/类型、持久化、路由、页面、聊天、卡片、组件、插件前端、主题、顶栏、动效、模块依赖 | 改前端任何功能 |
| **[backend.md](backend.md)** | 后端 16 个 Rust 文件:启动、AppState、129 个命令分组、bot 系统、原生通知、深链、卡片命令详解、插件后端、错误处理、配置 | 改 Tauri 命令 / 后端逻辑 |
| **[database.md](database.md)** | 9 张表完整 schema、全部 DTO、卡片数据模型与同步机制 | 动数据库 / 加表 / 改字段 |
| **[events.md](events.md)** | deltachat 核心 → 前端的事件流(23 个事件 + 前端处理) | 实时更新 / 事件处理 |
| **[conventions.md](conventions.md)** | 跨切面机制([CARD]/[PEYT_INVITE] 前缀、插件系统、TDesign 图标两处同步、主题+字体缩放、动效、styles.css 陷阱)+ 开发约定 + 常见任务 + 坑 | 动手前必读,特别是新功能 |

---

## 1. 项目总览

**PEYT Chat**(曾用名 Peytchat)——基于 Delta Chat 核心的跨平台桌面聊天客户端(Tauri v2)。在 Delta Chat 协议之上实现了:

- **工作区(workspace)/ 频道(channel)体系**:workspace 有 master 群,其下分频道(普通 `chat` 频道 + 卡片 `card` 频道)。
- **卡片式任务管理(Work 页)**:看板 / 列表 / 日历 / 时间线四种视图,卡片经 `[CARD]` 同步消息跨设备同步。
- **Bot 账号系统**:应用内管理 bot 账号(`bots` 表 + `bots.rs`),LLM 运行时(`llm.rs` / `bot_llm.rs`,接入 DeepSeek/OpenAI 等),bot 可自动回帖、进群、参与聊天。前端 `botsPage.ts` 提供创建/配置/启停/会话管理。
- **好友邀请系统**:选择联系人 / 通过邮箱添加 / 粘贴 peyt:// 邀请链接 / 分享我的邀请链接(contactsPicker.ts / inviteDialog.ts / utils/inviteLink.ts)。
- **插件系统**:从 GitHub Pages 市场安装,`new Function` 直执行,注入 `peytchat` 全局对象。
- **信封协议(`[PEYT]`)**:发送端把结构化数据(卡片/项目邀请等)封装成 `[PEYT]{...}` JSON 消息(envelope.rs),复用加密传输层跨设备同步。**接收端目前不解析**,信封消息原样渲染为普通消息(方便调试)。
- **原生系统通知**:`notifications.rs` + 前端通知中心,`show_notification` / 权限查询请求命令。
- **深链(Deep Link)**:`deeplink.rs` + `src/utils/deepLink.ts` 注册监听,唤起/冷启动 URL 都经 `DeepLink` 事件分发(登录预填 / 邀请 / QR)。capabilities 需 `deep-link:default`。
- **无边框窗口标题栏**:macOS `titleBarStyle: Overlay`(原生红绿灯,`window-overlay` 类);Windows/Linux `decorations: false` + 自绘标题栏(`window-frame` 类,logo + 标题 + 最小化/最大化/关闭,`titlebar.rs` / `windowControls.ts`)。顶栏有 VSCode 式居中全局搜索条(`titlebar.ts`)。
- **Delta Chat 对齐(进行中)**:按 `docs/superpowers/specs/2026-08-03-delta-alignment-roadmap.md` 分批次对齐 Delta 桌面端功能(批次 1-4 已完成:归档/保存/草稿/搜索/相册/语音/webxdc/通知/保护/多设备/备份)。后续 stub 陆续落地(资料/已读回执/取消保存/转发/静音/置顶/群成员添加/角色/我的 QR/webxdc blob)。
- **无框架**:前端是 Vanilla TypeScript + Vite,无状态管理库、无路由库。

设计哲学(源自 `docs/superpowers/specs/2026-07-31-full-ux-redesign-design.md`):暗色高级质感、线性 SVG 图标(TDesign,替代原 lucide)、全局禁用 emoji(用图标代替)、零弹窗(全部用下拉/内联/右键菜单/悬浮层)。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri v2(`protocol-asset` feature),零 tauri-plugin-* |
| 消息核心 | deltachat(git submodule `core/`,从源码编译) |
| 应用 DB | rusqlite 0.37 + SQLite(`peytchat.db`),与核心自己的存储分离 |
| 异步 | tokio(full) |
| 网络 | reqwest 0.12(插件市场 / 登录 / bot LLM 调用) |
| 前端 | Vanilla TS + Vite 5,`@tauri-apps/api` |
| 图标 | **TDesign**(`tdesignIcons.ts` vendored paths,stroke 模式 24 viewBox;自绘 SVG 序列化,替代原 lucide) |
| 通知 | 原生系统通知(notifications.rs,user-notify) |
| 深链 | Tauri deep-link plugin(`deep-link:default` 权限) |
| 其他 | highlight.js(代码高亮)、qrcode(登录/邀请二维码) |

**注意**:`socket2` 显式开启 `all` feature——deltachat 的传递依赖 netwatch(经 iroh)需要它,否则编译失败。`chrono` 需 `clock` feature。

## 3. 快速开始

```bash
git clone --recursive <repo>        # 必须 --recursive,否则 core/ submodule 缺失
npm install
npm run tauri dev                   # 开发模式(Vite 端口 1420)
npm run tauri build                 # 生产构建 → src-tauri/target/release/bundle/
npm run dev                         # 仅 Vite dev server
npm run build                       # 仅 Vite 构建
npx tsc --noEmit                    # 唯一的静态校验(无测试、无 linter)
```

- 首次 `cargo build` 编译 core/ 的 deltachat 核心,**10–30 分钟**;之后增量很快。
- 账号数据在 `~/Library/Application Support/com.peytchat.app/`(macOS);核心账号在 `accounts/` 子目录,应用 DB 是 `peytchat.db`。
- 前端 import 一律用 `.js` 扩展名(Vite 解析 .ts)——写错成 `.ts` 会构建失败。
- **仓库通过 submodule 引用 chatmail/core**,并频繁合并上游 `upstream/main`(bot 系统等)。拉取新上游后跑 `npx tsc --noEmit` + `npm run build` 确认。

## 4. 仓库结构

```
.
├── CLAUDE.md                  # 高层指南(本目录的互补)
├── core/                      # deltachat git submodule(Rust crate)
├── docs/
│   ├── agent/                 # ← 本目录
│   └── superpowers/
│       ├── specs/             # 设计规格(改功能前先读)
│       └── plans/             # 实施计划(与 spec 成对)
├── src/                       # 前端(70 个 TS 文件)
│   ├── main.ts                # 入口 boot():initTheme + initFontScale + 判断登录
│   ├── state.ts               # 全局可变状态 AppState 单例
│   ├── types.ts               # 全部共享类型(Page 含 'bots')
│   ├── persist.ts             # UI 状态 → localStorage
│   ├── api.ts                 # call() invoke 封装 + onEvent()(单一事件桥)
│   ├── theme.ts               # data-theme 主题(11 套)+ FontScale 字体缩放
│   ├── toast.ts               # showToast 单例
│   ├── styles.css             # 全部样式(~3757 行,单文件)
│   ├── shell/                 # 三栏骨架 + 顶栏:shell / rail / navPanel / rightDrawer / columnResizer / titlebar / windowControls
│   ├── pages/                 # 顶级页:messages / groups / inbox / bots / settings / work / debug
│   ├── chat/                  # chatView(Delta 式全量 DOM 渲染)/ composer(含语音录音)/ message
│   ├── work/                  # 卡片:kanban / list / calendar / timeline / cardDetail / activity
│   ├── components/            # 见 frontend.md;含 contactsPicker / inviteDialog / escape / tdesignIcons
│   ├── plugins/               # 插件系统前端:manager / api / permissions / settings / storage / view / confirm / types
│   ├── utils/                 # inviteLink.ts(peyt:// 编解码)、deepLink.ts(深链监听/路由)
│   └── views/login.ts         # 登录页
└── src-tauri/                 # 后端(16 个 Rust 文件)
    ├── src/
    │   ├── main.rs            # 入口 → peytchat_lib::run()
    │   ├── lib.rs             # Tauri builder,注册全部 129 个命令 + 事件转发
    │   ├── state.rs           # AppState(accounts / db / plugins / bots / data_dir)
    │   ├── commands.rs        # 全部业务命令(~2900 行)
    │   ├── bots.rs            # Bot 账号管理(create/list/delete/set_io/start_all)
    │   ├── bot_llm.rs         # Bot LLM 运行时(自动回帖、事件过滤、anti-loop)
    │   ├── llm.rs             # LLM 客户端(DeepSeek/OpenAI/Claude 等 providers)
    │   ├── notifications.rs   # 原生系统通知(show / permission)
    │   ├── deeplink.rs        # 深链:URL 解析 + take_pending_deeplink
    │   ├── titlebar.rs        # 无边框窗口标题栏(install,Windows/Linux 自绘)
    │   ├── envelope.rs        # [PEYT] 信封协议发送端构建器
    │   ├── db.rs              # SQLite 封装 + migrate() 建 9 张表
    │   ├── dto.rs             # 全部 DTO(含 BotDto / LlmConfigInput / DeepLinkPayload)
    │   ├── events.rs          # dc-event 事件转发器(23 个变体)
    │   ├── plugins.rs         # 插件注册表 / 安装 / 启停
    │   └── error.rs           # AppError
    ├── capabilities/
    │   └── default.json       # Tauri v2 ACL:事件监听 + 窗口控制 + deep-link
    ├── tauri.conf.json        # 窗口(macOS Overlay)+ 构建 / asset 协议
    ├── tauri.windows.conf.json / tauri.linux.conf.json   # decorations:false + shadow
    └── Cargo.toml
```

## 5. 架构与数据流

```
前端(Vanilla TS)
  │  invoke("命令名", args)                 ← Tauri IPC
  ▼
commands.rs  #[tauri::command] 函数(119 个,含 bots.rs)
  │  State<'_, AppState>
  ▼
AppState
  ├─ accounts   deltachat::Accounts(多账号)   ← 消息传输/联系人/群
  ├─ db         Db(rusqlite)                  ← workspaces/channels/cards/roles/pins/inbox/activities/bots
  ├─ plugins    PluginManager(文件系统)        ← 插件 JS + manifest
  └─ bots       BotService                     ← bot 账号 + LLM 运行时(llm.rs / bot_llm.rs)
  │
  ▼
deltachat 核心(core/)
  │  事件发射器(tokio broadcast)
  ▼
events.rs spawn_event_forwarder()
  │  app.emit("dc-event", payload)
  ▼
前端 onEvent() 订阅(全部集中在 shell/shell.ts)
```

**双数据库**:核心管自己的 SQLite(账号/联系人/聊天/消息),应用管 `peytchat.db`(workspace/channel/card/role/pin/inbox/activity/**bot**)。二者通过 `chat_id`(u32)互相对接。

**卡片跨设备同步**:不靠服务器——把 `[CARD]{...}` JSON 作为消息发进 deltachat 群,另一端的 `upsert_card_from_msg` 收到后落库。复用加密传输层。

**Bot 运行时**:`llm.rs` 提供 LLM 客户端(配置在 `bots` 表),`bot_llm.rs` 监听核心事件,符合条件的消息喂给 bot 的 LLM 自动回帖(anti-loop 防自回)。前端 `botsPage.ts` 管理。

→ 下一步:按 [文件索引](#文件索引) 进入对应主题。
