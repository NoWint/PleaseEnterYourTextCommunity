# PEYT 群组功能对齐 Delta Chat 设计文档

- 日期: 2026-08-03
- 状态: 待实施
- 范围: **完全仿照 Delta Chat 桌面端**实现 E2EE 群组闭环(创建/编辑/成员管理/二维码邀请/退群/系统消息),基于 deltachat core 2.58 群模型

## 0. 背景与约束

### 0.1 为什么是「core 群模型」而非「工作区频道」

PEYT 现有两类会话:

| 会话类型 | 存储 | 管理命令 | 对端同步 |
|---|---|---|---|
| **工作区频道**(channel) | 后端 app 级 `db.sqlite`(workspace/category/topic) | `create_channel` / `update_channel` / `set_channel_topic` | 无(不发给对端) |
| **core 会话**(单聊/群聊/邮件列表/广播) | core `deltachat.sqlite` | `create_group` / `create_chat_by_email` 等 | **经 SMTP 群同步消息同步** |

群组功能**完全建立在 core 群模型上**:群名/群描述/群头像/成员变更写入 core,由 core 生成系统消息 + 群同步消息发给对端,对端自动更新 —— 这是 Delta 群功能的根基。工作区频道模型保持不变,群组是**新增的独立能力**,二者并存。

**Why**: 若继续把群资料写在工作区 DB(`update_channel`/`set_channel_topic`),对端永远收不到群资料变更,群功能形同虚设。

**How to apply**:
- 所有群组命令直接调 core API(`chat::*`),不经 app 级 DB。
- `update_channel`/`set_channel_topic` 保留原样,服务工作区频道。

### 0.2 全局约束(沿用路线图)

- **本地永久留存**:不做自动删除/消失消息。
- **事件流**:经现有 `dc-event` → 前端 `onEvent` 单一 listener 分发。
- **前端 `.js` 导入**、注释中文、Apple 设计语言。

### 0.3 与既有子系统的边界

- **广播/邮件列表**:沿用现有 `mailingListProfile.ts`,不在本次范围(Delta ViewGroup 虽也服务 OutBroadcast,但 PEYT 已有独立入口,群组核心先做 `Group` 类型)。
- **保护状态/加密信息**:已有 `protectionDialog.ts`(`get_chat_encryption_info`),群信息弹窗直接复用其入口。
- **二维码邀请**:后端 `get_securejoin_qr(chatId)` / `secure_join(qr)` 已存在,前端复用 `QRCode.toDataURL` 生成(同 `settingsPage.showMyQr`)。

## 1. 目标与非目标

### 目标
1. 完整 E2EE 群闭环:创建(名称+描述+头像+成员)→ 编辑资料 → 加人/移除成员 → 历史成员 → 群二维码邀请 → 退群。
2. 系统消息("X 加入群"/"X 被移除"/"群名称已改为…"/"群头像已更换")在消息流中渲染为居中信息行。
3. 群变更实时同步:本端操作生效即刷新,对端经 core 事件收到同步。

### 非目标
- 工作区频道模型改造。
- 明文邮件群(`create_group_unencrypted`)创建入口(Delta 的 `GroupType.PLAIN_EMAIL`)。PEYT 群组默认加密。
- 广播频道/邮件列表的 Delta ViewGroup 化(维持现状)。
- 头像圆形裁切(`ImageCropper` 级):头像选择后**原图直接设置**,显示时由现有 CSS 圆形裁剪。裁切列为后续可选优化。
- 群描述/头像的编辑中实时同步动画(Delta 有 loading 态,PEYT 用按钮触发即可)。

## 2. 架构

```
前端                        Tauri IPC                后端(Rust)                 core
─────────                  ────────                 ───────────                ─────
createGroupDialog  ──────> create_group(description, ──> chat::create_group ──> Group chat
                            avatar_path, memberEmails)   + set_chat_name
                                                         + set_chat_description
                                                         + set_chat_profile_image
                                                         + add_contact_to_chat ×N
viewGroupDialog ─────────> rename_group / set_group_description /
                           set_group_avatar / remove_group_member / leave_group
memberPicker ────────────> get_contacts + add_group_member(contact_id)
                           + 本地已入群禁用
系统消息渲染 <──────────── MsgsChanged ──────────────── 系统消息(SystemMessage::*)
群资料刷新  <──────────── ChatModified ──────────────── 群名/头像/成员变更
```

## 3. 后端设计

### 3.1 新增命令(全部桥接 core)

