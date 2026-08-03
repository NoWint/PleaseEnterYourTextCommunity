# PEYT 群组功能对齐 Delta Chat 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完全仿照 Delta Chat 桌面端实现 E2EE 群组闭环(创建/编辑/成员管理/二维码邀请/退群/系统消息)。

**Architecture:** 后端全部桥接 deltachat core 2.58 群 API(`chat::*`),群资料写 core(对端经群同步消息自动更新);前端新建 3 组件(群创建对话框/成员选择器/群信息弹窗) + 系统消息居中渲染,复用现有 `ui.dialog`/`get_securejoin_qr`/`save_avatar_from_bytes` 管道。

**Tech Stack:** Tauri v2 + deltachat core + Vanilla TS。

**范围决策(用户已确认):** 头像原图直接设置(不做 ImageCropper 裁切);只做默认加密群(明文群/广播 ViewGroup 化列为后续)。

---

### Task 1: 后端 DTO 扩展(dto.rs)

**Files:**
- Modify: `src-tauri/src/dto.rs`

- [ ] **Step 1: `MemberDto` 无需改动;`ChatInfoDto` 增补 5 字段,`MsgDto` 增补 `is_info`**

```rust
// ChatInfoDto 增补(保留既有字段):
pub struct ChatInfoDto {
    pub chat_id: u32,
    pub name: String,
    pub is_group: bool,
    pub is_contact_request: bool,
    pub is_self_talk: bool,
    pub chat_type: String,
    pub is_encrypted: bool,
    pub members: Vec<MemberDto>,
    // 新增 ↓
    pub description: String,        // chat::get_chat_description
    pub avatar: Option<String>,     // chat.get_profile_image
    pub past_members: Vec<MemberDto>, // chat::get_past_chat_contacts
    pub can_send: bool,             // chat.can_send(&ctx)
    pub self_in_group: bool,        // chat.is_self_in_chat(&ctx)
}

// MsgDto 增补:
pub struct MsgDto {
    // ...既有字段
    pub is_info: bool,  // Message::is_info() —— 系统消息
}
```

- [ ] **Step 2: `cargo check` 确认无破坏**(此时 get_chat_info/msg_to_dto 尚未更新,会有字段缺失报错,属预期,下一步补齐)

### Task 2: 后端新增群组命令 + 扩展(commands.rs)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`(注册命令)

- [ ] **Step 1: 从 `get_chat_info` 提取成员解析为 helper(供 members/past_members 复用)**

在 `get_chat_info` 上方新增:
```rust
/// 联系人 → MemberDto(群成员/历史成员共用)。
async fn member_to_dto(ctx: &Context, cid: deltachat::contact::ContactId) -> AppResult<MemberDto> {
    let c = deltachat::contact::Contact::get_by_id(ctx, cid).await?;
    let avatar = c
        .get_profile_image(ctx)
        .await?
        .map(|p| p.to_string_lossy().to_string());
    Ok(MemberDto {
        contact_id: cid.to_u32(),
        name: c.get_display_name().to_string(),
        addr: c.get_addr().to_string(),
        is_self: cid == deltachat::contact::ContactId::SELF,
        avatar,
        color: Some(c.get_color()),
    })
}
```

- [ ] **Step 2: 扩展 `get_chat_info`(commands.rs:363)** — 用 `member_to_dto` 重构 members 循环,新增 description/avatar/past_members/can_send/self_in_group:

```rust
let mut members = Vec::new();
for cid in chat::get_chat_contacts(&ctx, chat_id).await? {
    members.push(member_to_dto(&ctx, cid).await?);
}
// self-talk 兜底(仅当 members 为空)保持既有逻辑
let mut past_members = Vec::new();
for cid in chat::get_past_chat_contacts(&ctx, chat_id).await? {
    past_members.push(member_to_dto(&ctx, cid).await?);
}
let description = chat::get_chat_description(&ctx, chat_id).await?;
let avatar = chat.get_profile_image(&ctx).await?.map(|p| p.to_string_lossy().to_string());
let can_send = chat.can_send(&ctx).await?;
let self_in_group = chat.is_self_in_chat(&ctx).await?;
```
注意 self-talk 兜底逻辑(现有 397 行 `if members.is_empty() && is_self_talk`)保留;`past_members` 对 self-talk 为空(无 past contacts)。

- [ ] **Step 3: 新增 4 个群组命令**(放在 `leave_group` 附近):

