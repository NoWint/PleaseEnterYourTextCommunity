# Delta 对齐批次 2 实施计划（搜索 / Gallery / 命令面板 / 邮件·广播）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Delta Chat 对齐批次 2 的 4 个子系统：全局搜索增强 + 会话内搜索、Gallery 相册、命令面板、邮件列表/广播列表识别。

**Architecture:** 全部桥接 core + 前端 UI。搜索复用现有 `search_msgs` + `search.ts`；Gallery 复用 `get_chat_msgs` 后端过滤 + 网格/全屏 UI；命令面板复用现有命令注册表 + search.ts 键盘导航；邮件/广播补 `chat_type` 字段暴露 + profile/已读数。

**Tech Stack:** Tauri v2 (Rust) + Vanilla TS/Vite + deltachat core 2.58

---

## 文件边界（子代理隔离关键）

| 子系统 | 独占文件 | 共享文件（只读） | 不得触碰 |
|---|---|---|---|
| **2.1 搜索** | `src/chat/chatView.ts`（仅头部搜索按钮+跳转高亮）、`src/components/search.ts` | `src-tauri/src/commands.rs`（search_msgs 扩展） | gallery、command palette 文件 |
| **2.2 Gallery** | `src/components/gallery.ts`（新建）、`src/chat/chatView.ts`（仅 Gallery 按钮） | `src-tauri/src/commands.rs`（get_chat_media） | search.ts |
| **2.3 命令面板** | `src/components/commandPalette.ts`（新建） | `src-tauri/src/commands.rs`（无新命令） | search.ts、gallery.ts |
| **2.4 邮件/广播** | `src/components/mailingListProfile.ts`（新建）、`src/pages/messagesPage.ts`（broadcast 标记） | `src-tauri/src/dto.rs`、`src-tauri/src/commands.rs` | 其他 |

**冲突规避**：
- `src-tauri/src/commands.rs` 共享文件：**子代理只 append 各自命令，不删改现有代码**。2.1 的 `search_msgs` 扩展、2.2 的 `get_chat_media`、2.4 的 `chat_type` 字段——**统一由主 Agent 收尾实现**，子代理只写前端并约定命令签名。
- `src/chat/chatView.ts` 被 2.1 和 2.2 共享——**由主 Agent 统一加头部按钮**，子代理不碰。
- `src-tauri/src/lib.rs`、`src-tauri/src/dto.rs` 主 Agent 独占。
- 每个子代理完成后汇报主 Agent，不自行 commit。

---

## 任务 A：全局搜索增强 + 会话内搜索（2.1）

**主 Agent 后端契约**（子代理不实现，只按此签名调）：
- `search_msgs(query, chatId?)` — 新增可选 `chatId` 参数，传了则只在指定会话内搜。

**Files:**
- Modify: `src/components/search.ts`（全局搜索跳转高亮）
- Modify: `src/chat/chatView.ts`（头部搜索按钮 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（search_msgs chatId 参数 — 主 Agent 做）

- [ ] **Step 1: search.ts 消息结果点击跳转增强**

当前 `bindSearchResults` 的 `type === 'msg'` 分支：`renderChatView(chatId)` 后找 `[data-msg="${id}"]` 高亮。问题：**虚拟化只渲染可视区**，目标消息可能在视口外 → `querySelector` 找不到 → 不高亮。改为用 `jumpToMessage` 逻辑：渲染后按需滚动。

在 `search.ts` 加一个辅助函数，点击消息结果时：`renderChatView(chatId)` 后，若 `[data-msg]` 不存在（目标在可视区外），调 `state.currentChatId` + 重新渲染并滚动。**主 Agent 会在 chatView 暴露 `jumpToMessage(msgId)`**，search.ts 调它。

- [ ] **Step 2: 会话内搜索入口**

主 Agent 在 chatView 头部加搜索按钮 → 打开 search.ts 的 `openSearch()` 并预填查询（聚焦当前会话）。search.ts 在 `doSearch` 里：若当前是会话内搜索，调 `search_msgs(query, chatId)`。

- [ ] **Step 3: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 任务 B：Gallery 相册（2.2）

**主 Agent 后端契约**：
- `get_chat_media(chatId, viewType)` → `Vec<MsgDto>`（拉 `get_chat_msgs` 后按 `view_type` 过滤，viewType 传 'Image'|'Video'|'Audio'|'File'|null=全部）