| 命令 | 入参 | core 调用 | 说明 |
|---|---|---|---|
| `remove_group_member` | `chat_id: u32, contact_id: u32` | `chat::remove_contact_from_chat(ctx, ChatId, ContactId)` | 移除他人;contact_id=SELF 即退群(core 允许) |
| `rename_group` | `chat_id: u32, name: String` | `chat::set_chat_name(ctx, ChatId, &name)` | 触发 `SystemMessage::GroupNameChanged` + `ChatModified` |
| `set_group_description` | `chat_id: u32, description: String` | `chat::set_chat_description(ctx, ChatId, &desc)` | 触发 `GroupDescriptionChanged` |
| `set_group_avatar` | `chat_id: u32, path: String` | `chat::set_chat_profile_image(ctx, ChatId, &path)` | `path=""` 表示移除头像;触发 `GroupImageChanged` |

### 3.2 扩展命令

- **`get_chat_info`**(commands.rs:363)返回 `ChatInfoDto` 增补:
  - `description: String` → `chat::get_chat_description`
  - `avatar: Option<String>` → `chat.get_profile_image(&ctx)`
  - `past_members: Vec<MemberDto>` → `chat::get_past_chat_contacts`(复用现有成员解析)
  - `can_send: bool` → `chat.can_send(&ctx)`
  - `self_in_group: bool` → `chat.is_self_in_chat(&ctx)`
- **`add_group_member`**(commands.rs:633)增补 `contact_id: Option<u32>` 入参:
  - `Some(id)` → 直接 `chat::add_contact_to_chat(ctx, chat_id, ContactId::new(id))`
  - `None` → 走现有 email → `Contact::create` 流程
- **`create_group`**(commands.rs:614)增补可选入参:
  - `description: Option<String>`、`avatar_path: Option<String>`、`member_contact_ids: Vec<u32>`
  - 建群后按需 `set_chat_description` / `set_chat_profile_image` / 按 contact_id 加人
  - (保留 `member_emails` 兼容现有调用)

### 3.3 DTO 扩展(`dto.rs`)

```rust
// MemberDto(既有)
pub struct MemberDto {
    pub contact_id: u32,
    pub name: String,
    pub addr: String,
    pub is_self: bool,
    pub avatar: Option<String>,
    pub color: Option<u32>,
}

// ChatInfoDto 增补
pub struct ChatInfoDto {
    // ...既有字段(chat_id/name/is_group/is_contact_request/is_self_talk/chat_type/is_encrypted/members)
    pub description: String,
    pub avatar: Option<String>,
    pub past_members: Vec<MemberDto>,
    pub can_send: bool,
    pub self_in_group: bool,
}

// MsgDto 增补
pub struct MsgDto {
    // ...既有字段
    pub is_info: bool,  // core Message::is_info() —— 系统消息标记
}
```

`msg_to_dto`(commands.rs:435)增补:
```rust
let is_info = m.is_info();
```

## 4. 前端设计

### 4.1 群创建对话框 `src/components/group/createGroupDialog.ts`

仿 Delta `CreateGroup`,调 `ui.dialog`:

- **头部**:群名称输入(空则报错,同 Delta `please_enter_chat_name`)。
- **群描述**:`textarea`(Delta `chat_description`)。
- **群头像**:头像预览(现有 `renderAvatarHtml` 风格,圆形)+「上传/移除」,上传走 `save_avatar_from_bytes` 得到 blobdir 路径,预览用 `transformBlobURL`。
- **成员**:成员数标签 +「添加成员」入口(打开 4.2 memberPicker)+ 已选成员 chips(可逐个移除,self 不可移除)。
- **底部**:取消 / 创建。创建调 `create_group({ name, description, avatarPath, memberEmails })`,成功后 `state.currentChatId = chatId` 并 `renderChatView`。

### 4.2 成员选择器 `src/components/group/memberPicker.ts`

仿 Delta `AddMemberInnerDialog`(复用 `contactsPicker.ts` 的搜索列表模式):

- **顶部 chips**:已选成员(头像+名+移除 ✕)。
- **搜索框**:按 name/addr 过滤 `get_contacts`(排除 self)。
- **成员列表**:每行 checkbox;已在群成员与 self **禁用**(灰显)。
- **手输新邮箱**:搜索无结果且输入为合法邮箱时,显示「以邮箱添加」行,勾选即临时加入(前端维护即可,不需建联系人)。
- **确认** → 回调选中的 contactId/email 数组,由调用方决定 `add_group_member(contact_id)` 或 `create_group(member_contact_ids)`。

### 4.3 群信息弹窗 `src/components/group/viewGroupDialog.ts`

仿 Delta `ViewGroup`,调 `ui.dialog`(`size: 'lg'`):