```rust
/// 从群聊移除成员(contact_id = SELF 即退群,core 允许)。
#[tauri::command]
pub async fn remove_group_member(
    state: State<'_, AppState>,
    chat_id: u32,
    contact_id: u32,
) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    chat::remove_contact_from_chat(&ctx, chat_id, deltachat::contact::ContactId::new(contact_id)).await?;
    Ok(())
}

/// 修改群名称(core 触发 GroupNameChanged 系统消息 + ChatModified 事件)。
#[tauri::command]
pub async fn rename_group(
    state: State<'_, AppState>,
    chat_id: u32,
    name: String,
) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    chat::set_chat_name(&ctx, deltachat::chat::ChatId::new(chat_id), &name).await?;
    Ok(())
}

/// 设置群描述(空字符串 = 清除)。
#[tauri::command]
pub async fn set_group_description(
    state: State<'_, AppState>,
    chat_id: u32,
    description: String,
) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    chat::set_chat_description(&ctx, deltachat::chat::ChatId::new(chat_id), &description).await?;
    Ok(())
}

/// 设置群头像(空字符串 = 移除)。path 为 blobdir 绝对路径(经 save_avatar_from_bytes 产生)。
#[tauri::command]
pub async fn set_group_avatar(
    state: State<'_, AppState>,
    chat_id: u32,
    path: String,
) -> AppResult<()> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    chat::set_chat_profile_image(&ctx, deltachat::chat::ChatId::new(chat_id), &path).await?;
    Ok(())
}
```

- [ ] **Step 4: 扩展 `create_group`(commands.rs:614)** — 增补 `description`/`avatar_path`/`member_contact_ids`:

```rust
#[tauri::command]
pub async fn create_group(
    state: State<'_, AppState>,
    name: String,
    member_emails: Vec<String>,
    member_contact_ids: Vec<u32>,
    description: Option<String>,
    avatar_path: Option<String>,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = chat::create_group(&ctx, &name).await?;
    if let Some(desc) = description.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        chat::set_chat_description(&ctx, chat_id, desc).await?;
    }
    if let Some(p) = avatar_path.as_deref().filter(|s| !s.is_empty()) {
        chat::set_chat_profile_image(&ctx, chat_id, p).await?;
    }
    for cid in member_contact_ids {
        chat::add_contact_to_chat(&ctx, chat_id, deltachat::contact::ContactId::new(cid)).await?;
    }
    for email in member_emails {
        let email = email.trim();
        if email.is_empty() { continue; }
        let cid = deltachat::contact::Contact::create(&ctx, "", email).await?;
        chat::add_contact_to_chat(&ctx, chat_id, cid).await?;
    }
    Ok(chat_id.to_u32())
}
```

- [ ] **Step 5: 扩展 `add_group_member`(commands.rs:633)** — 增补 `contact_id: Option<u32>`:

```rust
#[tauri::command]
pub async fn add_group_member(
    state: State<'_, AppState>,
    chat_id: u32,
    email: String,
    contact_id: Option<u32>,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let cid = match contact_id {
        Some(id) => deltachat::contact::ContactId::new(id),
        None => deltachat::contact::Contact::create(&ctx, "", &email).await?,
    };
    chat::add_contact_to_chat(&ctx, chat_id, cid).await?;
    Ok(cid.to_u32())
}
```

- [ ] **Step 6: `msg_to_dto`(commands.rs:435)增补 `is_info`** — 在构造 MsgDto 时加一行 `is_info: m.is_info(),`。

- [ ] **Step 7: `lib.rs` 注册新命令** — 在 `invoke_handler` 列表加入 `remove_group_member` / `rename_group` / `set_group_description` / `set_group_avatar`。

- [ ] **Step 8: `cargo check` 通过**(`cargo check` 于 src-tauri 目录)。

### Task 3: 前端类型同步(types.ts)

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: `MsgDto` 增补 `is_info: boolean;`**
- [ ] **Step 2: 新增 `ChatInfoDto` 接口**(rightDrawer/mailingListProfile 目前用局部接口,统一导出):

```ts
export interface ChatInfoDto {
  chat_id: number;
  name: string;
  is_group: boolean;
  is_contact_request: boolean;
  is_self_talk: boolean;
  chat_type: string;
  is_encrypted: boolean;
  members: MemberDto[];
  description: string;
  avatar: string | null;
  past_members: MemberDto[];
  can_send: boolean;
  self_in_group: boolean;
}
```

