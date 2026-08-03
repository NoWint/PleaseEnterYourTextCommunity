# Bot 系统 · 子项目 D：Bot 会话 UX 设计文档

> **定位**: 大特性「Bot 系统」的分解子项目 D（后端 bot-scoped 命令 + 前端双栏会话面板），实现从主账号界面以 Bot 身份浏览会话、收发消息。
>
> **前置决策**（brainstorming 问答确认）:
> - 交互模式: 机器人页内双栏面板（左会话列表 + 右消息线程/输入框），不切换整个 UI
> - 线程功能: 读 + 发文本 + 标记已读；回复/表情/转发/删除/置顶留后续
> - 实现路线: D1 — `bots.rs` 加 `ctx_for_bot` 助手 + commands 加 4 个 bot-scoped 命令（复用现有 DTO 与构建逻辑，抽小 helper 去重）；前端复用 `renderMessage` 渲染气泡

## 1. 目标与范围

### 1.1 目标
1. 后端: 以指定 Bot 账号身份操作会话的 4 个命令（chatlist / msgs / send / mark noticed）
2. 前端: 机器人页内双栏会话面板（会话列表 + 消息线程 + 输入框）
3. 复用现有 ChatDto/MsgDto 与 `renderMessage` 渲染

### 1.2 不做
- 线程的回复/表情/转发/删除/置顶等交互（需更多 bot-scoped 命令）
- 会话实时事件推送（本页不订阅事件，返回重进刷新）
- Bot 会话的归档/搜索等

## 2. 后端

### 2.1 `bots.rs` 助手
```rust
pub async fn ctx_for_bot(&self, owner_id: u32, bot_id: i64) -> AppResult<Context>
```
- `db.get_bot(owner_id, bot_id)` 无则 `AppError::Core("bot not found".into())`；`accounts.get_account(bot_account_id)` 无则同样报错；返回 Bot 的 `Context`。

### 2.2 `commands.rs` 4 个命令（均先 `state.bots.ctx_for_bot(owner, bot_id)`）
| 命令 | 入参 | 返回 | 实现 |
|---|---|---|---|
| `bot_get_chatlist` | `bot_id: i64` | `Vec<ChatDto>` | 复用现有 `get_chatlist` 的 Chatlist 构建（抽 `&Context` 版 helper，含跳过 archived_link/alldone） |
| `bot_get_chat_msgs` | `bot_id: i64, chat_id: u32` | `Vec<MsgDto>` | 复用现有 `get_chat_msgs` 的 MsgDto 构建逻辑（抽 `&Context` 版 helper） |
| `bot_send_text` | `bot_id: i64, chat_id: u32, text: String` | `MsgDto` | 复用现有 `send_text` 逻辑（抽 `&Context` 版 helper） |
| `bot_mark_chat_noticed` | `bot_id: i64, chat_id: u32` | — | 对 Bot context 调 `chat::marknoticed_chat` |

- owner 取 `state.current_id`（`current_owner_id` helper）。
- 去重原则: 把现有 `get_chat_msgs`/`send_text`/`mark_chat_noticed` 中纯 `&Context` 的部分抽成私有 async helper，当前账号命令与 Bot 命令共用，避免约 150 行重复。
- `lib.rs` `invoke_handler` 登记 4 个命令。

## 3. 前端（`botsPage.ts` 扩展）

页面内两态：`renderBots(main)`（列表态，已有）→ 点 Bot 行进入 `renderBotChats(bot, main)`（会话态），左栏顶部「← 返回列表」。

```
renderBotChats:
  左栏(~260px): Bot 头部(返回 + 名称/邮箱) + 会话列表
    每项: 会话名 + 最后消息(截断) + 未读徽标(unread>0)
    数据: call('bot_get_chatlist', { botId })
  右栏: 消息线程 + 输入框
    线程: 复用 renderMessage(m, 'solo') 渲染气泡(只读,不绑定回复/表情 action)
    未读清除: call('bot_mark_chat_noticed', { botId, chatId })
    输入框: 单行输入 + 发送按钮(Enter/点击发送)
    发送: call('bot_send_text', { botId, chatId, text }) → MsgDto 追加线程尾部,清空输入
```

- 默认打开第一个会话；无会话显示空态。
- 组件/样式复用 `ui.ts` 与现有页面样式，必要时少量内联样式；不新增全局 CSS。
- 会话列表点击切换右栏线程。

## 4. 测试验收

### 4.1 后端
- [ ] `cargo build` 通过
- [ ] `cargo test` 通过（`ctx_for_bot` owner 校验、既有测试不回归）

### 4.2 前端
- [ ] `npx tsc --noEmit` 通过
- [ ] 手动: 机器人页 → 点 Bot → 双栏会话视图 → 打开会话看历史（复用气泡渲染）→ 以 Bot 身份发文本 → 另一账号收到 → 返回列表
- [ ] 未读数徽标显示；打开会话后未读清除
