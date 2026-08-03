# Delta 对齐批次 1 实施计划（归档 / 保存消息 / 草稿）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Delta Chat 对齐批次 1 的 3 个低复杂度子系统：会话归档、保存消息（Saved Messages）、Composer 草稿持久化。

**Architecture:** 全部「桥接 core API + 前端 UI」。core 2.58 已内置归档（`Chat::set_visibility`）、保存消息（`save_msgs` + self-talk chat）、草稿（`Chat::set_draft`/`get_draft`）。后端加命令 + 填 DTO 字段，前端加 UI 入口与过滤。

**Tech Stack:** Tauri v2 (Rust) + Vanilla TS/Vite + deltachat core 2.58

---

## 文件边界（子代理隔离关键）

| 子系统 | 独占文件 | 共享文件（只读） | 不得触碰 |
|---|---|---|---|
| **归档** | `src-tauri/src/dto.rs`、`src/pages/messagesPage.ts` | `src-tauri/src/commands.rs`（仅归档相关）、`src/types.ts` | composer.ts、message.ts |
| **保存消息** | `src/chat/message.ts`、`src/state.ts`、`src/shell/navPanel.ts` | `src-tauri/src/commands.rs`（仅保存相关） | composer.ts、messagesPage.ts |
| **草稿** | `src/chat/composer.ts` | 无 | message.ts、messagesPage.ts、dto.rs |

**冲突规避**：
- `src-tauri/src/commands.rs` 是共享文件，**三个子代理只 append 各自的命令函数，不删除/不重排现有代码**。主 Agent 在全部完成后统一在 `src-tauri/src/lib.rs` 登记命令。
- `src-tauri/src/lib.rs`、`src/styles.css` **主 Agent 独占**，子代理不得修改。
- 每个子代理完成其子系统后**立即汇报**给主 Agent，不自行 commit。

---

## 任务 A：归档

**Files:**
- Modify: `src-tauri/src/dto.rs:26-35`（ChatDto 加 `is_archived`）
- Modify: `src-tauri/src/commands.rs`（get_chatlist 填 is_archived + 新增 archive_chat 命令）
- Modify: `src/types.ts:156-166`（ChatListItem 已有 is_archived，确认保留）
- Modify: `src/pages/messagesPage.ts`（归档视图过滤 + 上下文菜单归档项）

- [ ] **Step 1: 后端 ChatDto 加 is_archived 字段**

在 `src-tauri/src/dto.rs` 的 `ChatDto` struct（第 26-35 行）加字段：

```rust
pub struct ChatDto {
    pub chat_id: u32,
    pub name: String,
    pub is_group: bool,
    pub is_contact_request: bool,
    pub is_self_talk: bool,
    pub is_archived: bool,   // 新增
    pub last_msg: Option<String>,
    pub last_ts: Option<i64>,
    pub unread: u32,
}
```

- [ ] **Step 2: get_chatlist 填充 is_archived**

在 `src-tauri/src/commands.rs` 的 `get_chatlist` 函数（第 253 行起），`let is_self_talk = chat.is_self_talk();` 之后加：

```rust
let is_archived = chat.get_visibility() == deltachat::chat::ChatVisibility::Archived;
```

并在 `ChatDto { ... }` 构造块里 `is_self_talk,` 之后加 `is_archived,`。

**先确认 `chat.get_visibility()` 存在**：`ChatVisibility` 来自 `core/src/chat.rs:2156`（`Archived = 1`）。运行 `cargo check` 若 `get_visibility` 方法名不对，改用 `chat.visibility` 字段（见 chat.rs:1648 `archived: self.visibility == ChatVisibility::Archived` 的模式）。

- [ ] **Step 3: 新增 archive_chat 命令**

在 `src-tauri/src/commands.rs` 末尾（不与现有命令交错）加：

```rust
#[tauri::command]
pub async fn archive_chat(
    state: State<'_, AppState>,
    chat_id: u32,
    archive: bool,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat = Chat::load_from_db(&ctx, ChatId::new(chat_id)).await?;
    let visibility = if archive {
        deltachat::chat::ChatVisibility::Archived
    } else {
        deltachat::chat::ChatVisibility::Normal
    };
    chat.set_visibility(&ctx, visibility).await?;
    Ok(())
}
```

检查文件顶部是否已 import `Chat` / `ChatId` / `ChatVisibility`（get_chatlist 已用 `Chat::load_from_db` 和 `Chattype::Group`，`Chat`/`ChatId` 应该已导入）。若缺 `ChatVisibility`，补到 import 行。

- [ ] **Step 4: 前端 types.ts 确认 is_archived**

`src/types.ts:156-166` 的 `ChatListItem` 已含 `is_archived: boolean`，无需改。确认即可。

- [ ] **Step 5: 前端归档过滤**