### Task 4: 成员选择器 `src/components/group/memberPicker.ts`

**Files:**
- Create: `src/components/group/memberPicker.ts`

- [ ] **Step 1: 新建组件** — 仿 Delta `AddMemberInnerDialog` + 复用 `contactsPicker.ts` 搜索列表模式:

```ts
// 入参:已入群成员 contactId 集合(创建群时为空)、回调返回已选。
export interface MemberPick {
  contact_id: number; // 0 表示手输邮箱
  email: string;
  name: string;
}
export function openMemberPicker(opts: {
  title?: string;
  existing: Set<number>;       // 已入群 contactId(禁用)
  excludeSelf?: boolean;       // 默认 true(创建群时排除自己,加人时也可排除)
  onOk: (picks: MemberPick[]) => void;
}): void
```
- 拉 `get_contacts`(过滤 self),搜索输入按 name/addr 过滤。
- 列表每行:头像 + 名 + addr + checkbox;`existing` 内成员与 self 禁用(灰显)。
- 顶部 chips:已选成员(名 + ✕)。
- 搜索无结果且输入为合法邮箱(含 `@`)→ 显示「以邮箱添加 <addr>」行,点击加入(contact_id=0)。
- 底部:取消 / 确定;确定仅在已选非空时可点,回调 `onOk(picks)` 后关闭。

### Task 5: 群创建对话框 `src/components/group/createGroupDialog.ts`

**Files:**
- Create: `src/components/group/createGroupDialog.ts`

- [ ] **Step 1: 新建组件** — 仿 Delta `CreateGroup`:

```ts
export function openCreateGroupDialog(): void
```
- `ui.dialog`(`size: 'lg'`),标题「创建群」。
- 头部:群头像预览(圆形,现有 `renderAvatarHtml` 风格)+ 「上传/移除」按钮;上传 = file input(`accept="image/*"`)→ `save_avatar_from_bytes` → 预览 `transformBlobURL`;移除 → `avatarPath = ''`。
- 群名输入(空则报错「请输入群名称」)。
- 群描述 textarea。
- 成员区:「N 位成员」+「添加成员」按钮 → `openMemberPicker({ existing: new Set() })`,已选渲染为可移除 chips(self 不可移除)。
- 底部:取消 / 创建。创建调:
```ts
await call('create_group', {
  name, description, avatarPath,
  member_emails: picks.filter(p => p.contact_id === 0).map(p => p.email),
  member_contact_ids: picks.filter(p => p.contact_id !== 0).map(p => p.contact_id),
});
state.currentChatId = chatId;
saveState();
// 进入会话
```
- 成功后进入会话并关闭弹窗。

### Task 6: 群信息弹窗 `src/components/group/viewGroupDialog.ts`

**Files:**
- Create: `src/components/group/viewGroupDialog.ts`

- [ ] **Step 1: 新建组件** — 仿 Delta `ViewGroup`:

```ts
export function openViewGroupDialog(chatId: number): void
```
- 拉 `get_chat_info` → 渲染头部:群头像 + 群名 + `N 成员` + 描述 + 加密徽章(`is_encrypted`)。
- 操作栏按钮:
  - **编辑资料**(仅 `can_send`):新 `ui.dialog` 内名称/描述/头像,保存调 `rename_group` + `set_group_description` + `set_group_avatar`。
  - **添加成员**(仅 `can_send`):`openMemberPicker({ existing: 当前成员 contactId })` → 逐个 `add_group_member({ chat_id, contact_id })`。
  - **群二维码**:`get_securejoin_qr(chatId)` → `QRCode.toDataURL` 展示 + 复制链接(复用 `settingsPage.showMyQr` 模式)。
  - **保护状态**:复用现有 `protectionDialog.openProtectionDialog(chatId)`。
  - **退群**:`ui.confirm`(danger)→ `leave_group`,成功后关闭弹窗 + 退出当前会话。
- 当前成员列表:每行头像+名+邮箱;非 self 且 `can_send` 时显示「移除」按钮 → `ui.confirm` 确认 → `remove_group_member({ chat_id, contact_id })`;点击成员行 → 现有 `memberDetail.renderMemberDetail`。
- 历史成员段:分隔线「历史成员」+ `past_members` 只读列表。
- **实时刷新**:订阅 `ChatModified`(chatId 匹配)→ 重新 `get_chat_info` 更新;`ContactsChanged` → 更新成员头像/名(可选)。

