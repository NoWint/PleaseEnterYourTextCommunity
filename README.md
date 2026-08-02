# Peytchat

基于 [chatmail/core](https://github.com/chatmail/core)（Delta Chat 核心）+ Tauri 的跨平台桌面聊天客户端。支持邮箱登录、chatmail 快速开始、一对一私聊、群组、联系人请求与 SecureJoin 二维码。

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://www.rust-lang.org/) (stable) + cargo
- Tauri v2 系统依赖：参见 [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  - macOS: Xcode Command Line Tools
  - Linux: `webkit2gtk-4.1`、`libayatana-appindicator3-dev` 等
  - Windows: WebView2 + MSVC

## 获取代码

仓库通过 git submodule 引用 `chatmail/core`，克隆时必须带 `--recursive`：

```bash
git clone --recursive https://github.com/NoWint/PleaseEnterYourTextCommunity.git
cd PleaseEnterYourTextCommunity
```

如果已经普通克隆过，补齐 submodule：

```bash
git submodule update --init --recursive
```

## 安装与运行

```bash
# 安装前端依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 构建生产版本（输出到 src-tauri/target/release/bundle/）
npm run tauri build
```

首次 `cargo build` 会编译 `core/` 子模块中的 deltachat 核心，耗时较长（10–30 分钟），之后增量编译很快。

## 使用方法

### 快速开始（无需邮箱）

登录界面选「快速开始」标签，输入昵称即可。会自动在 `yzjtiantian.cn` chatmail 服务上创建一个随机邮箱账号。

### 邮箱登录

登录界面选「邮箱登录」标签，填入任意 IMAP/SMTP 邮箱地址与密码。

### 开始聊天

- **添加好友 / 私聊**：侧边栏点「添加好友」，输入对方邮箱（任何 Delta Chat / chatmail 用户均可）即可创建一对一私聊。
- **扫码加好友**：点「我的二维码」展示自己的 SecureJoin 二维码，让对方用 Delta Chat 扫描；或点「添加好友」→「扫描 QR 链接」标签，粘贴对方的 `dccontact:` 链接。
- **联系人请求**：对方先向你发消息时，会话会显示「请求」徽标，进入后点「接受」即可回复。
- **群组**：点「新建群组」创建群组；在会话「信息」面板可添加成员、查看成员列表、退出群组、生成群组邀请二维码。

## 技术栈

- **后端**：Rust + [deltachat](https://github.com/chatmail/core) crate（path 依赖到 `core/` 子模块）+ Tauri v2
- **前端**：Vanilla JS + Vite（单页应用，无框架）
- **事件流**：deltachat 核心事件 → Rust 事件循环 → Tauri `dc-event` → 前端 `onEvent` 监听

## 项目结构

```
peytchat/
├── core/                    # git submodule: chatmail/core (deltachat 核心)
├── src/                     # 前端 (Vanilla JS + Vite)
│   ├── views/               # 视图: login, chatList, chatView, group, addFriend, myQr, chatInfo
│   ├── api.js               # Tauri invoke / event 封装
│   ├── state.js             # 前端状态
│   ├── main.js              # 入口路由
│   └── styles.css           # 样式（黑白极简）
└── src-tauri/               # 后端 (Rust + Tauri)
    └── src/
        ├── commands.rs      # Tauri 命令（登录、收发消息、群组、SecureJoin 等）
        ├── events.rs        # 核心事件 → Tauri events 转发
        ├── state.rs         # AppState（账号管理、current_id）
        ├── dto.rs           # 数据传输对象
        ├── error.rs         # 错误类型
        └── lib.rs           # 应用入口
```