在 `src/pages/messagesPage.ts` 的 `renderMessageList`（第 46-48 行），把过滤改为排除已归档：

```ts
const messages = chats.filter((c) =>
  !c.is_group && !c.is_self_talk && !c.is_contact_request && !c.is_archived
);
```

- [ ] **Step 6: 归档视图切换**

在 `messagesPage.ts` 的 `renderMessageList` 顶部（`let list = ...` 之后）加归档状态变量（模块级）：

```ts
let showArchived = false;
```

在 nav-header 的标题区下方加一个切换按钮（`renderMessagesPage` 的 `panelEl.innerHTML` 里 `.nav-subtitle` 之后）：

```html
<button class="nav-archive-toggle" id="messages-archive-toggle">${showArchived ? '返回消息' : '已归档'}</button>
```

`renderMessageList` 过滤改为：`showArchived ? (c.is_archived && !c.is_group && !c.is_self_talk && !c.is_contact_request) : (!c.is_archived && !c.is_group && !c.is_self_talk && !c.is_contact_request)`。

在 `renderMessagesPage` 绑定按钮：

```ts
document.getElementById('messages-archive-toggle')?.addEventListener('click', () => {
  showArchived = !showArchived;
  void renderMessagesPage(panel!);
});
```

- [ ] **Step 7: 上下文菜单归档项**

在 `showChatContextMenu`（第 167 行起）的 items 数组里，`查看资料` 之后加：

```ts
{
  label: c.is_archived ? '取消归档' : '归档',
  icon: 'archive',
  action: async () => {
    try {
      await call('archive_chat', { chatId: id, archive: !c.is_archived });
      await renderMessagesPage(panel!);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  },
},
```

**注意**：`showChatContextMenu(anchor, id)` 目前只接收 id，需改签名接收整个 `c`（或查 `state.channels`/chatlist 拿 is_archived）。推荐改为 `showChatContextMenu(anchor, c: ChatListItem)`，内部用 `c.chat_id` / `c.is_archived`。

- [ ] **Step 8: 类型检查 + 构建**

Run: `npx tsc --noEmit` → 期望无错误；`npx vite build` → 期望成功。

---

## 任务 B：保存消息（Saved Messages）

**Files:**
- Modify: `src-tauri/src/commands.rs`（save_msg / unsave_msg 命令）
- Modify: `src/chat/message.ts`（右键菜单 + footer 书签图标）
- Modify: `src/state.ts`（savedMessageIds 缓存，可选）
- Modify: `src/shell/navPanel.ts`（「保存的消息」导航入口）

- [ ] **Step 1: 后端 save_msg / unsave_msg 命令**

在 `src-tauri/src/commands.rs` 末尾加：

```rust
#[tauri::command]
pub async fn save_msg(state: State<'_, AppState>, msg_id: u32) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    deltachat::chat::save_msgs(&ctx, &[MsgId::new(msg_id)]).await?;
    Ok(())
}

#[tauri::command]
pub async fn unsave_msg(state: State<'_, AppState>, msg_id: u32) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    // 取消保存 = 删除 saved message（core 里 saved 消息是原消息的转发副本）
    deltachat::message::Message::load_from_db(&ctx, MsgId::new(msg_id))
        .await?
        .delete(&ctx)
        .await?;
    Ok(())
}
```

**注意**：`save_msgs` 的返回是 `Result<()>`，签名是 `save_msgs(context: &Context, msg_ids: &[MsgId])`。若 `delete` 方法名不对，查 core `message.rs` 的删除 API（`Message::delete` 或 `delete_msgs`）。

- [ ] **Step 2: 前端 message.ts 右键菜单保存项**

在 `src/chat/message.ts` 的 `showContextMenuAt`（第 526 行起）items 数组里，`复制文本` 之后加：

```ts
items.push({
  label: '保存消息',
  icon: 'bookmark',
  action: async () => {
    try {
      await call('save_msg', { msgId });
      showToast('已保存');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  },
});
```

`bookmark` 图标需确认在 icon.ts 的 `IconName` 里存在；若没有，用已有图标（如 `star`）。

- [ ] **Step 3: footer 书签图标（可选，若时间允许）**

在 `message.ts` 的 `footerHtml`（第 234 行起）里，`${stateHtml}` 之前加书签标记——需先确认后端消息 DTO 是否携带 `savedMessageId`。若 `MsgDto` 没有该字段，**跳过本步**（保存功能通过右键菜单可用即可，书签图标留到批次 2）。

- [ ] **Step 4: navPanel「保存的消息」入口**

在 `src/shell/navPanel.ts` 的导航树/侧栏加一个「保存的消息」入口，点击时进入 self-talk chat（`is_self_talk`）。查看 navPanel.ts 现有结构决定插入位置，复用现有 chat 打开逻辑：