### Task 7: 系统消息渲染 + 入口接入

**Files:**
- Modify: `src/chat/message.ts`
- Modify: `src/chat/chatView.ts`
- Modify: `src/pages/messagesPage.ts`
- Modify: `src/shell/rightDrawer.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: `message.ts` 系统消息渲染** — `renderMessage` 开头加分支:

```ts
if (m.is_info) {
  return `<div class="msg-system" data-msg="${m.msg_id}">
    <span>${escapeHtml(m.text)}</span>
  </div>`;
}
```
(core 的 `is_info()` 文本已本地化拼接,如「X 加入了群组」「群组已加密」,直接展示。)

- [ ] **Step 2: `styles.css` 加 `.msg-system` 样式**(居中胶囊弱化行):

```css
.msg-system { display:flex; justify-content:center; align-items:center; padding:4px 0; }
.msg-system span { background:var(--capsule); color:var(--text-mute); font-size:var(--font-scale-secondary); padding:2px 12px; border-radius:999px; max-width:80%; text-align:center; line-height:1.4; }
```

- [ ] **Step 3: `chatView.ts` 头部加群信息按钮** — `currentChatIsGroup` 在头部按钮渲染之后才赋值(chatView.ts:179),故在 chatlist 拉取块(chatView.ts:173-184)内、`state.currentChatIsGroup = chat?.is_group === true;` 赋值后补插群信息按钮:

```ts
const chat = chats.find((c) => c.chat_id === chatId);
state.currentChatIsGroup = chat?.is_group === true;
if (state.currentChatIsGroup && headerEl && !headerEl.querySelector('[data-group-info]')) {
  const groupBtn = ui.iconButton({ icon: 'users', title: '群信息' });
  groupBtn.dataset.groupInfo = '1';
  groupBtn.addEventListener('click', () => {
    void import('../components/group/viewGroupDialog.js').then(({ openViewGroupDialog }) => openViewGroupDialog(chatId));
  });
  headerEl.appendChild(groupBtn);
}
```
(Step 3 的按钮改为在 Step 4 里创建,避免重复。)

- [ ] **Step 5: `messagesPage.ts` 新建群菜单** — `showInlineGroupInput`(messagesPage.ts:301)改为:

```ts
function showInlineGroupInput(): void {
  void import('../components/group/createGroupDialog.js').then(({ openCreateGroupDialog }) => openCreateGroupDialog());
}
```
(替换现有两次 `inputDialog`。创建对话框内部成功后自行进入会话 + renderChatView。)

- [ ] **Step 6: `rightDrawer.ts` 添加成员改成员选择器** — 第 306 行 `#rd-add-member` click 处理器改为:

```ts
body.querySelector<HTMLElement>('#rd-add-member')?.addEventListener('click', () => {
  void import('../components/group/memberPicker.js').then(({ openMemberPicker }) => {
    // 先拉当前成员得到 existing
    openMemberPicker({
      existing: new Set(info.members.map((m) => m.contact_id)),
      onOk: async (picks) => {
        for (const p of picks) {
          await call('add_group_member', {
            chatId: state.currentChatId,
            email: p.email,
            contact_id: p.contact_id || null,
          });
        }
        showToast(`已添加 ${picks.length} 位成员`);
        await renderMembers(body);
      },
    });
  });
});
```

- [ ] **Step 7: `tsc --noEmit` 通过**。

### Task 8: 验证

- [ ] **Step 1: `cd src-tauri && cargo check` 通过**。
- [ ] **Step 2: `npx tsc --noEmit` 通过**。
- [ ] **Step 3: `npm run tauri dev` 实测**(双账号或与 delta 对端):
  - 新建群(名称+描述+头像+多选成员)→ 进入会话,头部显示群名 + 群信息按钮。
  - 群信息弹窗:成员/历史成员/描述/加密徽章正确。
  - 加成员(memberPicker 搜索+多选+已入群禁用)→ 成员列表刷新。
  - 移除成员(确认)→ 历史成员区出现。
  - 改群名/描述/头像 → 弹窗 + 消息流系统消息同步。
  - 群二维码可扫码加入;退群后会话关闭。
  - 系统消息居中渲染,无头像/气泡。
  - 对端收到群资料同步 + 系统消息。

### Task 9: 提交

- [ ] **Step 1: 按项目 commit 风格提交**(中文,feat 前缀):`feat: 群组功能对齐 Delta(创建/编辑/成员/二维码/退群/系统消息)`。