- **头部**:群头像(圆形)+ 群名 + `N 成员` + 群描述 + 加密徽章(`is_encrypted`)。
- **操作栏**:编辑资料 / 加成员 / 群二维码 / 加密信息(`protectionDialog`)/ 退群。
- **当前成员列表**:每行头像+名+邮箱;非 self 成员显示「移除」按钮(点击 `ui.confirm` 确认后调 `remove_group_member`);点击成员行 → 现有 `memberDetail`。
- **历史成员段**:`past_members`,只读列表(分隔线「历史成员」)。
- **编辑资料**(`EditGroupDialog`):名称 + 描述 + 头像,调 `rename_group` / `set_group_description` / `set_group_avatar`。
- **群二维码**:`get_securejoin_qr(chatId)` → `QRCode.toDataURL` → 展示 + 复制链接(复用 `settingsPage.showMyQr` 模式)。
- **退群**:`ui.confirm`(danger)→ `leave_group`,成功后退出当前会话。
- **实时刷新**:`ChatModified`(chatId 匹配)时重新 `get_chat_info` 刷新;`ContactsChanged` 时刷新成员资料。

### 4.4 系统消息渲染 `src/chat/message.ts`

- `msg.is_info` 为真时,`renderMessage` 输出**居中信息行**(非气泡):小号弱化文字,参考 Delta `MessageSystemInfo`,形如:
  ```html
  <div class="msg-system"><span>「${from_name}」加入了群组</span></div>
  ```
- 不渲染头像/名字/气泡/meta(已读、时间等),不参与分组(`computeGroupRole` 对其跳过或直接给 `solo` 且不折叠)。
- 文案:core 的 `Message::is_info()` 返回文本即系统消息的完整描述(core 已本地化拼接,如 "群组已加密"),**直接展示 `msg.text` 即可**,无需前端拼词。

### 4.5 入口接入

- **chatView 头部**(chatView.ts:131):在 shield 按钮旁加「群信息」`ui.iconButton`(icon `users`,title 群信息),**仅 `state.currentChatIsGroup` 时显示**;点击打开 4.3 viewGroupDialog。
- **新建群菜单**(messagesPage.ts:301 `showInlineGroupInput`):改为打开 4.1 createGroupDialog,替换现有两次 `inputDialog`(群名 + 邮箱串)。
- **右键菜单/成员面板**:rightDrawer「成员」tab 的「添加成员」按钮(第306行)改为打开 4.2 memberPicker(多选),替代单邮箱输入。

## 5. 事件与数据流

| 事件 | 触发 | 前端处理 |
|---|---|---|
| `ChatModified` | 群名/头像/成员变更、验证态变更 | 若群信息弹窗打开 → 重新拉 `get_chat_info`;chat 头部标题/成员数刷新 |
| `MsgsChanged` | 系统消息进流、消息发送/接收 | 现有 `appendNewMessages` 增量追加,`is_info` 消息按 4.4 渲染 |
| `ContactsChanged` | 联系人资料变更 | 群信息弹窗成员头像/名字刷新(可选) |

数据模型:群资料与成员全部由 core 持久化,无 app 级新表。

## 6. 文件清单

**后端**(`src-tauri/src/`):
- `commands.rs`:新增 4 命令 + 扩展 `get_chat_info` / `add_group_member` / `create_group` / `msg_to_dto`(is_info)
- `dto.rs`:`ChatInfoDto` 增补 5 字段,`MsgDto` 增补 `is_info`
- `lib.rs`:注册新命令

**前端**(`src/`):
- 新建 `components/group/createGroupDialog.ts`
- 新建 `components/group/memberPicker.ts`
- 新建 `components/group/viewGroupDialog.ts`
- `chat/message.ts`:`is_info` 系统消息渲染
- `chat/chatView.ts`:头部群信息按钮 + ChatModified 刷新
- `pages/messagesPage.ts`:新建群菜单 → 群创建对话框
- `shell/rightDrawer.ts`:添加成员 → 成员选择器
- `types.ts`:`ChatInfoDto` / `MsgDto` 类型同步
- `styles.css`:`.msg-system` 信息行样式

## 7. 验收标准

- [ ] 创建群:输入名称/描述/上传头像/多选成员 → 创建成功进入会话,群名/描述/头像正确显示。
- [ ] 对端收到群资料同步(群名/描述/头像变更 + 成员变更),消息流出现系统信息行。
- [ ] 群信息弹窗:显示头像/名称/成员数/描述/加密状态。
- [ ] 编辑资料:改群名/描述/头像,弹窗与消息流系统消息同步更新。
- [ ] 加成员:memberPicker 搜索+多选+已入群禁用,添加后成员列表刷新。
- [ ] 移除成员:确认后移除,历史成员区出现该成员。
- [ ] 群二维码:显示可扫码,对端扫码加入群。
- [ ] 退群:确认后离开,当前会话关闭。
- [ ] 系统消息在消息流居中渲染,不显示头像/名字/气泡。
- [ ] `tsc --noEmit` + `cargo check` 通过。

## 8. 变更记录

- 2026-08-03 初稿。基于 Delta 桌面端 `CreateChat/index.tsx`、`ViewGroup/index.tsx`、`AddMember/*`、`LeaveGroupDialog.tsx` 及 core 2.58 `chat.rs` 逐行研究后对齐。