**Files:**
- Create: `src/components/gallery.ts`
- Modify: `src/chat/chatView.ts`（头部 Gallery 按钮 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（get_chat_media — 主 Agent 做）

- [ ] **Step 1: gallery.ts 网格**

```ts
export async function openGallery(chatId: number): Promise<void> {
  // 全屏浮层,含 4 tab: 图库(Image+Gif) / 文件(File) / 视频(Video) / 音频(Audio)
  // 每个 tab 调 call('get_chat_media', { chatId, viewType })
  // 渲染网格:图片缩略图(点击全屏)、文件/视频/音频卡片
}
```

- [ ] **Step 2: 全屏媒体查看器**

点击图片 → 全屏查看器（overlay，复用现有 `.img-fullscreen-overlay` 模式），支持相邻切换（`arrow` 键或左右按钮遍历当前 tab 的媒体列表）。

- [ ] **Step 3: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 任务 C：命令面板（2.3）

**主 Agent 后端契约**：无新命令（复用现有）。

**Files:**
- Create: `src/components/commandPalette.ts`
- Modify: `src/shell/shell.ts`（Cmd/Ctrl+P 快捷键 — 主 Agent 做）

- [ ] **Step 1: commandPalette.ts**

```ts
// 基于 search.ts 的命令分组扩展为独立组件:
// 命令 = 新建私聊 / 新建群 / 新建频道 / 归档切换 / 删除会话(需当前 chat) / 转设置 / 切视图 / 切主题
// 打开: Cmd/Ctrl+P; 键盘导航(上下/Enter/Esc); 模糊匹配 label
```

命令注册表：
- 新建私聊 → `create_chat_by_email` 流程（`ui.inputDialog`）
- 新建群 → `create_group_chat` 流程
- 切视图/主题 → 复用 search.ts 的 `switchView`/`applyTheme`
- 归档当前会话 → `archive_chat`
- 转设置 → `navigateToPage('settings')`

- [ ] **Step 2: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 任务 D：邮件列表 / 广播列表（2.4）

**主 Agent 后端契约**：
- `ChatInfoDto` 加 `chat_type: String`（'single'|'group'|'mailinglist'|'broadcast'|'self_talk'...）
- `get_chat_info` 填充它（用 `chat.get_type()` + `is_self_talk`）
- `get_message_read_receipt_count(msgId)` → u32

**Files:**
- Create: `src/components/mailingListProfile.ts`
- Modify: `src/pages/messagesPage.ts`（broadcast 会话标记 + 右键菜单）
- Modify: `src-tauri/src/dto.rs` + `src-tauri/src/commands.rs`（主 Agent 做）

- [ ] **Step 1: mailingListProfile.ts**

邮件列表会话的资料弹窗（对齐 Delta `MailingListProfile`）：显示地址、成员列表、离开/归档。

- [ ] **Step 2: messagesPage broadcast 标记**

在 `renderMessageList` 里，若 `c.chat_type === 'broadcast'` 显示广播标记（如 📢 或图标）。

- [ ] **Step 3: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 收尾（主 Agent 执行，非子代理）

- [ ] **主 Agent: 后端命令**
  - `search_msgs` 加 `chatId` 可选参数
  - 新增 `get_chat_media(chatId, viewType)`
  - `ChatInfoDto` 加 `chat_type` + `get_chat_info` 填充
  - 新增 `get_message_read_receipt_count(msgId)`
- [ ] **主 Agent: lib.rs 登记**（get_chat_media、get_message_read_receipt_count）
- [ ] **主 Agent: chatView 头部按钮**（搜索 + Gallery）
- [ ] **主 Agent: shell.ts Cmd/Ctrl+P** 打开命令面板
- [ ] **主 Agent: 全量验证**（tsc + vite build + cargo check）
- [ ] **主 Agent: commit**

```bash
git add src/ src-tauri/
git commit -m "feat(chat): Delta batch 2 — search, gallery, command palette, mailing/broadcast"
```

---

## 自审记录

- **占位符**：各子代理步骤里标注了「主 Agent 做」的后端契约，子代理只按签名调用，不空实现。
- **一致性**：`get_chat_media` 返回 `Vec<MsgDto>`（复用现有 MsgDto 序列化）；`chat_type` 用字符串联合。
- **隔离**：四个子系统文件边界互斥；chatView.ts / commands.rs / dto.rs / lib.rs 由主 Agent 收尾统一处理，避免冲突。