```ts
// 伪代码：找到 self-talk chat 并打开
const chats = await call<ChatListItem[]>('get_chatlist');
const selfTalk = chats.find((c) => c.is_self_talk);
if (selfTalk) {
  state.currentChatId = selfTalk.chat_id;
  // ... 复用现有打开 chat 的流程
}
```

**注意**：先读 navPanel.ts 了解现有入口结构和打开 chat 的方式，再实现。

- [ ] **Step 5: 类型检查 + 构建**

Run: `npx tsc --noEmit` → 无错误；`npx vite build` → 成功。

---

## 任务 C：Composer 草稿

**Files:**
- Modify: `src-tauri/src/commands.rs`（get_draft / set_draft 命令）
- Modify: `src/chat/composer.ts`（防抖保存 + 恢复）

- [ ] **Step 1: 后端 get_draft / set_draft 命令**

在 `src-tauri/src/commands.rs` 末尾加：

```rust
#[tauri::command]
pub async fn get_draft(state: State<'_, AppState>, chat_id: u32) -> AppResult<Option<String>> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat = Chat::load_from_db(&ctx, ChatId::new(chat_id)).await?;
    let draft = chat.get_draft(&ctx).await?;
    Ok(draft.map(|m| m.get_text().to_string()))
}

#[tauri::command]
pub async fn set_draft(
    state: State<'_, AppState>,
    chat_id: u32,
    text: String,
) -> AppResult<()> {
    let ctx = state
        .current()
        .await
        .ok_or_else(|| AppError::Core("no account".into()))?;
    let chat = Chat::load_from_db(&ctx, ChatId::new(chat_id)).await?;
    if text.trim().is_empty() {
        chat.set_draft(&ctx, None).await?;
    } else {
        let mut draft = Message::new(Viewtype::Text, text);
        chat.set_draft(&ctx, Some(&mut draft)).await?;
    }
    Ok(())
}
```

**注意**：`Chat::set_draft` 签名是 `set_draft(self, context: &Context, mut msg: Option<&mut Message>)`，`Message::new(Viewtype, text)` 需确认构造方式（查 core message.rs）。

- [ ] **Step 2: 前端 composer.ts 保存草稿**

在 `src/chat/composer.ts` 的 `renderComposer` 里，`input.oninput` 处加防抖保存：

```ts
let draftTimer: ReturnType<typeof setTimeout> | null = null;
// 输入防抖 500ms 保存草稿
const saveDraft = () => {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    void call('set_draft', { chatId, text: input.value });
  }, 500);
};
```

在 `input.oninput` 里末尾调用 `saveDraft()`。在 `send()` 成功后清空草稿：`await call('set_draft', { chatId, text: '' });`。

- [ ] **Step 3: 前端 composer.ts 恢复草稿**

在 `renderComposer` 里，`area.innerHTML = ...` 之后、`input.focus()` 之前，异步恢复：

```ts
try {
  const draft = await call<string | null>('get_draft', { chatId });
  if (draft) {
    input.value = draft;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateSendState();
  }
} catch {}
```

**注意**：`renderComposer` 目前是同步函数（`export function renderComposer`）。恢复草稿需要 await，需改签名或改成 async。查看调用方（chatView.ts `renderComposer(chatId, () => ...)`）是否 await——若不 await，改成 async 即可，调用方无需变（fire-and-forget）。

- [ ] **Step 4: 类型检查 + 构建**

Run: `npx tsc --noEmit` → 无错误；`npx vite build` → 成功。

---

## 收尾（主 Agent 执行，非子代理）

- [ ] **主 Agent: lib.rs 登记新命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里登记：`archive_chat`、`save_msg`、`unsave_msg`、`get_draft`、`set_draft`。

- [ ] **主 Agent: 全量验证**

Run: `npx tsc --noEmit` + `npx vite build` + `cd src-tauri && cargo check`。确认零错误。

- [ ] **主 Agent: commit**

```bash
git add src-tauri/ src/chat/composer.ts src/chat/message.ts src/pages/messagesPage.ts src/shell/navPanel.ts src/state.ts src/types.ts
git commit -m "feat(chat): Delta batch 1 — archive, saved messages, composer drafts"
```

---

## 自审记录

- **占位符**：`unsave_msg` 的 `delete` 方法名、`set_draft` 的 `Message::new` 构造、`navPanel` 入口位置、`get_visibility` 方法名——均标注了「先确认 core」的 fallback，非空占位符。
- **一致性**：`archive_chat` 用 `AppResult<()>` 与现有命令一致；`ChatDto` 加字段后 get_chatlist 必须同步填充（Step 2 强制）。
- **隔离**：三个子系统文件边界互斥，共享文件只 append 不删改；lib.rs/styles.css 主 Agent 独占。
